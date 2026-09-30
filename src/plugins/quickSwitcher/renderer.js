/*
 * Quick switcher. Everything it lists comes from Osmium's stores, and picking
 * a result goes through the app's own router (client.navigation.navigate), the
 * same call a sidebar link makes:
 *   chats     client.conversations.homeConversations   → /chat/<id>
 *   channels  client.channels.channels (those loaded)  → /<communityId>/<channelId>
 *   servers   client.communities.communities           → /<communityId>
 * Channels of a server only exist in the store once that server has been
 * opened, so a server you haven't visited this session lists as a server only.
 */
PlumoseCore.definePlugin('quickSwitcher', (api) => {
    'use strict';

    const { h, icons, modal } = PlumoseCore;
    const MAX_RESULTS = 40;
    const PREFIXES = { '@': 'chat', '#': 'channel', '*': 'server' };
    const KIND_LABELS = { chat: 'Chat', channel: 'Channel', server: 'Server' };

    const values = (map) => (map && typeof map.values === 'function' ? [...map.values()] : []);

    /* ------------------------------------------------------------- items -- */

    function items() {
        const client = api.client();
        if (!client) return [];
        const out = [];

        for (const c of [...(client.conversations?.homeConversations || [])]) {
            // Type 1 is the notes-to-self chat, which has id 0 and no /chat/<id> address.
            if (!c || c.type === 1) continue;
            out.push({ kind: 'chat', name: c.title || 'Chat', detail: c.type === 2 ? 'Group' : 'Direct message', path: `/chat/${c.id}`, unread: c.unreadCount || 0 });
        }

        for (const ch of values(client.channels?.channels)) {
            if (!ch || ch.isCategory || !ch.isVisible) continue;
            out.push({
                kind: 'channel', name: ch.name || 'channel', detail: ch.community?.name || 'Server',
                voice: ch.type === 1 || ch.type === 'VOICE',
                path: `/${ch.communityId}/${ch.id}`, unread: ch.conversation?.unreadCount || 0,
            });
        }

        for (const s of values(client.communities?.communities)) {
            if (s) out.push({ kind: 'server', name: s.name || 'Server', detail: 'Server', path: `/${s.id}`, unread: 0 });
        }
        return out;
    }

    /** Higher is better; 0 means no match. Matches at the start of the name or of a word win. */
    function score(name, query) {
        const n = name.toLowerCase();
        if (!query) return 1;
        if (n === query) return 100;
        if (n.startsWith(query)) return 80;
        const at = n.indexOf(query);
        if (at > 0) return /[\s\-_./]/.test(n[at - 1]) ? 60 : 40;
        // Letters in order, e.g. "gnrl" for "general".
        let i = 0;
        for (const ch of n) if (ch === query[i]) i++;
        return i === query.length ? 10 : 0;
    }

    function search(raw) {
        let query = raw.trim().toLowerCase();
        const only = PREFIXES[query[0]];
        if (only) query = query.slice(1).trim();

        const scored = [];
        for (const item of items()) {
            if (only && item.kind !== only) continue;
            const s = Math.max(score(item.name, query), query && item.kind === 'channel' ? score(item.detail, query) / 4 : 0);
            if (s > 0) scored.push({ item, s });
        }
        const unreadFirst = !query && api.settings.unreadFirst !== false;
        scored.sort((a, b) => b.s - a.s
            || (unreadFirst ? Number(b.item.unread > 0) - Number(a.item.unread > 0) : 0)
            || a.item.name.localeCompare(b.item.name));
        return scored.slice(0, MAX_RESULTS).map((x) => x.item);
    }

    /* ---------------------------------------------------------------- UI -- */

    let view = null;

    function open() {
        if (view) return view.close();
        let results = [];
        let selected = 0;

        const input = h('input', { class: 'osm-qs-input', type: 'text', placeholder: 'Where to? Try @name, #channel or *server', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Search chats, channels and servers' });
        const list = h('div', { class: 'osm-qs-list', role: 'listbox' });

        const go = (item) => {
            if (!item) return;
            view?.close();
            api.client()?.navigation?.navigate?.(item.path);
        };

        const highlight = () => {
            [...list.children].forEach((el, i) => {
                el.classList.toggle('is-on', i === selected);
                el.setAttribute('aria-selected', String(i === selected));
            });
            list.children[selected]?.scrollIntoView?.({ block: 'nearest' });
        };

        const render = () => {
            results = search(input.value);
            selected = 0;
            if (!results.length) {
                list.replaceChildren(h('div', { class: 'osm-empty' }, input.value.trim() ? 'Nothing matches.' : 'Nothing to show yet.'));
                return;
            }
            list.replaceChildren(...results.map((item, i) => h('div', {
                class: 'osm-qs-item', role: 'option',
                onclick: () => go(item),
                onmousemove: () => {
                    if (selected === i) return;
                    selected = i;
                    highlight();
                },
            },
                h('span', { class: 'osm-qs-mark' }, item.kind === 'chat' ? '@' : item.kind === 'server' ? '*' : item.voice ? '♪' : '#'),
                h('span', { class: 'osm-qs-name' }, item.name),
                h('span', { class: 'osm-qs-detail' }, item.kind === 'channel' ? item.detail : KIND_LABELS[item.kind]),
                item.unread > 0 && h('span', { class: 'osm-qs-unread' }, item.unread > 99 ? '99+' : String(item.unread)),
            )));
            highlight();
        };

        input.addEventListener('input', render);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!results.length) return;
                selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
                highlight();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                go(results[selected]);
            }
        });

        view = modal({
            title: 'Quick Switcher',
            subtitle: '↑ ↓ to move · Enter to open · Esc to close',
            className: 'osm-qs-modal',
            body: h('div', { class: 'osm-qs' }, h('label', { class: 'osm-qs-search' }, h('span', { html: icons.search }), input), list),
            onClose: () => (view = null),
        });
        render();
        input.focus();
    }

    return {
        start() {
            const onKey = (e) => {
                if (e.key?.toLowerCase() !== 'k' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
                e.preventDefault();
                e.stopPropagation();
                open();
            };
            document.addEventListener('keydown', onKey, true);
            api.track(() => document.removeEventListener('keydown', onKey, true));
        },
        stop() {
            view?.close();
        },
    };
});
