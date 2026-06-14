# Bonfire/JellyProfiles

Adds multi-user profile switching to Jellyfin. A single account can have up to five isolated profiles — each with its own watch history, parental controls, and library access.

> Built for Jellyfin Server **10.11.x** (all minor versions supported).

---

## Screenshots

![Profile selection screen](images/profile-selector.png)

*Profile selector — shown on launch and when switching profiles.*

---

## Installation

1. In your Jellyfin dashboard, go to **Plugins → Repositories → ＋**
2. Paste the following URL and click **Save**:
   ```
   https://ahouseofbards.github.io/Bonfire-JellyProfiles/manifest.json
   ```
3. Go to **Plugins → Catalog**, find **Bonfire/JellyProfiles**, and click **Install**
4. Restart your Jellyfin server when prompted

Once the server restarts, the plugin is active and will automatically load on all compatible clients with no further setup.

> [!NOTE]
> **Automatic Client Script Injection & Permissions:**
> On startup, the plugin automatically patches Jellyfin's `index.html` to inject the client-side profile switcher. If the Jellyfin process lacks write permissions to its web client files (common on Docker, Linux, or restricted Windows directories), the injection will fail.
> 
> * **How to know:** If injection fails, a prominent **⚠️ Client Script Auto-Injection Failed** banner will appear at the top of your plugin configuration page (**Dashboard → Plugins → Profiles**) with the copy-pasteable fix commands for your host OS.
> * **Quick Fixes:**
>   * **Linux (Native):** Run `sudo chown -R jellyfin:jellyfin /usr/share/jellyfin/web` and restart Jellyfin.
>   * **Docker (Run on host):** Run `docker exec -u root <container-name> sed -i 's|</body>|<script src="/plugins/profiles/profiles.js" defer></script>\n</body>|' /jellyfin/jellyfin-web/index.html`.
>   * **Windows (Admin Command Prompt):** Run `icacls "C:\Program Files\Jellyfin\Server\jellyfin-web\index.html" /grant "NT AUTHORITY\NetworkService:(M)"` and restart Jellyfin.

---

## Features

- **Multi-User Profile Switching**: Up to 5 isolated sub-profiles per Jellyfin account, each with separate watch history, library access, and parental ratings.
- **Resilient Deletion**: Automatically handles native Jellyfin database deletion bugs (like the playlist null reference error) by deactivating the underlying sub-profile user account and clearing plugin mappings.
- **Bonfire Grouping**: Link different master accounts together using secure 6-character codes to share switcher screens.
- **PIN Protection & LAN Bypass**: Secure profiles with PIN codes and bypass verification automatically when connected on your local network (LAN).
- **Device Whitelists**: Limit specific profiles to designated devices.
- **Premium UI**: Seamless native UI integration with custom profile pictures, custom avatar colors, and TV D-pad navigation support.

---

## Client Compatibility

**Compatible Clients:**
- Jellyfin Web (desktop & mobile browsers)
- Official Jellyfin Android App
- Jellyfin Media Player (Windows, macOS, Linux)

**Unsupported Clients (Requires native app updates):**
- Swiftfin (iOS / tvOS)
- Findroid (Android / Android TV)
- Jellyfin for Roku
- Infuse (iOS / tvOS / macOS)

---

## Known Limitations

**Skin Manager / custom themes**  
The Switch Profile button is designed to align with standard Jellyfin layouts. If you use custom themes or a skin manager, the button might occasionally appear misaligned or out of place. If you run into visual conflicts, please open an issue with the name of the theme you are using.

**Profile creation is on the home screen, not the admin dashboard**  
Profiles are created and managed via the Switch Profile button on the Jellyfin home screen. The admin dashboard page (**Dashboard → Plugins → Profiles**) is only for server-wide settings (maximum profile count, require-PIN policy) and administrator PIN resets.

---

## For Developers

Building a native app or custom Jellyfin client?

📄 **[Developer API Reference](docs/developer-api.md)**

Covers all endpoints, request/response schemas, the session lifecycle, silent PIN verification, inactivity lockout, and platform-specific implementation notes for tvOS, Android, Roku, Tizen, webOS, Xbox, PS4/PS5, and Electron.

---

## License

MIT — see [LICENSE](LICENSE)
