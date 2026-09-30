'use strict';

const { shell } = require('electron');
const { SpotifyController } = require('./backend');

/** Links the panel may open: Spotify pages, and the Spotify desktop app's URI scheme. */
function openSpotifyLink(raw, preferApp) {
    const url = new URL(String(raw));
    const allowed =
        url.protocol === 'spotify:' ||
        (url.protocol === 'https:' && /(^|\.)spotify\.com$/.test(url.hostname));
    if (!allowed) throw new Error('Refusing to open a non-Spotify link');

    // open.spotify.com/track/ID → spotify:track:ID jumps straight into the desktop app.
    const m = preferApp && url.hostname === 'open.spotify.com' && url.pathname.match(/^\/(track|episode|album|artist|playlist|show)\/(\w+)/);
    return shell.openExternal(m ? `spotify:${m[1]}:${m[2]}` : url.toString());
}

module.exports = {
    name: 'Spotify Controls',
    description: 'Now playing, seek, skip and volume, above your account card.',
    settings: {
        backend: {
            type: 'select',
            label: 'Source',
            default: process.platform === 'linux' ? 'mpris' : 'web',
            options: [['mpris', 'This computer'], ['web', 'Spotify account']],
        },
        anyPlayer: { type: 'boolean', default: false, label: 'Any media player' },
        clientId: { type: 'string', default: '', label: 'Spotify Client ID' },
        pollInterval: { type: 'number', default: 2000, hidden: true },
        placement: { type: 'select', default: 'docked', options: [['docked', 'Above account'], ['floating', 'Floating']] },
        floatingPos: { type: 'json', default: null, hidden: true },
        showWhenIdle: { type: 'boolean', default: false, label: 'Show when idle' },
        compact: { type: 'boolean', default: false, label: 'Compact' },
    },

    main(ctx) {
        const spotify = new SpotifyController(ctx);
        const subscribers = new Map(); // webContents id → webContents

        const broadcast = (event, state) => {
            for (const [id, wc] of subscribers) {
                if (wc.isDestroyed()) subscribers.delete(id);
                else wc.send('plumose:event', ctx.id, event, state);
            }
        };
        spotify.on('state', (s) => broadcast('state', s));
        spotify.on('tick', (s) => broadcast('tick', s));

        const unsubscribe = (id) => {
            subscribers.delete(id);
            if (subscribers.size === 0) spotify.stop();
        };

        return {
            // Polling only runs while a visible window is subscribed, so start() has nothing to do.
            stop() {
                subscribers.clear();
                spotify.stop();
            },
            onSettings() {
                spotify.restart();
            },
            handlers: {
                subscribe(event) {
                    const wc = event.sender;
                    if (!subscribers.has(wc.id)) {
                        subscribers.set(wc.id, wc);
                        wc.once('destroyed', () => unsubscribe(wc.id));
                    }
                    if (!spotify.running) spotify.start();
                    return spotify.getState();
                },
                unsubscribe: (event) => unsubscribe(event.sender.id),
                state: () => spotify.getState(),
                command: (_e, action, value) => spotify.command(action, value),
                connect: () => spotify.connectWeb(),
                disconnect: () => spotify.disconnectWeb(),
                open: (_e, url, preferApp) => openSpotifyLink(url, preferApp),
            },
        };
    },
};
