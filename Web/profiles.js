(function () {
    'use strict';

    const ProfilesPlugin = {
        config: {
            masterStorageKey: 'jellyfin_profiles_master_state',
            activeSessionKey: 'jellyfin_profiles_active_token',
            // Key set before window.location.reload() so the early-hide
            // inline head script can suppress the page flash on the next load.
            switchingKey: 'jpf-sw'
        },
        pluginId: 'b1462fca-774b-4b13-8d02-e2d4f2bc18b9',
        isManageMode: false,
        masterPin: null,
        cachedProfiles: [],
        inactivityTimer: null,
        inactivityEventHandlers: null,
        _pageRevealed: false,

        getAuthHeaders: function (token) {
            const apiClient = ApiClient;
            const client = typeof apiClient.appName === 'function' ? apiClient.appName() : (apiClient.appName || apiClient._appName || 'Jellyfin Web');
            const device = typeof apiClient.deviceName === 'function' ? apiClient.deviceName() : (apiClient.deviceName || apiClient._deviceName || 'Chrome');
            const deviceId = typeof apiClient.deviceId === 'function' ? apiClient.deviceId() : (apiClient.deviceId || apiClient._deviceId || '');
            const version = typeof apiClient.appVersion === 'function' ? apiClient.appVersion() : (apiClient.appVersion || apiClient._appVersion || '');

            return {
                'Authorization': `MediaBrowser Client="${client}", Device="${device}", DeviceId="${deviceId}", Version="${version}", Token="${token}"`
            };
        },

        updateStoredCredentials: function (newToken, newUserId) {
            try {
                const credsStr = localStorage.getItem('jellyfin_credentials');
                if (credsStr) {
                    const creds = JSON.parse(credsStr);
                    if (creds && Array.isArray(creds.Servers)) {
                        const currentServerId = typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : (ApiClient.serverId || '');
                        creds.Servers.forEach(server => {
                            if (!currentServerId || server.Id === currentServerId || creds.Servers.length === 1) {
                                server.AccessToken = newToken;
                                server.UserId = newUserId;
                            }
                        });
                        localStorage.setItem('jellyfin_credentials', JSON.stringify(creds));
                    }
                }
            } catch (e) {
                console.error("ProfilesPlugin: Stored credentials update failed:", e);
            }
        },

        normalizeGuid: function (guid) {
            if (!guid) return '';
            return guid.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
        },

        init: function () {
            if (typeof ApiClient === 'undefined') {
                // If ApiClient is not defined yet, wait for it
                setTimeout(() => this.init(), 100);
                return;
            }
            // viewshow fires when Jellyfin's React view system finishes rendering a view.
            // We gate _revealPage() on this event so we never fade in to a blank shell.
            this._viewShowFired = false;
            this._pendingReveal = false;
            this.bindEvents();
            this.injectStyles();
            this.validateSessionState();
            // If the user refreshes while a profile is active, restart the inactivity timer
            setTimeout(() => this.initLockoutTimer(), 800);
        },

        bindEvents: function () {
            const doCheck = () => this.checkRoute();

            // Jellyfin view-system events (fires on every page/view change)
            // Use doCheck so all logic is centralised in checkRoute.
            document.addEventListener('viewshow', () => {
                // Mark the view as ready so _revealPage() knows content is rendered.
                this._viewShowFired = true;
                // If _revealPage() was deferred waiting for this event, run it now.
                if (this._pendingReveal) this._revealPage();
                doCheck();
            });

            // SPA navigation events
            window.addEventListener('popstate', doCheck);
            window.addEventListener('hashchange', doCheck);

            // Intercept history.pushState / replaceState (React-router style navigation)
            ['pushState', 'replaceState'].forEach(method => {
                const orig = history[method];
                history[method] = function (...args) {
                    orig.apply(history, args);
                    // Small delay so the URL is committed before we read it
                    setTimeout(doCheck, 0);
                };
            });

            // Reduced polling interval: 150 ms catches DOM changes (e.g. video OSD
            // appearing) within a single frame budget without noticeable CPU impact.
            setInterval(doCheck, 150);

            // Initial check on load
            setTimeout(doCheck, 200);
        },

        checkRoute: function () {
            const hash = window.location.hash || '';
            const path = window.location.pathname || '';
            
            // Check if we are on the home screen
            // The home screen route can be: empty, '#/', '#/home', '#/home.html', or similar.
            // But we must NOT trigger it if we are on pages like configuration, plugins, selectserver, login, etc.
            const isIgnoredPage = hash.includes('configuration') || 
                                 hash.includes('plugin') || 
                                 hash.includes('login') || 
                                 hash.includes('selectserver') ||
                                 path.includes('configuration') ||
                                 path.includes('plugin') ||
                                 path.includes('login') ||
                                 path.includes('selectserver');

            const isHome = !isIgnoredPage && (
                hash === '' || 
                hash === '#/' || 
                hash.includes('home') || 
                path.endsWith('/home') || 
                path.endsWith('/home.html') ||
                // If there is no hash and we are at /web/index.html or root
                (!hash && (path.endsWith('index.html') || path === '/' || path === '/web/'))
            );

            // skipReveal: set to true when we know the gate overlay is about to be shown.
            // In that case showProfileOverlay() will call _revealPage() once the overlay
            // covers the page, preventing a blank-home flash during the async profile fetch.
            let skipReveal = false;

            if (isHome) {
                if (!this.isProfileSessionActive() && !document.getElementById('profiles-gate-overlay')) {
                    skipReveal = true;
                    this.interceptHomeAndShowProfiles();
                }
            } else {
                // If we navigate away from home, ensure the overlay is removed if it somehow got stuck
                if (document.getElementById('profiles-gate-overlay') && this.isProfileSessionActive()) {
                    this.removeProfileOverlay();
                }
            }

            // Monitor and hide shadow profiles from admin user management list
            const isUsersPage = hash.includes('users') || path.includes('users');
            if (isUsersPage) {
                this.monitorAndHideShadowProfiles();
            } else {
                if (this.usersObserver) {
                    this.usersObserver.disconnect();
                    this.usersObserver = null;
                }
                this.isMonitoringUsers = false;
                this.subProfileIdsToHide = null;
            }

            // ── Active player: URL-based detection ──────────────────────────────
            const isActivePlayer = hash.includes('videoosd') ||
                                   hash.includes('/nowplaying') ||
                                   (hash.includes('video') && !hash.includes('videos'));

            // ── Active player: DOM-based detection (catches delayed URL updates) ──
            // The OSD element appears in the DOM the moment playback starts.
            const hasOsdDom = !!document.querySelector(
                '.videoOsdBottom, .osdControls, .upNextContainer, ' +
                '[class*="videoOsd"], [class*="osdBottom"], .btnExitVideo'
            );

            // ── Admin / server-management pages ─────────────────────────────────
            // Exception: our own plugin settings page (configurationpage?name=Profiles)
            // is the only admin-area page where the button should remain visible.
            const isProfilesSettingsPage = hash.includes('configurationpage') &&
                                           hash.toLowerCase().includes('name=profiles');

            const isDashboard = !isProfilesSettingsPage && (
                hash.includes('dashboard')       || hash.includes('/admin')       ||
                hash.includes('useredit')        || hash.includes('usernew')      ||
                hash.includes('userparentalcontrol') || hash.includes('userlibraryaccess') ||
                hash.includes('userpassword')    || hash.includes('scheduledtasks') ||
                hash.includes('serveractivity')  || hash.includes('installedplugins') ||
                hash.includes('pluginscatalog')  || hash.includes('apikeys')      ||
                hash.includes('devices')         || hash.includes('dlnaprofiles') ||
                hash.includes('dlnasettings')    || hash.includes('networking')   ||
                hash.includes('notificationlist')|| hash.includes('streamingsettings') ||
                hash.includes('playbackconfiguration') ||                           
                hash.includes('library.html')    || hash.includes('librarydisplay') ||
                hash.includes('librarypathmapping') || hash.includes('log.html')  ||
                hash.includes('metadataeditor')  || hash.includes('metadatamanager') ||
                hash.includes('edititemmetadata')|| hash.includes('mediainfo')    ||
                hash.includes('configurationpage')  || // all other plugin config pages
                path.includes('dashboard')       || path.includes('/admin')
            );

            const viewType = (isActivePlayer || hasOsdDom) ? 'videoosd'
                           : isDashboard                   ? 'dashboard'
                           : isHome                        ? 'home'
                                                          : 'other';
            this._lastRouteType = viewType;
            this.evaluateFloatingBubbleVisibility(viewType);

            // Reveal the page now that the gate decision has been made.
            // Skip when skipReveal is set — the overlay isn't in the DOM yet and
            // revealing now would show a blank page during the profile fetch.
            if (!skipReveal) this._revealPage();

            // Inject sidebar link fallbacks for TV D-pad targeting
            this.injectSidebarLink();
        },

        // Smoothly fades the page back in after a profile switch.
        // Guards on _viewShowFired to ensure React has rendered the view before we
        // expose it — otherwise a blank white shell flashes for a moment.
        _revealPage: function () {
            if (this._pageRevealed || !document.documentElement.style.opacity) return;

            // Defer until Jellyfin's view system has finished rendering the view.
            // _viewShowFired is set by the viewshow listener in bindEvents().
            if (!this._viewShowFired) {
                this._pendingReveal = true;
                return;
            }

            this._pageRevealed = true;
            this._pendingReveal = false;

            if (window.__jpReveal) {
                clearTimeout(window.__jpReveal);
                window.__jpReveal = null;
            }

            document.documentElement.style.transition = 'opacity 0.18s ease';
            document.documentElement.style.opacity = '1';
            setTimeout(() => {
                document.documentElement.style.removeProperty('opacity');
                document.documentElement.style.removeProperty('transition');
                document.documentElement.style.removeProperty('background');
                document.documentElement.style.removeProperty('color-scheme');
                this._pageRevealed = false;
            }, 220);
        },

        isMonitoringUsers: false,
        subProfileIdsToHide: null,
        usersObserver: null,

        monitorAndHideShadowProfiles: function () {
            const apiClient = ApiClient;
            if (!apiClient) return;

            // Fetch only once per page visit
            if (this.isMonitoringUsers) {
                this.applyUsersHide();
                return;
            }
            this.isMonitoringUsers = true;

            const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
            const token = masterState ? masterState.masterToken : apiClient.accessToken();
            if (!token) return;

            const url = apiClient.getUrl('plugins/profiles/admin/mappings');
            fetch(url, {
                headers: this.getAuthHeaders(token)
            })
            .then(res => {
                if (!res.ok) throw new Error("Could not load mappings");
                return res.json();
            })
            .then(data => {
                const subProfiles = data.SubProfiles || [];
                this.subProfileIdsToHide = subProfiles.map(p => this.normalizeGuid(p.ProfileUserId));
                
                // Start a MutationObserver to hide cards as they are rendered dynamically
                if (this.usersObserver) {
                    this.usersObserver.disconnect();
                }

                this.usersObserver = new MutationObserver(() => this.applyUsersHide());
                this.usersObserver.observe(document.body, { childList: true, subtree: true });
                this.applyUsersHide();
            })
            .catch(err => {
                console.error("ProfilesPlugin: Error fetching admin mappings for hide logic:", err);
                this.isMonitoringUsers = false;
            });
        },

        applyUsersHide: function () {
            if (!this.subProfileIdsToHide || this.subProfileIdsToHide.length === 0) return;

            // Find all cards, list items, or elements with data-id or containing useredit links
            const cards = document.querySelectorAll('.card, .listItem, [data-id]');
            cards.forEach(card => {
                let id = card.getAttribute('data-id');
                if (id) {
                    id = this.normalizeGuid(id);
                    if (this.subProfileIdsToHide.includes(id)) {
                        card.style.display = 'none';
                        return;
                    }
                }

                // Check for links inside (e.g. useredit.html?userId=...)
                const links = card.querySelectorAll('a');
                for (let i = 0; i < links.length; i++) {
                    const href = links[i].getAttribute('href') || '';
                    if (href.includes('userId=')) {
                        const match = href.match(/userId=([^&]+)/);
                        if (match) {
                            const normalizedId = this.normalizeGuid(match[1]);
                            if (this.subProfileIdsToHide.includes(normalizedId)) {
                                card.style.display = 'none';
                                break;
                            }
                        }
                    }
                }
            });
        },

        isProfileSessionActive: function () {
            return !!sessionStorage.getItem(this.config.activeSessionKey);
        },

        getCachedActiveProfile: function () {
            const activeInfoStr = sessionStorage.getItem('jellyfin_profiles_active_info');
            if (activeInfoStr) {
                try {
                    const info = JSON.parse(activeInfoStr);
                    if (info && info.initial && info.color) return info;
                } catch (e) {}
            }

            // Fallback: search in localStorage cached profiles
            const currentUserId = ApiClient.getCurrentUserId();
            if (currentUserId) {
                try {
                    const cachedListStr = localStorage.getItem('jellyfin_profiles_cached_list');
                    if (cachedListStr) {
                        const profiles = JSON.parse(cachedListStr);
                        if (Array.isArray(profiles)) {
                            const profile = profiles.find(p => this.normalizeGuid(p.profileUserId) === this.normalizeGuid(currentUserId));
                            if (profile) {
                                const info = {
                                    name: profile.profileName,
                                    color: profile.avatarColor || '#00A4DC',
                                    initial: profile.avatarInitial || (profile.profileName ? profile.profileName.charAt(0).toUpperCase() : 'P')
                                };
                                // Store it in sessionStorage for future fast access
                                sessionStorage.setItem('jellyfin_profiles_active_info', JSON.stringify(info));
                                return info;
                            }
                        }
                    }
                } catch (e) {
                    console.error("ProfilesPlugin: Failed to read from profiles cache:", e);
                }
            }

            // Ultimate fallback (e.g. before any profile list has been loaded)
            return {
                name: 'Profiles',
                color: '#00A4DC',
                initial: 'P'
            };
        },

        validateSessionState: function () {
            const apiClient = ApiClient;
            if (!apiClient) return;

            const hash = window.location.hash || '';
            const path = window.location.pathname || '';
            if (hash.includes('login') || hash.includes('selectserver') || path.includes('login') || path.includes('selectserver')) {
                localStorage.removeItem(this.config.masterStorageKey);
                sessionStorage.removeItem(this.config.activeSessionKey);
                sessionStorage.removeItem('jellyfin_profiles_active_info');
                return;
            }

            const currentToken = apiClient.accessToken();
            if (!currentToken) return;

            // Dual-token check: if tab/app was closed, sessionStorage is wiped out.
            // If the current token in Jellyfin is NOT the master token, but sessionStorage is empty,
            // we must revert the browser to the master token and force the selection gate to display.
            const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
            if (masterState && masterState.masterToken) {
                const currentUserId = apiClient.getCurrentUserId();
                if (this.normalizeGuid(currentUserId) === this.normalizeGuid(masterState.masterUserId)) {
                    if (currentToken !== masterState.masterToken) {
                        masterState.masterToken = currentToken;
                        localStorage.setItem(this.config.masterStorageKey, JSON.stringify(masterState));
                        console.log("ProfilesPlugin: Master session token updated to match new valid token.");
                    }
                } else if (currentToken !== masterState.masterToken && !this.isProfileSessionActive()) {
                    this.updateStoredCredentials(masterState.masterToken, masterState.masterUserId);
                    apiClient.setAuthenticationInfo(masterState.masterToken, masterState.masterUserId);
                    // Hide current page instantly so there is no visible frame
                    // between old page unloading and new page's head script running.
                    document.documentElement.style.cssText = 'opacity:0;background:#101010;color-scheme:dark';
                    localStorage.setItem(this.config.switchingKey, '1');
                    window.location.reload();
                }
            }
        },

        handleSessionExpired: function () {
            console.warn("ProfilesPlugin: Master session expired or invalid. Redirecting to login.");
            localStorage.removeItem(this.config.masterStorageKey);
            sessionStorage.removeItem(this.config.activeSessionKey);
            sessionStorage.removeItem('jellyfin_profiles_active_info');
            
            const apiClient = ApiClient;
            if (apiClient) {
                if (typeof apiClient.clearUser === 'function') {
                    apiClient.clearUser();
                } else if (typeof apiClient.logout === 'function') {
                    apiClient.logout();
                }
            }
            
            window.location.hash = '#/login';
            window.location.reload();
        },

        interceptHomeAndShowProfiles: function () {
            const apiClient = ApiClient;
            if (!apiClient) return;

            const masterUserId = apiClient.getCurrentUserId();
            const masterToken = apiClient.accessToken();

            if (!masterUserId || !masterToken) return;

            let masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey)) || {};
            if (!masterState.masterToken) {
                masterState.masterToken = masterToken;
                masterState.masterUserId = masterUserId;
                localStorage.setItem(this.config.masterStorageKey, JSON.stringify(masterState));
            }

            this.fetchAndRenderProfiles(apiClient, masterUserId, masterToken);
        },

        fetchAndRenderProfiles: function (apiClient, masterUserId, masterToken) {
            // Use the pre-fetched cache for an instant, flash-free overlay.
            // The cache is populated in the background by _prefetchProfiles() while
            // the user is on the home screen.  Clear it after use so the next call
            // always gets fresh data (profile list may have changed server-side).
            if (this.cachedProfiles && this.cachedProfiles.length) {
                const profiles = this.cachedProfiles;
                this.cachedProfiles = [];
                this._profilePrefetchPending = false;
                this.showProfileOverlay(profiles);
                return;
            }

            const url = apiClient.getUrl(`plugins/profiles/list`);
            
            fetch(url, {
                headers: this.getAuthHeaders(masterToken)
            })
            .then(res => {
                if (res.status === 401) {
                    this.handleSessionExpired();
                    throw new Error("Unauthorized");
                }
                return res.json();
            })
            .then(profiles => {
                const normalized = (profiles || []).map(p => ({
                    profileUserId: p.profileUserId || p.ProfileUserId,
                    profileName: p.profileName || p.ProfileName,
                    avatarInitial: p.avatarInitial || p.AvatarInitial,
                    avatarColor: p.avatarColor || p.AvatarColor,
                    requiresPin: p.requiresPin !== undefined ? p.requiresPin : p.RequiresPin,
                    isMaster: p.isMaster !== undefined ? p.isMaster : p.IsMaster,
                    lockoutMinutes: p.lockoutMinutes !== undefined ? p.lockoutMinutes : (p.LockoutMinutes !== undefined ? p.LockoutMinutes : 5),
                    maxSubProfiles: p.maxSubProfiles !== undefined ? p.maxSubProfiles : (p.MaxSubProfiles !== undefined ? p.MaxSubProfiles : 5),
                    bypassPinOnLocalNetwork: p.bypassPinOnLocalNetwork !== undefined ? p.bypassPinOnLocalNetwork : (p.BypassPinOnLocalNetwork !== undefined ? p.BypassPinOnLocalNetwork : false),
                    allowedDeviceIds: p.allowedDeviceIds || p.AllowedDeviceIds || [],
                    isBonfire: p.isBonfire !== undefined ? p.isBonfire : (p.IsBonfire !== undefined ? p.IsBonfire : false)
                }));
                this.cachedProfiles = normalized;
                localStorage.setItem('jellyfin_profiles_cached_list', JSON.stringify(normalized));
                this.showProfileOverlay(normalized);
            })
            .catch(err => {
                console.error("Failed to load sub-profiles:", err);
                localStorage.removeItem(this.config.masterStorageKey);
            });
        },

        showProfileOverlay: function (profiles) {
            // Always stop the inactivity timer when showing the profile selector
            this.stopInactivityTimer();

            const skinHeader = document.querySelector('.skinHeader');
            if (skinHeader) skinHeader.style.display = 'none';

            // Do NOT apply filter:blur to #view-home — it triggers a GPU compositing
            // layer creation which causes a one-frame white flash on first paint.
            // The overlay's solid-dark background makes the blur redundant anyway.

            let overlay = document.getElementById('profiles-gate-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'profiles-gate-overlay';
                // Start at opacity 0 so the browser creates the compositing layer
                // silently.  We fade it in via rAF once it exists in the DOM.
                overlay.style.opacity = '0';
                document.body.appendChild(overlay);
            }

            // Disable scrolling
            document.body.classList.add('profiles-no-scroll');
            document.documentElement.classList.add('profiles-no-scroll');

            this.renderOverlayContent(overlay, profiles);

            // Reveal the page NOW — the overlay covers the home screen so there
            // is no blank-page flash.  checkRoute() skipped _revealPage() earlier
            // specifically so we could do it here at the right moment.
            this._viewShowFired = true; // overlay is rendered; treat this as view-ready
            this._revealPage();

            // Two rAF calls: first lets the browser paint with opacity:0 (compositing
            // layer created silently), second begins the CSS opacity transition.
            requestAnimationFrame(() => requestAnimationFrame(() => {
                overlay.style.opacity = ''; // CSS transition takes over
            }));

            // Auto-focus the first interactive element so TV/keyboard users
            // don't need to Tab before they can navigate the profile grid.
            setTimeout(() => {
                const first = overlay.querySelector('[tabindex="0"], button, input');
                if (first) first.focus();
            }, 100);
        },

        removeProfileOverlay: function () {
            const overlay = document.getElementById('profiles-gate-overlay');
            if (overlay) overlay.remove();

            // Re-enable scrolling
            document.body.classList.remove('profiles-no-scroll');
            document.documentElement.classList.remove('profiles-no-scroll');

            const skinHeader = document.querySelector('.skinHeader');
            if (skinHeader) skinHeader.style.display = '';

            // Note: view-home blur no longer applied (removed in v1.0.14)
        },

        // ─── Inactivity Lockout Timer ─────────────────────────────────────────────

        // Called on page load when an active profile session already exists.
        // Fetches /list (using the master token) to find the active profile's
        // lockout setting, then arms the inactivity timer.
        initLockoutTimer: function () {
            if (!this.isProfileSessionActive()) return;

            const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
            if (!masterState || !masterState.masterToken) return;

            const apiClient = ApiClient;
            if (!apiClient) return;

            const currentUserId = typeof apiClient.getCurrentUserId === 'function'
                ? apiClient.getCurrentUserId() : null;
            if (!currentUserId) return;

            const url = apiClient.getUrl('plugins/profiles/list');
            fetch(url, { headers: this.getAuthHeaders(masterState.masterToken) })
            .then(res => { if (!res.ok) throw new Error('fail'); return res.json(); })
            .then(profiles => {
                const active = (profiles || []).find(p => {
                    const id = p.profileUserId || p.ProfileUserId;
                    return this.normalizeGuid(id) === this.normalizeGuid(currentUserId);
                });
                if (!active) return;
                const requiresPin = active.requiresPin !== undefined ? active.requiresPin : active.RequiresPin;
                if (!requiresPin) return; // No PIN = no lockout
                const minutes = active.lockoutMinutes !== undefined ? active.lockoutMinutes
                    : (active.LockoutMinutes !== undefined ? active.LockoutMinutes : 5);
                if (minutes > 0) this.startInactivityTimer(minutes);
            })
            .catch(() => { /* silent — lockout timer is best-effort */ });
        },

        // Arms the inactivity timer. Resets on any user interaction.
        // Any device event (mouse, keyboard, touch, pointer, scroll) counts as activity,
        // making this safe for TV remotes, magic remotes, game pads, and touchscreens.
        startInactivityTimer: function (minutes) {
            this.stopInactivityTimer();
            const ms = minutes * 60 * 1000;
            const events = [
                'mousemove', 'mousedown', 'keydown',
                'touchstart', 'scroll', 'wheel', 'click',
                'pointermove', 'pointerdown'  // covers LG Magic Remote and pointer-based TV inputs
            ];

            const resetTimer = () => {
                clearTimeout(this.inactivityTimer);
                this.inactivityTimer = setTimeout(() => this.lockActiveProfile(), ms);
            };

            events.forEach(ev => document.addEventListener(ev, resetTimer, { passive: true }));
            this.inactivityEventHandlers = { resetTimer, events };
            resetTimer(); // Arm immediately
        },

        stopInactivityTimer: function () {
            clearTimeout(this.inactivityTimer);
            this.inactivityTimer = null;
            if (this.inactivityEventHandlers) {
                const { resetTimer, events } = this.inactivityEventHandlers;
                events.forEach(ev => document.removeEventListener(ev, resetTimer));
                this.inactivityEventHandlers = null;
            }
        },

        // Called when the inactivity timer fires. Clears the active session,
        // restores master credentials, then shows the profile selector.
        lockActiveProfile: function () {
            this.stopInactivityTimer();
            sessionStorage.removeItem(this.config.activeSessionKey);
            sessionStorage.removeItem('jellyfin_profiles_active_info');
            const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
            if (masterState) {
                this.updateStoredCredentials(masterState.masterToken, masterState.masterUserId);
                ApiClient.setAuthenticationInfo(masterState.masterToken, masterState.masterUserId);
            }
            this.interceptHomeAndShowProfiles();
        },


        renderOverlayContent: function (overlay, profiles) {
            const title = this.isManageMode ? "Manage Profiles" : "Who's Watching?";
            const manageBtnText = this.isManageMode ? "Done" : "Manage Profiles";

            const masterProfile = profiles.find(p => p.isMaster);
            const maxSubProfiles = masterProfile ? masterProfile.maxSubProfiles : 5;
            const subProfileCount = profiles.filter(p => !p.isMaster).length;
            const atLimit = subProfileCount >= maxSubProfiles;

            overlay.innerHTML = `
                <div class="profiles-modal-content anim-fade-in">
                    <h1 class="profiles-title">${title}</h1>
                    <div class="profiles-grid">
                        ${profiles.map(p => `
                            <div class="profile-card ${this.isManageMode ? 'manage-mode' : ''}" data-id="${p.profileUserId}" data-pin="${p.requiresPin}" tabindex="0">
                                <div class="profile-avatar-container">
                                    ${p.isMaster ? `
                                    <div class="profile-crown">
                                        <svg viewBox="0 0 24 24" fill="currentColor" style="width: 28px; height: 28px; color: #ffb800; filter: drop-shadow(0 2px 5px rgba(0,0,0,0.55));">
                                            <path d="M5 16h14a1 1 0 0 0 1-.76l2.89-10.12a.5.5 0 0 0-.74-.53l-5.6 3.73-4.11-6.17a.5.5 0 0 0-.88 0L7.45 8.32 1.85 4.59a.5.5 0 0 0-.74.53L4 15.24a1 1 0 0 0 1 .76z"/>
                                            <rect x="4" y="18" width="16" height="2" rx="1"/>
                                        </svg>
                                    </div>
                                    ` : ''}
                                    <div class="profile-avatar" style="background-color: ${p.avatarColor}">
                                        ${p.avatarInitial}
                                        ${this.isManageMode ? `
                                        <div class="profile-avatar-overlay-wrap">
                                            <svg class="profile-avatar-overlay-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 32px; height: 32px; color: #fff;">
                                                <path d="M12 20h9"></path>
                                                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                                            </svg>
                                        </div>
                                        ` : ''}
                                    </div>
                                    ${p.requiresPin ? `
                                    <div class="profile-lock-indicator">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px; color: #fff;">
                                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                                        </svg>
                                    </div>
                                    ` : ''}
                                    ${p.isBonfire ? `
                                    <div class="profile-bonfire-indicator" title="Bonfire Profile">
                                        <span class="material-icons" style="font-size: 1.15rem; color: #fff;">local_fire_department</span>
                                    </div>
                                    ` : ''}
                                </div>
                                <div class="profile-name">
                                    <span>${p.profileName}</span>
                                    ${this.isManageMode ? `
                                        <span class="profile-pin-badge ${p.requiresPin ? 'locked' : 'unlocked'}">
                                            ${p.requiresPin ? 'PIN Protected' : 'No PIN'}
                                        </span>
                                    ` : ''}
                                </div>
                            </div>
                        `).join('')}
                        
                        ${this.isManageMode && profiles.some(p => p.isMaster && !p.isBonfire) ? `
                        <div class="profile-card action-bonfire" tabindex="0">
                            <div class="profile-avatar-container">
                                <div class="profile-avatar" style="background: linear-gradient(135deg, #ff9900 0%, #ff5500 100%); display: flex; align-items: center; justify-content: center;">
                                    <span class="material-icons" style="font-size: 3.5rem; color: #fff;">local_fire_department</span>
                                </div>
                            </div>
                            <div class="profile-name">
                                <span>Bonfire</span>
                            </div>
                        </div>
                        ` : ''}

                        ${!this.isManageMode && !atLimit ? `
                        <div class="profile-card action-add-profile" tabindex="0">
                            <div class="profile-avatar-container">
                                <div class="profile-avatar add-avatar">+</div>
                            </div>
                            <div class="profile-name">Add Profile</div>
                        </div>
                        ` : (!this.isManageMode ? `
                        <div class="profiles-limit-notice">${subProfileCount}/${maxSubProfiles} profiles — limit reached</div>
                        ` : '')}
                    </div>
                    
                    <div class="profiles-footer">
                        <button id="profiles-toggle-manage-btn" class="profiles-btn btn-secondary">${manageBtnText}</button>
                    </div>
                </div>
            `;

            this.attachOverlayInteractions(overlay, profiles);
        },

        attachOverlayInteractions: function (overlay, profiles) {
            // Support D-pad Enter/Space selection on focused profile cards
            overlay.addEventListener('keydown', (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('profile-card')) {
                    e.preventDefault();
                    e.target.click();
                }
            });

            // Card selection logic
            overlay.querySelectorAll('.profile-card:not(.action-add-profile)').forEach(card => {
                card.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const profileId = card.getAttribute('data-id');
                    const profile = profiles.find(p => p.profileUserId === profileId);
                    if (!profile) return;

                    if (this.isManageMode) {
                        this.showEditProfileModal(profile);
                    } else {
                        if (profile.requiresPin) {
                            this.promptPinEntry(profileId);
                        } else {
                            this.executeProfileSwitch(profileId, null);
                        }
                    }
                });
            });

            // "Add Profile" action
            const addCard = overlay.querySelector('.action-add-profile');
            if (addCard) {
                addCard.addEventListener('click', () => {
                    const masterProfile = profiles.find(p => p.isMaster);
                    const masterRequiresPin = masterProfile && masterProfile.requiresPin;
                    
                    if (masterRequiresPin) {
                        ApiClient.getPluginConfiguration(this.pluginId).then(config => {
                            if (config.RequireMasterPinForCreation) {
                                this.promptMasterPinEntry('create', () => {
                                    this.showAddProfileModal();
                                });
                            } else {
                                this.showAddProfileModal();
                            }
                        }).catch(() => {
                            this.showAddProfileModal();
                        });
                    } else {
                        this.showAddProfileModal();
                    }
                });
            }

            // "Bonfire" action
            const bonfireCard = overlay.querySelector('.action-bonfire');
            if (bonfireCard) {
                bonfireCard.addEventListener('click', () => {
                    this.showBonfireModal();
                });
            }

            // "Manage Profiles" / "Done" toggle
            const manageBtn = document.getElementById('profiles-toggle-manage-btn');
            if (manageBtn) {
                manageBtn.addEventListener('click', () => {
                    if (this.isManageMode) {
                        this.isManageMode = false;
                        this.masterPin = null;
                        this.renderOverlayContent(overlay, profiles);
                    } else {
                        const masterProfile = profiles.find(p => p.isMaster);
                        if (masterProfile && masterProfile.requiresPin) {
                            this.promptMasterPinEntry('manage', () => {
                                this.isManageMode = true;
                                this.renderOverlayContent(overlay, profiles);
                            });
                        } else {
                            this.isManageMode = true;
                            this.renderOverlayContent(overlay, profiles);
                        }
                    }
                });
            }
        },

        promptPinEntry: function (profileId) {
            const content = document.querySelector('.profiles-modal-content');
            content.innerHTML = `
                <h1 class="profiles-title">Enter Profile PIN</h1>
                <div class="pin-entry-container">
                    <input type="text" id="profile-pin-input" maxlength="8" pattern="[0-9]*" inputmode="numeric" placeholder="••••" autocomplete="one-time-code" data-1p-ignore data-lpignore="true" data-bwignore data-protonpass-ignore="true" autofocus />
                    <div id="pin-error-msg" style="display:none; color:#ff6b6b; font-size:0.9rem; font-weight:600; text-align:center; margin-top:-0.5rem;"></div>
                    <div class="pin-actions">
                        <button id="pin-submit-btn" class="profiles-btn btn-primary">Unlock</button>
                        <button id="pin-cancel-btn" class="profiles-btn btn-secondary">Back</button>
                    </div>
                </div>
            `;

            const pinInput = document.getElementById('profile-pin-input');
            const errorMsg = document.getElementById('pin-error-msg');
            pinInput.focus();

            // Track in-flight silent verify so we can cancel it if the user keeps typing,
            // and prevent a second switch from firing if one is already in progress.
            let verifyController = null;
            let switchInProgress = false;

            const showPinError = (msg) => {
                switchInProgress = false;
                pinInput.style.borderColor = '#ff6b6b';
                pinInput.style.boxShadow = '0 0 15px rgba(255,107,107,0.5)';
                errorMsg.textContent = msg || 'Incorrect PIN. Please try again.';
                errorMsg.style.display = 'block';
                pinInput.value = '';
                // setTimeout avoids re-triggering the 'input' clearError listener on refocus
                setTimeout(() => pinInput.focus(), 0);
            };

            const clearError = () => {
                pinInput.style.borderColor = '';
                pinInput.style.boxShadow = '';
                errorMsg.style.display = 'none';
                errorMsg.textContent = '';
            };

            pinInput.addEventListener('input', () => {
                clearError();
                const currentValue = pinInput.value;

                // Need at least 4 digits, and don't fire another switch if one is underway
                if (currentValue.length < 4 || switchInProgress) return;

                // Cancel any previous in-flight verify — only the latest keystroke matters
                if (verifyController) verifyController.abort();
                verifyController = typeof AbortController !== 'undefined' ? new AbortController() : null;

                const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
                if (!masterState) return;

                // Silent verify — no error shown on failure, user just keeps typing
                fetch(ApiClient.getUrl('plugins/profiles/verify-pin'), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...this.getAuthHeaders(masterState.masterToken)
                    },
                    body: JSON.stringify({ profileId: profileId, pin: currentValue }),
                    ...(verifyController ? { signal: verifyController.signal } : {})
                })
                .then(res => {
                    if (res.status === 401) {
                        this.handleSessionExpired();
                        return;
                    }
                    // Only proceed if PIN matched and nothing else already triggered a switch
                    if (res.ok && !switchInProgress) {
                        switchInProgress = true;
                        this.executeProfileSwitch(profileId, currentValue, () => {
                            // Verify said OK but switch failed (edge case) — reset silently
                            switchInProgress = false;
                        });
                    }
                })
                .catch(err => {
                    // AbortError = user typed another digit, a new verify is already in flight
                    // Other errors (network) = ignore silently, user can still hit Enter
                });
            });

            // Manual submit — only place where we show an error on wrong PIN
            const submitPin = () => {
                if (verifyController) verifyController.abort();
                verifyController = null;
                const pin = pinInput.value;
                if (!pin) return;
                this.executeProfileSwitch(profileId, pin, showPinError);
            };

            document.getElementById('pin-submit-btn').addEventListener('click', submitPin);
            pinInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') submitPin();
            });

            document.getElementById('pin-cancel-btn').addEventListener('click', () => {
                if (verifyController) verifyController.abort();
                this.isManageMode = false;
                this.showProfileOverlay(this.cachedProfiles);
            });
        },

        promptMasterPinEntry: function (actionType, callback) {
            const masterProfile = this.cachedProfiles.find(p => p.isMaster);
            if (!masterProfile) return;

            const content = document.querySelector('.profiles-modal-content');
            content.innerHTML = `
                <h1 class="profiles-title">Enter Master PIN</h1>
                <div class="pin-entry-container">
                    <input type="text" id="master-pin-input" maxlength="8" pattern="[0-9]*" inputmode="numeric" placeholder="••••" autocomplete="one-time-code" data-1p-ignore data-lpignore="true" data-bwignore data-protonpass-ignore="true" autofocus />
                    <div id="master-pin-error-msg" style="display:none; color:#ff6b6b; font-size:0.9rem; font-weight:600; text-align:center; margin-top:-0.5rem;"></div>
                    <div class="pin-actions">
                        <button id="master-pin-submit-btn" class="profiles-btn btn-primary">Submit</button>
                        <button id="master-pin-cancel-btn" class="profiles-btn btn-secondary">Cancel</button>
                    </div>
                </div>
            `;

            const pinInput = document.getElementById('master-pin-input');
            const errorMsg = document.getElementById('master-pin-error-msg');
            pinInput.focus();

            let verifyController = null;
            let verified = false; // prevent callback firing more than once

            const showPinError = (msg) => {
                verified = false;
                pinInput.style.borderColor = '#ff6b6b';
                pinInput.style.boxShadow = '0 0 15px rgba(255,107,107,0.5)';
                errorMsg.textContent = msg || 'Incorrect PIN. Please try again.';
                errorMsg.style.display = 'block';
                pinInput.value = '';
                setTimeout(() => pinInput.focus(), 0);
            };

            const clearError = () => {
                pinInput.style.borderColor = '';
                pinInput.style.boxShadow = '';
                errorMsg.style.display = 'none';
                errorMsg.textContent = '';
            };

            pinInput.addEventListener('input', () => {
                clearError();
                const currentValue = pinInput.value;
                if (currentValue.length < 4 || verified) return;

                // Cancel previous in-flight verify — only the latest matters
                if (verifyController) verifyController.abort();
                verifyController = typeof AbortController !== 'undefined' ? new AbortController() : null;

                const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
                if (!masterState) return;

                // Silent verify — no error on failure, user keeps typing
                fetch(ApiClient.getUrl('plugins/profiles/verify-pin'), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...this.getAuthHeaders(masterState.masterToken)
                    },
                    body: JSON.stringify({ profileId: masterProfile.profileUserId, pin: currentValue }),
                    ...(verifyController ? { signal: verifyController.signal } : {})
                })
                .then(res => {
                    if (res.status === 401) {
                        this.handleSessionExpired();
                        return;
                    }
                    if (res.ok && !verified) {
                        verified = true;
                        this.masterPin = currentValue;
                        callback();
                    }
                })
                .catch(() => {
                    // AbortError or network error — ignore silently
                });
            });

            // Manual submit — only place where we show an error on wrong master PIN
            const submitPin = () => {
                if (verifyController) verifyController.abort();
                verifyController = null;
                const pin = pinInput.value;
                if (!pin) return;

                const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
                if (!masterState) return;

                fetch(ApiClient.getUrl('plugins/profiles/verify-pin'), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...this.getAuthHeaders(masterState.masterToken)
                    },
                    body: JSON.stringify({ profileId: masterProfile.profileUserId, pin: pin })
                })
                .then(res => {
                    if (res.status === 401) {
                        this.handleSessionExpired();
                        throw new Error('Session expired');
                    }
                    if (!res.ok) throw new Error('Invalid PIN');
                    this.masterPin = pin;
                    callback();
                })
                .catch(err => {
                    if (err.message !== 'Session expired') {
                        showPinError('Incorrect Master PIN. Please try again.');
                    }
                });
            };

            document.getElementById('master-pin-submit-btn').addEventListener('click', submitPin);
            pinInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') submitPin();
            });

            document.getElementById('master-pin-cancel-btn').addEventListener('click', () => {
                if (verifyController) verifyController.abort();
                this.showProfileOverlay(this.cachedProfiles);
            });
        },

        // onError: optional callback(message) invoked on a failed switch.
        // Callers capture their own DOM references via closure so we never re-query
        // the DOM inside an async callback (which can race against overlay teardown).
        executeProfileSwitch: function (profileId, pin, onError) {
            const apiClient = ApiClient;
            const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
            if (!masterState) return;

            const url = apiClient.getUrl('plugins/profiles/switch');

            fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...this.getAuthHeaders(masterState.masterToken)
                },
                body: JSON.stringify({ profileId: profileId, pin: pin })
            })
            .then(res => {
                if (res.status === 401) {
                    this.handleSessionExpired();
                    throw new Error('Session expired');
                }
                if (!res.ok) throw new Error('Incorrect PIN');
                return res.json();
            })
            .then(data => {
                const activeProfileToken = data.activeProfileToken || data.ActiveProfileToken;
                const jellyfinUserId = data.jellyfinUserId || data.JellyfinUserId;

                if (this.normalizeGuid(jellyfinUserId) === this.normalizeGuid(masterState.masterUserId)) {
                    masterState.masterToken = activeProfileToken;
                    localStorage.setItem(this.config.masterStorageKey, JSON.stringify(masterState));
                }

                sessionStorage.setItem(this.config.activeSessionKey, activeProfileToken);
                
                const profile = this.cachedProfiles.find(p => this.normalizeGuid(p.profileUserId) === this.normalizeGuid(profileId));
                if (profile) {
                    sessionStorage.setItem('jellyfin_profiles_active_info', JSON.stringify({
                        name: profile.profileName,
                        color: profile.avatarColor,
                        initial: profile.avatarInitial
                    }));
                }

                this.updateStoredCredentials(activeProfileToken, jellyfinUserId);
                apiClient.setAuthenticationInfo(activeProfileToken, jellyfinUserId);

                // Keep the overlay visible through the reload — removing it first
                // would expose the home screen for a frame before opacity:0 kicks in.
                // The reload will naturally destroy the overlay on the new page.
                // Transitioning it to solid black blends with the new page's dark state.
                const overlay = document.getElementById('profiles-gate-overlay');
                if (overlay) {
                    overlay.style.transition = 'background 0.12s ease';
                    overlay.style.background = '#101010';
                }
                // Hide everything else instantly.
                document.documentElement.style.cssText = 'opacity:0;background:#101010;color-scheme:dark';
                localStorage.setItem(this.config.switchingKey, '1');
                window.location.reload();
            })
            .catch(err => {
                if (err.message === 'Session expired') return;
                if (typeof onError === 'function') {
                    // Caller has closed-over references to the DOM — no re-query needed
                    onError('Incorrect PIN. Please try again.');
                } else {
                    // Fallback: no PIN screen is currently shown (e.g. direct card tap without PIN prompt)
                    this.isManageMode = false;
                    this.interceptHomeAndShowProfiles();
                }
            });
        },

        showAddProfileModal: function () {
            const apiClient = ApiClient;
            const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
            if (!masterState) return;

            // Fetch libraries matching master user permissions and connected devices
            const libUrl = apiClient.getUrl('plugins/profiles/libraries');
            const devicesUrl = apiClient.getUrl('plugins/profiles/devices');

            Promise.all([
                fetch(libUrl, { headers: this.getAuthHeaders(masterState.masterToken) }).then(res => res.json()),
                fetch(devicesUrl, { headers: this.getAuthHeaders(masterState.masterToken) }).then(res => res.json()).catch(() => [])
            ])
            .then(([libraries, devices]) => {
                const normalizedLibs = (libraries || []).map(lib => ({
                    id: lib.id || lib.Id,
                    name: lib.name || lib.Name,
                    collectionType: lib.collectionType || lib.CollectionType
                }));
                const content = document.querySelector('.profiles-modal-content');
                content.innerHTML = `
                    <h1 class="profiles-title">Create Profile</h1>
                    <div class="create-profile-container">
                        <div class="form-group">
                            <label>Profile Name</label>
                            <input type="text" id="create-name-input" placeholder="e.g. Kids" required />
                        </div>
                        <div class="form-group">
                            <label>PIN Code (Optional, 4-8 digits)</label>
                            <input type="text" id="create-pin-input" maxlength="8" pattern="[0-9]*" inputmode="numeric" placeholder="Leave empty for no PIN" autocomplete="one-time-code" data-1p-ignore data-lpignore="true" data-bwignore data-protonpass-ignore="true" />
                        </div>
                        <div class="form-group">
                            <label class="library-check-label" style="display: inline-flex; align-items: center; gap: 0.5rem; cursor: pointer; user-select: none;">
                                <input type="checkbox" id="create-local-bypass-checkbox" style="cursor: pointer; accent-color: #00a4dc;" />
                                <span>Bypass PIN on local network (LAN)</span>
                            </label>
                            <div class="form-hint">If enabled, users on the local home network won't be prompted for a PIN.</div>
                        </div>
                        <div class="form-group">
                            <label>Auto-lock after inactivity</label>
                            <select id="create-lockout-select">
                                <option value="0">Never</option>
                                <option value="1">1 minute</option>
                                <option value="5" selected>5 minutes (default)</option>
                                <option value="10">10 minutes</option>
                                <option value="20">20 minutes</option>
                                <option value="30">30 minutes</option>
                                <option value="60">1 hour</option>
                            </select>
                            <div class="form-hint">Only applies when this profile has a PIN set</div>
                        </div>
                        <div class="form-group">
                            <label>Allowed Devices (Optional)</label>
                            <div class="devices-dropdown-container" style="position: relative;">
                                <div id="create-devices-dropdown-trigger" class="devices-dropdown-trigger" tabindex="0">
                                    <span id="create-devices-dropdown-selected-text">All Devices Allowed</span>
                                    <span style="font-size: 0.8rem; opacity: 0.7;">▼</span>
                                </div>
                                <div id="create-devices-dropdown-list" class="devices-dropdown-list" style="display: none; position: absolute; top: 100%; left: 0; right: 0; z-index: 10000; margin-top: 4px;">
                                    ${devices && devices.length > 0 ? devices.map(dev => {
                                        return `
                                            <div class="device-dropdown-item" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; flex: 1; margin: 0; font-size: 0.9rem;">
                                                    <input type="checkbox" class="create-device-checkbox" value="${dev.deviceId}" style="cursor: pointer; accent-color: #00a4dc;" />
                                                    <span style="display: flex; flex-direction: column;">
                                                        <span style="font-weight: 500;">${dev.deviceName}</span>
                                                        <span style="font-size: 0.75rem; opacity: 0.6;">${dev.client} • Last seen ${new Date(dev.lastSeen).toLocaleDateString()}</span>
                                                    </span>
                                                </label>
                                            </div>
                                        `;
                                    }).join('') : `
                                        <div style="padding: 12px; text-align: center; opacity: 0.6; font-size: 0.9rem;">No connected devices found</div>
                                    `}
                                </div>
                            </div>
                            <div class="form-hint">If no devices are selected, this profile can be accessed from any device.</div>
                        </div>
                        <div class="form-group">
                            <label>Avatar Color</label>
                            <div class="avatar-color-picker">
                                <div class="color-dot active" style="background-color: #00A4DC" data-color="#00A4DC" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #E50914" data-color="#E50914" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #22C55E" data-color="#22C55E" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #EAB308" data-color="#EAB308" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #A855F7" data-color="#A855F7" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #EC4899" data-color="#EC4899" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #F97316" data-color="#F97316" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #06B6D4" data-color="#06B6D4" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #3B82F6" data-color="#3B82F6" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #10B981" data-color="#10B981" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #6366F1" data-color="#6366F1" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #8B5CF6" data-color="#8B5CF6" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #D946EF" data-color="#D946EF" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #F43F5E" data-color="#F43F5E" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #14B8A6" data-color="#14B8A6" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #F59E0B" data-color="#F59E0B" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #84CC16" data-color="#84CC16" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #64748B" data-color="#64748B" tabindex="0"></div>
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Max Parental Rating Limit (Optional)</label>
                            <select id="create-rating-select">
                                <option value="">No Restrictions</option>
                                <option value="6">G / TV-G (6+)</option>
                                <option value="10">PG / TV-PG (10+)</option>
                                <option value="14">PG-13 / TV-14 (14+)</option>
                                <option value="17">R / TV-MA (17+)</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.2rem;">
                                <label style="margin: 0;">Enabled Libraries</label>
                                <label class="library-check-label" style="font-size: 0.85rem; color: rgba(255,255,255,0.6); margin: 0; display: inline-flex; align-items: center; gap: 0.4rem;">
                                    <input type="checkbox" id="create-select-all-libraries" style="margin: 0; cursor: pointer; accent-color: #00a4dc;" />
                                    <span>Select all</span>
                                </label>
                            </div>
                            <div class="library-checklist">
                                ${normalizedLibs.map(lib => `
                                    <label class="library-check-label">
                                        <input type="checkbox" class="library-checkbox" value="${lib.id}" />
                                        <span>${lib.name}</span>
                                    </label>
                                `).join('')}
                            </div>
                        </div>
                        <div id="create-error-msg" style="display:none; color:#ff6b6b; font-size:0.88rem; font-weight:600; text-align:center; padding: 8px 12px; background: rgba(255,107,107,0.1); border-radius:8px; border: 1px solid rgba(255,107,107,0.25);"></div>
                        <div class="pin-actions">
                            <button id="create-submit-btn" class="profiles-btn btn-primary">Create</button>
                            <button id="create-cancel-btn" class="profiles-btn btn-secondary">Cancel</button>
                        </div>
                    </div>
                `;

                // Color selector interaction
                const dots = content.querySelectorAll('.color-dot');
                let selectedColor = '#00A4DC';
                dots.forEach(dot => {
                    dot.addEventListener('click', () => {
                        dots.forEach(d => d.classList.remove('active'));
                        dot.classList.add('active');
                        selectedColor = dot.getAttribute('data-color');
                    });
                });

                // Support D-pad Enter/Space select on color dots
                content.addEventListener('keydown', (e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('color-dot')) {
                        e.preventDefault();
                        e.target.click();
                    }
                });

                // Select all libraries logic for creation
                const selectAllCheckbox = document.getElementById('create-select-all-libraries');
                const libCheckboxes = content.querySelectorAll('.library-checkbox');
                if (selectAllCheckbox) {
                    selectAllCheckbox.addEventListener('change', (e) => {
                        const isChecked = e.target.checked;
                        libCheckboxes.forEach(cb => {
                            cb.checked = isChecked;
                        });
                    });

                    libCheckboxes.forEach(cb => {
                        cb.addEventListener('change', () => {
                            const allChecked = Array.from(libCheckboxes).every(c => c.checked);
                            selectAllCheckbox.checked = allChecked;
                        });
                    });
                }

                // Devices dropdown logic for create
                const createTrigger = document.getElementById('create-devices-dropdown-trigger');
                const createList = document.getElementById('create-devices-dropdown-list');
                if (createTrigger && createList) {
                    createTrigger.addEventListener('click', (e) => {
                        e.stopPropagation();
                        createList.style.display = createList.style.display === 'none' ? 'block' : 'none';
                    });
                    createTrigger.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            createTrigger.click();
                        }
                    });
                    document.addEventListener('click', () => {
                        createList.style.display = 'none';
                    });
                    createList.addEventListener('click', (e) => {
                        e.stopPropagation();
                    });
                    createList.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' && e.target.type === 'checkbox') {
                            e.preventDefault();
                            e.target.checked = !e.target.checked;
                            e.target.dispatchEvent(new Event('change'));
                        }
                    });
                }

                const updateCreateSelectedText = () => {
                    const checked = Array.from(content.querySelectorAll('.create-device-checkbox:checked'));
                    const txt = document.getElementById('create-devices-dropdown-selected-text');
                    if (txt) {
                        if (checked.length === 0) {
                            txt.textContent = 'All Devices Allowed';
                        } else if (checked.length === 1) {
                            txt.textContent = '1 Device Allowed';
                        } else {
                            txt.textContent = `${checked.length} Devices Allowed`;
                        }
                    }
                };
                content.querySelectorAll('.create-device-checkbox').forEach(cb => {
                    cb.addEventListener('change', updateCreateSelectedText);
                });
                updateCreateSelectedText();

                document.getElementById('create-submit-btn').addEventListener('click', () => {
                    const name = document.getElementById('create-name-input').value.trim();
                    const pin = document.getElementById('create-pin-input').value;
                    const rating = document.getElementById('create-rating-select').value;
                    const lockoutMinutes = parseInt(document.getElementById('create-lockout-select').value, 10);
                    const bypassPin = document.getElementById('create-local-bypass-checkbox').checked;
                    
                    const checkedLibs = [];
                    content.querySelectorAll('.library-checkbox:checked').forEach(cb => {
                        checkedLibs.push(cb.value);
                    });

                    const checkedDevices = [];
                    content.querySelectorAll('.create-device-checkbox:checked').forEach(cb => {
                        checkedDevices.push(cb.value);
                    });

                    const showCreateError = (msg) => {
                        const el = document.getElementById('create-error-msg');
                        if (el) { el.textContent = msg; el.style.display = 'block'; }
                    };

                    if (!name) {
                        showCreateError('Profile name is required.');
                        return;
                    }

                    if (pin && (pin.length < 4 || pin.length > 8 || !/^\d+$/.test(pin))) {
                        showCreateError('PIN must be 4–8 digits.');
                        return;
                    }

                    const createUrl = apiClient.getUrl('plugins/profiles/create');
                    fetch(createUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...this.getAuthHeaders(masterState.masterToken)
                        },
                        body: JSON.stringify({
                            profileName: name,
                            pin: pin,
                            avatarColor: selectedColor,
                            maxParentalRating: rating || null,
                            enabledFolders: checkedLibs,
                            masterPin: this.masterPin,
                            lockoutMinutes: lockoutMinutes,
                            bypassPinOnLocalNetwork: bypassPin,
                            allowedDeviceIds: checkedDevices
                        })
                    })
                    .then(res => {
                        if (!res.ok) return res.text().then(text => { throw new Error(text); });
                        return res.json();
                    })
                    .then(() => {
                        this.fetchAndRenderProfiles(apiClient, masterState.masterUserId, masterState.masterToken);
                    })
                    .catch(err => {
                        const el = document.getElementById('create-error-msg');
                        if (el) { el.textContent = err.message; el.style.display = 'block'; }
                    });
                });

                document.getElementById('create-cancel-btn').addEventListener('click', () => {
                    this.fetchAndRenderProfiles(apiClient, masterState.masterUserId, masterState.masterToken);
                });
            });
        },

        showEditProfileModal: function (profile) {
            const apiClient = ApiClient;
            const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
            if (!masterState) return;

            // Fetch libraries, target user details, and connected devices
            const libUrl = apiClient.getUrl('plugins/profiles/libraries');
            const userUrl = apiClient.getUrl(`Users/${profile.profileUserId}`);
            const devicesUrl = apiClient.getUrl('plugins/profiles/devices');

            Promise.all([
                fetch(libUrl, { headers: this.getAuthHeaders(masterState.masterToken) }).then(res => res.json()),
                fetch(userUrl, { headers: this.getAuthHeaders(masterState.masterToken) }).then(res => res.json()),
                fetch(devicesUrl, { headers: this.getAuthHeaders(masterState.masterToken) }).then(res => res.json()).catch(() => [])
            ])
            .then(([libraries, userDetails, devices]) => {
                const normalizedLibs = (libraries || []).map(lib => ({
                    id: lib.id || lib.Id,
                    name: lib.name || lib.Name,
                    collectionType: lib.collectionType || lib.CollectionType
                }));
                const policy = userDetails.Policy || userDetails.policy || {};
                const blockedFolders = policy.BlockedMediaFolders || policy.blockedMediaFolders || [];
                const enableAll = policy.EnableAllFolders !== undefined ? policy.EnableAllFolders : (policy.enableAllFolders || false);
                const maxRating = policy.MaxParentalRating !== undefined ? policy.MaxParentalRating : (policy.maxParentalRating !== undefined ? policy.maxParentalRating : null);
                const currentLockout = profile.lockoutMinutes !== undefined ? profile.lockoutMinutes : 5;

                const content = document.querySelector('.profiles-modal-content');

                content.innerHTML = `
                    <h1 class="profiles-title">Edit Profile</h1>
                    <div class="create-profile-container">
                        <div class="form-group">
                            <label>Profile Name</label>
                            <input type="text" id="edit-name-input" value="${profile.profileName}" ${profile.isMaster ? 'disabled style="opacity: 0.6"' : ''} required />
                        </div>
                        
                        <div class="form-group">
                            <label>PIN Code (Optional, 4-8 digits)</label>
                            <div class="pin-edit-group" style="display:flex; gap:10px;">
                                <input type="text" id="edit-pin-input" maxlength="8" pattern="[0-9]*" inputmode="numeric" placeholder="${profile.requiresPin ? '••••' : 'Unprotected'}" autocomplete="one-time-code" data-1p-ignore data-lpignore="true" data-bwignore data-protonpass-ignore="true" style="flex:1;" />
                                ${profile.requiresPin ? `<button id="edit-clear-pin-btn" class="profiles-btn btn-secondary" style="padding:10px 15px;">Clear PIN</button>` : ''}
                            </div>
                        </div>

                        <div class="form-group">
                            <label class="library-check-label" style="display: inline-flex; align-items: center; gap: 0.5rem; cursor: pointer; user-select: none;">
                                <input type="checkbox" id="edit-local-bypass-checkbox" ${profile.bypassPinOnLocalNetwork ? 'checked' : ''} style="cursor: pointer; accent-color: #00a4dc;" />
                                <span>Bypass PIN on local network (LAN)</span>
                            </label>
                            <div class="form-hint">If enabled, users on the local home network won't be prompted for a PIN.</div>
                        </div>

                        <div class="form-group">
                            <label>Auto-lock after inactivity</label>
                            <select id="edit-lockout-select">
                                <option value="0" ${currentLockout === 0 ? 'selected' : ''}>Never</option>
                                <option value="1" ${currentLockout === 1 ? 'selected' : ''}>1 minute</option>
                                <option value="5" ${currentLockout === 5 ? 'selected' : ''}>5 minutes</option>
                                <option value="10" ${currentLockout === 10 ? 'selected' : ''}>10 minutes</option>
                                <option value="20" ${currentLockout === 20 ? 'selected' : ''}>20 minutes</option>
                                <option value="30" ${currentLockout === 30 ? 'selected' : ''}>30 minutes</option>
                                <option value="60" ${currentLockout === 60 ? 'selected' : ''}>1 hour</option>
                            </select>
                            <div class="form-hint">Only applies when a PIN is set on this profile</div>
                        </div>

                        <div class="form-group">
                            <label>Avatar Color</label>
                            <div class="avatar-color-picker">
                                <div class="color-dot" style="background-color: #00A4DC" data-color="#00A4DC" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #E50914" data-color="#E50914" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #22C55E" data-color="#22C55E" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #EAB308" data-color="#EAB308" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #A855F7" data-color="#A855F7" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #EC4899" data-color="#EC4899" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #F97316" data-color="#F97316" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #06B6D4" data-color="#06B6D4" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #3B82F6" data-color="#3B82F6" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #10B981" data-color="#10B981" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #6366F1" data-color="#6366F1" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #8B5CF6" data-color="#8B5CF6" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #D946EF" data-color="#D946EF" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #F43F5E" data-color="#F43F5E" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #14B8A6" data-color="#14B8A6" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #F59E0B" data-color="#F59E0B" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #84CC16" data-color="#84CC16" tabindex="0"></div>
                                <div class="color-dot" style="background-color: #64748B" data-color="#64748B" tabindex="0"></div>
                            </div>
                        </div>

                        ${!profile.isMaster ? `
                        <div class="form-group">
                            <label>Allowed Devices (Optional)</label>
                            <div class="devices-dropdown-container" style="position: relative;">
                                <div id="devices-dropdown-trigger" class="devices-dropdown-trigger" tabindex="0">
                                    <span id="devices-dropdown-selected-text">All Devices Allowed</span>
                                    <span style="font-size: 0.8rem; opacity: 0.7;">▼</span>
                                </div>
                                <div id="devices-dropdown-list" class="devices-dropdown-list" style="display: none; position: absolute; top: 100%; left: 0; right: 0; z-index: 10000; margin-top: 4px;">
                                    ${devices && devices.length > 0 ? devices.map(dev => {
                                        const isChecked = profile.allowedDeviceIds && profile.allowedDeviceIds.includes(dev.deviceId);
                                        return `
                                            <div class="device-dropdown-item" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; flex: 1; margin: 0; font-size: 0.9rem;">
                                                    <input type="checkbox" class="device-checkbox" value="${dev.deviceId}" ${isChecked ? 'checked' : ''} style="cursor: pointer; accent-color: #00a4dc;" />
                                                    <span style="display: flex; flex-direction: column;">
                                                        <span style="font-weight: 500;">${dev.deviceName}</span>
                                                        <span style="font-size: 0.75rem; opacity: 0.6;">${dev.client} • Last seen ${new Date(dev.lastSeen).toLocaleDateString()}</span>
                                                    </span>
                                                </label>
                                                <button type="button" class="device-delete-btn" data-id="${dev.deviceId}" style="background: transparent; border: none; color: #ff6b6b; cursor: pointer; padding: 6px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; transition: background 0.2s;" onmouseover="this.style.background='rgba(255,107,107,0.15)'" onmouseout="this.style.background='transparent'">
                                                    🗑️
                                                </button>
                                            </div>
                                        `;
                                    }).join('') : `
                                        <div style="padding: 12px; text-align: center; opacity: 0.6; font-size: 0.9rem;">No connected devices found</div>
                                    `}
                                </div>
                            </div>
                            <div class="form-hint">If no devices are selected, this profile can be accessed from any device.</div>
                        </div>

                        <div class="form-group">
                            <label>Max Parental Rating Limit (Optional)</label>
                            <select id="edit-rating-select">
                                <option value="" ${maxRating === null ? 'selected' : ''}>No Restrictions</option>
                                <option value="6" ${maxRating === 6 ? 'selected' : ''}>G / TV-G (6+)</option>
                                <option value="10" ${maxRating === 10 ? 'selected' : ''}>PG / TV-PG (10+)</option>
                                <option value="14" ${maxRating === 14 ? 'selected' : ''}>PG-13 / TV-14 (14+)</option>
                                <option value="17" ${maxRating === 17 ? 'selected' : ''}>R / TV-MA (17+)</option>
                            </select>
                        </div>

                        <div class="form-group">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.2rem;">
                                <label style="margin: 0;">Enabled Libraries</label>
                                <label class="library-check-label" style="font-size: 0.85rem; color: rgba(255,255,255,0.6); margin: 0; display: inline-flex; align-items: center; gap: 0.4rem;">
                                    <input type="checkbox" id="edit-select-all-libraries" style="margin: 0; cursor: pointer; accent-color: #00a4dc;" />
                                    <span>Select all</span>
                                </label>
                            </div>
                            <div class="library-checklist">
                        ${normalizedLibs.map(lib => {
                                    const storedFolders = profile.enabledFolders;
                                    let isChecked;
                                    if (storedFolders !== null && storedFolders !== undefined) {
                                        isChecked = storedFolders.some(id => this.normalizeGuid(id) === this.normalizeGuid(lib.id));
                                    } else {
                                        isChecked = enableAll || !blockedFolders.some(bf => this.normalizeGuid(bf) === this.normalizeGuid(lib.id));
                                    }
                                    return `
                                        <label class="library-check-label">
                                            <input type="checkbox" class="library-checkbox" value="${lib.id}" ${isChecked ? 'checked' : ''} />
                                            <span>${lib.name}</span>
                                        </label>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                        ` : ''}

                        <div class="profile-dialog-actions">
                            <div class="dialog-action-buttons">
                                <button id="edit-submit-btn" class="profiles-btn btn-primary">Save</button>
                                <button id="edit-cancel-btn" class="profiles-btn btn-secondary">Cancel</button>
                            </div>
                            ${!profile.isMaster ? `
                                <button id="edit-delete-btn" class="profiles-btn btn-danger">Delete Profile</button>
                            ` : ''}
                        </div>
                    </div>
                `;

                // Setup active color dot selection
                const dots = content.querySelectorAll('.color-dot');
                let selectedColor = profile.avatarColor || '#00A4DC';
                dots.forEach(dot => {
                    const color = dot.getAttribute('data-color');
                    if (color.toLowerCase() === selectedColor.toLowerCase()) {
                        dot.classList.add('active');
                    }
                    dot.addEventListener('click', () => {
                        dots.forEach(d => d.classList.remove('active'));
                        dot.classList.add('active');
                        selectedColor = color;
                    });
                });

                // Support D-pad Enter/Space select on color dots
                content.addEventListener('keydown', (e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('color-dot')) {
                        e.preventDefault();
                        e.target.click();
                    }
                });

                // Select all libraries logic for edit
                const selectAllCheckbox = document.getElementById('edit-select-all-libraries');
                const libCheckboxes = content.querySelectorAll('.library-checkbox');
                if (selectAllCheckbox) {
                    const allChecked = libCheckboxes.length > 0 && Array.from(libCheckboxes).every(c => c.checked);
                    selectAllCheckbox.checked = allChecked;

                    selectAllCheckbox.addEventListener('change', (e) => {
                        const isChecked = e.target.checked;
                        libCheckboxes.forEach(cb => {
                            cb.checked = isChecked;
                        });
                    });

                    libCheckboxes.forEach(cb => {
                        cb.addEventListener('change', () => {
                            const allChecked = Array.from(libCheckboxes).every(c => c.checked);
                            selectAllCheckbox.checked = allChecked;
                        });
                    });
                }

                // Devices dropdown logic for edit
                const editTrigger = document.getElementById('devices-dropdown-trigger');
                const editList = document.getElementById('devices-dropdown-list');
                if (editTrigger && editList) {
                    editTrigger.addEventListener('click', (e) => {
                        e.stopPropagation();
                        editList.style.display = editList.style.display === 'none' ? 'block' : 'none';
                    });
                    editTrigger.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            editTrigger.click();
                        }
                    });
                    document.addEventListener('click', () => {
                        editList.style.display = 'none';
                    });
                    editList.addEventListener('click', (e) => {
                        e.stopPropagation();
                    });
                    editList.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' && e.target.type === 'checkbox') {
                            e.preventDefault();
                            e.target.checked = !e.target.checked;
                            e.target.dispatchEvent(new Event('change'));
                        }
                    });
                }

                const updateSelectedText = () => {
                    const checked = Array.from(content.querySelectorAll('.device-checkbox:checked'));
                    const txt = document.getElementById('devices-dropdown-selected-text');
                    if (txt) {
                        if (checked.length === 0) {
                            txt.textContent = 'All Devices Allowed';
                        } else if (checked.length === 1) {
                            txt.textContent = '1 Device Allowed';
                        } else {
                            txt.textContent = `${checked.length} Devices Allowed`;
                        }
                    }
                };
                content.querySelectorAll('.device-checkbox').forEach(cb => {
                    cb.addEventListener('change', updateSelectedText);
                });
                updateSelectedText();

                // Device deletion handler
                content.querySelectorAll('.device-delete-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const devId = btn.getAttribute('data-id');
                        if (confirm('Are you sure you want to delete this device from the connected history? This will also remove any access restrictions associated with it.')) {
                            const delDevUrl = apiClient.getUrl('plugins/profiles/devices/delete');
                            fetch(delDevUrl, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    ...this.getAuthHeaders(masterState.masterToken)
                                },
                                body: JSON.stringify({ deviceId: devId })
                            })
                            .then(res => {
                                if (res.ok) {
                                    const row = btn.closest('.device-dropdown-item');
                                    if (row) row.remove();
                                    const remaining = editList.querySelectorAll('.device-dropdown-item');
                                    if (remaining.length === 0) {
                                        editList.innerHTML = '<div style="padding: 12px; text-align: center; opacity: 0.6; font-size: 0.9rem;">No connected devices found</div>';
                                    }
                                    updateSelectedText();
                                } else {
                                    alert('Failed to delete device.');
                                }
                            })
                            .catch(err => alert('Error: ' + err.message));
                        }
                    });
                });

                // Clear PIN logic
                let isPinCleared = false;
                const clearPinBtn = document.getElementById('edit-clear-pin-btn');
                if (clearPinBtn) {
                    clearPinBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        isPinCleared = true;
                        document.getElementById('edit-pin-input').value = '';
                        document.getElementById('edit-pin-input').placeholder = 'Unprotected';
                        clearPinBtn.style.display = 'none';
                    });
                }



                // Save handler
                document.getElementById('edit-submit-btn').addEventListener('click', () => {
                    const name = document.getElementById('edit-name-input').value.trim();
                    const pinVal = document.getElementById('edit-pin-input').value;
                    const bypassPin = document.getElementById('edit-local-bypass-checkbox').checked;
                    
                    let rating = null;
                    let checkedLibs = null;
                    let checkedDevices = null;
                    if (!profile.isMaster) {
                        rating = document.getElementById('edit-rating-select').value;
                        checkedLibs = [];
                        content.querySelectorAll('.library-checkbox:checked').forEach(cb => {
                            checkedLibs.push(cb.value);
                        });
                        checkedDevices = [];
                        content.querySelectorAll('.device-checkbox:checked').forEach(cb => {
                            checkedDevices.push(cb.value);
                        });
                    }
                    const lockoutSel = document.getElementById('edit-lockout-select');
                    const lockoutMinutes = lockoutSel ? parseInt(lockoutSel.value, 10) : undefined;

                    if (!name) {
                        alert("Profile name is required.");
                        return;
                    }

                    let pin = null;
                    if (isPinCleared) {
                        pin = ''; // Tells backend to clear the PIN
                    } else if (pinVal) {
                        if (pinVal.length < 4 || pinVal.length > 8 || !/^\d+$/.test(pinVal)) {
                            alert("PIN code must be a numeric value between 4 and 8 digits.");
                            return;
                        }
                        pin = pinVal;
                    }

                    const updateUrl = apiClient.getUrl('plugins/profiles/update');
                    fetch(updateUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...this.getAuthHeaders(masterState.masterToken)
                        },
                        body: JSON.stringify({
                            profileId: profile.profileUserId,
                            profileName: name,
                            pin: pin,
                            avatarColor: selectedColor,
                            maxParentalRating: rating || null,
                            enabledFolders: checkedLibs,
                            masterPin: this.masterPin,
                            lockoutMinutes: lockoutMinutes,
                            bypassPinOnLocalNetwork: bypassPin,
                            allowedDeviceIds: checkedDevices
                        })
                    })
                    .then(res => {
                        if (!res.ok) return res.text().then(text => { throw new Error(text); });
                        this.fetchAndRenderProfiles(apiClient, masterState.masterUserId, masterState.masterToken);
                    })
                    .catch(err => alert("Error saving profile: " + err.message));
                });

                // Delete handler
                const delBtn = document.getElementById('edit-delete-btn');
                if (delBtn) {
                    delBtn.addEventListener('click', () => {
                        if (confirm(`Are you sure you want to delete profile "${profile.profileName}" and its underlying user account?`)) {
                            this.executeProfileDeletion(profile.profileUserId);
                        }
                    });
                }

                // Cancel handler
                document.getElementById('edit-cancel-btn').addEventListener('click', () => {
                    this.fetchAndRenderProfiles(apiClient, masterState.masterUserId, masterState.masterToken);
                });
            })
            .catch(err => {
                alert("Failed to load profile details: " + err.message);
                this.fetchAndRenderProfiles(apiClient, masterState.masterUserId, masterState.masterToken);
            });
        },

        showBonfireModal: function () {
            const apiClient = ApiClient;
            const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
            if (!masterState) return;

            const content = document.querySelector('.profiles-modal-content');
            if (!content) return;

            content.innerHTML = `
                <h1 class="profiles-title">Bonfire Grouping</h1>
                <div class="create-profile-container" style="max-width: 500px; width: 100%;">
                    <div id="bonfire-container" style="background: rgba(0,0,0,0.15); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 16px; min-height: 100px;">
                        <div style="display: flex; justify-content: center; padding: 20px;">
                            <div class="profiles-loading-spinner" style="border: 3px solid rgba(255,255,255,0.1); border-radius: 50%; border-top: 3px solid #00a4dc; width: 24px; height: 24px; animation: spin 1s linear infinite;"></div>
                        </div>
                    </div>
                    
                    <div class="profile-dialog-actions" style="margin-top: 2rem; display: flex; justify-content: center;">
                        <button id="bonfire-back-btn" class="profiles-btn btn-secondary">Back</button>
                    </div>
                </div>
            `;

            document.getElementById('bonfire-back-btn').addEventListener('click', () => {
                this.fetchAndRenderProfiles(apiClient, masterState.masterUserId, masterState.masterToken);
            });

            this.loadBonfireStatus(content, apiClient, masterState.masterToken);

            // Auto-focus first focusable element for TV D-pad navigation
            setTimeout(() => {
                const first = content.querySelector('input, button');
                if (first) first.focus();
            }, 250);
        },

        executeProfileDeletion: function (profileId) {
            const apiClient = ApiClient;
            const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
            if (!masterState) return;

            const url = apiClient.getUrl('plugins/profiles/delete');

            fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...this.getAuthHeaders(masterState.masterToken)
                },
                body: JSON.stringify({ 
                    profileId: profileId,
                    masterPin: this.masterPin
                })
            })
            .then(res => {
                if (!res.ok) throw new Error("Failed to delete profile");
                this.fetchAndRenderProfiles(apiClient, masterState.masterUserId, masterState.masterToken);
            })
            .catch(err => alert("Error deleting profile: " + err.message));
        },

        loadBonfireStatus: function (content, apiClient, masterToken) {
            const container = content.querySelector('#bonfire-container');
            if (!container) return;

            const statusUrl = apiClient.getUrl('plugins/profiles/bonfire/status');
            fetch(statusUrl, { headers: this.getAuthHeaders(masterToken) })
            .then(res => {
                if (res.status === 401) {
                    this.handleSessionExpired();
                    throw new Error('Unauthorized');
                }
                return res.json();
            })
            .then(status => {
                this.renderBonfireStatus(container, status, apiClient, masterToken);
            })
            .catch(err => {
                container.innerHTML = `<div style="color: #ff6b6b; font-size: 0.9rem;">Failed to load Bonfire status: ${err.message}</div>`;
            });
        },

        renderBonfireStatus: function (container, status, apiClient, masterToken) {
            if (status.isOwner) {
                container.innerHTML = `
                    <div style="margin-bottom: 12px;">
                        <span style="font-size: 0.9rem; opacity: 0.8;">You are the host of a Bonfire Group. Share this 6-character code with other users on the server so they can join your home:</span>
                        <div style="font-size: 2rem; font-weight: 700; color: #22c55e; letter-spacing: 4px; margin: 12px 0; font-family: monospace; text-align: center; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px; border: 1px dashed rgba(34,197,94,0.3);">${status.ownedCode}</div>
                    </div>
                    <div style="margin-top: 16px;">
                        <label style="font-size: 0.9rem; font-weight: 600; margin-bottom: 8px; display: block;">Members (${status.ownedMembers ? status.ownedMembers.length : 0})</label>
                        <div style="display: flex; flex-direction: column; gap: 8px; max-height: 150px; overflow-y: auto;">
                            ${status.ownedMembers && status.ownedMembers.length > 0 ? status.ownedMembers.map(m => `
                                <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: rgba(255,255,255,0.03); border-radius: 4px;">
                                    <span style="font-size: 0.9rem; font-weight: 500;">${m.username}</span>
                                    <button type="button" class="bonfire-kick-btn" data-id="${m.userId}" style="background: #ff6b6b; border: none; color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; cursor: pointer; font-weight: 600;">Kick</button>
                                </div>
                            `).join('') : '<div style="font-size: 0.85rem; opacity: 0.5; font-style: italic;">No members joined yet.</div>'}
                        </div>
                    </div>
                    <div style="margin-top: 20px; display: flex; justify-content: flex-end;">
                        <button type="button" id="bonfire-delete-btn" class="profiles-btn btn-danger" style="padding: 8px 14px; font-size: 0.85rem;">Delete Group</button>
                    </div>
                `;

                container.querySelectorAll('.bonfire-kick-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const mId = btn.getAttribute('data-id');
                        if (confirm('Are you sure you want to kick this user from your Bonfire group?')) {
                            fetch(apiClient.getUrl('plugins/profiles/bonfire/kick'), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders(masterToken) },
                                body: JSON.stringify({ memberId: mId })
                            })
                            .then(res => {
                                if (res.ok) this.loadBonfireStatus(container.closest('.create-profile-container'), apiClient, masterToken);
                                else alert('Failed to kick member.');
                            });
                        }
                    });
                });

                container.querySelector('#bonfire-delete-btn').addEventListener('click', () => {
                    if (confirm('Are you sure you want to delete your Bonfire group? All members will be disconnected and will no longer appear in your switcher.')) {
                        fetch(apiClient.getUrl('plugins/profiles/bonfire/delete-group'), {
                            method: 'POST',
                            headers: this.getAuthHeaders(masterToken)
                        })
                        .then(res => {
                            if (res.ok) this.loadBonfireStatus(container.closest('.create-profile-container'), apiClient, masterToken);
                            else alert('Failed to delete group.');
                        });
                    }
                });

            } else if (status.isMember) {
                container.innerHTML = `
                    <div style="margin-bottom: 12px;">
                        <span style="font-size: 0.9rem; opacity: 0.8;">You have joined a Bonfire Group owned by:</span>
                        <div style="font-size: 1.1rem; font-weight: 600; color: #00a4dc; margin: 8px 0;">${status.joinedOwnerName}</div>
                        <span style="font-size: 0.85rem; opacity: 0.6; display: block; margin-top: 4px;">You can access each other's profiles from the switcher grid.</span>
                    </div>
                    <div style="margin-top: 16px; display: flex; justify-content: flex-end;">
                        <button type="button" id="bonfire-leave-btn" class="profiles-btn btn-danger" style="padding: 8px 14px; font-size: 0.85rem;">Leave Group</button>
                    </div>
                `;

                container.querySelector('#bonfire-leave-btn').addEventListener('click', () => {
                    if (confirm('Are you sure you want to leave this Bonfire group? You will no longer share profile switchers.')) {
                        fetch(apiClient.getUrl('plugins/profiles/bonfire/leave'), {
                            method: 'POST',
                            headers: this.getAuthHeaders(masterToken)
                        })
                        .then(res => {
                            if (res.ok) this.loadBonfireStatus(container.closest('.create-profile-container'), apiClient, masterToken);
                            else alert('Failed to leave group.');
                        });
                    }
                });

            } else {
                container.innerHTML = `
                    <div style="display: flex; flex-direction: column; gap: 16px;">
                        <div>
                            <span style="font-size: 0.88rem; opacity: 0.7; display: block; margin-bottom: 10px;">Link up with other users on this server to share profile switchers.</span>
                            <button type="button" id="bonfire-generate-btn" class="profiles-btn btn-primary" style="width: 100%; padding: 10px; font-weight: 600;">Generate Join Code</button>
                        </div>
                        <div style="display: flex; align-items: center; justify-content: center; gap: 10px; opacity: 0.5;">
                            <hr style="flex: 1; border: none; border-top: 1px solid rgba(255,255,255,0.2);" />
                            <span style="font-size: 0.8rem;">OR</span>
                            <hr style="flex: 1; border: none; border-top: 1px solid rgba(255,255,255,0.2);" />
                        </div>
                        <div>
                            <label style="font-size: 0.85rem; opacity: 0.7; margin-bottom: 6px; display: block;">Enter a friend's Bonfire Code to join their group:</label>
                            <div style="display: flex; gap: 8px;">
                                <input type="text" id="bonfire-join-input" placeholder="e.g. B7F8XA" maxlength="6" style="flex: 1; text-align: center; text-transform: uppercase; font-family: monospace; letter-spacing: 2px;" />
                                <button type="button" id="bonfire-join-btn" class="profiles-btn btn-primary" style="padding: 10px 18px;">Join</button>
                            </div>
                            <div id="bonfire-join-error" style="display: none; color: #ff6b6b; font-size: 0.85rem; font-weight: 600; margin-top: 8px; text-align: center;"></div>
                        </div>
                    </div>
                `;

                container.querySelector('#bonfire-generate-btn').addEventListener('click', () => {
                    fetch(apiClient.getUrl('plugins/profiles/bonfire/generate'), {
                        method: 'POST',
                        headers: this.getAuthHeaders(masterToken)
                    })
                    .then(res => {
                        if (res.ok) this.loadBonfireStatus(container.closest('.create-profile-container'), apiClient, masterToken);
                        else alert('Failed to generate code.');
                    });
                });

                const joinInput = container.querySelector('#bonfire-join-input');
                const joinBtn = container.querySelector('#bonfire-join-btn');
                const errDiv = container.querySelector('#bonfire-join-error');

                const performJoin = () => {
                    const code = joinInput.value.trim();
                    errDiv.style.display = 'none';
                    if (!code || code.length !== 6) {
                        errDiv.textContent = 'Please enter a 6-character code.';
                        errDiv.style.display = 'block';
                        return;
                    }
                    fetch(apiClient.getUrl('plugins/profiles/bonfire/join'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders(masterToken) },
                        body: JSON.stringify({ code: code })
                    })
                    .then(res => {
                        if (res.status === 429) {
                            errDiv.textContent = 'Too many failed attempts. Try again in 15 minutes.';
                            errDiv.style.display = 'block';
                            return;
                        }
                        if (!res.ok) return res.text().then(text => { throw new Error(text); });
                        this.loadBonfireStatus(container.closest('.create-profile-container'), apiClient, masterToken);
                    })
                    .catch(err => {
                        errDiv.textContent = err.message || 'Failed to join group.';
                        errDiv.style.display = 'block';
                    });
                };

                joinBtn.addEventListener('click', performJoin);
                joinInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') performJoin();
                });
            }

            // TV D-pad Auto-focus helper
            setTimeout(() => {
                const target = container.querySelector('input, button');
                if (target) target.focus();
            }, 100);
        },

        injectSidebarLink: function () {
            if (!this.isProfileSessionActive()) {
                const existing = document.getElementById('profiles-sidebar-link');
                if (existing) existing.remove();
                return;
            }

            const container = document.querySelector('.sidebar-nav') || 
                              document.querySelector('.navMenu') || 
                              document.getElementById('menuItems');
            if (!container) return;

            if (document.getElementById('profiles-sidebar-link')) return;

            const link = document.createElement('a');
            link.id = 'profiles-sidebar-link';
            link.href = '#';
            link.className = 'sidebarLink navMenu-link';
            link.setAttribute('tabindex', '0');
            link.style.display = 'flex';
            link.style.alignItems = 'center';
            link.style.gap = '10px';
            link.style.cursor = 'pointer';

            const activeInfo = this.getCachedActiveProfile();
            const initial = activeInfo.initial;
            const color = activeInfo.color;
            const name = activeInfo.name;

            link.innerHTML = `
                <div class="sidebar-profile-avatar" style="width: 24px; height: 24px; border-radius: 50%; background-color: ${color}; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 0.85rem; font-weight: bold; text-transform: uppercase; flex-shrink: 0;">
                    ${initial}
                </div>
                <span class="sidebarLinkText">${name} (Switch)</span>
            `;

            link.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const drawer = document.querySelector('.drawer-open');
                if (drawer) {
                    const mask = document.querySelector('.appdrawer-mask');
                    if (mask) mask.click();
                }
                this.handleBubbleClick();
            });

            link.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    link.click();
                }
            });

            container.appendChild(link);
        },

        // ── Bubble visibility helpers ──────────────────────────────────────────
        _bubbleHide: function (bubble) {
            if (!bubble || bubble.dataset.profilesHiding === '1') return;
            bubble.dataset.profilesHiding = '1';
            bubble.classList.add('profiles-bubble-hiding');
            setTimeout(() => {
                // Only commit display:none if still in hiding state
                if (bubble.dataset.profilesHiding === '1') {
                    bubble.style.display = 'none';
                    bubble.classList.remove('profiles-bubble-hiding');
                    delete bubble.dataset.profilesHiding;
                }
            }, 160);
        },
        _bubbleShow: function (bubble) {
            if (!bubble) return;
            delete bubble.dataset.profilesHiding;
            bubble.style.display = '';
            // Tick so the browser has a chance to paint display:'' before removing
            // the opacity class, triggering the CSS transition.
            requestAnimationFrame(() => bubble.classList.remove('profiles-bubble-hiding'));
        },

        evaluateFloatingBubbleVisibility: function (viewType) {
            let bubble = document.getElementById('profiles-floating-bubble');

            // Hide during active playback/OSD or on any server-management page.
            if (viewType === 'videoosd' || viewType === 'dashboard') {
                this._bubbleHide(bubble);
                return;
            }

            if (!this.isProfileSessionActive()) {
                // No active session — remove entirely (will be re-created when needed)
                if (bubble) bubble.remove();
                return;
            }

            // ── Strategy 1: find the header button container by class name ─────────
            const headerContainer = this._findHeaderContainer();

            if (headerContainer) {
                if (bubble && bubble.classList.contains('profiles-floating-fallback')) {
                    bubble.remove();
                    bubble = null;
                }
                if (bubble) {
                    if (!document.contains(bubble)) {
                        bubble.remove();
                        bubble = null;
                    } else if (!headerContainer.contains(bubble)) {
                        // Button is in the DOM but drifted outside the header — re-insert.
                        this._insertBeforeUserBtn(headerContainer, bubble);
                    }
                }
                if (!bubble) {
                    bubble = this._buildHeaderBubble();
                    this._insertBeforeUserBtn(headerContainer, bubble);
                    this.attachBubbleClickHandler(bubble);
                }

            } else {
                // ── Strategy 2: geometry-based anchor ────────────────────────────────
                // If no named container matched (e.g. a custom Skin Manager theme),
                // find the rightmost visible button in the top 80px of the viewport
                // and insert next to it.  Works for ANY theme regardless of class names.
                const anchor = this._findGeometricHeaderAnchor();
                if (anchor) {
                    if (bubble && bubble.classList.contains('profiles-floating-fallback')) {
                        bubble.remove();
                        bubble = null;
                    }
                    if (bubble) {
                        if (!document.contains(bubble)) {
                            bubble.remove(); bubble = null;
                        } else if (!anchor.parentElement.contains(bubble)) {
                            bubble.remove(); bubble = null;
                        }
                    }
                    if (!bubble) {
                        bubble = this._buildHeaderBubble();
                        anchor.parentElement.insertBefore(bubble, anchor);
                        this.attachBubbleClickHandler(bubble);
                    }

                } else {
                    // ── Strategy 3: true corner-pill fallback ────────────────────────
                    // Appended to <html> (outside the body transform chain) so
                    // position:fixed works correctly regardless of CSS transforms.
                    if (bubble && !bubble.classList.contains('profiles-floating-fallback')) {
                        bubble.remove();
                        bubble = null;
                    }
                    if (!bubble) {
                        bubble = this._buildFallbackBubble();
                        document.documentElement.appendChild(bubble);
                        this.attachBubbleClickHandler(bubble);
                    }
                }
            }

            if (bubble && bubble.classList.contains('profiles-floating-fallback')) {
                const pos = this._findBestFallbackPosition();
                bubble.style.top = pos.top;
                bubble.style.bottom = pos.bottom;
                bubble.style.left = pos.left;
                bubble.style.right = pos.right;
            }

            this._bubbleShow(bubble);

            // Pre-fetch the profile list while the button is visible so the overlay
            // appears instantly (no network wait) when the user clicks it.
            if (viewType === 'home' && !this._profilePrefetchPending) {
                this._prefetchProfiles();
            }
        },

        // Fetches /list using the master token and caches the result in this.cachedProfiles.
        // Called proactively by evaluateFloatingBubbleVisibility; the cached result is
        // consumed by fetchAndRenderProfiles for instant, flash-free overlay display.
        _prefetchProfiles: function () {
            if (this._profilePrefetchPending || (this.cachedProfiles && this.cachedProfiles.length)) return;
            const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
            if (!masterState || !masterState.masterToken) return;

            this._profilePrefetchPending = true;
            const url = ApiClient.getUrl('plugins/profiles/list');
            fetch(url, { headers: this.getAuthHeaders(masterState.masterToken) })
                .then(res => {
                    if (!res.ok) throw new Error();
                    return res.json();
                })
                .then(profiles => {
                    const normalized = (profiles || []).map(p => ({
                        profileUserId: p.profileUserId || p.ProfileUserId,
                        profileName: p.profileName || p.ProfileName,
                        avatarInitial: p.avatarInitial || p.AvatarInitial,
                        avatarColor: p.avatarColor || p.AvatarColor,
                        requiresPin: p.requiresPin !== undefined ? p.requiresPin : p.RequiresPin,
                        isMaster: p.isMaster !== undefined ? p.isMaster : p.IsMaster,
                        lockoutMinutes: p.lockoutMinutes !== undefined ? p.lockoutMinutes : (p.LockoutMinutes !== undefined ? p.LockoutMinutes : 5),
                        maxSubProfiles: p.maxSubProfiles !== undefined ? p.maxSubProfiles : (p.MaxSubProfiles !== undefined ? p.MaxSubProfiles : 5),
                        bypassPinOnLocalNetwork: p.bypassPinOnLocalNetwork !== undefined ? p.bypassPinOnLocalNetwork : (p.BypassPinOnLocalNetwork !== undefined ? p.BypassPinOnLocalNetwork : false),
                        allowedDeviceIds: p.allowedDeviceIds || p.AllowedDeviceIds || [],
                        isBonfire: p.isBonfire !== undefined ? p.isBonfire : (p.IsBonfire !== undefined ? p.IsBonfire : false)
                    }));
                    this.cachedProfiles = normalized;
                    localStorage.setItem('jellyfin_profiles_cached_list', JSON.stringify(normalized));
                    this._profilePrefetchPending = false;

                    // Sync sessionStorage if matches current active user
                    const currentUserId = ApiClient.getCurrentUserId();
                    if (currentUserId) {
                        const currentProfile = normalized.find(p => this.normalizeGuid(p.profileUserId) === this.normalizeGuid(currentUserId));
                        if (currentProfile) {
                            const info = {
                                name: currentProfile.profileName,
                                color: currentProfile.avatarColor || '#00A4DC',
                                initial: currentProfile.avatarInitial || (currentProfile.profileName ? currentProfile.profileName.charAt(0).toUpperCase() : 'P')
                            };
                            sessionStorage.setItem('jellyfin_profiles_active_info', JSON.stringify(info));
                        }
                    }

                    // Re-render bubble with the fetched info
                    const currentRouteType = this._lastRouteType || 'other';
                    this.evaluateFloatingBubbleVisibility(currentRouteType);
                })
                .catch(() => { this._profilePrefetchPending = false; });
        },

        // ── Header-container detection ───────────────────────────────────────────

        _findHeaderContainer: function () {
            // Strategy A: explicit Jellyfin class names (fast path)
            const byClass =
                document.querySelector('.headerRightButtons') ||
                document.querySelector('.headerSelfView') ||
                document.querySelector('.skinHeader-rightButtons') ||
                document.querySelector('.headerButtons-right') ||
                document.querySelector('.headerRight') ||
                document.querySelector('.viewHeaderRight');
            if (byClass) return byClass;

            // Strategy B: parent of any known Jellyfin icon button
            const knownBtn = document.querySelector(
                '.btnCurrentUser, .headerButtonUser, .headerButton-user, ' +
                '.btnCast, .headerButton-cast, ' +
                '[class*="headerButton"]:not(#profiles-floating-bubble)'
            );
            if (knownBtn) return knownBtn.parentElement;

            // Strategy C: find the button cluster inside a custom skin/theme header.
            // ElegantFin and Skin Manager themes wrap everything in .skinHeader or
            // a similarly named element; we pick the child that contains the most
            // icon buttons (likely the right-side group).
            const skinHeader = document.querySelector(
                '.skinHeader, .jellyfinHeader, [class*="skinHeader"], [class*="topBar"]'
            );
            if (skinHeader) {
                const children = skinHeader.querySelectorAll('div, nav, ul, span');
                let best = null, bestCount = 0;
                for (const el of children) {
                    const btns = el.querySelectorAll('button, a[role="button"]');
                    if (btns.length > bestCount && btns.length >= 2) {
                        bestCount = btns.length;
                        best = el;
                    }
                }
                return best;
            }

            return null;
        },

        // Finds the rightmost visible button within the top 80px of the viewport.
        // Theme-agnostic: works even when class names are completely non-standard.
        _findGeometricHeaderAnchor: function () {
            const candidates = document.querySelectorAll(
                'button:not(#profiles-floating-bubble), a[role="button"]:not(#profiles-floating-bubble)'
            );
            let rightmost = null, rightmostX = -Infinity;
            for (const el of candidates) {
                const r = el.getBoundingClientRect();
                if (r.top >= 0 && r.bottom <= 80 && r.width > 0 && r.right > rightmostX) {
                    rightmostX = r.right;
                    rightmost = el;
                }
            }
            return rightmost;
        },

        // Builds the icon-style button for header insertion.
        _buildHeaderBubble: function () {
            const b = document.createElement('button');
            b.id = 'profiles-floating-bubble';
            b.className = 'paper-icon-button-light headerButton';
            b.title = 'Switch Profile';
            b.setAttribute('aria-label', 'Switch Profile');

            const activeInfo = this.getCachedActiveProfile();
            b.innerHTML = `
                <div class="profiles-header-avatar" style="background-color: ${activeInfo.color}; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.85rem; font-weight: 700; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.5); border: 1.5px solid rgba(255,255,255,0.25); box-sizing: border-box;">
                    ${activeInfo.initial}
                </div>
            `;
            return b;
        },

        // Builds the corner pill button (last-resort fallback).
        _buildFallbackBubble: function () {
            const b = document.createElement('button');
            b.id = 'profiles-floating-bubble';
            b.className = 'profiles-floating-fallback';
            b.title = 'Switch Profile';
            b.setAttribute('aria-label', 'Switch Profile');

            // Set initial position dynamically
            const pos = this._findBestFallbackPosition();
            b.style.top = pos.top;
            b.style.bottom = pos.bottom;
            b.style.left = pos.left;
            b.style.right = pos.right;

            const activeInfo = this.getCachedActiveProfile();
            b.innerHTML = `
                <div class="profiles-header-avatar" style="background-color: ${activeInfo.color}; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.85rem; font-weight: 700; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.5); border: 1.5px solid rgba(255,255,255,0.25); box-sizing: border-box;">
                    ${activeInfo.initial}
                </div>
            `;
            return b;
        },

        _findBestFallbackPosition: function () {
            const corners = [
                // Top-Right
                { top: '80px', bottom: 'auto', left: 'auto', right: '24px', x: () => window.innerWidth - 60, y: () => 95 },
                // Top-Left
                { top: '80px', bottom: 'auto', left: '24px', right: 'auto', x: () => 60, y: () => 95 },
                // Bottom-Left
                { top: 'auto', bottom: '24px', left: '24px', right: 'auto', x: () => 60, y: () => window.innerHeight - 40 },
                // Bottom-Right
                { top: 'auto', bottom: '24px', left: 'auto', right: '24px', x: () => window.innerWidth - 60, y: () => window.innerHeight - 40 }
            ];

            for (const corner of corners) {
                const cx = corner.x();
                const cy = corner.y();
                if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;

                const el = document.elementFromPoint(cx, cy);
                if (!el) return corner;

                if (!el.closest('button, a, [role="button"], input, select, textarea, .headerButton, .paper-icon-button-light')) {
                    return corner;
                }
            }

            return corners[0];
        },

        // Inserts bubble before the user-account button, or appends if not found.
        _insertBeforeUserBtn: function (container, bubble) {
            const userBtn =
                container.querySelector('.headerButton-user, .btnCurrentUser, .headerButtonUser') ||
                container.lastElementChild;
            if (userBtn) {
                userBtn.parentNode.insertBefore(bubble, userBtn);
            } else {
                container.appendChild(bubble);
            }
        },


        attachBubbleClickHandler: function (bubble) {
            const activate = (e) => {
                e.preventDefault();
                e.stopPropagation();

                bubble.disabled = true;
                bubble.style.opacity = '0.45';
                bubble.style.cursor = 'wait';

                const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
                if (masterState && masterState.masterToken) {
                    // Switch back to master credentials in memory.
                    // No page reload — we show the profile selector directly on top of
                    // the current page.  This eliminates the entire reload-based white
                    // flash that clicking this button previously caused.
                    sessionStorage.removeItem(this.config.activeSessionKey);
                    sessionStorage.removeItem('jellyfin_profiles_active_info');
                    this.updateStoredCredentials(masterState.masterToken, masterState.masterUserId);
                    ApiClient.setAuthenticationInfo(masterState.masterToken, masterState.masterUserId);

                    // Show the overlay.  If _prefetchProfiles() already ran in the
                    // background the cached data is used and the overlay is instant.
                    this.interceptHomeAndShowProfiles();

                    // Re-enable the button after the overlay has appeared so it is
                    // ready if the user dismisses and re-opens the overlay.
                    setTimeout(() => {
                        bubble.disabled = false;
                        bubble.style.opacity = '';
                        bubble.style.cursor = '';
                    }, 400);
                } else {
                    // No master state found — restore button so the user can try again
                    bubble.disabled = false;
                    bubble.style.opacity = '';
                    bubble.style.cursor = '';
                    console.warn('ProfilesPlugin: Master state missing from localStorage — cannot switch profiles.');
                }
            };

            bubble.addEventListener('click', activate);

            // Explicit D-pad/keyboard Enter+Space handler.
            // Native <button> fires click on Enter in most browsers, but some TV browsers
            // (notably older Tizen and webOS) skip this for non-focused or injected elements.
            bubble.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') activate(e);
            });
        },

        injectStyles: function () {
            const style = document.createElement('style');
            style.innerHTML = `
                /* Scroll Block */
                body.profiles-no-scroll, html.profiles-no-scroll {
                    overflow: hidden !important;
                    height: 100% !important;
                }

                /* Hide loaders behind overlay */
                body.profiles-no-scroll .docloader,
                body.profiles-no-scroll .mainLoader,
                body.profiles-no-scroll .loadingSpinner,
                body.profiles-no-scroll .spinner,
                body.profiles-no-scroll .view-loader,
                body.profiles-no-scroll paper-spinner,
                body.profiles-no-scroll paper-spinner-lite,
                body.profiles-no-scroll [class*="loader"],
                body.profiles-no-scroll [class*="spinner"],
                body.profiles-no-scroll [id*="loader"],
                body.profiles-no-scroll [id*="spinner"] {
                    display: none !important;
                    opacity: 0 !important;
                    visibility: hidden !important;
                }

                /* Overlay Glassmorphic Layout */
                #profiles-gate-overlay {
                    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                    background: radial-gradient(circle at 50% 40%, #1e1e2e 0%, #0d0d12 100%);
                    z-index: 99999; display: flex; align-items: center; justify-content: center;
                    color: #fff; font-family: 'Outfit', 'Inter', sans-serif;
                    overflow-y: auto; padding: 2rem 0; box-sizing: border-box;
                    opacity: 1; transition: opacity 0.22s ease;
                }
                .profiles-modal-content {
                    text-align: center; max-width: 900px; width: 90%;
                    display: flex; flex-direction: column; align-items: center;
                    margin: auto;
                }
                .profiles-title {
                    font-size: 3rem; font-weight: 700; margin-bottom: 3rem;
                    text-shadow: 0 4px 20px rgba(0,0,0,0.6); letter-spacing: -0.05rem;
                }
                .profiles-grid {
                    display: flex; flex-wrap: wrap; gap: 3rem; justify-content: center; width: 100%;
                }
                .profile-card {
                    display: flex; flex-direction: column; align-items: center;
                    width: 140px; cursor: pointer; position: relative;
                }
                .profile-avatar-container {
                    position: relative; width: 130px; height: 130px;
                    margin-top: 15px;
                }
                .profile-crown {
                    position: absolute; top: -20px; left: 50%;
                    transform: translateX(-50%); z-index: 15;
                    pointer-events: none;
                    animation: crownFloat 3s ease-in-out infinite;
                }
                @keyframes crownFloat {
                    0% { transform: translateX(-50%) translateY(0); }
                    50% { transform: translateX(-50%) translateY(-4px) rotate(2deg); }
                    100% { transform: translateX(-50%) translateY(0); }
                }
                .profile-avatar {
                    position: relative;
                    width: 100%; height: 100%; border-radius: 20px;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 3.5rem; font-weight: bold; text-transform: uppercase;
                    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                    transition: transform 0.3s cubic-bezier(0.165, 0.84, 0.44, 1), box-shadow 0.3s ease, border-color 0.3s ease;
                    border: 3px solid transparent;
                }
                .profile-card:hover .profile-avatar,
                .profile-card:focus .profile-avatar,
                .profile-card:focus-within .profile-avatar {
                    transform: scale(1.08);
                    box-shadow: 0 15px 35px rgba(0,164,220,0.4);
                    border-color: rgba(255,255,255,0.8);
                }
                .profile-card:focus {
                    outline: none;
                }
                .add-avatar {
                    border: 3px dashed rgba(255,255,255,0.25);
                    background: rgba(255,255,255,0.02) !important; color: rgba(255,255,255,0.4);
                }
                .profile-card:hover .add-avatar,
                .profile-card:focus .add-avatar,
                .profile-card:focus-within .add-avatar {
                    border-color: rgba(255,255,255,0.8); color: #fff;
                    background: rgba(255,255,255,0.05) !important;
                }
                .profile-name {
                    margin-top: 1rem; font-size: 1.25rem; font-weight: 500;
                    opacity: 0.75; transition: opacity 0.3s ease;
                    display: flex; flex-direction: column; align-items: center; gap: 4px;
                }
                .profiles-limit-notice {
                    font-size: 0.85rem; color: rgba(255,255,255,0.35);
                    font-style: italic; align-self: center; padding: 1rem 0;
                    width: 140px; text-align: center;
                }
                .master-badge {
                    font-size: 0.8rem; opacity: 0.6; font-weight: 400;
                }
                .profile-card:hover .profile-name {
                    opacity: 1;
                }

                /* Manage Mode Overlay Icon styling */
                .profile-avatar-overlay-wrap {
                    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                    background: rgba(0, 0, 0, 0.65); border-radius: 20px;
                    display: flex; align-items: center; justify-content: center;
                    opacity: 0; transition: opacity 0.25s ease;
                    pointer-events: none;
                    z-index: 5;
                }
                .profile-card.manage-mode:hover .profile-avatar-overlay-wrap {
                    opacity: 1;
                }
                .profile-avatar-overlay-svg {
                    filter: drop-shadow(0 2px 6px rgba(0,0,0,0.6));
                }
                .profile-lock-indicator {
                    position: absolute; bottom: 8px; right: 8px;
                    background: rgba(15, 15, 15, 0.85); border-radius: 50%;
                    width: 32px; height: 32px; display: flex;
                    align-items: center; justify-content: center;
                    pointer-events: none;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.55);
                    border: 1.5px solid rgba(255,255,255,0.2);
                    z-index: 10;
                }
                .profile-bonfire-indicator {
                    position: absolute; top: 8px; left: 8px;
                    background: linear-gradient(135deg, #ff9900 0%, #ff5500 100%);
                    border-radius: 50%;
                    width: 32px; height: 32px; display: flex;
                    align-items: center; justify-content: center;
                    pointer-events: none;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.55);
                    border: 1.5px solid rgba(255,255,255,0.2);
                    z-index: 10;
                }
                #bonfire-join-input {
                    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 8px; padding: 10px; color: #fff; font-size: 1rem;
                    transition: border-color 0.25s, box-shadow 0.25s;
                }
                #bonfire-join-input:focus {
                    border-color: #00a4dc; outline: none;
                    box-shadow: 0 0 10px rgba(0, 164, 220, 0.4);
                }
                .bonfire-kick-btn:focus, .bonfire-kick-btn:hover {
                    background-color: #e64980 !important;
                    outline: none;
                    box-shadow: 0 0 10px rgba(255, 107, 107, 0.4);
                }
                .profile-card.manage-mode:hover .profile-avatar {
                    transform: scale(1.08);
                    border-color: #00a4dc;
                }

                /* PIN Status Badges */
                .profile-pin-badge {
                    font-size: 0.75rem; margin-top: 4px; padding: 2px 8px; border-radius: 12px;
                    font-weight: 600; display: inline-flex; align-items: center; gap: 4px;
                }
                .profile-pin-badge.locked {
                    background: rgba(230, 0, 0, 0.15); color: #ff6b6b;
                    border: 1px solid rgba(230, 0, 0, 0.3);
                }
                .profile-pin-badge.unlocked {
                    background: rgba(0, 230, 0, 0.1); color: #51cf66;
                    border: 1px solid rgba(0, 230, 0, 0.25);
                }

                /* Floating Profiles Selector Bubble — fallback corner pill */
                /* This only appears when header injection fails entirely.    */
                #profiles-floating-bubble.profiles-floating-fallback {
                    position: fixed;
                    bottom: 24px; left: 24px; right: auto; top: auto;
                    z-index: 9999;
                    background: transparent;
                    color: #fff; padding: 0; border-radius: 50%;
                    cursor: pointer;
                    display: inline-flex; align-items: center; justify-content: center;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.35);
                    transition: transform 0.2s ease, box-shadow 0.2s ease;
                    border: none;
                    width: 40px; height: 40px;
                }
                #profiles-floating-bubble.profiles-floating-fallback:hover,
                #profiles-floating-bubble.profiles-floating-fallback:focus {
                    transform: scale(1.08) translateY(-2px);
                    box-shadow: 0 8px 20px rgba(0,0,0,0.5);
                    outline: none;
                }

                /* Header button integration style */
                #profiles-floating-bubble.headerButton {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    color: inherit;
                    background: transparent;
                    border: none;
                    cursor: pointer;
                    vertical-align: middle;
                    margin: 0 4px;
                    padding: 0;
                }

                /* Footer and bottom buttons */
                .profiles-footer {
                    margin-top: 4rem; width: 100%; display: flex; justify-content: center;
                }

                /* PIN Entry Form styles */
                .pin-entry-container {
                    display: flex; flex-direction: column; align-items: center; gap: 2rem;
                }
                #profile-pin-input, #master-pin-input {
                    background: rgba(255,255,255,0.06); border: 2px solid rgba(255,255,255,0.15);
                    border-radius: 12px; color: #fff; font-size: 2.5rem; text-align: center;
                    padding: 12px; width: 180px; letter-spacing: 0.6rem;
                    transition: border-color 0.3s ease, box-shadow 0.3s ease;
                    -webkit-text-security: disc;
                }
                #create-pin-input, #edit-pin-input {
                    -webkit-text-security: disc;
                }
                #profile-pin-input:focus, #master-pin-input:focus {
                    border-color: #00a4dc; outline: none;
                    box-shadow: 0 0 15px rgba(0,164,220,0.3);
                }
                .pin-error-text {
                    color: #ff6b6b;
                    font-size: 0.95rem;
                    font-weight: 500;
                    margin-top: -10px;
                    text-align: center;
                }
                .pin-input-error {
                    border-color: #ff6b6b !important;
                    box-shadow: 0 0 15px rgba(255, 107, 107, 0.4) !important;
                }

                /* Button Styling */
                .profiles-btn {
                    padding: 10px 24px; border: none; border-radius: 8px;
                    font-weight: 600; font-size: 1rem; cursor: pointer;
                    transition: background-color 0.25s ease, transform 0.2s ease;
                }
                .btn-primary {
                    background-color: #00a4dc; color: #fff;
                }
                .btn-primary:hover,
                .btn-primary:focus {
                    background-color: #0082ad; transform: translateY(-1px);
                    outline: none;
                }
                .btn-secondary {
                    background-color: rgba(255,255,255,0.08); color: rgba(255,255,255,0.7);
                    border: 1px solid rgba(255,255,255,0.15);
                }
                .btn-secondary:hover,
                .btn-secondary:focus {
                    background-color: rgba(255,255,255,0.15); color: #fff;
                    outline: none;
                }
                .pin-actions {
                    display: flex; gap: 1.25rem; margin-top: 1rem;
                }

                /* Profile Creation Form styles */
                .create-profile-container {
                    width: 100%; max-width: 440px; box-sizing: border-box;
                    display: flex; flex-direction: column; gap: 1.5rem;
                    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07);
                    border-radius: 20px; padding: 2rem; box-shadow: 0 20px 50px rgba(0,0,0,0.4);
                    text-align: left; max-height: 75vh; overflow-y: auto;
                }
                .profile-dialog-actions {
                    margin-top: 1rem; display: flex; justify-content: space-between; width: 100%; gap: 10px;
                }
                .dialog-action-buttons {
                    display: flex; gap: 10px;
                }
                .btn-danger {
                    background: rgba(230,0,0,0.85); color:#fff; border:none;
                }
                .btn-danger:hover,
                .btn-danger:focus {
                    background: rgba(200,0,0,0.95);
                    outline: none;
                }

                /* Mobile Responsiveness Media Queries */
                @media (max-width: 600px) {
                    #profiles-floating-bubble.profiles-floating-fallback {
                        left: 12px;
                        right: auto;
                        bottom: 12px;
                    }
                }
                @media (max-width: 480px) {
                    .profiles-title {
                        font-size: 2.2rem;
                        margin-bottom: 2rem;
                    }
                    .profile-dialog-actions {
                        flex-direction: column;
                    }
                    .dialog-action-buttons {
                        width: 100%;
                    }
                    .dialog-action-buttons button, #edit-delete-btn {
                        flex: 1;
                        width: 100%;
                        text-align: center;
                    }
                }
                .form-group {
                    display: flex; flex-direction: column; gap: 0.5rem;
                }
                .form-group label {
                    font-size: 0.9rem; font-weight: 600; color: rgba(255,255,255,0.6);
                }
                .form-group input[type="text"],
                .form-group input[type="password"] {
                    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 8px; padding: 10px; color: #fff; font-size: 1rem;
                }
                .form-group select {
                    background: rgba(255, 255, 255, 0.06) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23ffffff'%3E%3Cpath d='M7 10l5 5 5-5H7z'/%3E%3C/svg%3E") no-repeat right 12px center;
                    background-size: 20px;
                    border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 8px; padding: 10px; color: #fff; font-size: 1rem;
                    cursor: pointer;
                    appearance: none;
                    -webkit-appearance: none;
                    -moz-appearance: none;
                    padding-right: 36px;
                }
                .form-group select option {
                    background-color: #1a1a1a;
                    color: #fff;
                }
                .form-group input:focus, .form-group select:focus {
                    border-color: #00a4dc; outline: none;
                    box-shadow: 0 0 10px rgba(0, 164, 220, 0.4);
                }
                .avatar-color-picker {
                    display: flex; flex-wrap: wrap; gap: 10px;
                }
                .color-dot {
                    width: 32px; height: 32px; border-radius: 50%; cursor: pointer;
                    border: 2px solid transparent; transition: transform 0.2s ease, border-color 0.2s ease;
                }
                .color-dot:hover,
                .color-dot:focus {
                    border-color: rgba(255,255,255,0.8);
                    transform: scale(1.1);
                    outline: none;
                }
                .color-dot.active {
                    border-color: #fff; transform: scale(1.1);
                }
                .library-checklist {
                    background: rgba(255,255,255,0.04); border-radius: 8px;
                    padding: 10px; display: flex; flex-direction: column; gap: 0.5rem;
                    max-height: 140px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.1);
                }
                .library-check-label {
                    display: flex; align-items: center; gap: 0.6rem; cursor: pointer;
                    font-size: 0.95rem; color: rgba(255,255,255,0.85);
                }
                .library-check-label input {
                    cursor: pointer; accent-color: #00a4dc;
                }
                .form-hint {
                    font-size: 0.78rem;
                    color: rgba(255,255,255,0.4);
                    margin-top: -0.2rem;
                    text-align: left;
                }

                /* Switch-Profile bubble — fade transition */
                #profiles-floating-bubble {
                    transition: opacity 0.15s ease;
                }
                #profiles-floating-bubble.profiles-bubble-hiding {
                    opacity: 0 !important;
                    pointer-events: none;
                }
                /* Fallback bubble — fade transition (defers all positioning to ID rule above) */
                .profiles-floating-fallback {
                    transition: opacity 0.15s ease;
                }
                .profiles-floating-fallback.profiles-bubble-hiding {
                    opacity: 0 !important;
                    pointer-events: none;
                }

                /* Keyframe Animations */
                .anim-fade-in {
                    animation: fadeIn 0.4s cubic-bezier(0.165, 0.84, 0.44, 1) forwards;
                }
                @keyframes fadeIn {
                    from { opacity: 0; transform: scale(0.96) translateY(10px); }
                    to { opacity: 1; transform: scale(1) translateY(0); }
                }

                /* Devices Dropdown Styles */
                .devices-dropdown-trigger {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 10px 14px;
                    background: rgba(0,0,0,0.2);
                    border: 1px solid rgba(255,255,255,0.1);
                    border-radius: 6px;
                    cursor: pointer;
                    user-select: none;
                    font-size: 0.95rem;
                    transition: border-color 0.2s, box-shadow 0.2s;
                }
                .devices-dropdown-trigger:focus {
                    outline: none;
                    border-color: #00a4dc !important;
                    box-shadow: 0 0 10px rgba(0, 164, 220, 0.5) !important;
                }
                .devices-dropdown-trigger:hover {
                    background: rgba(255,255,255,0.05);
                }
                .devices-dropdown-list {
                    background: #202020;
                    border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 6px;
                    max-height: 250px;
                    overflow-y: auto;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                }
                .device-dropdown-item {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 8px 12px;
                    border-bottom: 1px solid rgba(255,255,255,0.05);
                    transition: background 0.2s;
                }
                .device-dropdown-item:hover, .device-dropdown-item:focus-within {
                    background: rgba(255,255,255,0.03);
                }
                .device-delete-btn:focus {
                    outline: none;
                    background: rgba(255,107,107,0.2) !important;
                }
            `;
            document.head.appendChild(style);
        }
    };

    ProfilesPlugin.init();
})();
