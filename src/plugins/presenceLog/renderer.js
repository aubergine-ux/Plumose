/*
 * Friend presence log. Osmium keeps every known user in a MobX store
 * (window.Osmium().users.users, an ObservableMap of id → user), and each
 * user's `status` is a MobX observable. The plugin subscribes to MobX's own
 * change events on those objects, so it sees every presence update with its
 * before and after values. It doesn't decode network traffic, doesn't depend
 * on minified function names, and doesn't change how the app's state behaves.
 *
 * status: undefined = offline, { status: 'ONLINE' | 'IDLE' (absent = online), activities: [...] }
 * activity: { type: 'PLAYING' | 'LISTENING' | 'WATCHING' | 'CUSTOM' (absent), title, state, ... }
 *   e.g. Spotify is { type: 'LISTENING', title: 'Spotify', state: 'Song – Artist' }
 */
PlumoseCore.definePlugin('presenceLog', (api) => {
    'use strict';

    const { h, icons, modal, waitFor, cleanError } = PlumoseCore;
    const FRIEND = 1; // RelationshipStatus.FRIEND
    const ACTIVITY_TYPES = ['CUSTOM', 'PLAYING', 'LISTENING', 'WATCHING'];
    const WARMUP_MS = 15000; // Startup syncs every status at once; that isn't news.

    /* ------------------------------------------------------------- model -- */

    const presenceOf = (s) => (!s ? 'offline' : s.status === 'IDLE' || s.status === 1 ? 'idle' : 'online');
    const typeOf = (a) => (typeof a?.type === 'number' ? ACTIVITY_TYPES[a.type] : a?.type) || 'CUSTOM';
    const customText = (s) => {
        const a = (s?.activities || []).find((x) => typeOf(x) === 'CUSTOM');
        return a ? [a.title, a.state].filter(Boolean).join(' — ') : '';
    };
    const activitiesByType = (s) => {
        const out = new Map();
        for (const a of s?.activities || []) {
            const type = typeOf(a);
            if (type !== 'CUSTOM' && (a.title || a.state)) out.set(type, { type, title: a.title || '', state: a.state || undefined });
        }
        return out;
    };

    /** Everything that changed between two statuses, as log entries (without user fields). */
    function diff(before, after) {
        const s = api.settings;
        const out = [];
        const was = presenceOf(before);
        const now = presenceOf(after);

        if (was !== now) {
            if (was === 'offline') out.push({ kind: 'online', detail: now === 'idle' ? { idle: true } : undefined });
            else if (now === 'offline') out.push({ kind: 'offline' });
            else if (s.logIdle) out.push({ kind: now === 'idle' ? 'idle' : 'active' });
        }

        // Going offline clears every activity, and listing each one ending is just noise.
        if (s.logActivities && now !== 'offline') {
            const a = activitiesByType(before);
            const b = activitiesByType(after);
            for (const [type, act] of b) {
                const old = a.get(type);
                if (!old) out.push({ kind: 'activity', detail: { ...act, change: 'start' } });
                // A new song or episode changes `state`, not `title`.
                else if (old.title !== act.title || old.state !== act.state) out.push({ kind: 'activity', detail: { ...act, change: 'change' } });
            }
            for (const [type, act] of a) if (!b.has(type)) out.push({ kind: 'activity', detail: { ...act, change: 'end' } });

            const c1 = customText(before);
            const c2 = customText(after);
            if (c1 !== c2 && (c2 || was !== 'offline')) out.push({ kind: 'status', detail: { text: c2 } });
        }
        return out;
    }

    /* ----------------------------------------------------------- watcher -- */

    let client = null;
    let readyAt = 0;
    let pending = [];
    let flushTimer = null;
    const userWatchers = new Map(); // user object → disposer
    let watchedUsers = null; // the ObservableMap we're subscribed to, and its disposer
    let watchedRels = null;

    const isMapLike = (m) => m && typeof m.get === 'function' && typeof m.values === 'function';
    const uid = (u) => String(u?.id ?? '');
    const selfId = () => String(client?.user?.id ?? '');
    const mobx = (obj) => {
        if (!obj) return null;
        const sym = Object.getOwnPropertySymbols(obj).find((s) => s.description === 'mobx administration');
        return sym ? obj[sym] : null;
    };
    /** MobX's own observe hook: on observable objects it's the administration, on maps the map itself. */
    const observe = (target, cb) => {
        const adm = typeof target?.observe_ === 'function' ? target : mobx(target);
        return typeof adm?.observe_ === 'function' ? adm.observe_(cb) : null;
    };

    function tracked(id) {
        if (!id || id === selfId()) return false;
        if (api.settings.everyone) return true;
        return client?.users?.relationships?.get(BigInt(id)) === FRIEND;
    }

    function record(user, entries) {
        if (Date.now() < readyAt || entries.length === 0) return;
        const id = uid(user);
        for (const e of entries) {
            pending.push({ t: Date.now(), id, name: user.name || user.username || id, username: user.username || undefined, ...e });
            maybeNotify(user, e);
        }
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, 800);
    }

    function flush() {
        if (!pending.length) return;
        const batch = pending;
        pending = [];
        api.invoke('append', batch).catch((err) => console.error('[Plumose:presenceLog]', cleanError(err)));
    }

    function maybeNotify(user, entry) {
        const s = api.settings;
        if (!s.notify || entry.kind !== 'online' || !(s.watched || []).includes(uid(user))) return;
        api.invoke('notify', { title: `${user.name || user.username} is online`, body: user.username ? `@${user.username}` : '' }).catch(() => {});
    }

    function onStatus(user, before, after) {
        try {
            if (before !== after && tracked(uid(user))) record(user, diff(before, after));
        } catch (err) {
            console.error('[Plumose:presenceLog] diff failed', err);
        }
    }

    function watchUser(user) {
        if (!user || typeof user !== 'object' || userWatchers.has(user)) return;
        const off = observe(user, (change) => {
            if (change.name === 'status') onStatus(user, change.oldValue, change.newValue);
        });
        userWatchers.set(user, off || (() => {}));
    }

    function unwatchAll() {
        for (const off of userWatchers.values()) off();
        userWatchers.clear();
        watchedUsers?.off?.();
        watchedRels?.off?.();
        watchedUsers = watchedRels = null;
    }

    const userById = (k) => client?.users?.users?.get(typeof k === 'bigint' ? k : BigInt(k)) || { id: k, name: String(k) };

    /** (Re)attaches to the current store. The web app can swap stores on reconnect, so this also runs periodically. */
    function attach() {
        client = api.client();
        const users = client?.users?.users;
        const rels = client?.users?.relationships;
        if (!isMapLike(users)) return false;

        if (watchedUsers?.map !== users) {
            watchedUsers?.off?.();
            const off = observe(users, (change) => {
                if (change.type === 'delete') return;
                const user = change.newValue;
                watchUser(user);
                // A whole new object for someone we already knew: compare it with the old one.
                if (change.type === 'update' && change.oldValue && change.oldValue !== user) onStatus(user, change.oldValue.status, user.status);
            });
            watchedUsers = { map: users, off };
        }
        for (const user of users.values()) watchUser(user);

        if (isMapLike(rels) && watchedRels?.map !== rels) {
            watchedRels?.off?.();
            const off = observe(rels, (change) => {
                const was = change.type === 'add' ? undefined : change.oldValue;
                const now = change.type === 'delete' ? undefined : change.newValue;
                if (now === FRIEND && was !== FRIEND) record(userById(change.name), [{ kind: 'friend-added' }]);
                else if (was === FRIEND && now !== FRIEND) record(userById(change.name), [{ kind: 'friend-removed' }]);
            });
            watchedRels = { map: rels, off };
        }
        return true;
    }

    /* ---------------------------------------------------------------- UI -- */

    let view = null; // { modal, tab, search, filter, limit }
    let entries = [];

    const FILTERS = {
        all: () => true,
        presence: (e) => ['online', 'offline', 'idle', 'active'].includes(e.kind),
        activity: (e) => e.kind === 'activity' || e.kind === 'status',
        friends: (e) => e.kind === 'friend-added' || e.kind === 'friend-removed',
    };

    const verb = { PLAYING: 'playing', LISTENING: 'listening to', WATCHING: 'watching' };

    function describe(e) {
        const d = e.detail || {};
        switch (e.kind) {
            case 'online': return [d.idle ? 'came online (idle)' : 'came online'];
            case 'offline': return ['went offline'];
            case 'idle': return ['went idle'];
            case 'active': return ['is back'];
            case 'friend-added': return ['is now your friend'];
            case 'friend-removed': return ['is no longer your friend'];
            case 'status': return d.text ? ['set their status to ', h('q', {}, d.text)] : ['cleared their status'];
            case 'activity': {
                // Music and video apps put the track in `state` and the app name in `title`.
                const trackFirst = (d.type === 'LISTENING' || d.type === 'WATCHING') && d.state;
                const what = h('strong', {}, trackFirst ? d.state : d.title);
                const via = trackFirst ? d.title : d.state;
                const extra = via ? h('span', { class: 'osm-pl-muted' }, trackFirst ? ` on ${via}` : ` · ${via}`) : null;
                if (d.change === 'end') return [`stopped ${verb[d.type] || 'doing'} `, what];
                return [`${d.change === 'change' ? 'is now' : 'started'} ${verb[d.type] || 'doing'} `, what, extra];
            }
            default: return [e.kind];
        }
    }

    const dotClass = (kind) =>
        ({ online: 'is-online', active: 'is-online', offline: 'is-offline', idle: 'is-idle', 'friend-added': 'is-friend', 'friend-removed': 'is-removed' })[kind] || 'is-activity';

    const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    function dayLabel(t) {
        const d = new Date(t);
        const today = new Date();
        const yesterday = new Date(Date.now() - 864e5);
        if (d.toDateString() === today.toDateString()) return 'Today';
        if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
    }
    function ago(t) {
        const s = Math.round((Date.now() - t) / 1000);
        if (s < 60) return 'just now';
        const m = Math.round(s / 60);
        if (m < 60) return `${m} min ago`;
        const hr = Math.round(m / 60);
        if (hr < 24) return `${hr} h ago`;
        const d = Math.round(hr / 24);
        return d < 30 ? `${d} d ago` : new Date(t).toLocaleDateString();
    }

    function userFor(id) {
        try {
            return client?.users?.users?.get(BigInt(id)) || null;
        } catch {
            return null;
        }
    }

    function avatar(id, name) {
        const u = userFor(id);
        const url = (b) => (b && !b.isDisposed && typeof b.objectURL === 'string' ? b.objectURL : null);
        let src = null;
        try {
            src = url(u?.photoLazy?.blob) || url(u?.previewBlob);
        } catch {}
        const hue = [...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
        return h('span', { class: 'osm-pl-avatar', style: { '--hue': hue } },
            src ? h('img', { src, alt: '' }) : (name || '?').trim().charAt(0).toUpperCase());
    }

    function hasDm(id) {
        try {
            return !!client?.conversations?.conversations?.has(BigInt(id));
        } catch {
            return false;
        }
    }

    function nameButton(id, name) {
        if (!hasDm(id)) return h('span', { class: 'osm-pl-name' }, name);
        return h('button', {
            type: 'button', class: 'osm-pl-name is-link', title: `Open DM with ${name}`,
            onclick: () => {
                client?.navigation?.navigate?.(`/chat/${id}`);
                view?.modal.close();
            },
        }, name);
    }

    function bell(id, name) {
        const watched = (api.settings.watched || []).includes(id);
        return h('button', {
            type: 'button', class: `osm-icon-btn osm-pl-bell ${watched ? 'is-on' : ''}`, html: icons.bell,
            title: watched ? `Stop notifying when ${name} comes online` : `Notify me when ${name} comes online`,
            'aria-pressed': String(watched),
            onclick: async () => {
                const list = new Set(api.settings.watched || []);
                watched ? list.delete(id) : list.add(id);
                await api.setSettings({ watched: [...list] });
                renderView();
            },
        });
    }

    function renderActivity() {
        const q = view.search.trim().toLowerCase();
        const filter = FILTERS[view.filter] || FILTERS.all;
        const matches = [];
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (!filter(e)) continue;
            if (q && !`${e.name} ${e.username || ''}`.toLowerCase().includes(q)) continue;
            matches.push(e);
        }
        if (!matches.length) {
            return h('div', { class: 'osm-empty' }, entries.length ? 'Nothing matches.' : 'Nothing yet. Changes show up here as your friends come and go.');
        }
        const list = h('div', { class: 'osm-pl-list' });
        let lastDay = null;
        for (const e of matches.slice(0, view.limit)) {
            const day = dayLabel(e.t);
            if (day !== lastDay) {
                lastDay = day;
                list.append(h('div', { class: 'osm-pl-day' }, day));
            }
            list.append(h('div', { class: 'osm-pl-row' },
                h('span', { class: 'osm-pl-time', title: new Date(e.t).toLocaleString() }, time(e.t)),
                h('span', { class: `osm-pl-dot ${dotClass(e.kind)}` }),
                avatar(e.id, e.name),
                h('div', { class: 'osm-pl-text' }, nameButton(e.id, e.name), ' ', ...describe(e)),
                bell(e.id, e.name),
            ));
        }
        if (matches.length > view.limit) {
            list.append(h('button', { type: 'button', class: 'osm-button osm-pl-more', onclick: () => { view.limit += 300; renderView(); } },
                `Show more (${matches.length - view.limit} older)`));
        }
        return list;
    }

    function activityLine(a) {
        const v = verb[a.type] || 'doing';
        const trackFirst = (a.type === 'LISTENING' || a.type === 'WATCHING') && a.state;
        return `${v[0].toUpperCase()}${v.slice(1)} ${trackFirst ? `${a.state} on ${a.title}` : a.title}`;
    }

    function renderFriends() {
        const users = client?.users?.users;
        const rels = client?.users?.relationships;
        if (!isMapLike(users)) return h('div', { class: 'osm-empty' }, 'Still loading your friends…');

        const lastSeen = new Map();
        for (const e of entries) if (e.kind === 'offline') lastSeen.set(e.id, e.t);

        const q = view.search.trim().toLowerCase();
        const rows = [];
        for (const [key, rel] of rels || []) {
            if (rel !== FRIEND) continue;
            const u = users.get(key);
            const id = String(key);
            const name = u?.name || u?.username || id;
            if (q && !`${name} ${u?.username || ''}`.toLowerCase().includes(q)) continue;
            rows.push({ id, name, u, presence: presenceOf(u?.status), seen: lastSeen.get(id) });
        }
        const rank = { online: 0, idle: 1, offline: 2 };
        rows.sort((a, b) => rank[a.presence] - rank[b.presence] || (b.seen || 0) - (a.seen || 0) || a.name.localeCompare(b.name));
        if (!rows.length) return h('div', { class: 'osm-empty' }, q ? 'Nothing matches.' : 'No friends yet.');

        return h('div', { class: 'osm-pl-list' }, rows.map((r) => {
            const acts = [...activitiesByType(r.u?.status).values()];
            const custom = customText(r.u?.status);
            const line = r.presence === 'offline'
                ? (r.seen ? `Last seen ${ago(r.seen)}` : 'Offline · not seen since logging started')
                : acts.length ? activityLine(acts[0])
                : custom || (r.presence === 'idle' ? 'Idle' : 'Online');
            return h('div', { class: 'osm-pl-row osm-pl-friend' },
                h('span', { class: `osm-pl-dot ${dotClass(r.presence)}`, title: r.presence }),
                avatar(r.id, r.name),
                h('div', { class: 'osm-pl-text' }, nameButton(r.id, r.name), h('div', { class: 'osm-pl-muted osm-pl-line' }, line)),
                bell(r.id, r.name),
            );
        }));
    }

    function renderView() {
        if (!view) return;
        const scroll = view.modal.content.querySelector('.osm-pl-scroll')?.scrollTop || 0;
        const tabs = h('div', { class: 'osm-pl-tabs', role: 'tablist' },
            [['activity', 'Activity'], ['friends', 'Friends']].map(([key, label]) =>
                h('button', {
                    type: 'button', role: 'tab', 'aria-selected': String(view.tab === key), class: view.tab === key ? 'is-on' : '',
                    onclick: () => { view.tab = key; renderView(); },
                }, label)));

        const search = h('label', { class: 'osm-pl-search' },
            h('span', { html: icons.search }),
            h('input', {
                type: 'search', placeholder: 'Filter by name', value: view.search, spellcheck: 'false',
                oninput: (e) => {
                    view.search = e.target.value;
                    clearTimeout(view.searchTimer);
                    view.searchTimer = setTimeout(() => {
                        const pos = e.target.selectionStart;
                        renderView();
                        const input = view.modal.content.querySelector('.osm-pl-search input');
                        input.focus();
                        input.setSelectionRange(pos, pos);
                    }, 150);
                },
            }));

        const toolbar = h('div', { class: 'osm-pl-toolbar' }, search,
            view.tab === 'activity' && h('select', {
                class: 'osm-select osm-pl-filter', 'aria-label': 'Show',
                onchange: (e) => { view.filter = e.target.value; renderView(); },
            }, [['all', 'Everything'], ['presence', 'Online / offline'], ['activity', 'Activities & statuses'], ['friends', 'Friend changes']]
                .map(([v, l]) => h('option', { value: v, selected: v === view.filter }, l))),
            view.tab === 'activity' && h('button', {
                type: 'button', class: 'osm-icon-btn', title: 'Clear log', 'aria-label': 'Clear log', html: icons.trash,
                onclick: async () => {
                    if (!confirm('Clear the whole presence log?')) return;
                    await api.invoke('clear');
                },
            }),
        );

        const scroller = h('div', { class: 'osm-pl-scroll' }, view.tab === 'activity' ? renderActivity() : renderFriends());
        view.modal.content.replaceChildren(tabs, toolbar, scroller);
        scroller.scrollTop = scroll;
    }

    async function openView() {
        if (view) return view.modal.close();
        view = { tab: 'activity', search: '', filter: 'all', limit: 300 };
        view.modal = modal({
            title: 'Presence log',
            subtitle: api.settings.everyone ? 'Everyone you share a space with' : 'Your friends',
            className: 'osm-pl-modal',
            onClose: () => (view = null),
        });
        try {
            entries = await api.invoke('list');
        } catch (err) {
            entries = [];
        }
        renderView();
    }

    /* --------------------------------------------------------- lifecycle -- */

    return {
        start() {
            readyAt = Date.now() + WARMUP_MS;
            waitFor(attach, { timeout: 120000, interval: 500 }).then(() => {
                // Re-check now and then in case the web app replaced its maps (reconnect, account switch).
                const timer = setInterval(attach, 5000);
                api.track(() => clearInterval(timer));
            }).catch(() => console.warn('[Plumose:presenceLog] Osmium’s user store never showed up'));

            api.on('appended', (added) => {
                entries.push(...added);
                if (view) renderView();
            });
            api.on('cleared', () => {
                entries = [];
                if (view) renderView();
            });
            api.track(PlumoseCore.cardButton({ id: 'presence-log', label: 'Presence log', icon: icons.history, onclick: openView }));
            // Refresh "last seen … ago" while the Friends tab is open.
            const timer = setInterval(() => view?.tab === 'friends' && !view.modal.content.contains(document.activeElement) && renderView(), 30000);
            api.track(() => clearInterval(timer));
        },

        stop() {
            flush();
            clearTimeout(flushTimer);
            unwatchAll();
            view?.modal.close();
        },

        onSettings() {
            if (view) renderView();
        },
    };
});
