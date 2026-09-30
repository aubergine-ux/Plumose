'use strict';

/**
 * Spotify playback, behind one interface with two backends:
 *
 *   mpris  The Spotify desktop app on this machine, over the D-Bus session bus.
 *          No account setup and no Premium needed. Linux only.
 *
 *   web    The Spotify Web API through OAuth PKCE. Controls whatever device is
 *          active on the account (phone, speaker, another computer). Needs a
 *          Client ID from developer.spotify.com, and Premium for playback control.
 *
 * Both produce the same state object, so the renderer never needs to know which
 * one it is talking to.
 */

const { EventEmitter } = require('events');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const { shell } = require('electron');

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

const REDIRECT_PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
].join(' ');

// MPRIS and the Web API name repeat modes differently; the UI uses the Web API's.
const LOOP_TO_REPEAT = { None: 'off', Playlist: 'context', Track: 'track' };
const REPEAT_TO_LOOP = { off: 'None', context: 'Playlist', track: 'Track' };

function run(cmd, args, timeout = 4000) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr?.trim() || err.message));
            resolve(stdout);
        });
    });
}

/* --------------------------------------------------------------- MPRIS ---- */

class MprisBackend {
    constructor(ctx) {
        this.ctx = ctx;
        this.busName = null;
        this.monitor = null;
    }

    async findPlayer() {
        const rows = JSON.parse(await run('busctl', ['--user', '--json=short', 'list']));
        const players = rows
            .map((row) => row?.name)
            .filter((name) => typeof name === 'string' && name.startsWith(MPRIS_PREFIX));
        const spotify = players.find((n) => /spotify/i.test(n));
        const anyPlayer = this.ctx.settings().anyPlayer;
        this.busName = spotify || (anyPlayer ? players[0] : null) || null;
        return this.busName;
    }

    async bus() {
        const bus = this.busName || (await this.findPlayer());
        if (!bus) throw new Error('Spotify is not running');
        return bus;
    }

    async getAll() {
        const bus = await this.bus();
        const out = await run('busctl', [
            '--user', '--json=short', 'call', bus, MPRIS_PATH,
            PROPS_IFACE, 'GetAll', 's', PLAYER_IFACE,
        ]);
        const props = {};
        for (const [k, v] of Object.entries(JSON.parse(out)?.data?.[0] || {})) props[k] = v?.data;
        return props;
    }

    async setProperty(name, signature, value) {
        const bus = await this.bus();
        await run('busctl', [
            '--user', 'set-property', bus, MPRIS_PATH, PLAYER_IFACE, name, signature, String(value),
        ]);
    }

    async callMethod(method, signature = '', ...args) {
        const bus = await this.bus();
        await run('busctl', [
            '--user', 'call', bus, MPRIS_PATH, PLAYER_IFACE, method,
            ...(signature ? [signature, ...args.map(String)] : []),
        ]);
    }

    async getState() {
        let props;
        try {
            props = await this.getAll();
        } catch (err) {
            // The player quit or was never there; look again on the next tick.
            this.busName = null;
            return { available: false, reason: 'Spotify is not running' };
        }

        const meta = {};
        for (const [k, v] of Object.entries(props.Metadata || {})) meta[k] = v?.data;
        const artists = [].concat(meta['xesam:artist'] || []).filter(Boolean);
        const status = props.PlaybackStatus || 'Stopped';

        // Older Spotify builds advertise Volume but pin it at 0 while audio plays.
        // Hide the slider rather than show one that does nothing.
        const volume = props.Volume;
        const volumeUsable = typeof volume === 'number' && !(volume === 0 && status === 'Playing');

        // Spotify's Linux app reports Shuffle and LoopStatus but silently ignores
        // writes to them, so those buttons would do nothing. Other players honour them.
        const isSpotify = /spotify/i.test(this.busName);

        return {
            available: true,
            backend: 'mpris',
            player: this.busName.slice(MPRIS_PREFIX.length).replace(/\.instance\d+$/, ''),
            isPlaying: status === 'Playing',
            status,
            track: meta['xesam:title']
                ? {
                      id: String(meta['mpris:trackid'] || ''),
                      title: meta['xesam:title'],
                      artists,
                      album: meta['xesam:album'] || '',
                      artUrl: meta['mpris:artUrl'] || null,
                      url: meta['xesam:url'] || null,
                      // MPRIS speaks microseconds; the UI speaks milliseconds.
                      durationMs: Math.round(Number(meta['mpris:length'] || 0) / 1000),
                  }
                : null,
            positionMs: Math.round(Number(props.Position || 0) / 1000),
            volume: volumeUsable ? Math.round(volume * 100) : null,
            shuffle: !!props.Shuffle,
            repeat: LOOP_TO_REPEAT[props.LoopStatus] || 'off',
            supports: {
                seek: props.CanSeek !== false,
                volume: volumeUsable,
                shuffle: !isSpotify && typeof props.Shuffle === 'boolean',
                repeat: !isSpotify && typeof props.LoopStatus === 'string',
                next: props.CanGoNext !== false,
                previous: props.CanGoPrevious !== false,
            },
            fetchedAt: Date.now(),
        };
    }

    play() { return this.callMethod('Play'); }
    pause() { return this.callMethod('Pause'); }
    playPause() { return this.callMethod('PlayPause'); }
    next() { return this.callMethod('Next'); }
    previous() { return this.callMethod('Previous'); }

    async seek(positionMs) {
        const props = await this.getAll();
        const trackId = props.Metadata?.['mpris:trackid']?.data;
        const targetUs = Math.max(0, Math.round(positionMs * 1000));
        if (trackId) {
            await this.callMethod('SetPosition', 'ox', trackId, targetUs);
        } else {
            // Players without track ids only support relative seeks.
            await this.callMethod('Seek', 'x', targetUs - Number(props.Position || 0));
        }
    }

    setVolume(percent) {
        return this.setProperty('Volume', 'd', Math.min(1, Math.max(0, percent / 100)));
    }
    setShuffle(on) { return this.setProperty('Shuffle', 'b', on ? 'true' : 'false'); }
    setRepeat(mode) { return this.setProperty('LoopStatus', 's', REPEAT_TO_LOOP[mode] || 'None'); }

    /**
     * Watches for MPRIS PropertiesChanged signals so track changes and play/pause
     * show up at once instead of on the next poll. Polling still runs underneath,
     * so if dbus-monitor is missing nothing breaks, it's just slower.
     */
    watch(onChange) {
        this.unwatch();
        let child;
        try {
            child = spawn('dbus-monitor', [
                '--session',
                `type='signal',interface='${PROPS_IFACE}',member='PropertiesChanged',path='${MPRIS_PATH}'`,
                `type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0namespace='org.mpris.MediaPlayer2'`,
            ], { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
            return;
        }
        child.on('error', () => {});
        let timer = null;
        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            if (text.includes('NameOwnerChanged')) this.busName = null;
            if (!/PropertiesChanged|NameOwnerChanged/.test(text)) return;
            clearTimeout(timer);
            timer = setTimeout(onChange, 120);
        });
        this.monitor = child;
    }

    unwatch() {
        this.monitor?.kill();
        this.monitor = null;
    }
}

/* ----------------------------------------------------------- Web API ------ */

function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

class WebBackend {
    constructor(ctx) {
        this.ctx = ctx;
        this.tokens = ctx.readSecret('token');
        this.authServer = null;
    }

    get clientId() {
        return this.ctx.settings().clientId?.trim();
    }

    isConnected() {
        return !!this.tokens?.refresh_token;
    }

    /** Runs the PKCE flow in the system browser, resolving once it redirects back. */
    authorize() {
        const clientId = this.clientId;
        if (!clientId) return Promise.reject(new Error('Enter a Spotify Client ID first'));
        if (this.authServer) return Promise.reject(new Error('A sign-in is already in progress'));

        const verifier = base64url(crypto.randomBytes(64));
        const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
        const state = base64url(crypto.randomBytes(16));

        return new Promise((resolve, reject) => {
            let timer;
            const finish = (err, value) => {
                this.authServer?.close();
                this.authServer = null;
                clearTimeout(timer);
                err ? reject(err) : resolve(value);
            };

            const server = http.createServer(async (req, res) => {
                const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
                if (url.pathname !== '/callback') return res.writeHead(404).end('Not found');

                const respond = (title, body) => {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(
                        `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
                            '<body style="font-family:system-ui;background:#121212;color:#eee;' +
                            'display:grid;place-items:center;height:100vh;margin:0">' +
                            `<div style="text-align:center"><h2>${escapeHtml(title)}</h2>` +
                            `<p>${escapeHtml(body)}</p></div>`,
                    );
                };

                const error = url.searchParams.get('error');
                if (error) {
                    respond('Sign-in cancelled', 'You can close this tab.');
                    return finish(new Error(`Spotify returned: ${error}`));
                }
                if (url.searchParams.get('state') !== state) {
                    respond('Sign-in failed', 'State mismatch. Please try again.');
                    return finish(new Error('OAuth state mismatch'));
                }
                try {
                    const tokens = await this.exchange({
                        grant_type: 'authorization_code',
                        code: url.searchParams.get('code'),
                        redirect_uri: REDIRECT_URI,
                        code_verifier: verifier,
                    });
                    respond('Spotify connected', 'You can close this tab and go back to Osmium.');
                    finish(null, tokens);
                } catch (err) {
                    respond('Sign-in failed', err.message);
                    finish(err);
                }
            });

            server.on('error', (err) => finish(err));
            server.listen(REDIRECT_PORT, '127.0.0.1', () => {
                this.authServer = server;
                const auth = new URL('https://accounts.spotify.com/authorize');
                auth.search = new URLSearchParams({
                    client_id: clientId,
                    response_type: 'code',
                    redirect_uri: REDIRECT_URI,
                    code_challenge_method: 'S256',
                    code_challenge: challenge,
                    state,
                    scope: SCOPES,
                }).toString();
                shell.openExternal(auth.toString());
            });

            timer = setTimeout(() => finish(new Error('Spotify sign-in timed out')), 300000);
        });
    }

    async exchange(params) {
        const res = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: this.clientId, ...params }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error_description || body.error || 'Token request failed');

        this.tokens = {
            access_token: body.access_token,
            // Refresh responses may leave out the refresh token; keep the old one.
            refresh_token: body.refresh_token || this.tokens?.refresh_token,
            expires_at: Date.now() + (body.expires_in ?? 3600) * 1000 - 30000,
        };
        this.ctx.writeSecret('token', this.tokens);
        return this.tokens;
    }

    async accessToken() {
        if (!this.tokens?.refresh_token) throw new Error('Spotify account not connected');
        if (this.tokens.access_token && Date.now() < this.tokens.expires_at) {
            return this.tokens.access_token;
        }
        await this.exchange({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token });
        return this.tokens.access_token;
    }

    async api(method, path, { query } = {}) {
        const token = await this.accessToken();
        const url = new URL(`https://api.spotify.com/v1${path}`);
        for (const [k, v] of Object.entries(query || {})) {
            if (v != null) url.searchParams.set(k, String(v));
        }
        const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 204) return null;
        const text = await res.text();
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            // Some control endpoints answer with an empty or non-JSON body.
        }
        if (!res.ok) throw new Error(parsed?.error?.message || `Spotify API ${res.status}`);
        return parsed;
    }

    async getState() {
        if (!this.isConnected()) return { available: false, reason: 'Spotify account not connected' };
        let state;
        try {
            state = await this.api('GET', '/me/player', { query: { additional_types: 'episode' } });
        } catch (err) {
            return { available: false, reason: err.message };
        }
        const item = state?.item;
        if (!item) return { available: false, reason: 'Nothing playing on your Spotify account' };

        const isEpisode = item.type === 'episode';
        const images = isEpisode ? item.images || item.show?.images : item.album?.images;
        return {
            available: true,
            backend: 'web',
            player: state.device?.name || 'Spotify',
            isPlaying: !!state.is_playing,
            status: state.is_playing ? 'Playing' : 'Paused',
            track: {
                id: item.id,
                title: item.name,
                artists: isEpisode ? [item.show?.name].filter(Boolean) : (item.artists || []).map((a) => a.name),
                album: isEpisode ? item.show?.name || '' : item.album?.name || '',
                artUrl: images?.[0]?.url || null,
                url: item.external_urls?.spotify || null,
                durationMs: item.duration_ms || 0,
            },
            positionMs: state.progress_ms || 0,
            volume: state.device?.volume_percent ?? null,
            shuffle: !!state.shuffle_state,
            repeat: state.repeat_state || 'off',
            supports: {
                seek: true,
                volume: state.device?.supports_volume !== false && state.device?.volume_percent != null,
                shuffle: true,
                repeat: true,
                next: true,
                previous: true,
            },
            fetchedAt: Date.now(),
        };
    }

    play() { return this.api('PUT', '/me/player/play'); }
    pause() { return this.api('PUT', '/me/player/pause'); }
    async playPause() {
        const state = await this.getState();
        return state.isPlaying ? this.pause() : this.play();
    }
    next() { return this.api('POST', '/me/player/next'); }
    previous() { return this.api('POST', '/me/player/previous'); }
    seek(ms) { return this.api('PUT', '/me/player/seek', { query: { position_ms: Math.round(ms) } }); }
    setVolume(percent) {
        return this.api('PUT', '/me/player/volume', {
            query: { volume_percent: Math.round(Math.min(100, Math.max(0, percent))) },
        });
    }
    setShuffle(on) { return this.api('PUT', '/me/player/shuffle', { query: { state: !!on } }); }
    setRepeat(mode) { return this.api('PUT', '/me/player/repeat', { query: { state: mode } }); }

    disconnect() {
        this.tokens = null;
        this.ctx.writeSecret('token', null);
    }
}

/* ------------------------------------------------------------ controller -- */

class SpotifyController extends EventEmitter {
    constructor(ctx) {
        super();
        this.ctx = ctx;
        this.mpris = new MprisBackend(ctx);
        this.web = new WebBackend(ctx);
        this.timer = null;
        this.running = false;
        this.lastFingerprint = null;
    }

    get backend() {
        return this.ctx.settings().backend === 'web' ? this.web : this.mpris;
    }

    async getState() {
        const settings = this.ctx.settings();
        if (settings.backend === 'mpris' && process.platform !== 'linux') {
            return { available: false, reason: 'The local player backend is Linux-only. Switch to Web API in settings.' };
        }
        const state = await this.backend.getState().catch((err) => ({ available: false, reason: err.message }));
        return { ...state, webConnected: this.web.isConnected() };
    }

    /** Fetches state and emits it; position-only changes go out as 'tick'. */
    async refresh(force = false) {
        const state = await this.getState();
        const { positionMs, fetchedAt, ...rest } = state;
        const fingerprint = JSON.stringify(rest);
        if (force || fingerprint !== this.lastFingerprint) {
            this.lastFingerprint = fingerprint;
            this.emit('state', state);
        } else {
            this.emit('tick', state);
        }
        return state;
    }

    start() {
        this.stop();
        this.running = true;
        const settings = this.ctx.settings();
        // The Web API rate-limits, so it never polls faster than every 3 seconds.
        const minimum = settings.backend === 'web' ? 3000 : 1000;
        const interval = Math.max(minimum, Number(settings.pollInterval) || 2000);

        const loop = async () => {
            if (!this.running) return;
            await this.refresh().catch(() => {});
            if (this.running) this.timer = setTimeout(loop, interval);
        };
        loop();

        if (settings.backend === 'mpris' && process.platform === 'linux') {
            this.mpris.watch(() => this.refresh().catch(() => {}));
        }
    }

    stop() {
        this.running = false;
        clearTimeout(this.timer);
        this.timer = null;
        this.mpris.unwatch();
    }

    restart() {
        this.lastFingerprint = null;
        if (this.running) this.start();
    }

    async command(action, value) {
        const b = this.backend;
        const need = (fn, what) => {
            if (typeof b[fn] !== 'function') throw new Error(`${what} isn't supported by this backend`);
            return b[fn](value);
        };
        switch (action) {
            case 'play': await b.play(); break;
            case 'pause': await b.pause(); break;
            case 'playPause': await b.playPause(); break;
            case 'next': await b.next(); break;
            case 'previous': await b.previous(); break;
            case 'seek': await b.seek(Number(value) || 0); break;
            case 'volume': await b.setVolume(Number(value) || 0); break;
            case 'shuffle': await need('setShuffle', 'Shuffle'); break;
            case 'repeat': await need('setRepeat', 'Repeat'); break;
            default: throw new Error(`Unknown action: ${action}`);
        }
        // Players take a moment to apply commands; read back once they have.
        await new Promise((r) => setTimeout(r, b === this.web ? 350 : 80));
        return this.refresh(true);
    }

    async connectWeb() {
        await this.web.authorize();
        return this.refresh(true);
    }

    disconnectWeb() {
        this.web.disconnect();
        return this.refresh(true);
    }
}

module.exports = { SpotifyController };
