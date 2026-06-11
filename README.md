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

---

## Features

- Up to 5 isolated profiles per Jellyfin account
- Per-profile PIN protection with auto-submit on correct entry
- Configurable inactivity auto-lock (1 min – 1 hour) per profile
- Parental rating limits per profile
- Per-profile library access control
- Profile avatars with 18 customizable colors
- Full profile management dashboard built into the Jellyfin web UI
- Switch Profile button injected into the Jellyfin header — works on desktop, mobile, and TV browsers

---

## Client Compatibility

### Works out of the box

These clients run Jellyfin's web interface directly, so the plugin's UI and session logic are active automatically.

| Client | Platform |
|---|---|
| Jellyfin Web | Desktop — Chrome, Firefox, Safari, Edge |
| Jellyfin Web | Mobile browsers — iOS Safari, Android Chrome |
| Jellyfin Media Player | Windows, macOS, Linux |
| Smart TV browser → Jellyfin Web | Samsung (Tizen 5+, 2018+) |
| Smart TV browser → Jellyfin Web | LG (webOS 5+, 2020+) |
| Smart TV browser → Jellyfin Web | Fire TV, Android TV built-in browser |

### Works with known limitations

| Client | Platform | Limitation |
|---|---|---|
| Jellyfin Web | Samsung TVs (Tizen 3–4, 2016–2018) | `AbortController` not available; PIN auto-submit falls back to manual Enter |
| Jellyfin Web | LG TVs (webOS 3–4, 2016–2019) | Same as above |
| Jellyfin Web | Apple TV (browser or WKWebView app) | System keyboard is always QWERTY — numeric keypad hint is ignored; inactivity timer pauses when the app backgrounds |

### Requires developer integration

These are native apps that do not run Jellyfin's web code. The plugin exposes a full REST API, but the client developer needs to implement the integration. See the [Developer API Reference](docs/developer-api.md).

| Client | Platform | Notes |
|---|---|---|
| Swiftfin | iOS, tvOS | Open source — integration is feasible |
| Findroid | Android, Android TV | Open source — integration is feasible |
| Jellyfin for Roku | Roku | Open source — integration is feasible |
| Infuse | iOS, tvOS, macOS | Closed source — requires Firecore to add support |
| Any custom native client | Any | Full API reference available |

---

## For Developers

Building a native app or custom Jellyfin client?

📄 **[Developer API Reference](docs/developer-api.md)**

Covers all endpoints, request/response schemas, the session lifecycle, silent PIN verification, inactivity lockout, and platform-specific implementation notes for tvOS, Android, Roku, Tizen, webOS, Xbox, PS4/PS5, and Electron.

---

## License

MIT — see [LICENSE](LICENSE)
