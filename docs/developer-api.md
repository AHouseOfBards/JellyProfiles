# Jellyfin Profiles Plugin — Developer API Reference

**Plugin ID:** `b1462fca-774b-4b13-8d02-e2d4f2bc18b9`  
**Base Path:** `/plugins/profiles`  

---

## Authentication

All API requests require a standard Jellyfin authorization header. Authenticate initial requests with the master user's token. After a profile switch, use the returned active profile token for subsequent Jellyfin API calls.

```http
Authorization: MediaBrowser Client="<ClientName>", Device="<DeviceName>", DeviceId="<DeviceId>", Version="<Version>", Token="<token>"
```

---

## Client Lifecycle Flow

### 1. Initialization
1. Authenticate with Jellyfin using the master credentials to get the master `Token` and `UserId`.
2. Fetch the profiles using `GET /plugins/profiles/list`.
3. If no active profile session exists, present a profile selection UI before loading home content.

### 2. Profile Switch
1. Call `POST /plugins/profiles/switch` with the chosen `profileId` (and `pin` if `requiresPin` is true).
2. Save the returned `activeProfileToken` and `jellyfinUserId`. Replace the active Jellyfin client credentials with these values.
3. If `lockoutMinutes` is greater than zero and `requiresPin` is true, start the inactivity tracking.

### 3. Return to Selector
1. Clear the active profile token and profile display info.
2. Restore the original master credentials to the Jellyfin client.
3. Refresh the profile list via `GET /plugins/profiles/list` and show the selector UI.

---

## Storage Recommendations

Keep the following values stored client-side:

| Store | Scope | Keys | Lifetime |
|---|---|---|---|
| Persistent | Local | `jellyfin_profiles_master_state`: Master `userId` and `masterToken` | Cleared on explicit logout |
| Session | Tab/App Run | `jellyfin_profiles_active_token`: Profile `activeProfileToken` and `jellyfinUserId` | Cleared on switch/lockout |
| Session | Tab/App Run | `jellyfin_profiles_active_info`: Selected profile name, color, and initial | Cleared on switch/lockout |

---

## Endpoint Reference

### Profiles API

#### `GET /plugins/profiles/list`
Fetch all profiles (master and sub-profiles) accessible to the authenticated master session.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Response `200 OK`:**
```json
[
  {
    "profileUserId": "8e3cdfa5-79a8-4bb9-bd9a-0e96b7dc974a",
    "profileName": "John",
    "avatarInitial": "J",
    "avatarColor": "#00A4DC",
    "requiresPin": true,
    "isMaster": true,
    "lockoutMinutes": 10,
    "maxSubProfiles": 5,
    "bypassPinOnLocalNetwork": false,
    "allowedDeviceIds": [],
    "isBonfire": false,
    "profileImage": null,
    "masterUserId": "8e3cdfa5-79a8-4bb9-bd9a-0e96b7dc974a"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `profileUserId` | string (GUID) | The Jellyfin user ID assigned to the profile. |
| `profileName` | string | Profile display name. |
| `avatarInitial` | string | Single character representing the profile. |
| `avatarColor` | string | Hex color code for fallback avatar display. |
| `requiresPin` | boolean | Indicates if a PIN entry is required to switch to this profile. |
| `isMaster` | boolean | True if this is the main master user account. |
| `lockoutMinutes` | integer | Auto-lock timeout in minutes. `0` means never. |
| `maxSubProfiles` | integer | Maximum sub-profiles allowed (only present when `isMaster` is true). |
| `enabledFolders` | string[] | Library GUIDs accessible to this sub-profile (only present when `isMaster` is false). |
| `bypassPinOnLocalNetwork` | boolean | If true, PIN entry is bypassed when client is on LAN. |
| `allowedDeviceIds` | string[] | Array of device IDs permitted to switch to this profile. Empty/null means all devices. |
| `isBonfire` | boolean | True if the profile belongs to a linked Bonfire guest home. |
| `profileImage` | string | Base64 data-URL or image URL representing the profile image. |
| `masterUserId` | string (GUID) | The master user ID that this profile belongs to. |

#### `POST /plugins/profiles/switch`
Switch session to a target profile.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request:**
```json
{
  "profileId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b",
  "pin": "1234"
}
```
* **Response `200 OK`:**
```json
{
  "activeProfileToken": "7ef4a378297b470183b0b3e6cda7670e",
  "jellyfinUserId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b"
}
```

#### `POST /plugins/profiles/verify-pin`
Validate a PIN without switching the active session. Used for input validation or silent PIN entry.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request:**
```json
{
  "profileId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b",
  "pin": "1234"
}
```
* **Response:** `200 OK` on match; `401 Unauthorized` on mismatch.

#### `POST /plugins/profiles/create`
Create a new sub-profile.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request:**
```json
{
  "profileName": "Kids",
  "pin": "4321",
  "avatarColor": "#EC4899",
  "maxParentalRating": "6",
  "enabledFolders": ["e67b2d5a39cb400ba45a7b0a70198de7"],
  "lockoutMinutes": 5,
  "masterPin": "1234",
  "bypassPinOnLocalNetwork": false,
  "allowedDeviceIds": [],
  "profileImage": null
}
```
* **Response `200 OK`:**
```json
{
  "profileUserId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b",
  "profileName": "Kids"
}
```

#### `POST /plugins/profiles/update`
Update profile settings.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request:**
```json
{
  "profileId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b",
  "profileName": "Kids (Edited)",
  "pin": "",
  "avatarColor": "#D946EF",
  "maxParentalRating": "10",
  "enabledFolders": ["e67b2d5a39cb400ba45a7b0a70198de7"],
  "lockoutMinutes": 30,
  "masterPin": "1234",
  "bypassPinOnLocalNetwork": false,
  "allowedDeviceIds": [],
  "profileImage": ""
}
```
*Note: Pass an empty string `""` to `pin` or `profileImage` to clear them. Pass `null` to leave them unchanged.*

* **Response:** `200 OK` on success.

#### `POST /plugins/profiles/delete`
Permanently delete a sub-profile and its underlying Jellyfin account.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request:**
```json
{
  "profileId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b",
  "masterPin": "1234"
}
```
* **Response:** `200 OK` on success.

#### `GET /plugins/profiles/libraries`
Get media library folders visible to the master user. Used for populating selectors.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Response `200 OK`:**
```json
[
  {
    "id": "e67b2d5a39cb400ba45a7b0a70198de7",
    "name": "Movies",
    "collectionType": "movies"
  }
]
```

---

### Devices API

#### `GET /plugins/profiles/devices`
Get all logged devices that have interacted with the plugin (server-wide).

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Response `200 OK`:**
```json
[
  {
    "deviceId": "57bfa7e8d35f492b950bf93c9d747a11",
    "deviceName": "Chrome",
    "client": "Jellyfin Web",
    "lastSeen": "2026-06-12T09:41:46.806Z"
  }
]
```

#### `POST /plugins/profiles/devices/delete`
Delete a device from the known devices log. Clears it from allowed device filters.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request:**
```json
{
  "deviceId": "57bfa7e8d35f492b950bf93c9d747a11"
}
```
* **Response:** `200 OK` on success.

---

### Bonfire API

#### `GET /plugins/profiles/bonfire/status`
Retrieve the bonfire group status and visibility settings for the caller.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Response `200 OK`:**
```json
{
  "isOwner": true,
  "ownedCode": "B7F8XA",
  "ownedMembers": [
    {
      "userId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b",
      "username": "FriendMaster"
    }
  ],
  "isMember": false,
  "joinedOwnerName": null,
  "joinedOwnerId": null,
  "hideMySubProfilesFromOthers": false,
  "hideOthersSubProfilesFromMe": false
}
```

#### `POST /plugins/profiles/bonfire/settings`
Update the visibility preferences for sharing profiles in Bonfire crossover homes.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request:**
```json
{
  "hideMySubProfilesFromOthers": false,
  "hideOthersSubProfilesFromMe": false
}
```
* **Response:** `200 OK` on success.

#### `POST /plugins/profiles/bonfire/generate`
Generate a new 6-character alphanumeric bonfire join code.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Response `200 OK`:**
```json
{
  "groupId": "4f5c9e2b",
  "bonfireCode": "B7F8XA",
  "members": []
}
```

#### `POST /plugins/profiles/bonfire/join`
Join a target group using its 6-character code. Rate limited to 3 failed attempts in 15 minutes.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request:**
```json
{
  "code": "B7F8XA"
}
```
* **Response `200 OK`:**
```json
{
  "message": "Successfully joined Bonfire group.",
  "ownerName": "FriendMaster"
}
```

#### `POST /plugins/profiles/bonfire/kick`
Kick a guest master user from your bonfire group.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request:**
```json
{
  "memberId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b"
}
```
* **Response:** `200 OK` on success.

#### `POST /plugins/profiles/bonfire/leave`
Leave the bonfire group that you have joined.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Response:** `200 OK` on success.

#### `POST /plugins/profiles/bonfire/delete-group`
Dissolve the bonfire group you own. All member switchers are unlinked.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Response:** `200 OK` on success.

---

### Admin API

#### `GET /plugins/profiles/admin/mappings`
Get all user profile mappings configured on the server.

* **Headers:** `Authorization: MediaBrowser Token="<adminToken>"`
* **Response `200 OK`:**
```json
{
  "masterUsers": [
    {
      "profileUserId": "8e3cdfa5-79a8-4bb9-bd9a-0e96b7dc974a",
      "profileName": "john",
      "requiresPin": true
    }
  ],
  "subProfiles": [
    {
      "profileUserId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b",
      "profileName": "Kids",
      "masterName": "john",
      "requiresPin": false
    }
  ]
}
```

#### `POST /plugins/profiles/admin/reset-pin`
Remove the PIN setting from a profile (recovery mechanism).

* **Headers:** `Authorization: MediaBrowser Token="<adminToken>"`
* **Request:**
```json
{
  "profileId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b"
}
```
* **Response:** `200 OK` on success.
