/*
 * Custom status. A user's status in Osmium is a list of activities, each
 * { type, title, state }, and type CUSTOM (0) is a plain message: the member
 * list shows its text under the name when nothing is playing. The app has no
 * screen for setting one, but the object that sends your status does it all:
 *
 *   client.appPresence.activities   Map of key → activity; games and music put theirs here
 *   .getCurrentStatus()             online or idle, as the app works it out
 *   .changeStatus(status)           sends settings.ChangeStatus with every activity in the map
 *
 * The plugin keeps one entry of its own in that map, so the message rides
 * along with whatever game or song the app is already reporting.
 */
PlumoseCore.definePlugin('customStatus', (api) => {
    'use strict';

    const { h, modal, cleanError } = PlumoseCore;
    const KEY = 'plumose:custom';
    const CUSTOM = 0; // UserStatus.Activity.ActivityType.CUSTOM
    const MAX_LENGTH = 128;
    const MAX_RECENT = 6;
    const DURATIONS = [['0', 'Don’t clear'], ['30', '30 minutes'], ['60', '1 hour'], ['240', '4 hours'], ['today', 'Today']];
    const ICON_BUBBLE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/></svg>';

    let view = null;

    /** The message that should be showing right now ('' for none). */
    function wanted() {
        const s = api.settings;
        if (s.expiresAt && Date.now() >= Number(s.expiresAt)) return '';
        return String(s.text || '').trim().slice(0, MAX_LENGTH);
    }

    /** Makes the app's status match `wanted()`. Returns false while the app isn't ready. */
    function sync(text = wanted()) {
        const presence = api.client()?.appPresence;
        if (!presence?.activities || typeof presence.changeStatus !== 'function' || !api.client()?.user) return false;
        const current = presence.activities.get(KEY);
        if ((current?.title || '') === text) return true;
        if (text) presence.activities.set(KEY, { type: CUSTOM, title: text });
        else presence.activities.delete(KEY);
        try {
            presence.changeStatus(presence.getCurrentStatus());
        } catch (err) {
            console.error('[Plumose:customStatus] status change failed', err);
        }
        return true;
    }

    function expiryFor(choice) {
        if (choice === 'today') return new Date().setHours(24, 0, 0, 0);
        const minutes = Number(choice);
        return minutes > 0 ? Date.now() + minutes * 60000 : null;
    }

    function save(text, choice) {
        const clean = text.trim().slice(0, MAX_LENGTH);
        const recent = clean ? [clean, ...(api.settings.recent || []).filter((r) => r !== clean)].slice(0, MAX_RECENT) : api.settings.recent || [];
        return api.setSettings({ text: clean, expiresAt: clean ? expiryFor(choice) : null, recent });
    }

    function open() {
        if (view) return view.close();
        const s = api.settings;
        const current = wanted();
        const input = h('input', { class: 'osm-input', type: 'text', maxlength: String(MAX_LENGTH), placeholder: 'What’s up?', spellcheck: 'true', 'aria-label': 'Status message' });
        input.value = current;
        const duration = h('select', { class: 'osm-select osm-cs-duration', 'aria-label': 'Clear after' }, DURATIONS.map(([v, label]) => h('option', { value: v }, label)));
        const note = h('div', { class: 'osm-setting-desc' },
            current && s.expiresAt ? `Clears ${new Date(Number(s.expiresAt)).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : 'Shown under your name in member lists.');
        const fail = (e) => (note.textContent = cleanError(e));
        const set = () => save(input.value, duration.value).then(() => view?.close()).catch(fail);
        const recent = (s.recent || []).filter((r) => r !== current);

        view = modal({
            title: 'Custom Status',
            subtitle: current ? `Now: ${current}` : 'No status set',
            className: 'osm-cs-modal',
            body: h('div', { class: 'osm-cs' },
                input,
                h('label', { class: 'osm-setting is-inline' }, h('div', { class: 'osm-setting-label' }, 'Clear after'), duration),
                recent.length > 0 && h('div', { class: 'osm-cs-recent' }, recent.map((text) => h('button', {
                    type: 'button', class: 'osm-cs-chip', title: 'Use this status',
                    onclick: () => {
                        input.value = text;
                        input.focus();
                    },
                }, text))),
                note,
                h('div', { class: 'osm-cs-actions' },
                    current && h('button', { type: 'button', class: 'osm-button is-danger', onclick: () => save('', '0').then(() => view?.close()).catch(fail) }, 'Clear status'),
                    h('span', { style: { flex: '1' } }),
                    h('button', { type: 'button', class: 'osm-button', onclick: () => view?.close() }, 'Cancel'),
                    h('button', { type: 'button', class: 'osm-button is-primary', onclick: set }, 'Set status'),
                ),
            ),
            onClose: () => (view = null),
        });
        input.addEventListener('keydown', (e) => e.key === 'Enter' && set());
        input.focus();
        input.select();
    }

    return {
        start() {
            api.track(PlumoseCore.cardButton({ id: 'custom-status', label: 'Custom status', icon: ICON_BUBBLE, onclick: open }));
            // Also covers the wait for sign-in, the expiry time, and the app rebuilding its status after a reconnect.
            sync();
            const timer = setInterval(() => {
                const s = api.settings;
                // Forget an expired message, so a stale expiry can't swallow the next one typed in the settings.
                if (s.text && s.expiresAt && Date.now() >= Number(s.expiresAt)) api.setSettings({ text: '', expiresAt: null }).catch(() => {});
                sync();
            }, 5000);
            api.track(() => clearInterval(timer));
        },
        stop() {
            view?.close();
            sync('');
        },
        onSettings() {
            sync();
        },
    };
});
