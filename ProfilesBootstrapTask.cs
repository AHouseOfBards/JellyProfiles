using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Profiles
{
    /// <summary>
    /// Runs once every time the Jellyfin server starts via the IHostedService lifecycle.
    ///
    /// Ensures that the Profiles client script tag is present in Jellyfin's index.html
    /// so the profile gate and switch button load automatically for all users without
    /// any manual post-installation steps.
    ///
    /// The patch is idempotent — if the tag is already present the file is left untouched.
    /// Because Jellyfin replaces index.html when the web client is updated, running
    /// this check on every startup keeps the injection self-healing.
    ///
    /// If the file cannot be written (admin-locked directory, insufficient permissions)
    /// a clear, platform-specific warning is written to the Jellyfin log with
    /// copy-pasteable fix commands for Docker, Linux, and Windows.
    /// </summary>
    public class ProfilesBootstrapTask : IHostedService
    {
        // The exact script tag to inject before </body>.
        // The URL /plugins/profiles/profiles.js is the path
        // Jellyfin uses to serve embedded resources from plugin assemblies.
        private const string BodyScriptTag =
            "<script src=\"/plugins/profiles/profiles.js\" defer></script>";

        // Unique substring to detect whether the body tag is already present.
        private const string BodyMarker = "/plugins/profiles/profiles.js";

        // Tiny inline script injected into <head> — runs before any deferred bundle,
        // before React renders. Reads the switching flag set by profiles.js before
        // each window.location.reload() and hides the html element instantly to
        // prevent the flash-of-content during profile switches.
        // A 4-second failsafe restores visibility if profiles.js fails to load.
        private const string HeadScript =
            "<script id=\"jpf-eh\">" +
            "!function(){" +
                "if(localStorage.getItem('jpf-sw')){" +
                    "var h=document.documentElement;" +
                    "h.style.opacity='0';" +
                    "h.style.background='#101010';" +
                    "h.style.colorScheme='dark';" +
                    "window.__jpReveal=setTimeout(function(){" +
                        "h.style.opacity='';" +
                        "h.style.background='';" +
                        "h.style.colorScheme='';" +
                    "},4e3);" +
                    "localStorage.removeItem('jpf-sw');" +
                "}" +
            "}();" +
            "</script>";

        // Unique substring to detect whether the head script is already present.
        private const string HeadMarker = "jpf-eh";

        // Exposed so the dashboard page JS can check whether setup is complete.
        internal static bool InjectionSucceeded { get; private set; }

        private readonly IApplicationPaths _appPaths;
        private readonly ILogger<ProfilesBootstrapTask> _logger;

        public ProfilesBootstrapTask(
            IApplicationPaths appPaths,
            ILogger<ProfilesBootstrapTask> logger)
        {
            _appPaths = appPaths;
            _logger = logger;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            TryPatchIndex();
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken)
            => Task.CompletedTask;

        // ── Main logic ──────────────────────────────────────────────────────────

        private void TryPatchIndex()
        {
            var indexPath = FindIndexHtml();

            if (indexPath is null)
            {
                _logger.LogWarning(
                    "ProfilesPlugin: Could not locate index.html in any known Jellyfin web path. " +
                    "The Profiles client script will not load automatically. " +
                    "Manually add the following line before </body> in your index.html: {Tag}",
                    BodyScriptTag);
                return;
            }

            try
            {
                var html = File.ReadAllText(indexPath);

                bool hasBody = html.Contains(BodyMarker, StringComparison.Ordinal);
                bool hasHead = html.Contains(HeadMarker, StringComparison.Ordinal);

                if (hasBody && hasHead)
                {
                    _logger.LogDebug(
                        "ProfilesPlugin: Scripts already correctly present in {Path} — no changes made.",
                        indexPath);
                    InjectionSucceeded = true;
                    return;
                }

                bool changed = false;

                // ── 1. Clean up any existing early-hide script ──────────────────
                int oldScriptIdx = html.IndexOf("<script id=\"jpf-eh\">", StringComparison.OrdinalIgnoreCase);
                if (oldScriptIdx != -1)
                {
                    int endScriptIdx = html.IndexOf("</script>", oldScriptIdx, StringComparison.OrdinalIgnoreCase);
                    if (endScriptIdx != -1)
                    {
                        html = html.Remove(oldScriptIdx, endScriptIdx + "</script>".Length - oldScriptIdx);
                        changed = true;
                    }
                }

                // ── 2. Clean up any existing body script ────────────────────────
                int oldBodyIdx = html.IndexOf(BodyMarker, StringComparison.OrdinalIgnoreCase);
                if (oldBodyIdx != -1)
                {
                    int tagStart = html.LastIndexOf("<script", oldBodyIdx, StringComparison.OrdinalIgnoreCase);
                    if (tagStart != -1)
                    {
                        int tagEnd = html.IndexOf("</script>", oldBodyIdx, StringComparison.OrdinalIgnoreCase);
                        if (tagEnd != -1)
                        {
                            html = html.Remove(tagStart, tagEnd + "</script>".Length - tagStart);
                            changed = true;
                        }
                    }
                }

                // ── 3. Inject new early-hide script right after <head> ──────────
                html = html.Replace(
                    "<head>",
                    "<head>" + Environment.NewLine + HeadScript,
                    StringComparison.OrdinalIgnoreCase);
                changed = true;

                // ── 4. Inject new deferred client script before </body> ──────────
                html = html.Replace(
                    "</body>",
                    BodyScriptTag + Environment.NewLine + "</body>",
                    StringComparison.OrdinalIgnoreCase);
                changed = true;

                if (changed)
                {
                    File.WriteAllText(indexPath, html);
                    InjectionSucceeded = true;
                    _logger.LogInformation(
                        "ProfilesPlugin: Client scripts injected successfully into {Path}.",
                        indexPath);
                }
            }
            catch (UnauthorizedAccessException ex)
            {
                LogPermissionError(indexPath, ex);
            }
            catch (IOException ex)
            {
                _logger.LogWarning(
                    ex,
                    "ProfilesPlugin: IO error reading/writing {Path}. " +
                    "Manually add the following line before </body>: {Tag}",
                    indexPath, BodyScriptTag);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex,
                    "ProfilesPlugin: Unexpected error while patching {Path}.", indexPath);
            }
        }

        // ── Path discovery ───────────────────────────────────────────────────────

        /// <summary>
        /// Searches all locations Jellyfin is known to place its web client on every
        /// supported platform (Windows installer, Linux packages, Docker images,
        /// portable/Scoop). Returns the full path to index.html or <c>null</c>.
        /// </summary>
        private string? FindIndexHtml()
        {
            var candidates = new List<string?>();

            // ── 1. Jellyfin's own reported WebPath (highest confidence) ──────────
            //    IApplicationPaths.WebPath is set by Jellyfin at startup from its
            //    own config, so this is correct on any properly configured install.
            candidates.Add(_appPaths.WebPath);

            // ── 2. Relative to the running executable ────────────────────────────
            //    Works for Windows portable, Scoop, and some Docker images where
            //    jellyfin-web is placed next to / near the server binary.
            var baseDir = AppContext.BaseDirectory;
            candidates.Add(Path.Combine(baseDir, "jellyfin-web"));
            candidates.Add(Path.Combine(baseDir, "..", "jellyfin-web"));
            candidates.Add(Path.Combine(baseDir, "..", "..", "jellyfin-web"));

            // ── 3. Windows — standard installer path ─────────────────────────────
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                candidates.Add(Path.Combine(pf, "Jellyfin", "Server", "jellyfin-web"));
                candidates.Add(Path.Combine(pf, "Jellyfin", "jellyfin-web"));
            }

            // ── 4. Linux — package manager installs (apt/rpm/AUR) ───────────────
            candidates.Add("/usr/share/jellyfin/web");
            candidates.Add("/usr/lib/jellyfin/web");
            candidates.Add("/usr/local/share/jellyfin/web");
            candidates.Add("/opt/jellyfin/web");

            // ── 5. Docker — common image layouts ────────────────────────────────
            candidates.Add("/jellyfin/jellyfin-web");
            candidates.Add("/jellyfin/web");
            candidates.Add("/app/jellyfin-web");
            candidates.Add("/config/jellyfin-web");
            candidates.Add("/data/jellyfin-web");

            foreach (var dir in candidates)
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;

                try
                {
                    var fullDir = Path.GetFullPath(dir);
                    var candidate = Path.Combine(fullDir, "index.html");
                    if (File.Exists(candidate))
                    {
                        _logger.LogDebug(
                            "ProfilesPlugin: Found index.html at {Path}.", candidate);
                        return candidate;
                    }
                }
                catch
                {
                    // Path may be syntactically invalid on this OS — skip it.
                }
            }

            return null;
        }

        // ── Error reporting ──────────────────────────────────────────────────────

        private void LogPermissionError(string indexPath, Exception ex)
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                _logger.LogWarning(
                    ex,
                    "ProfilesPlugin: Permission denied writing to {Path}.\n\n" +
                    "WINDOWS FIX — Grant the Jellyfin service account write access (run as Administrator):\n" +
                    "  icacls \"{IndexPath}\" /grant \"NT AUTHORITY\\NetworkService:(M)\"\n\n" +
                    "Or add the following line before </body> manually (Notepad as Administrator):\n" +
                    "  {Tag}",
                    indexPath, indexPath, BodyScriptTag);
            }
            else if (IsRunningInDocker())
            {
                _logger.LogWarning(
                    ex,
                    "ProfilesPlugin: Permission denied writing to {Path}.\n\n" +
                    "DOCKER FIX — One-time patch from the host:\n" +
                    "  docker exec -u root <container> sed -i 's|</body>|{Tag}\\n</body>|' {IndexPath}\n\n" +
                    "Or bind-mount the web directory so the container can write it:\n" +
                    "  -v /host/jellyfin-web:/jellyfin/jellyfin-web\n" +
                    "The plugin will re-inject automatically on the next server restart.",
                    indexPath, BodyScriptTag, indexPath);
            }
            else
            {
                _logger.LogWarning(
                    ex,
                    "ProfilesPlugin: Permission denied writing to {Path}.\n\n" +
                    "LINUX FIX — Grant write access to the Jellyfin service account, then restart:\n" +
                    "  sudo chown jellyfin:jellyfin {IndexPath} && sudo chmod 644 {IndexPath}\n\n" +
                    "Or apply the patch once as root:\n" +
                    "  sudo sed -i 's|</body>|{Tag}\\n</body>|' {IndexPath}",
                    indexPath, indexPath, indexPath, BodyScriptTag, indexPath);
            }
        }

        private static bool IsRunningInDocker() =>
            File.Exists("/.dockerenv") ||
            string.Equals(
                Environment.GetEnvironmentVariable("DOTNET_RUNNING_IN_CONTAINER"),
                "true",
                StringComparison.OrdinalIgnoreCase);
    }
}
