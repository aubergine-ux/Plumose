/*
 * Music controls (plugin id: spotify). Docked mode puts the player inside the account card's
 * container at the bottom of the sidebar, tucked behind the card the same way
 * Osmium's own voice-status strip is.
 */
PlumoseCore.definePlugin('spotify', (api) => {
    'use strict';

    const { h, cleanError } = PlumoseCore;
    const ANCHOR = '[class*="userInfoContainer-"]';

    /* ------------------------------------------------------------ icons -- */

    const stroke = (body) =>
        `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    const fill = (body) =>
        `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">${body}</svg>`;

    const SPEAKER = '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/>';
    const REPEAT = '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>';
    const ICONS = {
        play: fill('<path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.98-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z"/>'),
        pause: fill('<rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/>'),
        next: fill('<path d="M5 6.36v11.28a.9.9 0 0 0 1.38.76l8.62-5.64a.9.9 0 0 0 0-1.52L6.38 5.6A.9.9 0 0 0 5 6.36z"/><rect x="16.5" y="5" width="2.5" height="14" rx="1"/>'),
        previous: fill('<path d="M19 6.36v11.28a.9.9 0 0 1-1.38.76L9 12.76a.9.9 0 0 1 0-1.52l8.62-5.64A.9.9 0 0 1 19 6.36z"/><rect x="5" y="5" width="2.5" height="14" rx="1"/>'),
        shuffle: stroke('<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>'),
        repeat: stroke(REPEAT),
        repeatOne: stroke(`${REPEAT}<path d="M11 10h1v4"/>`),
        volume: stroke(`${SPEAKER}<path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>`),
        volumeLow: stroke(`${SPEAKER}<path d="M16 9a5 5 0 0 1 0 6"/>`),
        muted: stroke(`${SPEAKER}<line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>`),
        settings: stroke('<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>'),
        music: stroke('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
    };

    /* ---------------------------------------------------------- helpers -- */

    const fmt = (ms) => {
        const s = Math.max(0, Math.floor((ms || 0) / 1000));
        const hrs = Math.floor(s / 3600);
        const mins = Math.floor((s % 3600) / 60);
        const secs = String(s % 60).padStart(2, '0');
        return hrs ? `${hrs}:${String(mins).padStart(2, '0')}:${secs}` : `${mins}:${secs}`;
    };

    const iconButton = (name, label, onclick, extra = '') =>
        h('button', { class: `osm-sp-btn ${extra}`, type: 'button', 'aria-label': label, title: label, html: ICONS[name], onclick });

    /* ------------------------------------------------------------ state -- */

    let state = { available: false };
    let dragging = null; // 'seek' | 'volume' while a slider is held
    let flash = null;
    let flashTimer = null;
    let lastArt = null;

    const livePosition = () => {
        if (!state.available || !state.track) return 0;
        const base = state.positionMs || 0;
        const elapsed = state.isPlaying ? Date.now() - (state.fetchedAt || Date.now()) : 0;
        return Math.min(base + elapsed, state.track.durationMs || Infinity);
    };

    /* ------------------------------------------------------------- view -- */

    const ui = {};
    ui.art = h('img', { class: 'osm-sp-art-img', alt: '', draggable: 'false' });
    ui.artFallback = h('div', { class: 'osm-sp-art-fallback', html: ICONS.music });
    ui.artBtn = h('button', { class: 'osm-sp-art', type: 'button', title: 'Open in Spotify', onclick: () => openTrack() }, ui.art, ui.artFallback);
    ui.title = h('span');
    ui.titleBox = h('button', { class: 'osm-sp-title', type: 'button', title: 'Open in Spotify', onclick: () => openTrack() }, ui.title);
    ui.sub = h('span');
    ui.subBox = h('div', { class: 'osm-sp-sub' }, ui.sub);
    ui.gear = iconButton('settings', 'Music controls settings', (e) => toggleSettings(e.currentTarget), 'osm-sp-gear');

    ui.elapsed = h('span', { class: 'osm-sp-time' });
    ui.duration = h('span', { class: 'osm-sp-time' });
    ui.seek = h('input', { class: 'osm-sp-range osm-sp-seek', type: 'range', min: '0', max: '1000', step: '1', value: '0', 'aria-label': 'Seek' });

    ui.shuffle = iconButton('shuffle', 'Shuffle', () => run('shuffle', !state.shuffle), 'osm-sp-toggle');
    ui.previous = iconButton('previous', 'Previous', () => run('previous'));
    ui.play = iconButton('play', 'Play', () => run('playPause'), 'osm-sp-play');
    ui.next = iconButton('next', 'Next', () => run('next'));
    ui.repeat = iconButton('repeat', 'Repeat', () => {
        const order = ['off', 'context', 'track'];
        run('repeat', order[(order.indexOf(state.repeat) + 1) % order.length]);
    }, 'osm-sp-toggle');

    ui.volIcon = iconButton('volume', 'Mute', () => {
        if (state.volume > 0) {
            ui.volBeforeMute = state.volume;
            run('volume', 0);
        } else {
            run('volume', ui.volBeforeMute || 50);
        }
    }, 'osm-sp-vol-icon');
    ui.volume = h('input', { class: 'osm-sp-range osm-sp-volume', type: 'range', min: '0', max: '100', step: '1', value: '50', 'aria-label': 'Volume' });
    ui.volBox = h('div', { class: 'osm-sp-vol' }, ui.volIcon, ui.volume);

    ui.message = h('div', { class: 'osm-sp-message' });

    ui.root = h('div', { id: 'plumose-spotify', class: 'osm-sp', role: 'region', 'aria-label': 'Music controls' },
        h('div', { class: 'osm-sp-main' },
            ui.artBtn,
            h('div', { class: 'osm-sp-meta' }, ui.titleBox, ui.subBox),
            ui.gear,
        ),
        h('div', { class: 'osm-sp-progress' }, ui.elapsed, ui.seek, ui.duration),
        h('div', { class: 'osm-sp-controls' },
            h('div', { class: 'osm-sp-transport' }, ui.shuffle, ui.previous, ui.play, ui.next, ui.repeat),
            ui.volBox,
        ),
        ui.message,
    );

    ui.art.addEventListener('load', () => ui.artBtn.classList.add('has-art'));
    ui.art.addEventListener('error', () => ui.artBtn.classList.remove('has-art'));

    const setRangeFill = (input) => {
        const pct = ((input.value - input.min) / (input.max - input.min || 1)) * 100;
        input.style.setProperty('--fill', `${pct}%`);
    };

    // Sliders apply on release, so dragging doesn't flood the player with commands.
    ui.seek.addEventListener('input', () => {
        dragging = 'seek';
        const ms = (ui.seek.value / 1000) * (state.track?.durationMs || 0);
        ui.elapsed.textContent = fmt(ms);
        setRangeFill(ui.seek);
    });
    ui.seek.addEventListener('change', () => {
        const ms = (ui.seek.value / 1000) * (state.track?.durationMs || 0);
        // Show the new position straight away while the player catches up.
        state = { ...state, positionMs: ms, fetchedAt: Date.now() };
        dragging = null;
        run('seek', ms);
    });
    ui.volume.addEventListener('input', () => {
        dragging = 'volume';
        setRangeFill(ui.volume);
        updateVolumeIcon(Number(ui.volume.value));
    });
    ui.volume.addEventListener('change', () => {
        dragging = null;
        state = { ...state, volume: Number(ui.volume.value) };
        run('volume', Number(ui.volume.value));
    });
    ui.volBox.addEventListener('wheel', (e) => {
        if (state.volume == null) return;
        e.preventDefault();
        const next = Math.max(0, Math.min(100, state.volume + (e.deltaY < 0 ? 5 : -5)));
        state = { ...state, volume: next };
        render();
        clearTimeout(ui.wheelTimer);
        ui.wheelTimer = setTimeout(() => run('volume', next), 200);
    }, { passive: false });

    function updateVolumeIcon(v) {
        const name = v === 0 ? 'muted' : v < 50 ? 'volumeLow' : 'volume';
        if (ui.volIcon.dataset.icon !== name) {
            ui.volIcon.dataset.icon = name;
            ui.volIcon.innerHTML = ICONS[name];
            ui.volIcon.setAttribute('aria-label', v === 0 ? 'Unmute' : 'Mute');
            ui.volIcon.title = v === 0 ? 'Unmute' : 'Mute';
        }
    }

    function showFlash(text) {
        flash = text;
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
            flash = null;
            render();
        }, 4500);
        render();
    }

    async function run(action, value) {
        try {
            const next = await api.invoke('command', action, value);
            if (next) applyState(next);
        } catch (err) {
            showFlash(cleanError(err));
        }
    }

    function openTrack() {
        const url = state.track?.url;
        if (url) api.invoke('open', url, state.backend === 'mpris').catch((e) => showFlash(cleanError(e)));
    }

    /** Whether the panel should be on screen at all, and in which mode. */
    function visibility() {
        const s = api.settings;
        if (state.available && state.track) return 'player';
        // Setup problems are always shown, otherwise there'd be no way to fix them.
        const needsSetup = s.backend === 'web' && !state.webConnected;
        if (needsSetup || s.showWhenIdle) return 'idle';
        return 'hidden';
    }

    function render() {
        const mode = visibility();
        const s = api.settings;
        ui.root.hidden = mode === 'hidden';
        ui.root.classList.toggle('is-idle', mode === 'idle');
        ui.root.classList.toggle('is-compact', !!s.compact);
        ui.root.classList.toggle('is-playing', !!state.isPlaying);
        ui.root.classList.toggle('is-floating', s.placement === 'floating');
        ui.root.classList.toggle('is-docked', s.placement !== 'floating');

        ui.message.textContent = flash || '';
        ui.message.hidden = !flash;
        if (mode === 'hidden') return;

        if (mode === 'idle') {
            ui.title.textContent = 'Spotify';
            ui.sub.textContent = state.reason || 'Nothing playing';
            ui.titleBox.disabled = true;
            ui.artBtn.disabled = true;
            ui.artBtn.classList.remove('has-art');
            lastArt = null;
            return;
        }

        const t = state.track;
        ui.titleBox.disabled = !t.url;
        ui.artBtn.disabled = !t.url;
        if (ui.title.textContent !== t.title) {
            ui.title.textContent = t.title;
            ui.titleBox.title = `${t.title}${t.url ? ' · Open in Spotify' : ''}`;
        }
        const sub = [t.artists.join(', '), t.album].filter(Boolean).join(' — ');
        if (ui.sub.textContent !== sub) {
            ui.sub.textContent = sub;
            ui.subBox.title = sub;
        }
        if (t.artUrl !== lastArt) {
            lastArt = t.artUrl;
            ui.artBtn.classList.remove('has-art');
            if (t.artUrl) ui.art.src = t.artUrl;
            else ui.art.removeAttribute('src');
        }
        requestAnimationFrame(updateMarquee);

        const playing = !!state.isPlaying;
        ui.play.innerHTML = playing ? ICONS.pause : ICONS.play;
        ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        ui.play.title = playing ? 'Pause' : 'Play';

        const sup = state.supports || {};
        ui.shuffle.hidden = !sup.shuffle;
        ui.repeat.hidden = !sup.repeat;
        ui.previous.disabled = sup.previous === false;
        ui.next.disabled = sup.next === false;
        ui.shuffle.classList.toggle('is-on', !!state.shuffle);
        ui.shuffle.setAttribute('aria-pressed', String(!!state.shuffle));
        const repeatOn = state.repeat && state.repeat !== 'off';
        ui.repeat.classList.toggle('is-on', !!repeatOn);
        ui.repeat.innerHTML = state.repeat === 'track' ? ICONS.repeatOne : ICONS.repeat;
        ui.repeat.title = { off: 'Repeat', context: 'Repeat all', track: 'Repeat one' }[state.repeat || 'off'];
        ui.repeat.setAttribute('aria-label', ui.repeat.title);

        ui.volBox.hidden = !sup.volume || state.volume == null;
        if (dragging !== 'volume' && state.volume != null) {
            ui.volume.value = String(state.volume);
            setRangeFill(ui.volume);
            updateVolumeIcon(state.volume);
        }

        ui.seek.disabled = !sup.seek || !t.durationMs;
        ui.duration.textContent = fmt(t.durationMs);
        renderProgress();
    }

    function renderProgress() {
        if (dragging === 'seek' || !state.track) return;
        const pos = livePosition();
        const dur = state.track.durationMs || 0;
        ui.elapsed.textContent = fmt(pos);
        ui.seek.value = String(dur ? Math.round((pos / dur) * 1000) : 0);
        setRangeFill(ui.seek);
    }

    /** Long titles scroll on hover instead of being cut off for good. */
    function updateMarquee() {
        for (const [box, span] of [[ui.titleBox, ui.title], [ui.subBox, ui.sub]]) {
            const overflow = span.scrollWidth - box.clientWidth;
            box.classList.toggle('is-overflowing', overflow > 2);
            box.style.setProperty('--osm-sp-overflow', `${-Math.max(0, overflow + 8)}px`);
            box.style.setProperty('--osm-sp-marquee-time', `${Math.max(3, overflow / 25)}s`);
        }
    }

    function applyState(next) {
        const trackChanged = next?.track?.id !== state?.track?.id;
        state = next || { available: false };
        if (trackChanged && dragging === 'seek') dragging = null;
        render();
    }

    /* --------------------------------------------------------- settings -- */

    let popover = null;

    function closeSettings() {
        popover?.remove();
        popover = null;
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onEscape, true);
    }
    const onOutside = (e) => {
        if (popover && !popover.contains(e.target) && !ui.gear.contains(e.target)) closeSettings();
    };
    const onEscape = (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            closeSettings();
        }
    };

    const save = async (patch) => {
        try {
            await api.setSettings(patch);
        } catch (err) {
            showFlash(cleanError(err));
        }
    };

    function toggleSettings(anchor) {
        if (popover) return closeSettings();
        popover = h('div', { class: 'osm-sp-popover', role: 'dialog', 'aria-label': 'Music controls settings' });
        document.body.append(popover);
        buildSettings(popover, true);
        const r = anchor.getBoundingClientRect();
        const pr = popover.getBoundingClientRect();
        const left = Math.min(Math.max(8, r.right - pr.width), innerWidth - pr.width - 8);
        const above = r.top - pr.height - 8;
        popover.style.left = `${left}px`;
        popover.style.top = `${above > 8 ? above : Math.min(r.bottom + 8, innerHeight - pr.height - 8)}px`;
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onEscape, true);
    }

    function toggleRow(label, hint, checked, onchange) {
        const input = h('input', { type: 'checkbox', class: 'osm-sp-switch', checked, onchange: (e) => onchange(e.target.checked) });
        return h('label', { class: 'osm-sp-row' },
            h('div', { class: 'osm-sp-row-text' }, h('div', { class: 'osm-sp-row-label' }, label), hint && h('div', { class: 'osm-sp-hint' }, hint)),
            input,
        );
    }

    function segmented(options, value, onchange) {
        return h('div', { class: 'osm-sp-seg', role: 'radiogroup' },
            options.map(([val, label]) =>
                h('button', {
                    type: 'button', role: 'radio', 'aria-checked': String(val === value),
                    class: val === value ? 'is-on' : '', onclick: () => val !== value && onchange(val),
                }, label),
            ),
        );
    }

    /** One settings UI, used both by the gear popover and by the Mods screen. */
    function buildSettings(container, withTitle) {
        const s = api.settings;
        const isLinux = api.platform === 'linux';
        const body = [];

        if (withTitle) {
            body.push(h('div', { class: 'osm-sp-pop-title' }, 'Music controls',
                h('button', { type: 'button', class: 'osm-sp-link', onclick: () => { closeSettings(); PlumoseCore.openMods(); } }, 'All mods')));
        }

        body.push(h('div', { class: 'osm-sp-label' }, 'Source'));
        body.push(segmented(
            [...(isLinux ? [['mpris', 'This computer']] : []), ['web', 'Spotify account']],
            s.backend, (v) => save({ backend: v }),
        ));

        if (s.backend === 'mpris') {
            body.push(h('div', { class: 'osm-sp-hint' }, 'Controls the Spotify app on this machine over MPRIS. No sign-in needed.'));
            body.push(toggleRow('Any media player', 'Fall back to browsers, mpv, etc. when Spotify isn’t open', s.anyPlayer, (v) => save({ anyPlayer: v })));
        } else {
            const id = h('input', {
                class: 'osm-sp-input', type: 'text', spellcheck: 'false', placeholder: 'Spotify Client ID',
                value: s.clientId || '', onchange: (e) => save({ clientId: e.target.value.trim() }),
            });
            body.push(h('div', { class: 'osm-sp-hint' },
                'Controls whichever device is active on your account. Create an app at ',
                h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.invoke('open', 'https://developer.spotify.com/dashboard'); } }, 'developer.spotify.com'),
                ', add the redirect URI ', h('code', {}, 'http://127.0.0.1:8888/callback'), ' and paste its Client ID here. Playback control needs Premium.',
            ));
            body.push(id);
            const status = h('div', { class: 'osm-sp-hint' });
            const connect = h('button', {
                type: 'button', class: 'osm-sp-action',
                onclick: async () => {
                    if (id.value.trim() !== (s.clientId || '')) await save({ clientId: id.value.trim() });
                    status.textContent = 'Finish signing in in your browser…';
                    connect.disabled = true;
                    try {
                        applyState(await api.invoke('connect'));
                        buildSettings(container, withTitle);
                    } catch (err) {
                        status.textContent = cleanError(err);
                        connect.disabled = false;
                    }
                },
            }, 'Connect Spotify');
            const disconnect = h('button', {
                type: 'button', class: 'osm-sp-action is-secondary',
                onclick: async () => { applyState(await api.invoke('disconnect')); buildSettings(container, withTitle); },
            }, 'Disconnect');
            body.push(h('div', { class: 'osm-sp-actions' }, state.webConnected ? disconnect : connect), status);
            if (state.webConnected) status.textContent = 'Connected.';
        }

        body.push(h('div', { class: 'osm-sp-label' }, 'Placement'));
        body.push(segmented([['docked', 'Above account'], ['floating', 'Floating']], s.placement, (v) => save({ placement: v })));
        body.push(toggleRow('Compact', 'Hide the seek bar and extra buttons', s.compact, (v) => save({ compact: v })));
        body.push(toggleRow('Show when idle', 'Keep the panel visible when nothing is playing', s.showWhenIdle, (v) => save({ showWhenIdle: v })));

        container.classList.add('osm-sp-settings');
        container.replaceChildren(...body);
    }

    /* -------------------------------------------------------- placement -- */

    let floatingDrag = null;

    function mount() {
        const s = api.settings;
        if (s.placement === 'floating') {
            if (ui.root.parentElement !== document.body) document.body.append(ui.root);
            positionFloating();
            return;
        }
        const anchor = document.querySelector(ANCHOR);
        if (!anchor) {
            // Login screen, settings page or mobile layout: nothing to dock to.
            ui.root.remove();
            return;
        }
        // Sit above Osmium's own voice-status strip if there is one, so both stack like cards.
        const parent = anchor.parentElement;
        if (ui.root.parentElement !== parent || parent.firstElementChild !== ui.root) {
            parent.insertBefore(ui.root, parent.firstElementChild);
        }
        ui.root.style.left = ui.root.style.top = '';
    }

    function positionFloating() {
        const pos = api.settings.floatingPos;
        const w = ui.root.offsetWidth || 300;
        const hgt = ui.root.offsetHeight || 120;
        const x = pos ? pos.x : 16;
        const y = pos ? pos.y : innerHeight - hgt - 90;
        ui.root.style.left = `${Math.min(Math.max(8, x), innerWidth - w - 8)}px`;
        ui.root.style.top = `${Math.min(Math.max(8, y), innerHeight - hgt - 8)}px`;
    }

    ui.root.addEventListener('pointerdown', (e) => {
        if (api.settings.placement !== 'floating') return;
        if (e.button !== 0 || e.target.closest('button, input, a')) return;
        const r = ui.root.getBoundingClientRect();
        floatingDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        ui.root.setPointerCapture(e.pointerId);
        ui.root.classList.add('is-dragging');
    });
    ui.root.addEventListener('pointermove', (e) => {
        if (!floatingDrag) return;
        ui.root.style.left = `${Math.min(Math.max(8, e.clientX - floatingDrag.dx), innerWidth - ui.root.offsetWidth - 8)}px`;
        ui.root.style.top = `${Math.min(Math.max(8, e.clientY - floatingDrag.dy), innerHeight - ui.root.offsetHeight - 8)}px`;
    });
    ui.root.addEventListener('pointerup', () => {
        if (!floatingDrag) return;
        floatingDrag = null;
        ui.root.classList.remove('is-dragging');
        const r = ui.root.getBoundingClientRect();
        save({ floatingPos: { x: Math.round(r.left), y: Math.round(r.top) } });
    });

    /* -------------------------------------------------------- lifecycle -- */

    let subscribed = false;
    async function setSubscribed(on) {
        if (on === subscribed) return;
        subscribed = on;
        try {
            if (on) applyState(await api.invoke('subscribe'));
            else await api.invoke('unsubscribe');
        } catch (err) {
            console.error('[Plumose:spotify] subscribe failed', err);
        }
    }

    return {
        start() {
            api.on('state', applyState);
            api.on('tick', (tick) => {
                // Ticks only differ in position; resync the playhead without a full render.
                state = { ...state, positionMs: tick.positionMs, fetchedAt: tick.fetchedAt };
            });
            render();
            api.onDom(mount);

            // Only poll while the window is actually visible.
            const onVisibility = () => setSubscribed(document.visibilityState === 'visible');
            document.addEventListener('visibilitychange', onVisibility);
            api.track(() => document.removeEventListener('visibilitychange', onVisibility));
            onVisibility();

            const onResize = () => api.settings.placement === 'floating' && positionFloating();
            addEventListener('resize', onResize);
            api.track(() => removeEventListener('resize', onResize));

            const timer = setInterval(() => {
                if (state.isPlaying && !ui.root.hidden && document.visibilityState === 'visible') renderProgress();
            }, 250);
            api.track(() => clearInterval(timer));
        },

        stop() {
            closeSettings();
            ui.root.remove();
            subscribed = false;
            state = { available: false };
        },

        onSettings(next, prev) {
            if (next.backend !== prev.backend) state = { available: false };
            mount();
            render();
            if (popover) buildSettings(popover, true);
        },

        renderSettings(container) {
            buildSettings(container, false);
        },
    };
});
