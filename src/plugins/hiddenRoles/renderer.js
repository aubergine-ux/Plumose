/*
 * Show hidden roles. A role has a `public` flag ("whether this role can be
 * viewed by everyone"), and the web app never reads it: it draws whatever
 * roles it holds. So "hidden" here means two things the app already has in
 * memory but doesn't point out:
 *   - roles in the role store with public === false;
 *   - role IDs on a member (member.roleIds) with no role in the store. The
 *     profile card drops those silently (member.roles filters them out).
 *
 * Nothing is requested beyond what the app asks for itself, so a role the
 * server withholds completely stays unknown.
 */
PlumoseCore.definePlugin('hiddenRoles', (api) => {
    'use strict';

    const { h, modal } = PlumoseCore;
    const PERMISSION_LABELS = {
        ADMINISTRATOR: 'Administrator', VIEW_CHANNEL: 'View channels', SEND_MESSAGES: 'Send messages', CONNECT_VOICE: 'Connect to voice',
        MODIFY_CHANNEL: 'Modify channels', SEND_MEDIA: 'Send media', DELETE_MESSAGES: 'Delete messages', PIN_MESSAGES: 'Pin messages',
        SPEAK_VOICE: 'Speak', MODIFY_COMMUNITY: 'Modify community', MODIFY_ROLES: 'Modify roles', REMOVE_MEMBERS: 'Remove members',
        ADD_REACTIONS: 'Add reactions', MODIFY_LINKED_STICKERS: 'Modify linked stickers',
    };
    const BATCH = 50; // member records per request
    const MAX_FETCH = 1000;
    const ICON_SHIELD = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>';

    /* ------------------------------------------------------------- data -- */

    function communityId() {
        const fromNav = api.client()?.navigation?.params?.communityId;
        if (fromNav != null) return String(fromNav);
        return location.pathname.match(/^\/(\d+)(\/|$)/)?.[1] || null;
    }

    const big = (id) => {
        try {
            return BigInt(id);
        } catch {
            return null;
        }
    };
    const isHidden = (role) => role?.public === false;
    const userName = (id) => {
        const u = api.client()?.users?.users?.get(id);
        return u?.name || u?.username || `User ${id}`;
    };

    function members(cid) {
        const map = api.client()?.members?.byCommunity?.get(big(cid));
        return map && typeof map.values === 'function' ? [...map.values()] : [];
    }

    function memberOf(cid, userId) {
        return api.client()?.members?.byCommunity?.get(big(cid))?.get(userId) || null;
    }

    /** Everyone in the member lists Osmium has loaded for this server's channels. */
    function listedUserIds(cid) {
        const client = api.client();
        const lists = client?.members?.byChannel;
        if (!lists || typeof lists.entries !== 'function') return [];
        const ids = new Map();
        for (const [channelId, entries] of lists.entries()) {
            if (String(client.channels?.channels?.get(channelId)?.communityId) !== String(cid)) continue;
            for (const entry of entries || []) {
                const id = entry?.user?.user?.id;
                if (id != null) ids.set(String(id), id);
            }
        }
        return [...ids.values()];
    }

    /**
     * A member list only carries names. Who holds which role is on the member
     * record, which the app fetches one profile at a time (communities.GetMembers).
     * This asks for the records of everyone in the loaded member lists, with the
     * same request, in small batches.
     */
    async function loadMembers(cid, isCurrent) {
        const store = api.client()?.members;
        if (typeof store?.fetchMembers !== 'function') return;
        const have = store.byCommunity?.get(big(cid));
        const missing = listedUserIds(cid).filter((id) => !have?.has(id)).slice(0, MAX_FETCH);
        for (let i = 0; i < missing.length && isCurrent(); i += BATCH) {
            try {
                await store.fetchMembers(big(cid), missing.slice(i, i + BATCH));
            } catch (err) {
                console.warn('[Plumose:hiddenRoles] member fetch failed', err);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }

    /** Role IDs a member carries that have no role in the store. */
    function unknownRoleIds(member) {
        const roles = api.client()?.roles;
        return [...(member?.roleIds || [])].filter((id) => !roles?.get(id));
    }

    /* ---------------------------------------------------------- profiles -- */

    function userByUsername(username) {
        const users = api.client()?.users?.users;
        if (!users || typeof users.values !== 'function') return null;
        for (const u of users.values()) if (u?.username === username) return u;
        return null;
    }

    function markProfiles() {
        const on = api.settings.markOnProfiles !== false;
        const cid = communityId();
        for (const card of document.querySelectorAll('[class*="userProfileWrapper-"]')) {
            const username = card.querySelector('p[class*="username-"]')?.textContent?.replace(/^@/, '').trim();
            const member = on && cid && username ? memberOf(cid, userByUsername(username)?.id) : null;
            const hidden = member ? [...(member.roles || [])].filter(isHidden).map((r) => r.name) : [];
            const unknown = member ? unknownRoleIds(member).map(String) : [];

            // Only touch the card when what it should show has changed.
            const key = JSON.stringify([hidden, unknown]);
            const chips = [...card.querySelectorAll('[class*="rolesList-"] > li')];
            const marked = chips.filter((li) => li.hasAttribute('data-osm-hr')).length;
            const wanted = chips.filter((li) => hidden.includes(li.querySelector('[class*="roleLabel-"]')?.textContent)).length;
            if (card.dataset.osmHrKey === key && marked === wanted && !!card.querySelector('.osm-hr-extra') === unknown.length > 0) continue;
            card.dataset.osmHrKey = key;

            for (const li of chips) {
                const flag = hidden.includes(li.querySelector('[class*="roleLabel-"]')?.textContent);
                if (flag === li.hasAttribute('data-osm-hr')) continue;
                li.toggleAttribute('data-osm-hr', flag);
                if (flag) li.title = 'Hidden role: not public in this server';
                else li.removeAttribute('title');
            }

            card.querySelector('.osm-hr-extra')?.remove();
            if (unknown.length) {
                const host = card.querySelector('[class*="rolesSection-"]') || card.querySelector('[class*="content-"]') || card;
                host.append(h('div', { class: 'osm-hr-extra' },
                    h('div', { class: 'osm-hr-extra-label' }, `${unknown.length} role${unknown.length === 1 ? '' : 's'} Osmium doesn’t show`),
                    h('div', { class: 'osm-hr-chips' }, unknown.map((id) => h('span', { class: 'osm-hr-chip', title: `Role ID ${id}` }, `Role …${id.slice(-6)}`))),
                ));
            }
        }
    }

    function unmarkProfiles() {
        document.querySelectorAll('.osm-hr-extra').forEach((el) => el.remove());
        document.querySelectorAll('[data-osm-hr]').forEach((el) => {
            el.removeAttribute('data-osm-hr');
            el.removeAttribute('title');
        });
        document.querySelectorAll('[data-osm-hr-key]').forEach((el) => delete el.dataset.osmHrKey);
    }

    /* --------------------------------------------------------- role list -- */

    function roleRow({ name, color, badges, permissions, holders, total }) {
        const hidden = badges.includes('Hidden');
        return h('div', { class: 'osm-hr-role' },
            h('div', { class: 'osm-hr-role-head' },
                h('span', { class: 'osm-hr-dot', style: { background: color || 'var(--icon-soft-400, #717784)' } }),
                h('span', { class: 'osm-hr-role-name' }, name),
                badges.map((b) => h('span', { class: `osm-hr-badge ${b === 'Hidden' || b === 'Unknown' ? 'is-hidden' : ''}` }, b)),
            ),
            permissions && h('div', { class: 'osm-hr-role-line' }, permissions),
            h('div', { class: 'osm-hr-role-line' }, holders.length
                ? `${holders.length} of ${total} loaded member${total === 1 ? '' : 's'}: ${holders.slice(0, 40).join(', ')}${holders.length > 40 ? '…' : ''}`
                : hidden
                    ? `None of the ${total} loaded members. Osmium’s server may be leaving this role off other people’s records.`
                    : `None of the ${total} loaded members`),
        );
    }

    function renderRoles(cid, el) {
        const client = api.client();
        // Same call the server settings screen makes; it fetches the list if the app hasn't yet.
        const roles = [...(client?.roles?.getForCommunity?.(big(cid)) || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
        const all = members(cid);

        const known = roles.map((role) => {
            const names = (() => {
                try {
                    return [...(role.permissionNames || [])];
                } catch {
                    return [];
                }
            })();
            return roleRow({
                name: role.name || 'Unnamed role',
                color: role.colorHex,
                badges: [isHidden(role) && 'Hidden', role.separated && 'Separated'].filter(Boolean),
                permissions: api.settings.showPermissions !== false && (names.length ? names.map((n) => PERMISSION_LABELS[n] || n).join(' · ') : 'No permissions'),
                holders: all.filter((m) => [...(m.roleIds || [])].includes(role.id)).map((m) => m.nickname || userName(m.id)),
                total: all.length,
            });
        });

        const unknown = new Map(); // role id → member names
        for (const m of all) {
            for (const id of unknownRoleIds(m)) {
                if (!unknown.has(String(id))) unknown.set(String(id), []);
                unknown.get(String(id)).push(m.nickname || userName(m.id));
            }
        }
        const unknownRows = [...unknown].map(([id, holders]) => roleRow({ name: `Role ${id}`, badges: ['Unknown'], holders, total: all.length }));

        const hiddenCount = roles.filter(isHidden).length;
        el.replaceChildren(
            h('div', { class: 'osm-setting-desc' },
                `${roles.length} role${roles.length === 1 ? '' : 's'}, ${hiddenCount} hidden, ${unknown.size} unknown. `
                + `Holders are counted among the ${all.length} member${all.length === 1 ? '' : 's'} loaded so far: everyone in the member lists you’ve opened in this server. `
                + 'Open a channel and scroll its member list to bring in more.'),
            known.length ? h('div', { class: 'osm-hr-list' }, known) : h('div', { class: 'osm-empty' }, 'Osmium hasn’t loaded this server’s roles yet. Try again in a moment.'),
            unknownRows.length > 0 && h('div', { class: 'osm-hr-section' }, 'Carried by members, but not in the role list'),
            unknownRows.length > 0 && h('div', { class: 'osm-hr-list' }, unknownRows),
        );
        return `${roles.length}:${all.length}:${unknown.size}`;
    }

    let view = null;

    function openRoles() {
        if (view) return view.close();
        const cid = communityId();
        if (!cid) return;
        const name = api.client()?.communities?.communities?.get(big(cid))?.name || 'this server';
        const body = h('div', { class: 'osm-hr-body' });
        let seen = renderRoles(cid, body);
        // The role list arrives a moment after it's first asked for; redraw when the counts move.
        const timer = setInterval(() => {
            const client = api.client();
            const now = `${client?.roles?.byCommunity?.get(big(cid))?.length || 0}:${members(cid).length}`;
            if (!seen.startsWith(`${now}:`)) seen = renderRoles(cid, body);
        }, 1500);
        view = modal({
            title: 'Roles',
            subtitle: name,
            className: 'osm-hr-modal',
            body,
            onClose: () => {
                clearInterval(timer);
                view = null;
            },
        });
        loadMembers(cid, () => !!view && communityId() === cid);
    }

    /** A shield button beside the server's search button, above the channel list. */
    function mountButton() {
        const header = document.querySelector('[class*="communityTrigger-"]')?.parentElement;
        if (!header || header.querySelector('.osm-hr-btn')) return;
        header.append(h('button', { type: 'button', class: 'osm-hr-btn', 'aria-label': 'Server roles', title: 'Server roles', html: ICON_SHIELD, onclick: openRoles }));
    }

    return {
        start() {
            api.onDom(() => {
                mountButton();
                markProfiles();
            });
        },
        stop() {
            view?.close();
            document.querySelectorAll('.osm-hr-btn').forEach((el) => el.remove());
            unmarkProfiles();
        },
        onSettings() {
            markProfiles();
        },
    };
});
