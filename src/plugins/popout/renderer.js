/*
 * Pop-out chat. In the main window it adds a pop-out button to the chat header
 * and lets you Shift+click or middle-click a chat to pop it out. In a pop-out
 * window it hides the sidebar and adds pin (always on top) and dock buttons.
 */
PlumoseCore.definePlugin('popout', (api) => {
    'use strict';

    const { h, icons, cleanError } = PlumoseCore;
    const CHAT_PATH = /^\/(chat\/\d+|\d+\/\d+)\/?$/;
    const HEADER_BUTTONS = 'main[class*="chatContainer-"] > [class*="container-"] [class*="buttons-"]';
    const DOCK_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/></svg>';

    // The pop-out runs a second copy of the web app. Keep it from doubling up on
    // message notifications and sounds; the main window still handles those.
    // This runs before the web app's own scripts, which is what makes it stick.
    if (api.isPopout) {
        const getItem = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
            if (key === 'suppressNotifications' && this === window.localStorage) return 'true';
            return getItem.call(this, key);
        };
    }

    const chatPath = (href) => {
        try {
            const { pathname, origin } = new URL(href, location.href);
            return origin === location.origin && CHAT_PATH.test(pathname) ? pathname.replace(/\/+$/, '') : null;
        } catch {
            return null;
        }
    };

    /** The conversation name shown in the chat header, for the window title. */
    function headerTitle() {
        const header = document.querySelector('main[class*="chatContainer-"] > [class*="container-"]');
        const label = document.querySelector('main[class*="chatContainer-"]')?.getAttribute('aria-label') || '';
        const text = header?.querySelector('[class*="title-"], [class*="name-"], h1, h2, h3')?.textContent?.trim();
        return text || label.replace(/^[^ ]+ [^ ]+ /, '').trim() || null;
    }

    async function popOut(path, title) {
        try {
            // Plain copies of the desktop identity, so the pop-out can sign in as the same client.
            const n = window.OsmiumNative;
            const info = n?.clientInfo ? JSON.parse(JSON.stringify({ version: n.version, clientInfo: n.clientInfo })) : null;
            await api.invoke('open', path, title, info);
        } catch (err) {
            console.error('[Plumose:popout]', cleanError(err));
        }
    }

    /** A header button that borrows Osmium's own icon class, so it lines up with search/call/pin. */
    function headerButton(key, label, icon, onclick) {
        // Narrow windows use Osmium's mobile header, which has a second button group
        // on the left for the back arrow. Ours go in the right-hand group.
        const groups = document.querySelectorAll(HEADER_BUTTONS);
        const bar = groups[groups.length - 1];
        if (!bar) return null;
        let btn = bar.querySelector(`[data-osm-popout="${key}"]`);
        if (btn) return btn;
        const native = [...bar.children].find((el) => !el.dataset.osmPopout && /\bicon-/.test(el.className));
        btn = h('span', {
            class: `${native?.className || ''} osm-popout-btn`, 'data-osm-popout': key,
            role: 'button', tabindex: '0', 'aria-label': label, title: label, html: icon,
            onclick, onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onclick(e)),
        });
        bar.prepend(btn);
        return btn;
    }

    /* ------------------------------------------------------ main window -- */

    function mainWindow() {
        api.onDom(() => {
            const path = chatPath(location.href);
            const existing = document.querySelector('[data-osm-popout="open"]');
            if (!path) return existing?.remove();
            headerButton('open', 'Open in a new window', icons.popout, () => {
                const current = chatPath(location.href);
                if (current) popOut(current, headerTitle());
            });
        });

        // Shift+click or middle-click a chat link in the sidebar.
        const onClick = (e) => {
            const shift = e.type === 'click' && e.shiftKey;
            const middle = e.type === 'auxclick' && e.button === 1;
            if (!shift && !middle) return;
            const link = e.target.closest?.('a[href]');
            const path = link && chatPath(link.getAttribute('href'));
            if (!path) return;
            e.preventDefault();
            e.stopPropagation();
            const name = link.querySelector('[class*="name-"], [class*="title-"]')?.textContent?.trim() || link.textContent.trim().split('\n')[0];
            popOut(path, name?.slice(0, 60));
        };
        document.addEventListener('click', onClick, true);
        document.addEventListener('auxclick', onClick, true);
        // Stops Chromium's autoscroll on middle-click over chat links.
        const onDown = (e) => e.button === 1 && e.target.closest?.('a[href]') && chatPath(e.target.closest('a[href]').getAttribute('href')) && e.preventDefault();
        document.addEventListener('mousedown', onDown, true);
        api.track(() => {
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('auxclick', onClick, true);
            document.removeEventListener('mousedown', onDown, true);
        });

        // "Dock" in a pop-out sends the main window back to that chat.
        api.on('navigate', (path) => {
            if (CHAT_PATH.test(path)) api.client()?.navigation?.navigate?.(path);
        });
    }

    /* ---------------------------------------------------- pop-out window -- */

    function popoutWindow() {
        let onTop = false;
        let lastTitle = null;

        const syncPin = (btn) => {
            btn.classList.toggle('is-on', onTop);
            btn.setAttribute('aria-pressed', String(onTop));
            btn.title = onTop ? 'Unpin from top' : 'Keep on top';
            btn.setAttribute('aria-label', btn.title);
        };

        api.invoke('isOnTop').then((v) => {
            onTop = !!v;
            const btn = document.querySelector('[data-osm-popout="pin"]');
            if (btn) syncPin(btn);
        }).catch(() => {});

        api.onDom(() => {
            document.documentElement.classList.toggle('osm-popout-hide-profile', !!api.settings.hideProfilePanel);
            const pin = headerButton('pin', 'Keep on top', icons.pin, async () => {
                onTop = await api.invoke('setOnTop', !onTop).catch(() => onTop);
                syncPin(pin);
            });
            if (pin) syncPin(pin);
            headerButton('dock', 'Back to the main window', DOCK_ICON, () => api.invoke('dock'));

            const title = headerTitle();
            if (title && title !== lastTitle) {
                lastTitle = title;
                api.invoke('setTitle', title).catch(() => {});
            }
        });
    }

    return {
        start() {
            if (api.isPopout) popoutWindow();
            else mainWindow();
        },
        stop() {
            document.querySelectorAll('[data-osm-popout]').forEach((el) => el.remove());
        },
        onSettings() {
            document.documentElement.classList.toggle('osm-popout-hide-profile', !!api.settings.hideProfilePanel);
        },
    };
});
