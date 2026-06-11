# Jellyfin Profiles Plugin

Adds Netflix-style multi-user profiles to Jellyfin. A single Jellyfin account can have multiple isolated profiles with separate watch history, parental controls, and library access — no extra Jellyfin accounts required.

> Built for Jellyfin Server **10.11.x** (all minor versions supported).

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

- Create up to 5 isolated profiles per Jellyfin account
- Per-profile PIN protection
- Parental rating limits per profile
- Per-profile library access control
- Profile avatars with customizable colors
- Full profile management dashboard in the Jellyfin web UI
- Works on any Jellyfin web client or web-wrapper app

---

## For Developers

Building a native app or custom Jellyfin client and want to integrate profile switching?

📄 **[Developer API Reference](docs/developer-api.md)**

The API reference covers all endpoints, request/response schemas, the session lifecycle, and TV remote control implementation notes.

---

## License

MIT — see [LICENSE](LICENSE)
