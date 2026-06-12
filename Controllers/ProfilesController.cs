using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Jellyfin.Profiles.Configuration;
using Jellyfin.Profiles.Models;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Session;
using MediaBrowser.Model.Users;
using Microsoft.Extensions.Logging;
using MediaBrowser.Common.Net;
using System.Net;

namespace Jellyfin.Profiles.Controllers
{
    [ApiController]
    [Route("plugins/profiles")]
    [AllowAnonymous]
    public class ProfilesController : ControllerBase
    {
        private readonly IUserManager _userManager;
        private readonly ISessionManager _sessionManager;
        private readonly ILibraryManager _libraryManager;
        private readonly INetworkManager _networkManager;
        private readonly ILogger<ProfilesController> _logger;

        public ProfilesController(IUserManager userManager, ISessionManager sessionManager, ILibraryManager libraryManager, INetworkManager networkManager, ILogger<ProfilesController> logger)
        {
            _userManager = userManager;
            _sessionManager = sessionManager;
            _libraryManager = libraryManager;
            _networkManager = networkManager;
            _logger = logger;
        }

        [HttpGet("list")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult<IEnumerable<object>> GetProfiles()
        {
            _logger.LogDebug("ProfilesPlugin: GetProfiles endpoint called.");

            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            // Resolve Master ID from caller claims context (preventing spoofing)
            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null)
            {
                return Unauthorized();
            }
            Guid currentUserId = currentUserIdVal.Value;

            var currentMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == currentUserId);
            Guid masterUserId = currentMapping != null ? currentMapping.MasterUserId : currentUserId;

            var masterUser = _userManager.GetUserById(masterUserId);
            if (masterUser == null) return NotFound("Master user not found.");

            RecordDeviceActivity();

            var remoteIp = HttpContext.Connection.RemoteIpAddress;
            bool isLocal = remoteIp != null && _networkManager.IsInLocalNetwork(remoteIp);

            var localMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterUserId);
            bool localHidesOthers = localMapping?.HideOthersSubProfilesFromMe ?? false;

            var linkedMasterIds = GetLinkedMasterUserIds(masterUserId, config);
            var profileList = new List<object>();

            foreach (var linkedId in linkedMasterIds)
            {
                var linkedUser = _userManager.GetUserById(linkedId);
                if (linkedUser == null) continue;

                var linkedMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == linkedId);
                bool masterRequiresPin = linkedMapping != null && !string.IsNullOrEmpty(linkedMapping.PinHash);
                if (isLocal && linkedMapping != null && linkedMapping.BypassPinOnLocalNetwork)
                {
                    masterRequiresPin = false;
                }

                profileList.Add(new
                {
                    ProfileUserId = linkedId,
                    ProfileName = linkedUser.Username,
                    AvatarInitial = string.IsNullOrEmpty(linkedUser.Username) ? "M" : linkedUser.Username.Substring(0, 1).ToUpper(),
                    AvatarColor = linkedMapping?.AvatarColor ?? "#00A4DC",
                    RequiresPin = masterRequiresPin,
                    IsMaster = true,
                    LockoutMinutes = linkedMapping?.LockoutMinutes ?? 5,
                    MaxSubProfiles = GetMaxProfilesForUser(linkedId, config),
                    BypassPinOnLocalNetwork = linkedMapping?.BypassPinOnLocalNetwork ?? false,
                    AllowedDeviceIds = linkedMapping?.AllowedDeviceIds ?? new List<string>(),
                    IsBonfire = (linkedId != masterUserId),
                    ProfileImage = linkedMapping?.ProfileImage,
                    MasterUserId = linkedId
                });

                bool shouldAddShadowProfiles = true;
                if (linkedId != masterUserId)
                {
                    bool linkedHidesOwn = linkedMapping?.HideMySubProfilesFromOthers ?? false;
                    if (localHidesOthers || linkedHidesOwn)
                    {
                        shouldAddShadowProfiles = false;
                    }
                }

                if (shouldAddShadowProfiles)
                {
                    // Add all shadow profiles for this master
                    var shadowProfiles = config.Mappings
                        .Where(m => m.MasterUserId == linkedId && m.ProfileUserId != linkedId)
                        .Select(m => {
                            bool requiresPin = !string.IsNullOrEmpty(m.PinHash);
                            if (isLocal && m.BypassPinOnLocalNetwork)
                            {
                                requiresPin = false;
                            }
                            return new
                            {
                                m.ProfileUserId,
                                m.ProfileName,
                                AvatarInitial = string.IsNullOrEmpty(m.ProfileName) ? "?" : m.ProfileName.Substring(0, 1).ToUpper(),
                                m.AvatarColor,
                                RequiresPin = requiresPin,
                                IsMaster = false,
                                m.LockoutMinutes,
                                EnabledFolders = m.EnabledFolders ?? new List<Guid>(),
                                BypassPinOnLocalNetwork = m.BypassPinOnLocalNetwork,
                                AllowedDeviceIds = m.AllowedDeviceIds ?? new List<string>(),
                                IsBonfire = (linkedId != masterUserId),
                                m.ProfileImage,
                                m.MasterUserId
                            };
                        });

                    profileList.AddRange(shadowProfiles);
                }
            }

            return Ok(profileList);
        }

        [HttpGet("libraries")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public ActionResult<IEnumerable<object>> GetLibraries()
        {
            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null)
            {
                return Unauthorized();
            }
            Guid currentUserId = currentUserIdVal.Value;

            var caller = _userManager.GetUserById(currentUserId);
            if (caller == null) return NotFound("Calling user not found.");

            var folders = _libraryManager.GetVirtualFolders();

            // Filter folders by caller's user policy
            var callerDto = _userManager.GetUserDto(caller, string.Empty);
            if (!callerDto.Policy.EnableAllFolders)
            {
                var enabled = callerDto.Policy.EnabledFolders ?? Array.Empty<Guid>();
                var blocked = callerDto.Policy.BlockedMediaFolders ?? Array.Empty<Guid>();
                folders = folders.Where(f => Guid.TryParse(f.ItemId, out var id) && enabled.Contains(id) && !blocked.Contains(id)).ToList();
            }

            var libraries = folders.Select(f => new
            {
                Id = f.ItemId,
                Name = f.Name,
                CollectionType = f.CollectionType
            });
            return Ok(libraries);
        }

        [HttpPost("create")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public async Task<ActionResult<object>> CreateProfile([FromBody] CreateProfileRequest request)
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null)
            {
                return Unauthorized();
            }
            Guid currentUserId = currentUserIdVal.Value;

            var currentMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == currentUserId);
            Guid masterUserId = currentMapping != null ? currentMapping.MasterUserId : currentUserId;

            if (currentUserId != masterUserId)
            {
                return Unauthorized("Only the master profile can manage profiles.");
            }

            // Verify Master PIN if required and master profile has a PIN
            if (config.RequireMasterPinForCreation)
            {
                var masterMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterUserId);
                if (masterMapping != null && !string.IsNullOrEmpty(masterMapping.PinHash))
                {
                    if (string.IsNullOrEmpty(request.MasterPin) || HashPin(request.MasterPin) != masterMapping.PinHash)
                    {
                        return BadRequest("Invalid Master PIN code.");
                    }
                }
            }

            var masterUser = _userManager.GetUserById(masterUserId);
            if (masterUser == null) return NotFound("Master user not found.");

            // Enforce max profiles limit
            var maxProfiles = GetMaxProfilesForUser(masterUserId, config);
            var existingCount = config.Mappings.Count(m => m.MasterUserId == masterUserId && m.ProfileUserId != masterUserId);
            if (existingCount >= maxProfiles)
            {
                return BadRequest($"Maximum profile limit of {maxProfiles} reached.");
            }

            // PIN validation (4-8 digits numeric)
            if (!string.IsNullOrEmpty(request.Pin))
            {
                if (request.Pin.Length < 4 || request.Pin.Length > 8 || !request.Pin.All(char.IsDigit))
                {
                    return BadRequest("PIN code must be a numeric value between 4 and 8 digits.");
                }
            }

            // Standardize username to avoid global collisions
            string systemUsername = $"{masterUser.Username}_{request.ProfileName.Replace(" ", "")}";

            // Ensure name uniqueness in system
            var existingUser = GetAllUsers().FirstOrDefault(u => string.Equals(u.Username, systemUsername, StringComparison.OrdinalIgnoreCase));
            if (existingUser != null)
            {
                return BadRequest("A profile with this name already exists.");
            }

            // Create system user
            var targetUser = await _userManager.CreateUserAsync(systemUsername).ConfigureAwait(false);

            // Set high-entropy random password to prevent direct password-based bypass logins
            string securePassword = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
            await ChangePasswordCompat(targetUser, securePassword).ConfigureAwait(false);

            // Fetch master user's details for inheritance
            var masterUserDto = _userManager.GetUserDto(masterUser, string.Empty);
            var masterPolicy = masterUserDto.Policy;
            var masterConfig = masterUserDto.Configuration;

            // Build target policy
            var targetPolicy = new UserPolicy();
            CopyUserPolicy(masterPolicy, targetPolicy);
            targetPolicy.IsAdministrator = false;
            targetPolicy.IsHidden = true;
            targetPolicy.IsDisabled = false;

            // Set parental rating limit (enforce parent rating if set)
            if (!string.IsNullOrEmpty(request.MaxParentalRating) && int.TryParse(request.MaxParentalRating, out var rating))
            {
                targetPolicy.MaxParentalRating = rating;
            }
            if (masterPolicy.MaxParentalRating.HasValue)
            {
                if (!targetPolicy.MaxParentalRating.HasValue || targetPolicy.MaxParentalRating.Value > masterPolicy.MaxParentalRating.Value)
                {
                    targetPolicy.MaxParentalRating = masterPolicy.MaxParentalRating.Value;
                }
            }

            // Library folder filtering (propagate master blocks)
            if (request.EnabledFolders != null)
            {
                targetPolicy.EnableAllFolders = false;
                targetPolicy.EnabledFolders = request.EnabledFolders.ToArray();

                var allFolders = _libraryManager.GetVirtualFolders();
                var blockedMediaFolders = allFolders
                    .Select(f => Guid.TryParse(f.ItemId, out var id) ? id : Guid.Empty)
                    .Where(id => id != Guid.Empty && !request.EnabledFolders.Contains(id))
                    .ToArray();

                var masterBlocked = masterPolicy.BlockedMediaFolders ?? Array.Empty<Guid>();
                targetPolicy.BlockedMediaFolders = blockedMediaFolders.Union(masterBlocked).ToArray();
            }
            else
            {
                // Inherit blocked libraries and folder accessibility from master user
                targetPolicy.EnableAllFolders = masterPolicy.EnableAllFolders;
                targetPolicy.EnabledFolders = masterPolicy.EnabledFolders;
                targetPolicy.BlockedMediaFolders = masterPolicy.BlockedMediaFolders;
            }

            // Clone general non-admin user configurations
            var targetConfig = new UserConfiguration
            {
                AudioLanguagePreference = masterConfig.AudioLanguagePreference,
                SubtitleLanguagePreference = masterConfig.SubtitleLanguagePreference,
                SubtitleMode = masterConfig.SubtitleMode,
                EnableLocalPassword = false
            };

            // Persist the policy and configuration settings to the database
            await _userManager.UpdatePolicyAsync(targetUser.Id, targetPolicy).ConfigureAwait(false);
            await _userManager.UpdateConfigurationAsync(targetUser.Id, targetConfig).ConfigureAwait(false);

            // Add new mapping entry
            lock (config)
            {
                config.Mappings.Add(new ProfileMapping
                {
                    ProfileUserId = targetUser.Id,
                    MasterUserId = masterUserId,
                    ProfileName = request.ProfileName,
                    PinHash = HashPin(request.Pin),
                    AvatarColor = request.AvatarColor,
                    IsHidden = true,
                    LockoutMinutes = request.LockoutMinutes ?? 5,
                    // Store the selected libraries as the plugin's own ground truth
                    EnabledFolders = request.EnabledFolders?.ToList() ?? new List<Guid>(),
                    BypassPinOnLocalNetwork = request.BypassPinOnLocalNetwork ?? false,
                    AllowedDeviceIds = request.AllowedDeviceIds ?? new List<string>(),
                    ProfileImage = SaveProfileImage(targetUser.Id, request.ProfileImage)
                });

                Plugin.Instance?.SaveConfiguration();
            }

            return Ok(new
            {
                ProfileUserId = targetUser.Id,
                ProfileName = request.ProfileName
            });
        }

        [HttpPost("delete")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult> DeleteProfile([FromBody] DeleteProfileRequest request)
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null)
            {
                return Unauthorized();
            }
            Guid currentUserId = currentUserIdVal.Value;

            var currentMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == currentUserId);
            Guid masterUserId = currentMapping != null ? currentMapping.MasterUserId : currentUserId;

            if (currentUserId != masterUserId)
            {
                return Unauthorized("Only the master profile can manage profiles.");
            }

            if (request.ProfileId == masterUserId)
            {
                return BadRequest("Cannot delete the master profile.");
            }

            // Verify Master PIN if master profile has a PIN
            var masterMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterUserId);
            if (masterMapping != null && !string.IsNullOrEmpty(masterMapping.PinHash))
            {
                if (string.IsNullOrEmpty(request.MasterPin) || HashPin(request.MasterPin) != masterMapping.PinHash)
                {
                    return BadRequest("Invalid Master PIN code.");
                }
            }

            var mapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == request.ProfileId);
            if (mapping == null) return NotFound("Profile not found.");

            // Verify mapping ownership
            if (mapping.MasterUserId != masterUserId)
            {
                return Unauthorized("Unauthorized profile deletion attempt.");
            }

            // Delete underlying native system user
            var targetUser = _userManager.GetUserById(request.ProfileId);
            if (targetUser != null)
            {
                await _userManager.DeleteUserAsync(targetUser.Id).ConfigureAwait(false);
            }

            // Clean up static profile image if any
            SaveProfileImage(request.ProfileId, null);

            lock (config)
            {
                var mappingToRemove = config.Mappings.FirstOrDefault(m => m.ProfileUserId == request.ProfileId);
                if (mappingToRemove != null)
                {
                    config.Mappings.Remove(mappingToRemove);
                    Plugin.Instance?.SaveConfiguration();
                }
            }

            return Ok();
        }

        [HttpPost("switch")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<object>> SwitchProfile([FromBody] SwitchProfileRequest request)
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            // Master user is always valid. If no mapping exists for master, check if request is master user ID.
            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null)
            {
                return Unauthorized();
            }
            Guid currentUserId = currentUserIdVal.Value;

            var currentMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == currentUserId);
            Guid callerMasterUserId = currentMapping != null ? currentMapping.MasterUserId : currentUserId;

            ProfileMapping? mapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == request.ProfileId);

            RecordDeviceActivity();

            var linkedMasterIds = GetLinkedMasterUserIds(callerMasterUserId, config);

            // Validate switch permissions: must belong to the same master user group or a linked Bonfire group.
            if (request.ProfileId == callerMasterUserId)
            {
                // Switching to own master profile is allowed
            }
            else if (linkedMasterIds.Contains(request.ProfileId))
            {
                // Switching to a linked master profile is allowed
            }
            else
            {
                if (mapping == null || !linkedMasterIds.Contains(mapping.MasterUserId))
                {
                    return Unauthorized("Unauthorized profile switch attempt.");
                }
            }

            // Enforce device restrictions for sub-profiles
            if (mapping != null && mapping.ProfileUserId != mapping.MasterUserId && mapping.AllowedDeviceIds != null && mapping.AllowedDeviceIds.Count > 0)
            {
                var targetDeviceId = GetAuthorizationParameter("DeviceId");
                if (string.IsNullOrEmpty(targetDeviceId) || !mapping.AllowedDeviceIds.Any(id => string.Equals(id, targetDeviceId, StringComparison.OrdinalIgnoreCase)))
                {
                    return BadRequest("This profile is not allowed on this device.");
                }
            }

            var remoteIp = HttpContext.Connection.RemoteIpAddress;
            bool isLocal = remoteIp != null && _networkManager.IsInLocalNetwork(remoteIp);
            var ip = remoteIp?.ToString() ?? "127.0.0.1";

            // Verify PIN if set
            var pinHashToCheck = mapping?.PinHash;
            if (!string.IsNullOrEmpty(pinHashToCheck))
            {
                bool bypass = mapping != null && mapping.BypassPinOnLocalNetwork && isLocal;
                if (!bypass)
                {
                    if (PinRateLimiter.IsRateLimited(ip))
                    {
                        return StatusCode(StatusCodes.Status429TooManyRequests, "Too many failed PIN attempts. Please try again in 15 minutes.");
                    }

                    var inputHash = HashPin(request.Pin);
                    if (pinHashToCheck != inputHash)
                    {
                        PinRateLimiter.RecordFailure(ip);
                        return BadRequest("Invalid PIN code.");
                    }
                }
            }

            PinRateLimiter.Reset(ip);

            var targetUser = _userManager.GetUserById(request.ProfileId);
            if (targetUser == null) return NotFound("Underlying system user missing.");

            // Inherit/synchronize streaming policies and configurations from master user dynamically during switch
            var targetMasterUserId = mapping != null ? mapping.MasterUserId : request.ProfileId;
            var masterUser = _userManager.GetUserById(targetMasterUserId);
            if (masterUser != null && targetUser.Id != callerMasterUserId)
            {
                var masterUserDto = _userManager.GetUserDto(masterUser, string.Empty);
                var masterPolicy = masterUserDto.Policy;

                var targetUserDto = _userManager.GetUserDto(targetUser, string.Empty);
                var targetPolicy = targetUserDto.Policy;

                // Sync streaming, transcoding, and bitrate policies
                var childMaxParentalRating = targetPolicy.MaxParentalRating;
                var childBlockedFolders = targetPolicy.BlockedMediaFolders;
                var childEnableAllFolders = targetPolicy.EnableAllFolders;
                var childEnabledFolders = targetPolicy.EnabledFolders;

                CopyUserPolicy(masterPolicy, targetPolicy);

                // Restore child-specific overrides
                targetPolicy.IsAdministrator = false;
                targetPolicy.IsHidden = true;
                targetPolicy.IsDisabled = false;
                targetPolicy.MaxParentalRating = childMaxParentalRating;

                // Determine the authoritative enabled-folder list:
                //  - If the plugin mapping has a stored list (EnabledFolders != null), use it as ground truth.
                //    This survives Jellyfin restarts that reset user policies.
                //  - If EnabledFolders is null (profile predates this field), fall back to the Jellyfin policy
                //    and auto-migrate by saving the list into the mapping now.
                List<Guid> authorityFolders;
                if (mapping?.EnabledFolders != null)
                {
                    authorityFolders = mapping.EnabledFolders;
                }
                else
                {
                    // Legacy profile: read from Jellyfin policy and migrate
                    var legacyEnabled = childEnableAllFolders
                        ? (masterPolicy.EnabledFolders ?? Array.Empty<Guid>()).ToList()
                        : (childEnabledFolders ?? Array.Empty<Guid>()).ToList();

                    // If still empty, derive from BlockedMediaFolders
                    if (legacyEnabled.Count == 0 && childBlockedFolders != null && childBlockedFolders.Length > 0)
                    {
                        var allFolderIds = _libraryManager.GetVirtualFolders()
                            .Select(f => Guid.TryParse(f.ItemId, out var fid) ? fid : Guid.Empty)
                            .Where(fid => fid != Guid.Empty)
                            .ToList();
                        legacyEnabled = allFolderIds.Where(fid => !childBlockedFolders.Contains(fid)).ToList();
                    }

                    authorityFolders = legacyEnabled;

                    // Persist the migration so we never need this fallback again
                    if (mapping != null)
                    {
                        lock (config)
                        {
                            mapping.EnabledFolders = authorityFolders;
                            Plugin.Instance?.SaveConfiguration();
                        }
                    }
                }

                // Re-apply the stored library policy (heals resets caused by Jellyfin restarts)
                targetPolicy.EnableAllFolders = false;
                targetPolicy.EnabledFolders = authorityFolders.ToArray();

                var allFolders2 = _libraryManager.GetVirtualFolders();
                var reapplyBlocked = allFolders2
                    .Select(f => Guid.TryParse(f.ItemId, out var id2) ? id2 : Guid.Empty)
                    .Where(id2 => id2 != Guid.Empty && !authorityFolders.Contains(id2))
                    .ToArray();
                var masterBlocked2 = masterPolicy.BlockedMediaFolders ?? Array.Empty<Guid>();
                targetPolicy.BlockedMediaFolders = reapplyBlocked.Union(masterBlocked2).ToArray();

                await _userManager.UpdatePolicyAsync(targetUser.Id, targetPolicy).ConfigureAwait(false);

                // Sync basic configuration settings (language settings, subtitles preference)
                var masterConfig = masterUserDto.Configuration;
                var targetConfig = targetUserDto.Configuration;
                targetConfig.AudioLanguagePreference = masterConfig.AudioLanguagePreference;
                targetConfig.SubtitleLanguagePreference = masterConfig.SubtitleLanguagePreference;
                targetConfig.SubtitleMode = masterConfig.SubtitleMode;

                await _userManager.UpdateConfigurationAsync(targetUser.Id, targetConfig).ConfigureAwait(false);
            }

            var authRequest = new AuthenticationRequest
            {
                Username = targetUser.Username,
                RemoteEndPoint = HttpContext.Connection.RemoteIpAddress?.ToString() ?? "127.0.0.1"
            };

            // Propagate client/device identifiers to SessionManager to avoid ArgumentNullException in LogSessionActivity
            var client = GetAuthorizationParameter("Client");
            var device = GetAuthorizationParameter("Device");
            var deviceId = GetAuthorizationParameter("DeviceId");
            var version = GetAuthorizationParameter("Version");

            if (!string.IsNullOrEmpty(client)) authRequest.App = client;
            if (!string.IsNullOrEmpty(device)) authRequest.DeviceName = device;
            if (!string.IsNullOrEmpty(deviceId)) authRequest.DeviceId = deviceId;
            if (!string.IsNullOrEmpty(version)) authRequest.AppVersion = version;
            // Authenticate directly bypassing password check (securely validated caller + PIN validation)
            var session = await _sessionManager.AuthenticateDirect(authRequest).ConfigureAwait(false);

            // Record profile switch audit log
            RecordAuditLog(masterUser?.Username ?? "Unknown", targetUser.Username);

            return Ok(new
            {
                ActiveProfileToken = session.AccessToken,
                JellyfinUserId = targetUser.Id
            });
        }

        [HttpPost("verify-pin")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult VerifyPin([FromBody] SwitchProfileRequest request)
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null)
            {
                return Unauthorized();
            }
            Guid currentUserId = currentUserIdVal.Value;

            var currentMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == currentUserId);
            Guid callerMasterUserId = currentMapping != null ? currentMapping.MasterUserId : currentUserId;

            var linkedMasterIds = GetLinkedMasterUserIds(callerMasterUserId, config);

            // Enforce device restrictions for sub-profiles
            var mapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == request.ProfileId);
            if (mapping != null && mapping.ProfileUserId != mapping.MasterUserId && mapping.AllowedDeviceIds != null && mapping.AllowedDeviceIds.Count > 0)
            {
                var deviceId = GetAuthorizationParameter("DeviceId");
                if (string.IsNullOrEmpty(deviceId) || !mapping.AllowedDeviceIds.Any(id => string.Equals(id, deviceId, StringComparison.OrdinalIgnoreCase)))
                {
                    return BadRequest("This profile is not allowed on this device.");
                }
            }

            var remoteIp = HttpContext.Connection.RemoteIpAddress;
            bool isLocal = remoteIp != null && _networkManager.IsInLocalNetwork(remoteIp);
            var ip = remoteIp?.ToString() ?? "127.0.0.1";

            if (linkedMasterIds.Contains(request.ProfileId))
            {
                // Verify master PIN
                var masterMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == request.ProfileId);
                var pinHash = masterMapping?.PinHash;
                if (!string.IsNullOrEmpty(pinHash))
                {
                    bool bypass = masterMapping != null && masterMapping.BypassPinOnLocalNetwork && isLocal;
                    if (!bypass)
                    {
                        if (PinRateLimiter.IsRateLimited(ip))
                        {
                            return StatusCode(StatusCodes.Status429TooManyRequests, "Too many failed PIN attempts. Please try again in 15 minutes.");
                        }

                        if (string.IsNullOrEmpty(request.Pin) || HashPin(request.Pin) != pinHash)
                        {
                            PinRateLimiter.RecordFailure(ip);
                            return BadRequest("Invalid PIN.");
                        }
                    }
                }
                PinRateLimiter.Reset(ip);
                return Ok();
            }
            else
            {
                if (mapping == null || !linkedMasterIds.Contains(mapping.MasterUserId))
                {
                    return Unauthorized("Unauthorized profile PIN verification.");
                }
                var pinHash = mapping.PinHash;
                if (!string.IsNullOrEmpty(pinHash))
                {
                    bool bypass = mapping.BypassPinOnLocalNetwork && isLocal;
                    if (!bypass)
                    {
                        if (PinRateLimiter.IsRateLimited(ip))
                        {
                            return StatusCode(StatusCodes.Status429TooManyRequests, "Too many failed PIN attempts. Please try again in 15 minutes.");
                        }

                        if (string.IsNullOrEmpty(request.Pin) || HashPin(request.Pin) != pinHash)
                        {
                            PinRateLimiter.RecordFailure(ip);
                            return BadRequest("Invalid PIN.");
                        }
                    }
                }
                PinRateLimiter.Reset(ip);
                return Ok();
            }
        }

        [HttpGet("admin/mappings")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult<object> GetAdminMappings()
        {
            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();

            var caller = _userManager.GetUserById(currentUserIdVal.Value);
            if (caller == null) return Unauthorized();

            var callerDto = _userManager.GetUserDto(caller, string.Empty);
            if (!callerDto.Policy.IsAdministrator)
            {
                return Unauthorized("Only administrators can view all mappings.");
            }

            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var subProfileIds = config.Mappings
                .Where(m => m.ProfileUserId != m.MasterUserId)
                .Select(m => m.ProfileUserId)
                .ToHashSet();

            var masterUsersList = new List<object>();
            var subProfilesList = new List<object>();

            var allUsers = GetAllUsers().ToList();
            foreach (var user in allUsers)
            {
                if (subProfileIds.Contains(user.Id))
                {
                    var mapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == user.Id);
                    var masterUser = mapping != null ? _userManager.GetUserById(mapping.MasterUserId) : null;
                    subProfilesList.Add(new
                    {
                        ProfileUserId = user.Id,
                        ProfileName = mapping?.ProfileName ?? user.Username,
                        MasterName = masterUser?.Username ?? "Unknown",
                        RequiresPin = mapping != null && !string.IsNullOrEmpty(mapping.PinHash)
                    });
                }
                else
                {
                    var mapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == user.Id);
                    var limitOverride = config.UserProfileLimitOverrides?.FirstOrDefault(o => o.UserId == user.Id)?.MaxProfiles;
                    masterUsersList.Add(new
                    {
                        ProfileUserId = user.Id,
                        ProfileName = user.Username,
                        RequiresPin = mapping != null && !string.IsNullOrEmpty(mapping.PinHash),
                        MaxProfiles = GetMaxProfilesForUser(user.Id, config),
                        LimitOverride = limitOverride
                    });
                }
            }

            return Ok(new
            {
                MasterUsers = masterUsersList,
                SubProfiles = subProfilesList
            });
        }

        [HttpPost("admin/reset-pin")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public ActionResult ResetPinAdmin([FromBody] DeleteProfileRequest request)
        {
            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();

            var caller = _userManager.GetUserById(currentUserIdVal.Value);
            if (caller == null) return Unauthorized();

            var callerDto = _userManager.GetUserDto(caller, string.Empty);
            if (!callerDto.Policy.IsAdministrator)
            {
                return Unauthorized("Only administrators can reset PINs.");
            }

            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            lock (config)
            {
                var mapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == request.ProfileId);
                if (mapping == null) return NotFound("Profile mapping not found.");

                mapping.PinHash = string.Empty;
                Plugin.Instance?.SaveConfiguration();
            }

            return Ok();
        }



        [HttpPost("update")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult> UpdateProfile([FromBody] UpdateProfileRequest request)
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null)
            {
                return Unauthorized();
            }
            Guid currentUserId = currentUserIdVal.Value;

            var currentMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == currentUserId);
            Guid masterUserId = currentMapping != null ? currentMapping.MasterUserId : currentUserId;

            if (currentUserId != masterUserId)
            {
                return Unauthorized("Only the master profile can manage profiles.");
            }

            // Verify Master PIN if master profile has a PIN
            var masterMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterUserId);
            if (masterMapping != null && !string.IsNullOrEmpty(masterMapping.PinHash))
            {
                if (string.IsNullOrEmpty(request.MasterPin) || HashPin(request.MasterPin) != masterMapping.PinHash)
                {
                    return BadRequest("Invalid Master PIN code.");
                }
            }

            // Enforce ownership: the profile being edited must belong to the caller's master account.
            if (request.ProfileId != masterUserId)
            {
                var mapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == request.ProfileId);
                if (mapping == null || mapping.MasterUserId != masterUserId)
                {
                    return Unauthorized("Unauthorized profile update attempt.");
                }
            }

            // PIN validation (4-8 digits numeric if provided)
            if (!string.IsNullOrEmpty(request.Pin))
            {
                if (request.Pin.Length < 4 || request.Pin.Length > 8 || !request.Pin.All(char.IsDigit))
                {
                    return BadRequest("PIN code must be a numeric value between 4 and 8 digits.");
                }
            }

            var targetUser = _userManager.GetUserById(request.ProfileId);
            if (targetUser == null) return NotFound("Target user not found.");

            var masterUser = _userManager.GetUserById(masterUserId);
            if (masterUser == null) return NotFound("Master user not found.");
            
            var masterUserDto = _userManager.GetUserDto(masterUser, string.Empty);
            var masterPolicy = masterUserDto.Policy;

            // Renaming logic
            if (request.ProfileId != masterUserId)
            {
                string systemUsername = $"{masterUser.Username}_{request.ProfileName.Replace(" ", "")}";
                if (!string.Equals(targetUser.Username, systemUsername, StringComparison.OrdinalIgnoreCase))
                {
                    var existingUser = GetAllUsers().FirstOrDefault(u => string.Equals(u.Username, systemUsername, StringComparison.OrdinalIgnoreCase));
                    if (existingUser != null)
                    {
                        return BadRequest("A profile with this name already exists.");
                    }
                    targetUser.Username = systemUsername;
                    await _userManager.UpdateUserAsync(targetUser).ConfigureAwait(false);
                }
            }

            // Update policy for sub-profiles
            if (request.ProfileId != masterUserId)
            {
                var targetUserDto = _userManager.GetUserDto(targetUser, string.Empty);
                var targetPolicy = targetUserDto.Policy;

                // Set parental rating
                if (!string.IsNullOrEmpty(request.MaxParentalRating) && int.TryParse(request.MaxParentalRating, out var rating))
                {
                    targetPolicy.MaxParentalRating = rating;
                }
                else
                {
                    targetPolicy.MaxParentalRating = null;
                }

                if (masterPolicy.MaxParentalRating.HasValue)
                {
                    if (!targetPolicy.MaxParentalRating.HasValue || targetPolicy.MaxParentalRating.Value > masterPolicy.MaxParentalRating.Value)
                    {
                        targetPolicy.MaxParentalRating = masterPolicy.MaxParentalRating.Value;
                    }
                }

                // Library access propagation
                if (request.EnabledFolders != null)
                {
                    targetPolicy.EnableAllFolders = false;
                    targetPolicy.EnabledFolders = request.EnabledFolders.ToArray();

                    var allFolders = _libraryManager.GetVirtualFolders();
                    var blockedMediaFolders = allFolders
                        .Select(f => Guid.TryParse(f.ItemId, out var id) ? id : Guid.Empty)
                        .Where(id => id != Guid.Empty && !request.EnabledFolders.Contains(id))
                        .ToArray();

                    var masterBlocked = masterPolicy.BlockedMediaFolders ?? Array.Empty<Guid>();
                    targetPolicy.BlockedMediaFolders = blockedMediaFolders.Union(masterBlocked).ToArray();
                }
                else
                {
                    targetPolicy.EnableAllFolders = masterPolicy.EnableAllFolders;
                    targetPolicy.EnabledFolders = masterPolicy.EnabledFolders;
                    targetPolicy.BlockedMediaFolders = masterPolicy.BlockedMediaFolders;
                }

                await _userManager.UpdatePolicyAsync(targetUser.Id, targetPolicy).ConfigureAwait(false);
            }

            lock (config)
            {
                // Fetch or create mapping for this profile inside the lock
                var mappingEntry = config.Mappings.FirstOrDefault(m => m.ProfileUserId == request.ProfileId);
                if (mappingEntry == null && request.ProfileId == masterUserId)
                {
                    mappingEntry = new ProfileMapping
                    {
                        ProfileUserId = masterUserId,
                        MasterUserId = masterUserId,
                        ProfileName = masterUser.Username,
                        IsHidden = false
                    };
                    config.Mappings.Add(mappingEntry);
                }

                if (mappingEntry != null)
                {
                    // Update basic mapping properties (only for sub-profiles; master name is read-only)
                    if (request.ProfileId != masterUserId)
                    {
                        mappingEntry.ProfileName = request.ProfileName;
                    }

                    mappingEntry.AvatarColor = request.AvatarColor;

                    if (request.ProfileImage != null)
                    {
                        mappingEntry.ProfileImage = SaveProfileImage(request.ProfileId, request.ProfileImage);
                    }

                    // Handle PIN updates
                    if (request.Pin == string.Empty)
                    {
                        mappingEntry.PinHash = string.Empty;
                    }
                    else if (request.Pin != null)
                    {
                        mappingEntry.PinHash = HashPin(request.Pin);
                    }

                    // Handle lockout timer update
                    if (request.LockoutMinutes.HasValue)
                    {
                        mappingEntry.LockoutMinutes = request.LockoutMinutes.Value;
                    }

                    // Update stored library list (plugin's ground truth)
                    if (request.EnabledFolders != null)
                    {
                        mappingEntry.EnabledFolders = request.EnabledFolders.ToList();
                    }

                    if (request.BypassPinOnLocalNetwork.HasValue)
                    {
                        mappingEntry.BypassPinOnLocalNetwork = request.BypassPinOnLocalNetwork.Value;
                    }

                    if (request.AllowedDeviceIds != null)
                    {
                        mappingEntry.AllowedDeviceIds = request.AllowedDeviceIds;
                    }
                }

                Plugin.Instance?.SaveConfiguration();
            }

            return Ok();
        }

        [HttpGet("profiles.js")]
        [AllowAnonymous]
        [Produces("application/javascript")]
        public ActionResult GetProfilesJs()
        {
            var assembly = typeof(Plugin).Assembly;
            using var stream = assembly.GetManifestResourceStream("Jellyfin.Profiles.Web.profiles.js");
            if (stream == null) return NotFound();

            using var reader = new StreamReader(stream);
            var content = reader.ReadToEnd();
            return Content(content, "application/javascript");
        }

        private Guid? GetCurrentUserId()
        {
            var claim = User?.FindFirst("Jellyfin-UserId") ?? User?.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier);
            if (claim == null)
            {
                _logger.LogWarning("ProfilesPlugin: User ID claim not found in User principal.");
                return null;
            }

            if (!Guid.TryParse(claim.Value, out var userId))
            {
                _logger.LogWarning("ProfilesPlugin: Failed to parse User ID claim value '{Value}' as Guid.", claim.Value);
                return null;
            }

            return userId;
        }

        // ── Cross-version compatibility helpers ──────────────────────────────────
        // IUserManager.Users (property) was renamed to GetUsers() (method) in 10.11.7.
        // IUserManager.ChangePassword(User, string) became ChangePassword(Guid, string) in 10.11.7.
        // We compile against 10.11.6 and use reflection to call the newer signature at runtime
        // when the server is running 10.11.7+, so that a single DLL works across all 10.11.x.

        private IEnumerable<Jellyfin.Database.Implementations.Entities.User> GetAllUsers()
        {
            var mgr = _userManager;
            var type = mgr.GetType();

            // 10.11.7+ exposes GetUsers() as a method.
            var method = type.GetMethod("GetUsers", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance);
            if (method != null)
            {
                try
                {
                    return (IEnumerable<Jellyfin.Database.Implementations.Entities.User>)method.Invoke(mgr, null)!;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "ProfilesPlugin: GetUsers() reflection call failed, falling back to Users property.");
                }
            }

            // 10.11.0–10.11.6 exposes Users as a property.
            var prop = type.GetProperty("Users", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance);
            if (prop != null)
            {
                return (IEnumerable<Jellyfin.Database.Implementations.Entities.User>)prop.GetValue(mgr)!;
            }

            _logger.LogError("ProfilesPlugin: Could not resolve user list from IUserManager on this server version.");
            return Enumerable.Empty<Jellyfin.Database.Implementations.Entities.User>();
        }

        private Task ChangePasswordCompat(Jellyfin.Database.Implementations.Entities.User user, string newPassword)
        {
            var mgr = _userManager;
            var type = mgr.GetType();

            // 10.11.7+: ChangePassword(Guid userId, string newPassword)
            var methodByGuid = type.GetMethod("ChangePassword", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance,
                null, new[] { typeof(Guid), typeof(string) }, null);
            if (methodByGuid != null)
            {
                return (Task)methodByGuid.Invoke(mgr, new object[] { user.Id, newPassword })!;
            }

            // 10.11.0–10.11.6: ChangePassword(User user, string newPassword)
            var methodByUser = type.GetMethod("ChangePassword", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance,
                null, new[] { user.GetType(), typeof(string) }, null);
            if (methodByUser != null)
            {
                return (Task)methodByUser.Invoke(mgr, new object[] { user, newPassword })!;
            }

            _logger.LogError("ProfilesPlugin: Could not resolve ChangePassword on IUserManager for this server version.");
            return Task.CompletedTask;
        }

        private string HashPin(string? pin)
        {
            if (string.IsNullOrEmpty(pin)) return string.Empty;
            using var sha256 = SHA256.Create();
            var bytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(pin));
            return Convert.ToHexString(bytes);
        }

        private string? GetAuthorizationParameter(string name)
        {
            var header = Request.Headers["Authorization"].FirstOrDefault() 
                         ?? Request.Headers["X-Emby-Authorization"].FirstOrDefault();
            
            if (string.IsNullOrEmpty(header)) return null;

            var pattern = $"{name}=\"([^\"]*)\"";
            var match = System.Text.RegularExpressions.Regex.Match(header, pattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (match.Success)
            {
                return match.Groups[1].Value;
            }
            return null;
        }

        private void CopyUserPolicy(UserPolicy source, UserPolicy destination)
        {
            foreach (var prop in typeof(UserPolicy).GetProperties(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
            {
                if (prop.CanRead && prop.CanWrite)
                {
                    // Skip Administrator and Hidden/Disabled flags to prevent escalations or errors
                    if (prop.Name == "IsAdministrator" || prop.Name == "IsHidden" || prop.Name == "IsDisabled")
                    {
                        continue;
                    }
                    var val = prop.GetValue(source);
                    prop.SetValue(destination, val);
                }
            }
        }

        // ── Device Log & Restrictions Endpoints ──────────────────────────────────

        private void RecordDeviceActivity()
        {
            var deviceId = GetAuthorizationParameter("DeviceId");
            var deviceName = GetAuthorizationParameter("Device");
            var client = GetAuthorizationParameter("Client");

            if (string.IsNullOrEmpty(deviceId)) return;

            var config = Plugin.Instance?.Configuration;
            if (config == null) return;

            lock (config)
            {
                var existing = config.KnownDevices.FirstOrDefault(d => string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));
                bool shouldSave = false;
                if (existing != null)
                {
                    if (deviceName != null && existing.DeviceName != deviceName)
                    {
                        existing.DeviceName = deviceName;
                        shouldSave = true;
                    }
                    if (client != null && existing.Client != client)
                    {
                        existing.Client = client;
                        shouldSave = true;
                    }
                    var now = DateTime.UtcNow;
                    if ((now - existing.LastSeen).TotalMinutes >= 15)
                    {
                        existing.LastSeen = now;
                        shouldSave = true;
                    }
                }
                else
                {
                    config.KnownDevices.Add(new KnownDevice
                    {
                        DeviceId = deviceId,
                        DeviceName = deviceName ?? "Unknown Device",
                        Client = client ?? "Unknown Client",
                        LastSeen = DateTime.UtcNow
                    });
                    shouldSave = true;
                }

                if (shouldSave)
                {
                    Plugin.Instance?.SaveConfiguration();
                }
            }
        }

        [HttpGet("devices")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult<IEnumerable<KnownDevice>> GetDevices()
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();

            var devices = config.KnownDevices
                .GroupBy(d => d.DeviceId, StringComparer.OrdinalIgnoreCase)
                .Select(g => g.OrderByDescending(d => d.LastSeen).First())
                .OrderByDescending(d => d.LastSeen)
                .ToList();
            return Ok(devices);
        }

        public class DeleteDeviceRequest
        {
            public string DeviceId { get; set; } = string.Empty;
        }

        [HttpPost("devices/delete")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult DeleteDevice([FromBody] DeleteDeviceRequest request)
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();
            Guid masterId = currentUserIdVal.Value;

            var currentMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterId);
            if (currentMapping != null && currentMapping.MasterUserId != masterId)
            {
                return Unauthorized("Only the master profile can delete devices.");
            }

            if (string.IsNullOrEmpty(request.DeviceId))
            {
                return BadRequest("DeviceId is required.");
            }

            lock (config)
            {
                var matchingDevices = config.KnownDevices
                    .Where(d => string.Equals(d.DeviceId, request.DeviceId, StringComparison.OrdinalIgnoreCase))
                    .ToList();
                foreach (var d in matchingDevices)
                {
                    config.KnownDevices.Remove(d);
                }

                // Remove it from any profile's allowed list
                foreach (var mapping in config.Mappings)
                {
                    if (mapping.AllowedDeviceIds != null)
                    {
                        mapping.AllowedDeviceIds.RemoveAll(id => string.Equals(id, request.DeviceId, StringComparison.OrdinalIgnoreCase));
                    }
                }

                Plugin.Instance?.SaveConfiguration();
            }

            return Ok();
        }

        // ── Bonfire Codes (Plex Home Style Grouping) ──────────────────────────────

        private HashSet<Guid> GetLinkedMasterUserIds(Guid masterUserId, PluginConfiguration config)
        {
            var linkedMasterIds = new HashSet<Guid> { masterUserId };

            var ownedGroups = config.BonfireGroups.Where(g => g.OwnerUserId == masterUserId);
            foreach (var g in ownedGroups)
            {
                foreach (var memberId in g.MemberUserIds)
                {
                    linkedMasterIds.Add(memberId);
                }
            }

            var memberGroups = config.BonfireGroups.Where(g => g.MemberUserIds.Contains(masterUserId));
            foreach (var g in memberGroups)
            {
                linkedMasterIds.Add(g.OwnerUserId);
                foreach (var memberId in g.MemberUserIds)
                {
                    linkedMasterIds.Add(memberId);
                }
            }

            return linkedMasterIds;
        }

        private string GenerateSecureCode()
        {
            const string chars = "ABCDEFGHJKLMNOPQRSTUVWXYZ23456789";
            var bytes = new byte[6];
            using (var rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }
            var result = new char[6];
            for (int i = 0; i < 6; i++)
            {
                result[i] = chars[bytes[i] % chars.Length];
            }
            return new string(result);
        }

        private List<object> GetBonfireGroupMembers(BonfireGroup group, PluginConfiguration config)
        {
            var list = new List<object>();
            foreach (var memberId in group.MemberUserIds)
            {
                var user = _userManager.GetUserById(memberId);
                list.Add(new
                {
                    UserId = memberId,
                    Username = user?.Username ?? "Unknown User"
                });
            }
            return list;
        }

        [HttpGet("bonfire/status")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult<object> GetBonfireStatus()
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();
            Guid masterUserId = currentUserIdVal.Value;

            var currentMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterUserId);
            Guid masterId = currentMapping != null ? currentMapping.MasterUserId : masterUserId;

            var ownedGroup = config.BonfireGroups.FirstOrDefault(g => g.OwnerUserId == masterId);
            var joinedGroup = config.BonfireGroups.FirstOrDefault(g => g.MemberUserIds.Contains(masterId));
            var masterMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterId);

            return Ok(new
            {
                IsOwner = ownedGroup != null,
                OwnedCode = ownedGroup?.BonfireCode,
                OwnedMembers = ownedGroup != null ? GetBonfireGroupMembers(ownedGroup, config) : null,
                IsMember = joinedGroup != null,
                JoinedOwnerName = joinedGroup != null ? (_userManager.GetUserById(joinedGroup.OwnerUserId)?.Username ?? "Unknown") : null,
                JoinedOwnerId = joinedGroup?.OwnerUserId,
                HideMySubProfilesFromOthers = masterMapping?.HideMySubProfilesFromOthers ?? false,
                HideOthersSubProfilesFromMe = masterMapping?.HideOthersSubProfilesFromMe ?? false
            });
        }

        [HttpPost("bonfire/generate")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult<object> GenerateBonfireCode()
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();
            Guid masterUserId = currentUserIdVal.Value;

            var currentMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterUserId);
            if (currentMapping != null && currentMapping.MasterUserId != masterUserId)
            {
                return Unauthorized("Only the master profile can manage Bonfire groups.");
            }

            string groupId;
            string bonfireCode;
            List<object> members;

            lock (config)
            {
                var group = config.BonfireGroups.FirstOrDefault(g => g.OwnerUserId == masterUserId);
                if (group == null)
                {
                    group = new BonfireGroup
                    {
                        OwnerUserId = masterUserId,
                        BonfireCode = GenerateSecureCode()
                    };
                    config.BonfireGroups.Add(group);
                }
                else if (string.IsNullOrEmpty(group.BonfireCode))
                {
                    group.BonfireCode = GenerateSecureCode();
                }

                Plugin.Instance?.SaveConfiguration();

                groupId = group.GroupId;
                bonfireCode = group.BonfireCode;
                members = GetBonfireGroupMembers(group, config);
            }

            return Ok(new
            {
                GroupId = groupId,
                BonfireCode = bonfireCode,
                Members = members
            });
        }

        public class JoinBonfireRequest
        {
            public string Code { get; set; } = string.Empty;
        }

        [HttpPost("bonfire/join")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult JoinBonfire([FromBody] JoinBonfireRequest request)
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();
            Guid masterUserId = currentUserIdVal.Value;

            var currentMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterUserId);
            Guid masterId = currentMapping != null ? currentMapping.MasterUserId : masterUserId;

            if (currentMapping != null && currentMapping.MasterUserId != masterUserId)
            {
                return Unauthorized("Only the master profile can join Bonfire groups.");
            }

            var ip = HttpContext.Connection.RemoteIpAddress?.ToString() ?? "127.0.0.1";
            if (BonfireRateLimiter.IsRateLimited(ip))
            {
                return StatusCode(StatusCodes.Status429TooManyRequests, "Too many failed attempts. Please try again in 15 minutes.");
            }

            var code = request.Code?.Trim().ToUpperInvariant();
            if (string.IsNullOrEmpty(code) || code.Length != 6)
            {
                BonfireRateLimiter.RecordFailure(ip);
                return BadRequest("Invalid code format.");
            }

            Guid ownerUserId;
            bool newlyJoined = false;

            lock (config)
            {
                var group = config.BonfireGroups.FirstOrDefault(g => g.BonfireCode == code);
                if (group == null)
                {
                    BonfireRateLimiter.RecordFailure(ip);
                    return BadRequest("Invalid Bonfire Code.");
                }

                if (group.OwnerUserId == masterId)
                {
                    return BadRequest("You cannot join your own Bonfire group.");
                }

                if (group.MemberUserIds.Contains(masterId))
                {
                    return Ok(new { Message = "Already a member of this group." });
                }

                // Remove user from any existing bonfire groups they joined
                foreach (var g in config.BonfireGroups)
                {
                    if (g.MemberUserIds.Contains(masterId))
                    {
                        g.MemberUserIds.Remove(masterId);
                    }
                }

                group.MemberUserIds.Add(masterId);
                Plugin.Instance?.SaveConfiguration();

                ownerUserId = group.OwnerUserId;
                newlyJoined = true;
            }

            if (newlyJoined)
            {
                BonfireRateLimiter.Reset(ip);
            }

            return Ok(new
            {
                Message = "Successfully joined Bonfire group.",
                OwnerName = _userManager.GetUserById(ownerUserId)?.Username ?? "Unknown"
            });
        }

        public class KickBonfireRequest
        {
            public Guid MemberId { get; set; }
        }

        [HttpPost("bonfire/kick")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult KickBonfireMember([FromBody] KickBonfireRequest request)
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();
            Guid masterId = currentUserIdVal.Value;

            var callerMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterId);
            if (callerMapping != null && callerMapping.MasterUserId != masterId)
            {
                return Unauthorized("Only the master profile can manage Bonfire groups.");
            }

            lock (config)
            {
                var group = config.BonfireGroups.FirstOrDefault(g => g.OwnerUserId == masterId);
                if (group == null)
                {
                    return BadRequest("You do not own a Bonfire group.");
                }

                if (group.MemberUserIds.Contains(request.MemberId))
                {
                    group.MemberUserIds.Remove(request.MemberId);
                    Plugin.Instance?.SaveConfiguration();
                    return Ok();
                }
            }

            return NotFound("Member not found in your Bonfire group.");
        }

        [HttpPost("bonfire/leave")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult LeaveBonfire()
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();
            Guid masterId = currentUserIdVal.Value;

            lock (config)
            {
                var joinedGroup = config.BonfireGroups.FirstOrDefault(g => g.MemberUserIds.Contains(masterId));
                if (joinedGroup != null)
                {
                    joinedGroup.MemberUserIds.Remove(masterId);
                    Plugin.Instance?.SaveConfiguration();
                    return Ok();
                }
            }

            return BadRequest("You are not in any Bonfire group.");
        }

        [HttpPost("bonfire/delete-group")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult DeleteBonfireGroup()
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();
            Guid masterId = currentUserIdVal.Value;

            lock (config)
            {
                var group = config.BonfireGroups.FirstOrDefault(g => g.OwnerUserId == masterId);
                if (group != null)
                {
                    config.BonfireGroups.Remove(group);
                    Plugin.Instance?.SaveConfiguration();
                    return Ok();
                }
            }

            return BadRequest("You do not own a Bonfire group.");
        }

        [HttpPost("bonfire/settings")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult UpdateBonfireSettings([FromBody] UpdateBonfireSettingsRequest request)
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();
            Guid masterUserId = currentUserIdVal.Value;

            var currentMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterUserId);
            if (currentMapping != null && currentMapping.MasterUserId != masterUserId)
            {
                return Unauthorized("Only the master profile can update Bonfire settings.");
            }

            lock (config)
            {
                var masterMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterUserId);
                if (masterMapping == null)
                {
                    masterMapping = new ProfileMapping
                    {
                        ProfileUserId = masterUserId,
                        MasterUserId = masterUserId,
                        ProfileName = _userManager.GetUserById(masterUserId)?.Username ?? "Master",
                        IsHidden = false
                    };
                    config.Mappings.Add(masterMapping);
                }

                masterMapping.HideMySubProfilesFromOthers = request.HideMySubProfilesFromOthers;
                masterMapping.HideOthersSubProfilesFromMe = request.HideOthersSubProfilesFromMe;

                Plugin.Instance?.SaveConfiguration();
            }

            return Ok();
        }

        private int GetMaxProfilesForUser(Guid userId, PluginConfiguration config)
        {
            var overrideEntry = config.UserProfileLimitOverrides?.FirstOrDefault(o => o.UserId == userId);
            return overrideEntry?.MaxProfiles ?? config.MaxProfilesPerUser;
        }

        private string? SaveProfileImage(Guid profileId, string? profileImageInput)
        {
            if (string.IsNullOrEmpty(profileImageInput))
            {
                var pluginDataFolder = Path.Combine(Plugin.Instance!.AppPaths.DataPath, "plugins", "ProfilesManagement");
                var jpgPath = Path.Combine(pluginDataFolder, $"{profileId}.jpg");
                var pngPath = Path.Combine(pluginDataFolder, $"{profileId}.png");
                if (System.IO.File.Exists(jpgPath)) System.IO.File.Delete(jpgPath);
                if (System.IO.File.Exists(pngPath)) System.IO.File.Delete(pngPath);
                return null;
            }

            if (profileImageInput.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            {
                return profileImageInput;
            }

            if (profileImageInput.StartsWith("/plugins/profiles/image/", StringComparison.OrdinalIgnoreCase))
            {
                return profileImageInput;
            }

            if (profileImageInput.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    var commaIndex = profileImageInput.IndexOf(',');
                    if (commaIndex >= 0)
                    {
                        var mimePart = profileImageInput.Substring(0, commaIndex);
                        var base64Part = profileImageInput.Substring(commaIndex + 1);
                        var bytes = Convert.FromBase64String(base64Part);

                        string ext = ".jpg";
                        if (mimePart.Contains("image/png")) ext = ".png";
                        else if (mimePart.Contains("image/gif")) ext = ".gif";

                        var pluginDataFolder = Path.Combine(Plugin.Instance!.AppPaths.DataPath, "plugins", "ProfilesManagement");
                        Directory.CreateDirectory(pluginDataFolder);

                        var oldJpg = Path.Combine(pluginDataFolder, $"{profileId}.jpg");
                        var oldPng = Path.Combine(pluginDataFolder, $"{profileId}.png");
                        if (System.IO.File.Exists(oldJpg)) System.IO.File.Delete(oldJpg);
                        if (System.IO.File.Exists(oldPng)) System.IO.File.Delete(oldPng);

                        var filePath = Path.Combine(pluginDataFolder, $"{profileId}{ext}");
                        System.IO.File.WriteAllBytes(filePath, bytes);

                        return $"/plugins/profiles/image/{profileId}?v={DateTime.UtcNow.Ticks}";
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "ProfilesPlugin: Failed to save base64 profile image for {ProfileId}", profileId);
                }
            }

            return profileImageInput;
        }

        private void RecordAuditLog(string masterUsername, string targetUsername)
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return;

            var device = GetAuthorizationParameter("Device") ?? "Unknown Device";
            var client = GetAuthorizationParameter("Client") ?? "Unknown Client";
            var ip = HttpContext.Connection.RemoteIpAddress?.ToString() ?? "Unknown IP";

            lock (config)
            {
                if (config.AuditLogs == null)
                {
                    config.AuditLogs = new List<AuditLogEntry>();
                }
                config.AuditLogs.Add(new AuditLogEntry
                {
                    Timestamp = DateTime.UtcNow,
                    MasterUsername = masterUsername,
                    TargetUsername = targetUsername,
                    DeviceName = device,
                    Client = client,
                    IpAddress = ip
                });

                if (config.AuditLogs.Count > 1000)
                {
                    config.AuditLogs = config.AuditLogs.OrderBy(l => l.Timestamp).Skip(config.AuditLogs.Count - 1000).ToList();
                }

                Plugin.Instance?.SaveConfiguration();
            }
        }

        [HttpGet("image/{profileId}")]
        [AllowAnonymous]
        public ActionResult GetProfileImage(Guid profileId)
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null) return NotFound();

            var mapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == profileId);
            if (mapping == null || string.IsNullOrEmpty(mapping.ProfileImage))
            {
                return NotFound();
            }

            var pluginDataFolder = Path.Combine(Plugin.Instance!.AppPaths.DataPath, "plugins", "ProfilesManagement");
            var filePath = Path.Combine(pluginDataFolder, $"{profileId}.jpg");
            if (!System.IO.File.Exists(filePath))
            {
                filePath = Path.Combine(pluginDataFolder, $"{profileId}.png");
            }

            if (System.IO.File.Exists(filePath))
            {
                var bytes = System.IO.File.ReadAllBytes(filePath);
                var contentType = filePath.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ? "image/png" : "image/jpeg";
                return File(bytes, contentType);
            }

            if (mapping.ProfileImage.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            {
                return Redirect(mapping.ProfileImage);
            }

            return NotFound();
        }

        public class SetProfileLimitRequest
        {
            public Guid UserId { get; set; }
            public int? MaxProfiles { get; set; }
        }

        [HttpPost("admin/set-profile-limit")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        public ActionResult SetProfileLimit([FromBody] SetProfileLimitRequest request)
        {
            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();

            var caller = _userManager.GetUserById(currentUserIdVal.Value);
            if (caller == null) return Unauthorized();

            var callerDto = _userManager.GetUserDto(caller, string.Empty);
            if (!callerDto.Policy.IsAdministrator)
            {
                return Unauthorized("Only administrators can update profile limits.");
            }

            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            lock (config)
            {
                if (request.MaxProfiles.HasValue)
                {
                    if (request.MaxProfiles.Value < 1)
                    {
                        return BadRequest("Maximum profiles must be at least 1.");
                    }
                    var existing = config.UserProfileLimitOverrides.FirstOrDefault(o => o.UserId == request.UserId);
                    if (existing != null)
                    {
                        existing.MaxProfiles = request.MaxProfiles.Value;
                    }
                    else
                    {
                        config.UserProfileLimitOverrides.Add(new UserProfileLimitOverride
                        {
                            UserId = request.UserId,
                            MaxProfiles = request.MaxProfiles.Value
                        });
                    }
                }
                else
                {
                    config.UserProfileLimitOverrides.RemoveAll(o => o.UserId == request.UserId);
                }

                Plugin.Instance?.SaveConfiguration();
            }

            return Ok();
        }

        [HttpGet("admin/audit-logs")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult<IEnumerable<AuditLogEntry>> GetAuditLogs()
        {
            var currentUserIdVal = GetCurrentUserId();
            if (currentUserIdVal == null) return Unauthorized();

            var caller = _userManager.GetUserById(currentUserIdVal.Value);
            if (caller == null) return Unauthorized();

            var callerDto = _userManager.GetUserDto(caller, string.Empty);
            if (!callerDto.Policy.IsAdministrator)
            {
                return Unauthorized("Only administrators can view audit logs.");
            }

            var config = Plugin.Instance?.Configuration;
            if (config == null) return BadRequest("Plugin configuration missing.");

            var logs = config.AuditLogs ?? new List<AuditLogEntry>();
            return Ok(logs.OrderByDescending(l => l.Timestamp).ToList());
        }
    }

    public static class BonfireRateLimiter
    {
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, List<DateTime>> _failedAttempts = new();
        private static readonly object _cleanupLock = new();
        private static DateTime _nextCleanup = DateTime.UtcNow.AddMinutes(5);

        private static void PruneExpiredEntries()
        {
            var now = DateTime.UtcNow;
            if (now < _nextCleanup) return;

            lock (_cleanupLock)
            {
                if (now < _nextCleanup) return;
                _nextCleanup = now.AddMinutes(5);

                var cutoff = now.AddMinutes(-15);
                foreach (var key in _failedAttempts.Keys)
                {
                    if (_failedAttempts.TryGetValue(key, out var list))
                    {
                        lock (list)
                        {
                            list.RemoveAll(t => t < cutoff);
                            if (list.Count == 0)
                            {
                                _failedAttempts.TryRemove(key, out _);
                            }
                        }
                    }
                }
            }
        }

        public static bool IsRateLimited(string ipAddress)
        {
            if (string.IsNullOrEmpty(ipAddress)) return false;

            PruneExpiredEntries();

            if (_failedAttempts.TryGetValue(ipAddress, out var attempts))
            {
                lock (attempts)
                {
                    attempts.RemoveAll(t => t < DateTime.UtcNow.AddMinutes(-15));
                    return attempts.Count >= 3;
                }
            }
            return false;
        }

        public static void RecordFailure(string ipAddress)
        {
            if (string.IsNullOrEmpty(ipAddress)) return;

            PruneExpiredEntries();

            var attempts = _failedAttempts.GetOrAdd(ipAddress, _ => new List<DateTime>());
            lock (attempts)
            {
                attempts.Add(DateTime.UtcNow);
            }
        }

        public static void Reset(string ipAddress)
        {
            if (string.IsNullOrEmpty(ipAddress)) return;
            _failedAttempts.TryRemove(ipAddress, out _);
        }
    }

    public static class PinRateLimiter
    {
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, List<DateTime>> _failedAttempts = new();
        private static readonly object _cleanupLock = new();
        private static DateTime _nextCleanup = DateTime.UtcNow.AddMinutes(5);

        private static void PruneExpiredEntries()
        {
            var now = DateTime.UtcNow;
            if (now < _nextCleanup) return;

            lock (_cleanupLock)
            {
                if (now < _nextCleanup) return;
                _nextCleanup = now.AddMinutes(5);

                var cutoff = now.AddMinutes(-15);
                foreach (var key in _failedAttempts.Keys)
                {
                    if (_failedAttempts.TryGetValue(key, out var list))
                    {
                        lock (list)
                        {
                            list.RemoveAll(t => t < cutoff);
                            if (list.Count == 0)
                            {
                                _failedAttempts.TryRemove(key, out _);
                            }
                        }
                    }
                }
            }
        }

        public static bool IsRateLimited(string ipAddress)
        {
            if (string.IsNullOrEmpty(ipAddress)) return false;

            PruneExpiredEntries();

            if (_failedAttempts.TryGetValue(ipAddress, out var attempts))
            {
                lock (attempts)
                {
                    attempts.RemoveAll(t => t < DateTime.UtcNow.AddMinutes(-15));
                    return attempts.Count >= 5;
                }
            }
            return false;
        }

        public static void RecordFailure(string ipAddress)
        {
            if (string.IsNullOrEmpty(ipAddress)) return;

            PruneExpiredEntries();

            var attempts = _failedAttempts.GetOrAdd(ipAddress, _ => new List<DateTime>());
            lock (attempts)
            {
                attempts.Add(DateTime.UtcNow);
            }
        }

        public static void Reset(string ipAddress)
        {
            if (string.IsNullOrEmpty(ipAddress)) return;
            _failedAttempts.TryRemove(ipAddress, out _);
        }
    }
}
