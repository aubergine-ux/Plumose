'use strict';

/**
 * Session preload. It runs sandboxed next to Osmium's own preload in every
 * frame, and does nothing anywhere except the top-level Osmium web app. There
 * it exposes a small `window.Plumose` bridge and injects the mod core plus
 * every plugin's page code before the web app's own scripts run.
 */

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const isAppFrame = (() => {
    try {
        return window.top === window && /(^|\.)osmium\.chat$/.test(location.hostname);
    } catch {
        return false;
    }
})();

// Never rename this channel. The preload is re-read from disk on every page load,
// but the main process only updates when Osmium restarts. A sync request that
// nobody answers freezes the page, and that is what happens on Ctrl+R if the
// two disagree on the name.
const source = isAppFrame ? ipcRenderer.sendSync('plumose:sources') : null;

if (source) {
    const listen = (channel, cb) => {
        const handler = (_e, ...args) => cb(...args);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
    };

    contextBridge.exposeInMainWorld('Plumose', {
        version: source.version,
        name: source.name,
        platform: process.platform,
        popout: source.popout,
        initialSettings: source.settings,
        plugins: source.plugins.map(({ id, name, description, settings }) => ({ id, name, description, settings })),
        getSettings: () => ipcRenderer.invoke('plumose:settings:get'),
        setSettings: (pluginId, patch) => ipcRenderer.invoke('plumose:settings:set', pluginId, patch),
        onSettings: (cb) => listen('plumose:settings', cb),
        invoke: (pluginId, name, ...args) => ipcRenderer.invoke('plumose:invoke', pluginId, name, ...args),
        onEvent: (cb) => listen('plumose:event', cb),
    });

    if (source.extra?.nativeShim && source.popout) exposeNativeShim(source.extra.nativeShim);

    // Styles go in as soon as <head> exists; each plugin's sheet starts disabled
    // and the core switches it on when the plugin starts.
    const injectStyles = () => {
        const add = (id, css, disabled) => {
            const style = document.createElement('style');
            style.dataset.plumose = id;
            style.textContent = css;
            document.head.appendChild(style);
            style.disabled = disabled;
        };
        add('core', source.core.css, false);
        for (const p of source.plugins) if (p.css) add(p.id, p.css, true);
    };
    if (document.head) injectStyles();
    else document.addEventListener('DOMContentLoaded', injectStyles, { once: true });

    // Core first, then plugins. Each gets a sourceURL so errors point at the right file in DevTools.
    // Calls run in order, and a plugin that throws doesn't stop the others.
    const run = (code, name) =>
        webFrame
            .executeJavaScript(`${code}\n//# sourceURL=plumose://${name}.js`)
            .catch((err) => console.error(`[Plumose] ${name} failed to load`, err));
    run(source.core.js, 'core');
    for (const p of source.plugins) if (p.js) run(p.js, `plugins/${p.id}`);
}

/**
 * A stand-in for Osmium's own `OsmiumNative` bridge in pop-out windows. It
 * reports the same client identity as the main window, so the session token
 * is accepted. Calls that are safe to share go to Osmium's real handlers.
 * Calls that would take something over from the main window are no-ops:
 * now-playing and game detection, global keybinds, the badge count, focusing
 * the window, and deep links.
 */
function exposeNativeShim({ version, clientInfo }) {
    const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
    const noop = () => {};
    const unsubscribe = () => noop;
    contextBridge.exposeInMainWorld('OsmiumNative', {
        version,
        clientInfo,
        settings: { get: invoke('settings:get'), set: invoke('settings:set'), getAll: invoke('settings:getAll'), reset: async () => {} },
        window: { openExternal: invoke('app:openExternal'), focus: async () => {}, titleBar: { mode: undefined }, onProtocolUrl: unsubscribe },
        app: { getVersion: invoke('app:getVersion'), getName: invoke('app:getName'), isPackaged: invoke('app:isPackaged'), setBadgeCount: async () => {} },
        capabilities: { list: async () => [], has: async () => false },
        audioCapture: { start: async () => ({ success: false }), stop: async () => ({ success: true }) },
        screenshare: {
            getSources: invoke('screenshare:getSources'),
            selectSource: invoke('screenshare:selectSource'),
            hasCustomPicker: () => false,
            getPickerSettings: invoke('screenshare:getPickerSettings'),
            setUseSystemPickerOverride: async () => {},
        },
        keybinds: { registerGlobal: async () => ({ success: false }), unregisterGlobal: async () => ({ success: true }), unregisterAllGlobal: async () => ({ success: true }), onStateChanged: unsubscribe },
        files: {
            createDownload: invoke('files:createDownload'),
            getStatus: invoke('files:getStatus'),
            writeChunk: (id, offset, data) => ipcRenderer.invoke('files:writeChunk', id, offset, data instanceof Uint8Array ? data : new Uint8Array(data)),
            complete: invoke('files:complete'),
            cancel: invoke('files:cancel'),
            open: invoke('files:open'),
            reveal: invoke('files:reveal'),
            delete: invoke('files:delete'),
            cleanupPartials: async () => {},
        },
        presence: { setNowPlayingCallback: unsubscribe, setGameDetectionCallback: unsubscribe },
        powerMonitor: { getSystemIdleTime: invoke('powerMonitor:getSystemIdleTime'), on: unsubscribe },
    });
}
