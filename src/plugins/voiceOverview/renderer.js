/*
 * Voice overview. Osmium keeps the state of every voice room it knows about in
 * client.conversations.roomStates: chat id → { participants: [{ userId, muted,
 * deafened, videoAvailable, screenAvailable }] }. The app fills it at startup
 * (voice.GetRoomStates) and keeps it current from server updates, to draw the
 * avatars under voice channels. This plugin reads the same map and lists it in
 * one place. Clicking a call opens its channel; it doesn't join.
 */
PlumoseCore.definePlugin('voiceOverview', (api) => {
    'use strict';

    const { h, modal } = PlumoseCore;
    const FRIEND = 1; // RelationshipStatus.FRIEND
    const REFRESH_MS = 2000;

    const stroke = (body, size = 18) =>
        `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    const ICON_HEADPHONES = stroke('<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>');
    const ICON_MIC_OFF = stroke('<path d="M12 19v3"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M16.95 16.95A7 7 0 0 1 5 12v-2"/><path d="M18.89 13.23A7 7 0 0 0 19 12v-2"/><path d="m2 2 20 20"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/>', 14);
    const ICON_DEAF = stroke('<path d="M21 14h-1.343"/><path d="M9.128 3.47A9 9 0 0 1 21 12v3.343"/><path d="m2 2 20 20"/><path d="M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3"/><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364"/>', 14);
    const ICON_SCREEN = stroke('<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>', 14);
    const ICON_VIDEO = stroke('<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>', 14);

    /* ------------------------------------------------------------- data -- */

    function calls() {
        const client = api.client();
        const rooms = client?.conversations?.roomStates;
        if (!rooms || typeof rooms.entries !== 'function') return [];
        const out = [];
        for (const [key, state] of rooms.entries()) {
            const people = [...(state?.participants || [])];
            if (!people.length) continue;
            const channel = client.channels?.channels?.get(key);
            const chat = channel ? null : client.conversations?.conversations?.get(key);
            // One entry per person, even if they're connected from two devices.
            const seen = new Map();
            for (const p of people) {
                const id = String(p.userId);
                const user = client.users?.users?.get(p.userId);
                const prev = seen.get(id);
                seen.set(id, {
                    name: user?.name || user?.username || `User ${id}`,
                    friend: client.users?.relationships?.get(p.userId) === FRIEND,
                    self: id === String(client.user?.id ?? ''),
                    muted: !!p.muted && (prev ? prev.muted : true),
                    deafened: !!p.deafened && (prev ? prev.deafened : true),
                    screen: !!p.screenAvailable || !!prev?.screen,
                    video: !!p.videoAvailable || !!prev?.video,
                });
            }
            out.push({
                id: String(key),
                name: channel?.name || chat?.title || 'Voice call',
                place: channel ? channel.community?.name || 'Server' : 'Chat',
                path: channel ? `/${channel.communityId}/${channel.id}` : `/chat/${key}`,
                // Rooms in channels the app won't show you are left unlinked.
                canOpen: channel ? !!channel.isVisible : !!chat,
                people: [...seen.values()].sort((a, b) => Number(b.friend) - Number(a.friend) || a.name.localeCompare(b.name)),
            });
        }
        const friendsFirst = api.settings.friendsFirst !== false;
        const hasFriend = (c) => c.people.some((p) => p.friend);
        return out.sort((a, b) => (friendsFirst ? Number(hasFriend(b)) - Number(hasFriend(a)) : 0)
            || b.people.length - a.people.length
            || a.name.localeCompare(b.name));
    }

    /* ---------------------------------------------------------------- UI -- */

    let view = null;

    function render(list, el) {
        if (!list.length) {
            el.replaceChildren(h('div', { class: 'osm-empty' }, 'Nobody is in voice right now.'));
            return;
        }
        el.replaceChildren(...list.map((call) => {
            const go = () => {
                view?.close();
                api.client()?.navigation?.navigate?.(call.path);
            };
            return h('div', { class: 'osm-vo-call' },
                h(call.canOpen ? 'button' : 'div', { class: 'osm-vo-head', type: call.canOpen ? 'button' : null, title: call.canOpen ? 'Open this channel' : null, onclick: call.canOpen ? go : null },
                    h('span', { class: 'osm-vo-name' }, call.name),
                    h('span', { class: 'osm-vo-place' }, call.place),
                    h('span', { class: 'osm-vo-count' }, String(call.people.length)),
                ),
                h('div', { class: 'osm-vo-people' }, call.people.map((p) => h('div', { class: `osm-vo-person ${p.friend ? 'is-friend' : ''}` },
                    h('span', { class: 'osm-vo-person-name' }, p.self ? `${p.name} (you)` : p.name),
                    p.screen && h('span', { class: 'osm-vo-flag is-live', title: 'Sharing their screen', html: ICON_SCREEN }),
                    p.video && h('span', { class: 'osm-vo-flag', title: 'Camera on', html: ICON_VIDEO }),
                    p.deafened ? h('span', { class: 'osm-vo-flag', title: 'Deafened', html: ICON_DEAF })
                        : p.muted && h('span', { class: 'osm-vo-flag', title: 'Muted', html: ICON_MIC_OFF }),
                ))),
            );
        }));
    }

    function open() {
        if (view) return view.close();
        const body = h('div', { class: 'osm-vo-list' });
        let last = null;
        const refresh = () => {
            const list = calls();
            const key = JSON.stringify(list);
            if (key === last) return;
            last = key;
            render(list, body);
        };
        refresh();
        const timer = setInterval(refresh, REFRESH_MS);
        view = modal({
            title: 'Voice Overview',
            subtitle: 'Everyone in voice that Osmium knows about · updates live',
            className: 'osm-vo-modal',
            body,
            onClose: () => {
                clearInterval(timer);
                view = null;
            },
        });
    }

    return {
        start() {
            api.track(PlumoseCore.cardButton({ id: 'voice-overview', label: 'Voice overview', icon: ICON_HEADPHONES, onclick: open }));
        },
        stop() {
            view?.close();
        },
    };
});
