'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, shell } = require('electron');

// Chat routes in the web app: /chat/<id> for DMs and groups, /<community>/<channel> for channels.
const CHAT_PATH = /^\/(chat\/\d+|\d+\/\d+)\/?$/;

function iconPath() {
    const base = path.join(process.resourcesPath, 'assets');
    const candidates =
        process.platform === 'win32' ? ['icon.ico'] : process.platform === 'darwin' ? ['icon.icns'] : ['icons/512x512.png', 'icon-1024.png'];
    return candidates.map((c) => path.join(base, c)).find((f) => fs.existsSync(f));
}

module.exports = {
    name: 'Pop-out Chat',
    description: 'Open a chat in its own window. Use the button in the chat header, or Shift+click / middle-click a chat in the sidebar.',
    popout: true,
    settings: {
        alwaysOnTop: { type: 'boolean', default: false, label: 'Keep new pop-outs on top', description: 'You can also pin each window from its header.' },
        hideProfilePanel: { type: 'boolean', default: true, label: 'Hide the profile panel in pop-outs', description: 'Gives the conversation the whole window.' },
    },

    main(ctx) {
        const origin = new URL(process.env.APP_URL || 'https://web.osmium.chat/').origin;
        const windows = new Map(); // chat path → BrowserWindow
        // Osmium's session token is tied to the desktop client's identity, which
        // its preload reports as OsmiumNative.clientInfo. Pop-outs don't load that
        // preload, so they borrow the identity the main window reported.
        let native = ctx.readData('native', null);

        function open(chatPath, title) {
            chatPath = String(chatPath || '').replace(/\/+$/, '');
            if (!CHAT_PATH.test(chatPath)) throw new Error('That isn’t a chat');

            const existing = windows.get(chatPath);
            if (existing && !existing.isDestroyed()) {
                if (existing.isMinimized()) existing.restore();
                existing.show();
                existing.focus();
                return;
            }

            const saved = ctx.readData('bounds', null) || {};
            // Cascade new windows so they don't open exactly on top of each other.
            const offset = windows.size * 28;
            const win = new BrowserWindow({
                width: saved.width || 480,
                height: saved.height || 720,
                ...(saved.x != null ? { x: saved.x + offset, y: saved.y + offset } : {}),
                minWidth: 320,
                minHeight: 360,
                title: title ? `${title} – Osmium` : 'Osmium',
                icon: iconPath(),
                autoHideMenuBar: true,
                backgroundColor: '#121212',
                alwaysOnTop: !!ctx.settings().alwaysOnTop,
                show: false,
                // No Osmium preload on purpose: the pop-out runs the web app in its
                // browser mode, so it can't take over now-playing or game detection,
                // global keybinds or the badge count from the main window.
                webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
            });
            ctx.windows.markPopout(win.webContents);
            win.setMenuBarVisibility(false);

            const wc = win.webContents;
            wc.setWindowOpenHandler(({ url }) => {
                if (/^https?:\/\//i.test(url)) shell.openExternal(url);
                return { action: 'deny' };
            });
            wc.on('will-navigate', (e, url) => {
                if (new URL(url).origin !== origin) e.preventDefault();
            });
            win.on('page-title-updated', (e) => e.preventDefault());
            win.once('ready-to-show', () => win.show());

            const remember = () => {
                if (!win.isDestroyed() && !win.isMinimized() && !win.isMaximized()) {
                    ctx.writeData('bounds', win.getBounds());
                }
            };
            win.on('resized', remember);
            win.on('moved', remember);
            win.on('closed', () => windows.delete(chatPath));

            windows.set(chatPath, win);
            win.loadURL(origin + chatPath);
        }

        const own = (event) => {
            const win = BrowserWindow.fromWebContents(event.sender);
            if (!win || !ctx.windows.isPopout(event.sender)) throw new Error('Not a pop-out window');
            return win;
        };

        return {
            preloadData(wc) {
                return ctx.windows.isPopout(wc) && native ? { nativeShim: native } : null;
            },
            stop() {
                for (const win of windows.values()) if (!win.isDestroyed()) win.close();
                windows.clear();
            },
            handlers: {
                open: (_e, chatPath, title, info) => {
                    if (info && typeof info === 'object' && info.clientInfo) {
                        native = { version: info.version, clientInfo: info.clientInfo };
                        ctx.writeData('native', native);
                    }
                    return open(chatPath, title);
                },
                setTitle: (event, title) => own(event).setTitle(title ? `${title} – Osmium` : 'Osmium'),
                setOnTop: (event, on) => {
                    const win = own(event);
                    win.setAlwaysOnTop(!!on);
                    return win.isAlwaysOnTop();
                },
                isOnTop: (event) => own(event).isAlwaysOnTop(),
                /** Brings the main window forward on the same chat, then closes the pop-out. */
                dock: (event) => {
                    const win = own(event);
                    const main = BrowserWindow.getAllWindows().find((w) => !ctx.windows.isPopout(w.webContents) && ctx.windows.isTrustedFrame(w.webContents.mainFrame));
                    if (main) {
                        const target = new URL(event.sender.getURL()).pathname;
                        main.webContents.send('plumose:event', ctx.id, 'navigate', target);
                        if (main.isMinimized()) main.restore();
                        main.show();
                        main.focus();
                    }
                    win.close();
                },
            },
        };
    },
};
