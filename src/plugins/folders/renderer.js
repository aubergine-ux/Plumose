/*
 * Server folders. Osmium's server rail is a scroller of <a href="/<communityId>">
 * links that React owns. Moving those nodes around would fight React, so they
 * stay where they are:
 *   - the scroller becomes a flex column, and each item gets a CSS `order`
 *     that puts it right after its folder;
 *   - folder tiles are extra elements appended to the scroller and placed with `order` too;
 *   - servers in a closed folder are hidden with an attribute.
 * Osmium's own drag-to-reorder keeps working for servers outside folders.
 */
PlumoseCore.definePlugin('folders', (api) => {
    'use strict';

    const { h, modal, cleanError } = PlumoseCore;
    const SCROLLER = '[class*="communityListScroller-"]';
    const COLORS = ['#7c6cf2', '#3b82f6', '#06b6d4', '#10b981', '#84cc16', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#64748b'];

    const stroke = (body, size = 22) =>
        `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    const ICON_FOLDER = stroke('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>');
    const ICON_FOLDER_OPEN = stroke('<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>');
    const ICON_FOLDER_PLUS = stroke('<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>');

    /* ------------------------------------------------------------- data -- */

    const folders = () => (Array.isArray(api.settings.folders) ? api.settings.folders : []);
    const save = (list) => api.setSettings({ folders: list }).catch((e) => alert(cleanError(e)));
    const newId = () => Math.random().toString(36).slice(2, 10);

    const communityId = (a) => a?.getAttribute('href')?.match(/^\/(\d+)\/?$/)?.[1] || null;

    function community(id) {
        try {
            return api.client()?.communities?.communities?.get(BigInt(id)) || null;
        } catch {
            return null;
        }
    }

    /** Name and icon for a server, from the rail first and the store as a fallback. */
    function info(id, anchor) {
        const c = community(id);
        const img = anchor?.querySelector('img')?.src || null;
        const label = anchor?.querySelector('svg[aria-label]')?.getAttribute('aria-label');
        return { id, name: c?.name || label || id, img };
    }

    /* ------------------------------------------------------------ layout -- */

    let dragId = null;
    let applying = false;

    function apply() {
        const scroller = document.querySelector(SCROLLER);
        if (!scroller || applying) return;
        applying = true;
        try {
            layout(scroller);
        } finally {
            applying = false;
        }
    }

    function layout(scroller) {
        scroller.classList.add('osm-folders-rail');
        const list = folders();
        const folderOf = new Map();
        for (const f of list) for (const id of f.ids || []) if (!folderOf.has(id)) folderOf.set(id, f);

        const items = [...scroller.children].filter((el) => !el.classList.contains('osm-folder') && !el.classList.contains('osm-folder-new'));
        const anchors = new Map(); // community id → <a>
        for (const el of items) {
            const id = el.tagName === 'A' ? communityId(el) : null;
            if (id) anchors.set(id, el);
        }

        // Walk the rail in Osmium's order. A folder takes the place of its first
        // member and pulls the rest of its members in right after it.
        let order = 0;
        const placed = new Set();
        const tiles = new Map([...scroller.querySelectorAll(':scope > .osm-folder')].map((t) => [t.dataset.folder, t]));
        const liveFolders = new Set();

        const placeFolder = (f) => {
            const members = (f.ids || []).filter((id) => anchors.has(id) && folderOf.get(id) === f);
            if (!members.length) return;
            liveFolders.add(f.id);
            const tile = tiles.get(f.id) || createTile(scroller, f.id);
            renderTile(tile, f, members.map((id) => anchors.get(id)));
            tile.style.order = String(order++);
            members.forEach((id, i) => {
                const a = anchors.get(id);
                placed.add(a);
                a.style.order = String(order++);
                a.dataset.osmFolder = f.id;
                a.style.setProperty('--osm-folder-color', f.color || COLORS[0]);
                a.toggleAttribute('data-osm-folder-hidden', !f.open);
                a.toggleAttribute('data-osm-folder-last', i === members.length - 1);
            });
        };

        // The "new folder" button goes after the last server, before "add a server" and "discover".
        let newBtn = scroller.querySelector(':scope > .osm-folder-new');
        if (!newBtn) {
            const native = scroller.querySelector('[class*="communityActionButton-"]');
            newBtn = h('button', {
                type: 'button', class: `${native?.className || ''} osm-folder-new`, 'aria-label': 'New folder', title: 'New folder',
                html: ICON_FOLDER_PLUS, onclick: () => editFolder(null),
            });
            scroller.append(newBtn);
        }
        let newBtnPlaced = false;

        for (const el of items) {
            if (placed.has(el)) continue;
            const id = el.tagName === 'A' ? communityId(el) : null;
            if (!id && !newBtnPlaced) {
                newBtn.style.order = String(order++);
                newBtnPlaced = true;
            }
            const f = id && folderOf.get(id);
            if (f && !liveFolders.has(f.id)) {
                placeFolder(f);
                continue;
            }
            el.style.order = String(order++);
            if (el.dataset.osmFolder) {
                delete el.dataset.osmFolder;
                el.removeAttribute('data-osm-folder-hidden');
                el.removeAttribute('data-osm-folder-last');
            }
        }

        if (!newBtnPlaced) newBtn.style.order = String(order++);

        // Folders whose servers are all gone (left the server, or not loaded yet) get no tile.
        for (const [fid, tile] of tiles) if (!liveFolders.has(fid)) tile.remove();
    }

    function createTile(scroller, fid) {
        const tile = h('div', { class: 'osm-folder', 'data-folder': fid });
        tile.addEventListener('click', () => toggle(fid));
        tile.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            folderMenu(fid, e.clientX, e.clientY);
        });
        tile.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle(fid);
            }
        });
        // Drop a server on a folder to add it.
        tile.addEventListener('dragover', (e) => {
            if (!dragId) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            tile.classList.add('is-drop');
        });
        tile.addEventListener('dragleave', () => tile.classList.remove('is-drop'));
        tile.addEventListener('drop', (e) => {
            tile.classList.remove('is-drop');
            if (!dragId) return;
            e.preventDefault();
            e.stopPropagation();
            addToFolder(fid, dragId);
            dragId = null;
        });
        scroller.append(tile);
        return tile;
    }

    function renderTile(tile, f, members) {
        const color = f.color || COLORS[0];
        tile.style.setProperty('--osm-folder-color', color);
        tile.classList.toggle('is-open', !!f.open);
        tile.setAttribute('role', 'button');
        tile.setAttribute('tabindex', '0');
        tile.setAttribute('aria-expanded', String(!!f.open));
        const unread = members.some((a) => a.querySelector('[class*="unreadBadge-"]'));
        const mentions = members.some((a) => a.querySelector('[class*="unreadMentions-"]'));
        const active = members.some((a) => a.querySelector('[class*="selected-"]'));
        const label = `${f.name || 'Folder'} (${members.length} server${members.length === 1 ? '' : 's'})`;
        tile.setAttribute('aria-label', label);
        tile.title = label;

        // Only rebuild the inside when something visible changed; the rail re-renders a lot.
        const preview = !f.open && api.settings.showPreview !== false;
        const key = JSON.stringify([f.open, color, preview, unread, mentions, active, preview && members.slice(0, 4).map((a) => a.querySelector('img')?.src || communityId(a))]);
        if (tile.dataset.key === key) return;
        tile.dataset.key = key;

        const face = h('div', { class: `osm-folder-face ${active && !f.open ? 'is-active' : ''}` });
        if (preview) {
            face.classList.add('is-preview');
            for (const a of members.slice(0, 4)) {
                const i = info(communityId(a), a);
                face.append(h('span', { class: 'osm-folder-mini' }, i.img ? h('img', { src: i.img, alt: '', draggable: 'false' }) : (i.name || '?').trim().charAt(0)));
            }
        } else {
            face.innerHTML = f.open ? ICON_FOLDER_OPEN : ICON_FOLDER;
        }
        if (!f.open && unread) face.append(h('span', { class: `osm-folder-badge ${mentions ? 'is-mention' : ''}` }));
        tile.replaceChildren(face);
    }

    /* ----------------------------------------------------------- actions -- */

    function update(fid, fn) {
        const list = folders().map((f) => (f.id === fid ? fn({ ...f }) : f)).filter(Boolean);
        return save(list);
    }

    const toggle = (fid) => update(fid, (f) => ({ ...f, open: !f.open }));

    function addToFolder(fid, id) {
        // A server lives in one folder at a time.
        const list = folders().map((f) => {
            const ids = (f.ids || []).filter((x) => x !== id);
            return f.id === fid ? { ...f, ids: [...ids, id] } : { ...f, ids };
        });
        return save(list);
    }

    function deleteFolder(fid) {
        return save(folders().filter((f) => f.id !== fid));
    }

    /* -------------------------------------------------------------- menu -- */

    let menu = null;
    function closeMenu() {
        menu?.remove();
        menu = null;
        document.removeEventListener('pointerdown', onMenuOutside, true);
        document.removeEventListener('keydown', onMenuKey, true);
    }
    const onMenuOutside = (e) => menu && !menu.contains(e.target) && closeMenu();
    const onMenuKey = (e) => e.key === 'Escape' && (e.stopPropagation(), closeMenu());

    function folderMenu(fid, x, y) {
        closeMenu();
        const f = folders().find((x) => x.id === fid);
        if (!f) return;
        const item = (label, fn, danger) => h('button', { type: 'button', class: `osm-folder-menu-item ${danger ? 'is-danger' : ''}`, onclick: () => { closeMenu(); fn(); } }, label);
        menu = h('div', { class: 'osm-folder-menu', role: 'menu' },
            h('div', { class: 'osm-folder-menu-title' }, f.name || 'Folder'),
            item(f.open ? 'Close folder' : 'Open folder', () => toggle(fid)),
            item('Edit folder…', () => editFolder(fid)),
            h('div', { class: 'osm-folder-swatches' }, COLORS.map((c) => h('button', {
                type: 'button', class: `osm-folder-swatch ${c === f.color ? 'is-on' : ''}`, style: { background: c }, title: 'Folder colour',
                'aria-label': `Colour ${c}`, onclick: () => { closeMenu(); update(fid, (x) => ({ ...x, color: c })); },
            }))),
            item('Delete folder', () => deleteFolder(fid), true),
        );
        document.body.append(menu);
        const r = menu.getBoundingClientRect();
        menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
        menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
        document.addEventListener('pointerdown', onMenuOutside, true);
        document.addEventListener('keydown', onMenuKey, true);
    }

    /* ------------------------------------------------------------ editor -- */

    function editFolder(fid) {
        const existing = folders().find((f) => f.id === fid);
        const draft = existing ? { ...existing, ids: [...(existing.ids || [])] } : { id: newId(), name: '', color: COLORS[folders().length % COLORS.length], ids: [], open: false };

        const scroller = document.querySelector(SCROLLER);
        const railAnchors = scroller ? [...scroller.querySelectorAll(':scope > a[href]')] : [];
        // Servers in the rail's own order.
        const servers = railAnchors.map((a) => info(communityId(a), a)).filter((s) => s.id);
        const ownerOf = new Map();
        for (const f of folders()) if (f.id !== draft.id) for (const id of f.ids || []) ownerOf.set(id, f);

        const name = h('input', { class: 'osm-input', type: 'text', placeholder: 'Folder name', value: draft.name, maxlength: '40', spellcheck: 'false' });
        const swatches = h('div', { class: 'osm-folder-swatches is-large' });
        const renderSwatches = () => swatches.replaceChildren(...COLORS.map((c) => h('button', {
            type: 'button', class: `osm-folder-swatch ${c === draft.color ? 'is-on' : ''}`, style: { background: c }, 'aria-label': `Colour ${c}`,
            onclick: () => { draft.color = c; renderSwatches(); },
        })));
        renderSwatches();

        const filter = h('input', { class: 'osm-input', type: 'search', placeholder: 'Filter servers', spellcheck: 'false' });
        const list = h('div', { class: 'osm-folder-picker' });
        const renderList = () => {
            const q = filter.value.trim().toLowerCase();
            list.replaceChildren(...servers.filter((s) => !q || s.name.toLowerCase().includes(q)).map((s) => {
                const other = ownerOf.get(s.id);
                return h('label', { class: 'osm-folder-pick' },
                    h('input', {
                        type: 'checkbox', checked: draft.ids.includes(s.id),
                        onchange: (e) => {
                            draft.ids = draft.ids.filter((x) => x !== s.id);
                            if (e.target.checked) draft.ids.push(s.id);
                        },
                    }),
                    h('span', { class: 'osm-folder-pick-icon' }, s.img ? h('img', { src: s.img, alt: '' }) : s.name.charAt(0)),
                    h('span', { class: 'osm-folder-pick-name' }, s.name),
                    other && h('span', { class: 'osm-folder-pick-note' }, `in ${other.name || 'another folder'}`),
                );
            }));
        };
        filter.addEventListener('input', renderList);
        renderList();

        const saveBtn = h('button', {
            type: 'button', class: 'osm-button is-primary',
            onclick: async () => {
                draft.name = name.value.trim() || 'Folder';
                // Keep the rail's order inside the folder, and take servers out of any other folder.
                const railOrder = servers.map((s) => s.id);
                draft.ids = [...new Set(draft.ids)].sort((a, b) => railOrder.indexOf(a) - railOrder.indexOf(b));
                const others = folders().filter((f) => f.id !== draft.id).map((f) => ({ ...f, ids: (f.ids || []).filter((x) => !draft.ids.includes(x)) }));
                const list = existing ? folders().map((f) => (f.id === draft.id ? draft : others.find((o) => o.id === f.id))) : [...others, draft];
                await save(list.filter((f) => f && (f.id === draft.id || f.ids.length)));
                dialog.close();
            },
        }, existing ? 'Save' : 'Create folder');

        const dialog = modal({
            title: existing ? 'Edit folder' : 'New folder',
            subtitle: 'Pick the servers that go in it. Tip: you can also drag a server onto a folder.',
            className: 'osm-folder-modal',
            body: h('div', { class: 'osm-folder-editor' },
                h('div', { class: 'osm-folder-row' }, name),
                swatches,
                filter,
                list,
                h('div', { class: 'osm-folder-actions' },
                    existing && h('button', { type: 'button', class: 'osm-button is-danger', onclick: async () => { await deleteFolder(draft.id); dialog.close(); } }, 'Delete folder'),
                    h('span', { style: { flex: '1' } }),
                    h('button', { type: 'button', class: 'osm-button', onclick: () => dialog.close() }, 'Cancel'),
                    saveBtn,
                ),
            ),
        });
        name.focus();
        name.addEventListener('keydown', (e) => e.key === 'Enter' && saveBtn.click());
    }

    /* --------------------------------------------------------- lifecycle -- */

    function cleanup() {
        closeMenu();
        document.querySelectorAll('.osm-folder, .osm-folder-new').forEach((el) => el.remove());
        document.querySelectorAll(`${SCROLLER} > *`).forEach((el) => {
            el.style.removeProperty('order');
            el.style.removeProperty('--osm-folder-color');
            delete el.dataset.osmFolder;
            el.removeAttribute('data-osm-folder-hidden');
            el.removeAttribute('data-osm-folder-last');
        });
        document.querySelectorAll('.osm-folders-rail').forEach((el) => el.classList.remove('osm-folders-rail'));
    }

    return {
        start() {
            api.onDom(apply);
            // Remember which server is being dragged, for dropping onto folders.
            const onDragStart = (e) => {
                const a = e.target.closest?.(`${SCROLLER} > a[href]`);
                dragId = a ? communityId(a) : null;
            };
            const onDragEnd = () => {
                dragId = null;
                document.querySelectorAll('.osm-folder.is-drop').forEach((t) => t.classList.remove('is-drop'));
            };
            document.addEventListener('dragstart', onDragStart, true);
            document.addEventListener('dragend', onDragEnd, true);
            api.track(() => {
                document.removeEventListener('dragstart', onDragStart, true);
                document.removeEventListener('dragend', onDragEnd, true);
            });
        },
        stop: cleanup,
        onSettings() {
            apply();
        },
        renderSettings(el) {
            const s = api.settings;
            const list = folders();
            el.append(
                h('label', { class: 'osm-setting is-inline' },
                    h('div', { class: 'osm-setting-text' },
                        h('div', { class: 'osm-setting-label' }, 'Show server previews'),
                        h('div', { class: 'osm-setting-desc' }, 'A closed folder shows its first four server icons instead of a folder icon.')),
                    h('input', { type: 'checkbox', class: 'osm-switch', checked: s.showPreview !== false, onchange: (e) => api.setSettings({ showPreview: e.target.checked }) })),
                h('div', { class: 'osm-setting-desc' }, list.length ? `${list.length} folder${list.length === 1 ? '' : 's'}: ${list.map((f) => f.name).join(', ')}` : 'No folders yet.'),
                h('div', {}, h('button', { type: 'button', class: 'osm-button', onclick: () => editFolder(null) }, 'New folder…')),
            );
        },
    };
});
