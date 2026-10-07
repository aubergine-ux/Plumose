/*
 * Pinned DMs. Osmium's Direct Messages list is a flex column of
 * <a href="/chat/<id>"> rows that React owns and sorts by latest message.
 * Moving those nodes would fight React, so, as with Server Folders:
 *   - pinned rows get a CSS `order` that puts them first;
 *   - the "Pinned" heading and the line under the pinned rows are extra
 *     elements appended to the list and placed with `order` too;
 *   - each row gets a pin button that shows on hover.
 * Osmium only lists chats that have a message in them, so a pinned chat with
 * no messages yet stays out of the list until it has one.
 */
PlumoseCore.definePlugin('pinnedDms', (api) => {
    'use strict';

    const { h, cleanError } = PlumoseCore;
    const LIST = 'nav[class*="container-"] [class*="listInner-"][role="list"]';
    const ROWS = ':scope > a[href^="/chat/"]';
    const REST = 100000; // order for unpinned rows: after every pinned one

    const stroke = (body, size = 14) =>
        `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    // Lucide icons (ISC licence).
    const ICON_PIN = stroke('<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>');
    const ICON_UNPIN = stroke('<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>');

    /* ------------------------------------------------------------- data -- */

    const pins = () => (Array.isArray(api.settings.pins) ? api.settings.pins : []);
    const save = (list) => api.setSettings({ pins: list }).catch((e) => alert(cleanError(e)));

    const chatId = (a) => a?.getAttribute('href')?.match(/^\/chat\/(\d+)\/?$/)?.[1] || null;

    const togglePin = (id) => save(pins().includes(id) ? pins().filter((x) => x !== id) : [...pins(), id]);

    function move(id, by) {
        const list = [...pins()];
        const from = list.indexOf(id);
        const to = from + by;
        if (from < 0 || to < 0 || to >= list.length) return;
        [list[from], list[to]] = [list[to], list[from]];
        save(list);
    }

    /** A chat's name, from the store first and the rendered list as a fallback. */
    function chatName(id) {
        try {
            const convs = api.client()?.conversations?.homeConversations;
            for (const c of convs && typeof convs.values === 'function' ? convs.values() : []) {
                if (c && String(c.id) === id && c.title) return c.title;
            }
        } catch {}
        const row = document.querySelector(`${LIST} > a[href="/chat/${CSS.escape(id)}"]`);
        return row?.querySelector('[class*="title-"]')?.textContent?.trim() || null;
    }

    /* ------------------------------------------------------------ layout -- */

    function apply() {
        const list = document.querySelector(LIST);
        if (!list) return;
        const rank = new Map(pins().map((id, i) => [id, i]));
        const byPinOrder = api.settings.order !== 'recent';
        const rows = [...list.querySelectorAll(ROWS)];
        const pinnedCount = rows.filter((a) => rank.has(chatId(a))).length;

        for (const a of rows) {
            const id = chatId(a);
            if (!id) continue;
            const pinned = rank.has(id);
            a.setAttribute('data-osm-pindm-row', '');
            a.toggleAttribute('data-osm-pinned', pinned);
            // Equal `order` values keep DOM order, which is Osmium's latest-message-first.
            const order = !pinnedCount ? '' : pinned ? String(byPinOrder ? rank.get(id) + 1 : 1) : String(REST);
            if (a.style.order !== order) a.style.order = order;
            pinButton(a, id, pinned);
        }

        const showLabel = pinnedCount > 0 && api.settings.showLabel !== false;
        place(list, 'osm-pindm-label', showLabel, 0, () => h('div', { class: 'osm-pindm-label', 'aria-hidden': 'true' }, 'Pinned'));
        place(list, 'osm-pindm-sep', showLabel && pinnedCount < rows.length, REST - 1, () => h('div', { class: 'osm-pindm-sep', 'aria-hidden': 'true' }));
    }

    /** Adds, positions or removes one of our own elements in the list. */
    function place(list, cls, show, order, make) {
        let el = list.querySelector(`:scope > .${cls}`);
        if (!show) return el?.remove();
        if (!el) list.append((el = make()));
        if (el.style.order !== String(order)) el.style.order = String(order);
    }

    function pinButton(a, id, pinned) {
        let btn = a.querySelector(':scope > .osm-pindm-btn');
        if (!btn) {
            // A <span>, not a <button>: the row is a link, and links can't hold buttons.
            btn = h('span', { class: 'osm-pindm-btn', role: 'button', tabindex: '-1' });
            // Stops the click before it reaches the link (navigation) or React's router.
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                togglePin(id);
            });
            a.append(btn);
        }
        const state = pinned ? 'on' : 'off';
        if (btn.dataset.state === state) return;
        btn.dataset.state = state;
        btn.innerHTML = pinned ? ICON_UNPIN : ICON_PIN;
        btn.title = pinned ? 'Unpin chat' : 'Pin chat';
        btn.setAttribute('aria-label', btn.title);
    }

    /* --------------------------------------------------------- lifecycle -- */

    function cleanup() {
        document.querySelectorAll('.osm-pindm-btn, .osm-pindm-label, .osm-pindm-sep').forEach((el) => el.remove());
        document.querySelectorAll('[data-osm-pindm-row]').forEach((a) => {
            a.style.removeProperty('order');
            a.removeAttribute('data-osm-pindm-row');
            a.removeAttribute('data-osm-pinned');
        });
    }

    return {
        start() {
            api.onDom(apply);
        },
        stop: cleanup,
        onSettings() {
            apply();
        },
        renderInfo(el) {
            const list = pins();
            el.append(h('div', { class: 'osm-setting-desc' },
                list.length ? `${list.length} pinned chat${list.length === 1 ? '' : 's'}:` : 'No pinned chats yet. Hover a chat in Direct Messages and click the pin.'));
            if (!list.length) return;
            el.append(h('div', { class: 'osm-pindm-manage' }, list.map((id, i) => h('div', { class: 'osm-pindm-item' },
                h('span', { class: 'osm-pindm-item-name' }, chatName(id) || 'Chat not loaded'),
                h('button', { type: 'button', class: 'osm-icon-btn', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(id, -1) }, '↑'),
                h('button', { type: 'button', class: 'osm-icon-btn', title: 'Move down', 'aria-label': 'Move down', disabled: i === list.length - 1, onclick: () => move(id, 1) }, '↓'),
                h('button', { type: 'button', class: 'osm-icon-btn', title: 'Unpin', 'aria-label': 'Unpin', html: ICON_UNPIN, onclick: () => togglePin(id) }),
            ))));
        },
    };
});
