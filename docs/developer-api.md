# Jellyfin Profiles Plugin — Developer API Reference

**Plugin ID:** `b1462fca-774b-4b13-8d02-e2d4f2bc18b9`  
**Base Path:** `/plugins/profiles`  

---

## Authentication

All API requests require a Jellyfin authorization header. Initial requests and profile management endpoints must be authenticated with the master user's token. After a profile switch, the returned active profile token must be used for subsequent API requests.

```http
Authorization: MediaBrowser Client="<ClientName>", Device="<DeviceName>", DeviceId="<DeviceId>", Version="<Version>", Token="<token>"
```

---

## Profiles API

### `GET /plugins/profiles/list`
Retrieves a list of all profiles (master and sub-profiles) accessible to the authenticated master session.

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
| `profileUserId` | string (GUID) | Jellyfin user ID assigned to the profile. |
| `profileName` | string | Display name of the profile. |
| `avatarInitial` | string | Single character representing the profile avatar. |
| `avatarColor` | string | Hex color code for the fallback avatar display. |
| `requiresPin` | boolean | Indicates if a PIN entry is required to switch to this profile. |
| `isMaster` | boolean | Indicates if this is the master user account. |
| `lockoutMinutes` | integer | Inactivity timeout in minutes before auto-lock. `0` indicates disabled. |
| `maxSubProfiles` | integer | Maximum sub-profiles allowed (present only when `isMaster` is true). |
| `enabledFolders` | string[] (GUIDs) | Library GUIDs accessible to this sub-profile (present only when `isMaster` is false). |
| `bypassPinOnLocalNetwork` | boolean | If true, PIN entry is bypassed when the client is on a local network (LAN). |
| `allowedDeviceIds` | string[] | Device IDs permitted to access this profile. Empty or null indicates no device restrictions. |
| `isBonfire` | boolean | Indicates if the profile belongs to a linked Bonfire guest home. |
| `profileImage` | string | Base64 data-URL or image URL representing the profile picture. Null if none. |
| `masterUserId` | string (GUID) | Jellyfin user ID of the master user account this profile belongs to. |

### `POST /plugins/profiles/switch`
Authenticates a profile selection and returns a scoped session token. Rate limited to 5 failed attempts in 15 minutes.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request Body:**
```json
{
  "profileId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b",
  "pin": "1234"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `profileId` | string (GUID) | Yes | The Jellyfin user ID of the target profile. |
| `pin` | string | Conditional | Required if `requiresPin` is true for the target profile. |

* **Response `200 OK`:**
```json
{
  "activeProfileToken": "7ef4a378297b470183b0b3e6cda7670e",
  "jellyfinUserId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b"
}
```

| Field | Type | Description |
|---|---|---|
| `activeProfileToken` | string | Scoped Jellyfin session token for the target profile. |
| `jellyfinUserId` | string (GUID) | Jellyfin user ID of the target profile. |

* **Error Responses:**
  * `400 Bad Request`: Incorrect PIN, device restrictions not met, or invalid parameters.
  * `401 Unauthorized`: Caller is not authenticated, or unauthorized profile switch attempt.
  * `404 Not Found`: Target profile or underlying system user does not exist.
  * `429 Too Many Requests`: PIN authentication rate limit exceeded (5 failed attempts per 15 minutes).

### `POST /plugins/profiles/verify-pin`
Validates a profile PIN without switching the active session. Rate limited to 5 failed attempts in 15 minutes.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request Body:**
```json
{
  "profileId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b",
  "pin": "1234"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `profileId` | string (GUID) | Yes | The Jellyfin user ID of the profile. |
| `pin` | string | Yes | The numeric PIN to validate. |

* **Response `200 OK`:** PIN is correct.
* **Error Responses:**
  * `400 Bad Request`: Incorrect PIN, device restrictions not met, or invalid parameters.
  * `401 Unauthorized`: Caller is not authenticated, or unauthorized profile PIN verification.
  * `429 Too Many Requests`: PIN authentication rate limit exceeded (5 failed attempts per 15 minutes).

### `POST /plugins/profiles/create`
Creates a new sub-profile.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request Body:**
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

| Field | Type | Required | Description |
|---|---|---|---|
| `profileName` | string | Yes | Display name for the new profile. |
| `pin` | string | No | Numeric PIN for the profile (4-8 digits). Pass null or omit for no PIN. |
| `avatarColor` | string | No | Hex color code for the fallback avatar. Defaults to `#1F77B4`. |
| `maxParentalRating` | string | No | Maximum parental rating allowed (e.g., "6", "10", "14", "17"). Omit for no restriction. |
| `enabledFolders` | string[] (GUIDs) | No | Array of library GUIDs accessible to this profile. Empty array denies all library access. |
| `lockoutMinutes` | integer | No | Inactivity timeout in minutes before auto-lock. `0` to disable. Defaults to `5`. |
| `masterPin` | string | Conditional | Required if the master account has a PIN set. |
| `bypassPinOnLocalNetwork` | boolean | No | Bypasses PIN entry when the client is on a local network. Defaults to `false`. |
| `allowedDeviceIds` | string[] | No | Specific device IDs permitted to switch to this profile. Empty or null for no restriction. |
| `profileImage` | string | No | Base64-encoded JPEG data-URL or image URL representing the profile picture. |

* **Response `200 OK`:**
```json
{
  "profileUserId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b",
  "profileName": "Kids"
}
```

| Field | Type | Description |
|---|---|---|
| `profileUserId` | string (GUID) | Jellyfin user ID assigned to the new profile. |
| `profileName` | string | Display name of the new profile. |

### `POST /plugins/profiles/update`
Updates settings for an existing sub-profile.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request Body:**
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

| Field | Type | Required | Description |
|---|---|---|---|
| `profileId` | string (GUID) | Yes | Jellyfin user ID of the profile to update. |
| `profileName` | string | Yes | New display name. |
| `pin` | string | No | New numeric PIN. Pass `""` to clear the PIN. Pass `null` to leave unchanged. |
| `avatarColor` | string | No | New hex color code. |
| `maxParentalRating` | string | No | New maximum parental rating code. Pass `null` to leave unchanged. |
| `enabledFolders` | string[] (GUIDs) | No | Updated library GUIDs. Pass `null` to leave unchanged. |
| `lockoutMinutes` | integer | No | New inactivity timeout in minutes. Pass `null` to leave unchanged. |
| `masterPin` | string | Conditional | Required if the master account has a PIN set. |
| `bypassPinOnLocalNetwork` | boolean | No | Updated local network PIN bypass setting. Pass `null` to leave unchanged. |
| `allowedDeviceIds` | string[] | No | Updated list of allowed device IDs. Pass `null` to leave unchanged. |
| `profileImage` | string | No | Base64-encoded JPEG data-URL or image URL representing the profile picture. Pass `""` to clear the picture, or `null` to leave unchanged. |

* **Response:** `200 OK` on success.

### `POST /plugins/profiles/delete`
Permanently deletes a sub-profile and its underlying Jellyfin account.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request Body:**
```json
{
  "profileId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b",
  "masterPin": "1234"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `profileId` | string (GUID) | Yes | Jellyfin user ID of the profile to delete. |
| `masterPin` | string | Conditional | Required if the master account has a PIN set. |

* **Response:** `200 OK` on success.

### `GET /plugins/profiles/libraries`
Retrieves media library folders visible to the master user.

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

| Field | Type | Description |
|---|---|---|
| `id` | string (GUID) | Library folder GUID. |
| `name` | string | Display name of the library. |
| `collectionType` | string | Type of media collection (e.g., "movies", "tvshows"). |

---

## Images API

### `GET /plugins/profiles/image/{profileId}`
Serves the custom profile picture file for the specified profile.

* **Parameters:**
  * `profileId`: string (GUID) in path.
* **Response:**
  * `200 OK`: Binary image file (JPEG or PNG).
  * `302 Found`: Redirect to the external image URL if not stored locally.
  * `404 Not Found`: Profile or image not found.

---

## Devices API

### `GET /plugins/profiles/devices`
Retrieves all logged devices that have interacted with the plugin (server-wide).

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

| Field | Type | Description |
|---|---|---|
| `deviceId` | string | Recorded device identifier. |
| `deviceName` | string | Display name of the device. |
| `client` | string | Client application name. |
| `lastSeen` | string (ISO-8601) | Timestamp of the last interaction. |

### `POST /plugins/profiles/devices/delete`
Deletes a device from the known devices log.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request Body:**
```json
{
  "deviceId": "57bfa7e8d35f492b950bf93c9d747a11"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `deviceId` | string | Yes | The device ID to remove. |

* **Response:** `200 OK` on success.

---

## Bonfire API

### `GET /plugins/profiles/bonfire/status`
Retrieves the bonfire group status and visibility settings for the caller.

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

| Field | Type | Description |
|---|---|---|
| `isOwner` | boolean | Indicates if the master user owns a Bonfire group. |
| `ownedCode` | string | 6-character alphanumeric join code for the owned group. Null if none. |
| `ownedMembers` | array | List of guest master users in the owned group. Each member has `userId` and `username`. |
| `isMember` | boolean | Indicates if the master user has joined another user's Bonfire group. |
| `joinedOwnerName` | string | Username of the owner of the joined group. Null if none. |
| `joinedOwnerId` | string (GUID) | User ID of the owner of the joined group. Null if none. |
| `hideMySubProfilesFromOthers` | boolean | If true, local sub-profiles are hidden from Bonfire group members. |
| `hideOthersSubProfilesFromMe` | boolean | If true, remote sub-profiles are hidden locally. |

### `POST /plugins/profiles/bonfire/settings`
Updates the visibility preferences for sharing profiles in Bonfire crossover homes.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request Body:**
```json
{
  "hideMySubProfilesFromOthers": false,
  "hideOthersSubProfilesFromMe": false
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `hideMySubProfilesFromOthers` | boolean | Yes | Hide local sub-profiles from Bonfire group members. |
| `hideOthersSubProfilesFromMe` | boolean | Yes | Hide remote sub-profiles locally. |

* **Response:** `200 OK` on success.

### `POST /plugins/profiles/bonfire/generate`
Generates a new 6-character alphanumeric bonfire join code.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Response `200 OK`:**
```json
{
  "groupId": "4f5c9e2b",
  "bonfireCode": "B7F8XA",
  "members": []
}
```

| Field | Type | Description |
|---|---|---|
| `groupId` | string | Identifier of the generated Bonfire group. |
| `bonfireCode` | string | Alphanumeric code needed to join the group. |
| `members` | array | List of group members. |

### `POST /plugins/profiles/bonfire/join`
Joins a target group using its 6-character code. Rate limited to 3 failed attempts in 15 minutes.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request Body:**
```json
{
  "code": "B7F8XA"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string | Yes | 6-character alphanumeric Bonfire join code. |

* **Response `200 OK`:**
```json
{
  "message": "Successfully joined Bonfire group.",
  "ownerName": "FriendMaster"
}
```

| Field | Type | Description |
|---|---|---|
| `message` | string | Confirmation message of successful group joining. |
| `ownerName` | string | Username of the bonfire group owner. |

* **Error Responses:**
  * `400 Bad Request`: Invalid code format, invalid Bonfire Code, or attempting to join owned group.
  * `401 Unauthorized`: Caller is not authenticated, or caller is not a master profile.
  * `429 Too Many Requests`: Join rate limit exceeded (3 failed attempts per 15 minutes).

### `POST /plugins/profiles/bonfire/kick`
Kicks a guest master user from the owned bonfire group.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Request Body:**
```json
{
  "memberId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `memberId` | string (GUID) | Yes | The user ID of the guest member to remove. |

* **Response:** `200 OK` on success.

### `POST /plugins/profiles/bonfire/leave`
Leaves the currently joined bonfire group.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Response:** `200 OK` on success.

### `POST /plugins/profiles/bonfire/delete-group`
Dissolves the owned bonfire group. All member associations are removed.

* **Headers:** `Authorization: MediaBrowser Token="<masterToken>"`
* **Response:** `200 OK` on success.

---

## Admin API

### `GET /plugins/profiles/admin/mappings`
Retrieves all user profile mappings configured on the server.

* **Headers:** `Authorization: MediaBrowser Token="<adminToken>"`
* **Response `200 OK`:**
```json
{
  "masterUsers": [
    {
      "profileUserId": "8e3cdfa5-79a8-4bb9-bd9a-0e96b7dc974a",
      "profileName": "john",
      "requiresPin": true,
      "maxProfiles": 5,
      "limitOverride": null
    }
  ],
  "subProfiles": [
    {
      "profileUserId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b",
      "profileName": "Kids",
      "masterName": "john",
      "requiresPin": false
    }
  ],
  "injectionSucceeded": true
}
```

| Field | Type | Description |
|---|---|---|
| `masterUsers` | array | List of master accounts. Each entry has `profileUserId`, `profileName`, `requiresPin`, `maxProfiles`, and `limitOverride`. |
| `subProfiles` | array | List of sub-profiles. Each entry has `profileUserId`, `profileName`, `masterName`, and `requiresPin`. |
| `injectionSucceeded` | boolean | Indicates if the client-side script auto-injection into `index.html` succeeded. |

* **Error Responses:**
  * `401 Unauthorized`: Caller is not authenticated, or caller is not an administrator.

### `POST /plugins/profiles/admin/reset-pin`
Removes the PIN requirement from the specified profile.

* **Headers:** `Authorization: MediaBrowser Token="<adminToken>"`
* **Request Body:**
```json
{
  "profileId": "a90f11cb-42a1-432d-94bb-97cc2d42ef8b"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `profileId` | string (GUID) | Yes | The user ID of the target profile. |

* **Response:** `200 OK` on success.

* **Error Responses:**
  * `401 Unauthorized`: Caller is not authenticated, or caller is not an administrator.
  * `404 Not Found`: Profile mapping not found.

### `POST /plugins/profiles/admin/set-profile-limit`
Overrides the maximum number of profiles a master user is allowed to create.

* **Headers:** `Authorization: MediaBrowser Token="<adminToken>"`
* **Request Body:**
```json
{
  "userId": "8e3cdfa5-79a8-4bb9-bd9a-0e96b7dc974a",
  "maxProfiles": 8
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `userId` | string (GUID) | Yes | The user ID of the master account to override. |
| `maxProfiles` | integer | No | The custom maximum profiles limit. Pass null to remove override. |

* **Response:** `200 OK` on success.

* **Error Responses:**
  * `400 Bad Request`: Maximum profiles must be at least 1, or plugin configuration missing.
  * `401 Unauthorized`: Caller is not authenticated, or caller is not an administrator.

### `GET /plugins/profiles/admin/audit-logs`
Retrieves recent profile switching event logs.

* **Headers:** `Authorization: MediaBrowser Token="<adminToken>"`
* **Response `200 OK`:**
```json
[
  {
    "timestamp": "2026-06-12T20:52:00Z",
    "masterUsername": "john",
    "targetUsername": "Kids",
    "deviceName": "Chrome",
    "client": "Jellyfin Web",
    "ipAddress": "192.168.1.50"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `timestamp` | string (ISO-8601) | Timestamp of the profile switch event. |
| `masterUsername` | string | Username of the master account owner. |
| `targetUsername` | string | Username of the profile switched to. |
| `deviceName` | string | Recorded device name. |
| `client` | string | Recorded client name. |
| `ipAddress` | string | Client IP address. |

* **Error Responses:**
  * `401 Unauthorized`: Caller is not authenticated, or caller is not an administrator.
