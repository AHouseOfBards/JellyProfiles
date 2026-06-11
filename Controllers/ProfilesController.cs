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
        private readonly ILogger<ProfilesController> _logger;

        public ProfilesController(IUserManager userManager, ISessionManager sessionManager, ILibraryManager libraryManager, ILogger<ProfilesController> logger)
        {
            _userManager = userManager;
            _sessionManager = sessionManager;
            _libraryManager = libraryManager;
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

            var profileList = new List<object>();

            // Find if there is a mapping/PIN for the master user, or default master user entry
            var masterMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == masterUserId);
            
            profileList.Add(new
            {
                ProfileUserId = masterUserId,
                ProfileName = masterUser.Username,
                AvatarInitial = string.IsNullOrEmpty(masterUser.Username) ? "M" : masterUser.Username.Substring(0, 1).ToUpper(),
                AvatarColor = masterMapping?.AvatarColor ?? "#00A4DC",
                RequiresPin = masterMapping != null && !string.IsNullOrEmpty(masterMapping.PinHash),
                IsMaster = true,
                LockoutMinutes = masterMapping?.LockoutMinutes ?? 5
            });

            // Add all shadow profiles
            var shadowProfiles = config.Mappings
                .Where(m => m.MasterUserId == masterUserId && m.ProfileUserId != masterUserId)
                .Select(m => new
                {
                    m.ProfileUserId,
                    m.ProfileName,
                    AvatarInitial = string.IsNullOrEmpty(m.ProfileName) ? "?" : m.ProfileName.Substring(0, 1).ToUpper(),
                    m.AvatarColor,
                    RequiresPin = !string.IsNullOrEmpty(m.PinHash),
                    IsMaster = false,
                    m.LockoutMinutes,
                    EnabledFolders = m.EnabledFolders ?? new List<Guid>()
                });

            profileList.AddRange(shadowProfiles);

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
                        return Unauthorized("Invalid Master PIN code.");
                    }
                }
            }

            var masterUser = _userManager.GetUserById(masterUserId);
            if (masterUser == null) return NotFound("Master user not found.");

            // Enforce max profiles limit
            var existingCount = config.Mappings.Count(m => m.MasterUserId == masterUserId && m.ProfileUserId != masterUserId);
            if (existingCount >= config.MaxProfilesPerUser)
            {
                return BadRequest($"Maximum profile limit of {config.MaxProfilesPerUser} reached.");
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
                EnabledFolders = request.EnabledFolders?.ToList() ?? new List<Guid>()
            });

            Plugin.Instance?.SaveConfiguration();

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
                    return Unauthorized("Invalid Master PIN code.");
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

            config.Mappings.Remove(mapping);
            Plugin.Instance?.SaveConfiguration();

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

            // Validate switch permissions: must belong to the same master user group.
            if (request.ProfileId == callerMasterUserId)
            {
                // Switch back to master profile
                // Master user mapping entry might not exist, but that's fine.
            }
            else
            {
                if (mapping == null || mapping.MasterUserId != callerMasterUserId)
                {
                    return Unauthorized("Unauthorized profile switch attempt.");
                }
            }

            // Verify PIN if set
            var pinHashToCheck = mapping?.PinHash;
            if (!string.IsNullOrEmpty(pinHashToCheck))
            {
                var inputHash = HashPin(request.Pin);
                if (pinHashToCheck != inputHash)
                {
                    return Unauthorized("Invalid PIN code.");
                }
            }

            var targetUser = _userManager.GetUserById(request.ProfileId);
            if (targetUser == null) return NotFound("Underlying system user missing.");

            // Inherit/synchronize streaming policies and configurations from master user dynamically during switch
            var masterUser = _userManager.GetUserById(callerMasterUserId);
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
                        mapping.EnabledFolders = authorityFolders;
                        Plugin.Instance?.SaveConfiguration();
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

            if (request.ProfileId == callerMasterUserId)
            {
                // Verify master PIN
                var masterMapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == callerMasterUserId);
                var pinHash = masterMapping?.PinHash;
                if (!string.IsNullOrEmpty(pinHash))
                {
                    if (string.IsNullOrEmpty(request.Pin) || HashPin(request.Pin) != pinHash)
                    {
                        return Unauthorized("Invalid PIN.");
                    }
                }
                return Ok();
            }
            else
            {
                var mapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == request.ProfileId);
                if (mapping == null || mapping.MasterUserId != callerMasterUserId)
                {
                    return Unauthorized("Unauthorized profile PIN verification.");
                }
                var pinHash = mapping.PinHash;
                if (!string.IsNullOrEmpty(pinHash))
                {
                    if (string.IsNullOrEmpty(request.Pin) || HashPin(request.Pin) != pinHash)
                    {
                        return Unauthorized("Invalid PIN.");
                    }
                }
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
                    masterUsersList.Add(new
                    {
                        ProfileUserId = user.Id,
                        ProfileName = user.Username,
                        RequiresPin = mapping != null && !string.IsNullOrEmpty(mapping.PinHash)
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

            var mapping = config.Mappings.FirstOrDefault(m => m.ProfileUserId == request.ProfileId);
            if (mapping == null) return NotFound("Profile mapping not found.");

            mapping.PinHash = string.Empty;
            Plugin.Instance?.SaveConfiguration();

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
                    return Unauthorized("Invalid Master PIN code.");
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

            // Fetch or create mapping for this profile
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

                mappingEntry.AvatarColor = request.AvatarColor;

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
                // Always set when editing a sub-profile; null means "leave unchanged" (sent by master-profile saves).
                if (request.EnabledFolders != null)
                {
                    mappingEntry.EnabledFolders = request.EnabledFolders.ToList();
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

            Plugin.Instance?.SaveConfiguration();
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
    }
}
