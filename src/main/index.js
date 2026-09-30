'use strict';

/**
 * Main-process core of the mod. The loader in Osmium's `resources/app/` calls
 * this before handing over to the official `_app.asar`, the same trick Vencord
 * uses on Discord. It only adds things: a session preload script, IPC channels
 * prefixed `plumose:`, and whatever the enabled plugins do. Osmium's own
 * main process is left unchanged.
 */

const fs = require('fs');
const path = require('path');
const { app, ipcMain, session, webContents } = require('electron');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'preload.js');
const CORE_JS = path.join(ROOT, 'renderer', 'core.js');
const CORE_CSS = path.join(ROOT, 'renderer', 'core.css');
const PKG = require('../../package.json');
const MOD_VERSION = PKG.version;
// "Plumose-InjectorV1.1.0": the name always carries the version.
const MOD_NAME = `${PKG.displayName}V${PKG.version}`;

const log = (...args) => console.log('[Plumose]', ...args);

const appHost = () => new URL(process.env.APP_URL || 'https://web.osmium.chat/').hostname;

/** Only the Osmium web app itself may talk to the mod. Embeds and iframes may not. */
function isTrustedFrame(frame) {
    try {
        const { hostname, protocol } = new URL(frame?.url || '');
        return protocol === 'https:' && (hostname === appHost() || hostname.endsWith('.osmium.chat'));
    } catch {
        return false;
    }
}

function guard(fn) {
    return (event, ...args) => {
        if (!isTrustedFrame(event.senderFrame)) throw new Error('Untrusted sender');
        return fn(event, ...args);
    };
}

module.exports = function inject() {
    // For development: run a second, isolated Osmium profile beside your real one.
    if (process.env.OSMIUM_MOD_USER_DATA) app.setPath('userData', process.env.OSMIUM_MOD_USER_DATA);

    const { Store } = require('./store');
    const { PluginManager } = require('./plugins');

    const popouts = new Set(); // webContents ids of pop-out chat windows
    let store = null;
    let plugins = null;

    const appWindows = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && isTrustedFrame(wc.mainFrame));
    const emit = (pluginId, event, payload) => {
        for (const wc of appWindows()) wc.send('plumose:event', pluginId, event, payload);
    };

    // The preload is sandboxed and can't read files, so it asks for the page code synchronously.
    // This channel name is a fixed contract with preload.js. Never rename it (see the note there).
    ipcMain.on('plumose:sources', (event) => {
        if (!isTrustedFrame(event.senderFrame) || !plugins) {
            event.returnValue = null;
            return;
        }
        try {
            const popout = popouts.has(event.sender.id);
            event.returnValue = {
                version: MOD_VERSION,
                name: MOD_NAME,
                popout,
                settings: store.get(),
                core: { js: fs.readFileSync(CORE_JS, 'utf8'), css: fs.readFileSync(CORE_CSS, 'utf8') },
                plugins: plugins.sources({ popout }),
                extra: plugins.preloadData(event.sender),
            };
        } catch (err) {
            log('Failed to read page code:', err);
            event.returnValue = null;
        }
    });

    ipcMain.handle('plumose:settings:get', guard(() => store.get()));
    ipcMain.handle('plumose:settings:set', guard((_e, pluginId, patch) => {
        const settings = plugins.setSettings(pluginId, patch);
        for (const wc of appWindows()) wc.send('plumose:settings', settings);
        return settings;
    }));
    ipcMain.handle('plumose:invoke', guard((event, pluginId, name, ...args) => plugins.invoke(pluginId, name, event, args)));

    app.whenReady().then(() => {
        store = new Store();
        plugins = new PluginManager({ store, emit, log });
        plugins.windows = {
            markPopout: (wc) => {
                popouts.add(wc.id);
                wc.once('destroyed', () => popouts.delete(wc.id));
            },
            isPopout: (wc) => popouts.has(wc.id),
            isTrustedFrame,
        };
        plugins.load();
        plugins.init();

        // Runs alongside Osmium's own preload, not instead of it.
        const ses = session.defaultSession;
        if (typeof ses.registerPreloadScript === 'function') {
            ses.registerPreloadScript({ type: 'frame', id: 'plumose', filePath: PRELOAD });
        } else {
            ses.setPreloads([...ses.getPreloads(), PRELOAD]);
        }
        log(`${MOD_NAME} loaded with ${plugins.plugins.size} plugins (Osmium ${app.getVersion()}, Electron ${process.versions.electron})`);
    });

    app.on('before-quit', () => plugins?.stopAll());
};
