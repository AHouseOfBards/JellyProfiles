(function () {
    'use strict';

    const ProfilesPlugin = {
        config: {
            masterStorageKey: 'jellyfin_profiles_master_state',
            activeSessionKey: 'jellyfin_profiles_active_token'
        },
        pluginId: 'b1462fca-774b-4b13-8d02-e2d4f2bc18b9',
        isManageMode: false,
        masterPin: null,
        cachedProfiles: [],

        getAuthHeaders: function (token) {
            const apiClient = ApiClient;
            const client = typeof apiClient.appName === 'function' ? apiClient.appName() : (apiClient.appName || apiClient._appName || 'Jellyfin Web');
            const device = typeof apiClient.deviceName === 'function' ? apiClient.deviceName() : (apiClient.deviceName || apiClient._deviceName || 'Chrome');
            const deviceId = typeof apiClient.deviceId === 'function' ? apiClient.deviceId() : (apiClient.deviceId || apiClient._deviceId || '');
            const version = typeof apiClient.appVersion === 'function' ? apiClient.appVersion() : (apiClient.appVersion || apiClient._appVersion || '');
            
            const headers = {
                'Authorization': `MediaBrowser Client="${client}", Device="${device}", DeviceId="${deviceId}", Version="${version}", Token="${token}"`
            };
            
            console.log("ProfilesPlugin [Auth Debug]:", {
                client: client,
                device: device,
                deviceId: deviceId,
                version: version,
                token: token,
                generatedHeaders: headers
            });

            return headers;
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
            this.bindEvents();
            this.injectStyles();
            this.validateSessionState();
        },

        bindEvents: function () {
            // Support legacy viewshow event
            document.addEventListener('viewshow', (e) => {
                const currentView = e.detail.type;
                if (currentView === 'home' && !this.isProfileSessionActive()) {
                    this.interceptHomeAndShowProfiles();
                }
                this.evaluateFloatingBubbleVisibility(currentView);
            });

            // Support SPA navigation in new React client via popstate and hashchange
            window.addEventListener('popstate', () => this.checkRoute());
            window.addEventListener('hashchange', () => this.checkRoute());

            // Intercept history.pushState and history.replaceState
            const pushState = history.pushState;
            history.pushState = function (...args) {
                pushState.apply(history, args);
                window.dispatchEvent(new Event('pushstate'));
            };
            const replaceState = history.replaceState;
            history.replaceState = function (...args) {
                replaceState.apply(history, args);
                window.dispatchEvent(new Event('replacestate'));
            };
            window.addEventListener('pushstate', () => this.checkRoute());
            window.addEventListener('replacestate', () => this.checkRoute());

            // Periodically verify route in case of framework-specific silent transition
            setInterval(() => this.checkRoute(), 500);

            // Initial check on load
            setTimeout(() => this.checkRoute(), 200);
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

            if (isHome) {
                if (!this.isProfileSessionActive() && !document.getElementById('profiles-gate-overlay')) {
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

            const isPlayer = hash.includes('videoosd') || hash.includes('item') || path.includes('videoosd') || path.includes('item');
            this.evaluateFloatingBubbleVisibility(isPlayer ? 'videoosd' : (isHome ? 'home' : 'other'));
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

        validateSessionState: function () {
            const apiClient = ApiClient;
            if (!apiClient) return;

            const currentToken = apiClient.accessToken();
            if (!currentToken) {
                // Only clear master credentials if we are on a page that indicates logout,
                // like login or selectserver, to prevent premature wiping during connection initialization
                const hash = window.location.hash || '';
                const path = window.location.pathname || '';
                if (hash.includes('login') || hash.includes('selectserver') || path.includes('login') || path.includes('selectserver')) {
                    localStorage.removeItem(this.config.masterStorageKey);
                    sessionStorage.removeItem(this.config.activeSessionKey);
                }
                return;
            }

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
                    window.location.reload();
                }
            }
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
            const url = apiClient.getUrl(`plugins/profiles/list`);
            
            fetch(url, {
                headers: this.getAuthHeaders(masterToken)
            })
            .then(res => {
                if (res.status === 401) throw new Error("Unauthorized");
                return res.json();
            })
            .then(profiles => {
                const normalized = (profiles || []).map(p => ({
                    profileUserId: p.profileUserId || p.ProfileUserId,
                    profileName: p.profileName || p.ProfileName,
                    avatarInitial: p.avatarInitial || p.AvatarInitial,
                    avatarColor: p.avatarColor || p.AvatarColor,
                    requiresPin: p.requiresPin !== undefined ? p.requiresPin : p.RequiresPin,
                    isMaster: p.isMaster !== undefined ? p.isMaster : p.IsMaster
                }));
                this.cachedProfiles = normalized;
                this.showProfileOverlay(normalized);
            })
            .catch(err => {
                console.error("Failed to load sub-profiles:", err);
                localStorage.removeItem(this.config.masterStorageKey);
            });
        },

        showProfileOverlay: function (profiles) {
            const skinHeader = document.querySelector('.skinHeader');
            if (skinHeader) skinHeader.style.display = 'none';

            const viewHome = document.getElementById('view-home');
            if (viewHome) viewHome.style.filter = 'blur(25px)';

            let overlay = document.getElementById('profiles-gate-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'profiles-gate-overlay';
                document.body.appendChild(overlay);
            }

            // Disable scrolling
            document.body.classList.add('profiles-no-scroll');
            document.documentElement.classList.add('profiles-no-scroll');

            this.renderOverlayContent(overlay, profiles);
        },

        removeProfileOverlay: function () {
            const overlay = document.getElementById('profiles-gate-overlay');
            if (overlay) overlay.remove();

            // Re-enable scrolling
            document.body.classList.remove('profiles-no-scroll');
            document.documentElement.classList.remove('profiles-no-scroll');

            const skinHeader = document.querySelector('.skinHeader');
            if (skinHeader) skinHeader.style.display = '';

            const viewHome = document.getElementById('view-home');
            if (viewHome) viewHome.style.filter = '';
        },

        renderOverlayContent: function (overlay, profiles) {
            const title = this.isManageMode ? "Manage Profiles" : "Who's Watching?";
            const manageBtnText = this.isManageMode ? "Done" : "Manage Profiles";

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
                        
                        ${!this.isManageMode ? `
                        <div class="profile-card action-add-profile" tabindex="0">
                            <div class="profile-avatar-container">
                                <div class="profile-avatar add-avatar">+</div>
                            </div>
                            <div class="profile-name">Add Profile</div>
                        </div>
                        ` : ''}
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
                    <input type="password" id="profile-pin-input" maxlength="8" pattern="[0-9]*" inputmode="numeric" placeholder="••••" autofocus />
                    <div id="pin-error-msg" class="pin-error-text" style="display: none;"></div>
                    <div class="pin-actions">
                        <button id="pin-submit-btn" class="profiles-btn btn-primary">Unlock</button>
                        <button id="pin-cancel-btn" class="profiles-btn btn-secondary">Back</button>
                    </div>
                </div>
            `;

            const pinInput = document.getElementById('profile-pin-input');
            const errorMsg = document.getElementById('pin-error-msg');
            pinInput.focus();

            const showPinError = (msg) => {
                // Set inline styles directly so Jellyfin's own stylesheet cannot override them
                pinInput.style.borderColor = '#ff6b6b';
                pinInput.style.boxShadow = '0 0 15px rgba(255, 107, 107, 0.4)';
                pinInput.classList.add('pin-input-error');
                errorMsg.textContent = msg || 'Incorrect PIN. Please try again.';
                errorMsg.style.display = 'block';
                pinInput.value = '';
                pinInput.focus();
            };

            const clearError = () => {
                pinInput.classList.remove('pin-input-error');
                pinInput.style.borderColor = '';
                pinInput.style.boxShadow = '';
                errorMsg.style.display = 'none';
                errorMsg.textContent = '';
            };

            pinInput.addEventListener('input', clearError);
            pinInput.addEventListener('focus', clearError);

            const submitPin = () => {
                const pin = pinInput.value;
                this.executeProfileSwitch(profileId, pin, showPinError);
            };

            document.getElementById('pin-submit-btn').addEventListener('click', submitPin);
            pinInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') submitPin();
            });

            document.getElementById('pin-cancel-btn').addEventListener('click', () => {
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
                    <input type="password" id="master-pin-input" maxlength="8" pattern="[0-9]*" inputmode="numeric" placeholder="••••" autofocus />
                    <div id="master-pin-error-msg" class="pin-error-text" style="display: none;"></div>
                    <div class="pin-actions">
                        <button id="master-pin-submit-btn" class="profiles-btn btn-primary">Submit</button>
                        <button id="master-pin-cancel-btn" class="profiles-btn btn-secondary">Cancel</button>
                    </div>
                </div>
            `;

            const pinInput = document.getElementById('master-pin-input');
            const errorMsg = document.getElementById('master-pin-error-msg');
            pinInput.focus();

            const clearError = () => {
                pinInput.classList.remove('pin-input-error');
                errorMsg.style.display = 'none';
                errorMsg.innerText = '';
            };

            pinInput.addEventListener('input', clearError);
            pinInput.addEventListener('focus', clearError);

            const submitPin = () => {
                const pin = pinInput.value;
                const apiClient = ApiClient;
                const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
                if (!masterState) return;

                const url = apiClient.getUrl('plugins/profiles/verify-pin');
                fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...this.getAuthHeaders(masterState.masterToken)
                    },
                    body: JSON.stringify({ profileId: masterProfile.profileUserId, pin: pin })
                })
                .then(res => {
                    if (!res.ok) throw new Error("Invalid PIN");
                    this.masterPin = pin;
                    callback();
                })
                .catch(err => {
                    // Inline styles ensure visibility regardless of Jellyfin stylesheet specificity
                    pinInput.style.borderColor = '#ff6b6b';
                    pinInput.style.boxShadow = '0 0 15px rgba(255, 107, 107, 0.4)';
                    pinInput.classList.add('pin-input-error');
                    errorMsg.textContent = 'Incorrect Master PIN. Please try again.';
                    errorMsg.style.display = 'block';
                    pinInput.value = '';
                    pinInput.focus();
                });
            };

            document.getElementById('master-pin-submit-btn').addEventListener('click', submitPin);
            pinInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') submitPin();
            });

            document.getElementById('master-pin-cancel-btn').addEventListener('click', () => {
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
                this.updateStoredCredentials(activeProfileToken, jellyfinUserId);
                apiClient.setAuthenticationInfo(activeProfileToken, jellyfinUserId);

                this.removeProfileOverlay();
                window.location.reload();
            })
            .catch(err => {
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

            // Fetch libraries matching master user permissions
            const libUrl = apiClient.getUrl('plugins/profiles/libraries');
            fetch(libUrl, {
                headers: this.getAuthHeaders(masterState.masterToken)
            })
            .then(res => res.json())
            .then(libraries => {
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
                            <input type="password" id="create-pin-input" maxlength="8" pattern="[0-9]*" inputmode="numeric" placeholder="Leave empty for no PIN" />
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

                document.getElementById('create-submit-btn').addEventListener('click', () => {
                    const name = document.getElementById('create-name-input').value.trim();
                    const pin = document.getElementById('create-pin-input').value;
                    const rating = document.getElementById('create-rating-select').value;
                    
                    const checkedLibs = [];
                    content.querySelectorAll('.library-checkbox:checked').forEach(cb => {
                        checkedLibs.push(cb.value);
                    });

                    if (!name) {
                        alert("Profile name is required.");
                        return;
                    }

                    if (pin && (pin.length < 4 || pin.length > 8 || !/^\d+$/.test(pin))) {
                        alert("PIN code must be a numeric value between 4 and 8 digits.");
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
                            masterPin: this.masterPin
                        })
                    })
                    .then(res => {
                        if (!res.ok) return res.text().then(text => { throw new Error(text); });
                        return res.json();
                    })
                    .then(() => {
                        this.fetchAndRenderProfiles(apiClient, masterState.masterUserId, masterState.masterToken);
                    })
                    .catch(err => alert("Error: " + err.message));
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

            // Fetch libraries matching master permissions
            const libUrl = apiClient.getUrl('plugins/profiles/libraries');
            // Fetch target profile user's specific policy details
            const userUrl = apiClient.getUrl(`Users/${profile.profileUserId}`);

            Promise.all([
                fetch(libUrl, { headers: this.getAuthHeaders(masterState.masterToken) }).then(res => res.json()),
                fetch(userUrl, { headers: this.getAuthHeaders(masterState.masterToken) }).then(res => res.json())
            ])
            .then(([libraries, userDetails]) => {
                const normalizedLibs = (libraries || []).map(lib => ({
                    id: lib.id || lib.Id,
                    name: lib.name || lib.Name,
                    collectionType: lib.collectionType || lib.CollectionType
                }));
                const policy = userDetails.Policy || userDetails.policy || {};
                const blockedFolders = policy.BlockedMediaFolders || policy.blockedMediaFolders || [];
                const enableAll = policy.EnableAllFolders !== undefined ? policy.EnableAllFolders : (policy.enableAllFolders || false);
                const maxRating = policy.MaxParentalRating !== undefined ? policy.MaxParentalRating : (policy.maxParentalRating !== undefined ? policy.maxParentalRating : null);

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
                                <input type="password" id="edit-pin-input" maxlength="8" pattern="[0-9]*" inputmode="numeric" placeholder="${profile.requiresPin ? '••••' : 'Unprotected'}" style="flex:1;" />
                                ${profile.requiresPin ? `<button id="edit-clear-pin-btn" class="profiles-btn btn-secondary" style="padding:10px 15px;">Clear PIN</button>` : ''}
                            </div>
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
                                    const isChecked = enableAll || !blockedFolders.some(bf => this.normalizeGuid(bf) === this.normalizeGuid(lib.id));
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
                    
                    let rating = null;
                    let checkedLibs = null;
                    if (!profile.isMaster) {
                        rating = document.getElementById('edit-rating-select').value;
                        checkedLibs = [];
                        content.querySelectorAll('.library-checkbox:checked').forEach(cb => {
                            checkedLibs.push(cb.value);
                        });
                    }

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
                            masterPin: this.masterPin
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

        evaluateFloatingBubbleVisibility: function (viewType) {
            let bubble = document.getElementById('profiles-floating-bubble');
            
            // Hide the button during playback/OSD
            if (viewType === 'videoosd' || viewType === 'item') {
                if (bubble) bubble.style.display = 'none';
                return;
            }

            if (!this.isProfileSessionActive()) {
                if (bubble) bubble.remove();
                return;
            }

            const headerRight = document.querySelector('.headerRightButtons')
                              || document.querySelector('.headerSelfView')
                              || document.querySelector('.skinHeader-rightButtons')
                              || document.querySelector('.headerButtons-right');
            if (headerRight) {
                // Remove fallback bubble if it exists in the body
                if (bubble && (bubble.tagName === 'DIV' || bubble.parentElement !== headerRight)) {
                    bubble.remove();
                    bubble = null;
                }

                if (!bubble) {
                    bubble = document.createElement('button');
                    bubble.id = 'profiles-floating-bubble';
                    bubble.className = 'paper-icon-button-light headerButton';
                    bubble.title = 'Switch Profile';
                    // Material Icon "people" is standard for multiple users/profiles
                    bubble.innerHTML = '<span class="material-icons">people</span>';
                    
                    // Insert before the user profile button
                    const userBtn = headerRight.querySelector('.headerButton-user') || headerRight.lastElementChild;
                    if (userBtn) {
                        headerRight.insertBefore(bubble, userBtn);
                    } else {
                        headerRight.appendChild(bubble);
                    }

                    this.attachBubbleClickHandler(bubble);
                }
            } else {
                // Fallback to absolute positioned floating bubble if header buttons container is not found
                if (bubble && bubble.tagName === 'BUTTON') {
                    bubble.remove();
                    bubble = null;
                }

                if (!bubble) {
                    bubble = document.createElement('button');
                    bubble.id = 'profiles-floating-bubble';
                    bubble.className = 'profiles-floating-fallback';
                    bubble.innerText = 'Profiles';
                    document.body.appendChild(bubble);
                    
                    this.attachBubbleClickHandler(bubble);
                }
            }

            if (bubble) bubble.style.display = '';
        },

        attachBubbleClickHandler: function (bubble) {
            bubble.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const masterState = JSON.parse(localStorage.getItem(this.config.masterStorageKey));
                if (masterState && masterState.masterToken) {
                    sessionStorage.removeItem(this.config.activeSessionKey);
                    this.updateStoredCredentials(masterState.masterToken, masterState.masterUserId);
                    ApiClient.setAuthenticationInfo(masterState.masterToken, masterState.masterUserId);
                    window.location.reload();
                }
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
                    background: radial-gradient(circle, rgba(20,20,20,0.85) 0%, rgba(10,10,10,0.98) 100%);
                    backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px);
                    z-index: 99999; display: flex; align-items: center; justify-content: center;
                    color: #fff; font-family: 'Outfit', 'Inter', sans-serif;
                    overflow-y: auto; padding: 2rem 0; box-sizing: border-box;
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

                /* Floating Profiles Selector Bubble - Fallback style */
                #profiles-floating-bubble.profiles-floating-fallback {
                    position: fixed; top: 15px; right: 220px; z-index: 9999;
                    background: var(--theme-accent-color, #00a4dc);
                    color: #fff; padding: 7px 16px; border-radius: 20px;
                    font-weight: 600; cursor: pointer; font-size: 0.85rem;
                    box-shadow: 0 6px 16px rgba(0,164,220,0.3);
                    transition: transform 0.25s ease, box-shadow 0.25s ease;
                    border: none;
                }
                #profiles-floating-bubble.profiles-floating-fallback:hover,
                #profiles-floating-bubble.profiles-floating-fallback:focus {
                    transform: translateY(-2px);
                    box-shadow: 0 8px 20px rgba(0,164,220,0.5);
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
                        right: 15px;
                        bottom: 15px;
                        top: auto;
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

                /* Keyframe Animations */
                .anim-fade-in {
                    animation: fadeIn 0.4s cubic-bezier(0.165, 0.84, 0.44, 1) forwards;
                }
                @keyframes fadeIn {
                    from { opacity: 0; transform: scale(0.96) translateY(10px); }
                    to { opacity: 1; transform: scale(1) translateY(0); }
                }
            `;
            document.head.appendChild(style);
        }
    };

    ProfilesPlugin.init();
})();
