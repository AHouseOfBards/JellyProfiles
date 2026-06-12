# Jellyfin Profiles Plugin

Adds multi-user profile switching to Jellyfin. A single account can have up to five isolated profiles — each with its own watch history, parental controls, and library access.

> Built for Jellyfin Server **10.11.x** (all minor versions supported).

---

## Screenshots

![Profile selection screen](images/profile-selector.png)

*Profile selector — shown on launch and when switching profiles.*

![Create profile screen](images/create-profile.png)

*Create profile — name, PIN, auto-lock timer, avatar color, parental rating, and library access.*

---

## Installation

1. In your Jellyfin dashboard, go to **Plugins → Repositories → ＋**
2. Paste the following URL and click **Save**:
   ```
   https://ahouseofbards.github.io/JellyProfiles/manifest.json
   ```
3. Go to **Plugins → Catalog**, find **Profiles Management**, and click **Install**
4. Restart your Jellyfin server when prompted

Once the server restarts, the plugin is active and will automatically load on all compatible clients with no further setup.

> [!NOTE]
> **Docker users:** If your container's web directory is read-only, the plugin may not load automatically. If this happens, check your Jellyfin logs for a permission fix command.

---

## Features

- Up to 5 isolated profiles per Jellyfin account
- Per-profile PIN protection with auto-submit on correct entry
- **Local Network PIN Bypass:** Option to skip PIN prompts automatically when connected via local home network (LAN)
- **Device Restrictions:** Restrict specific sub-profiles to designated devices only (whitelist)
- **Connected Device History:** View a log of connected devices and delete inactive device logs
- **Plex Home-style Bonfire Codes:** Securely link separate master accounts using server-generated 6-character codes, protected by brute-force rate limiting
- Configurable inactivity auto-lock (1 min – 1 hour) per profile
- Parental rating limits per profile
- Per-profile library access control
- Profile avatars with 18 customizable colors
- Full profile management dashboard built into the Jellyfin web UI

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
