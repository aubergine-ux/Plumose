/*
 * Show hidden channels. The web app decides what to draw from the channels it
 * holds: every channel has an `isVisible` getter (owner, ADMINISTRATOR, or
 * VIEW_CHANNEL after the channel's overrides) and the channel list filters on
 * it. This plugin draws the ones that filter drops. Whether there are any
 * depends on the server: if its GetChannels reply leaves out what you can't
 * view, the store has nothing hidden, and renderInfo() says so.
 *
 * Only what the client already holds is shown: name, type, topic, category and
 * voice participants. Message history is checked by the server, so a hidden
 * channel can't be opened.
 *
 * The list is React's, so rows are only ever appended: to the end of a
 * category's <ul>, or to extra category blocks at the end of the scroller for
 * categories that aren't drawn at all.
 */
PlumoseCore.definePlugin('hiddenChannels', (api) => {
    'use strict';

    const { h, modal } = PlumoseCore;
    const TYPE_NAMES = { 0: 'Text channel', 1: 'Voice channel', 3: 'Announcement channel', TEXT: 'Text channel', VOICE: 'Voice channel', ANNOUNCEMENT: 'Announcement channel' };

    const stroke = (body, size = 16) =>
        `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    const ICON_LOCK = stroke('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>');
    const ICON_VOICE = stroke('<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/>');

    /* ------------------------------------------------------------- data -- */

    function communityId() {
        const fromNav = api.client()?.navigation?.params?.communityId;
        if (fromNav != null) return String(fromNav);
        return location.pathname.match(/^\/(\d+)(\/|$)/)?.[1] || null;
    }

    const isVoice = (c) => c.type === 1 || c.type === 'VOICE';
    const values = (coll) => (coll && typeof coll.values === 'function' ? [...coll.values()] : []);
    const channelById = (id) => {
        try {
            return api.client()?.channels?.channels?.get(BigInt(id)) || null;
        } catch {
            return null;
        }
    };

    /** Channels of this server the app holds but won't draw. */
    function hiddenChannels(cid) {
        let list;
        try {
            list = api.client()?.channels?.byCommunity?.get(BigInt(cid));
        } catch {}
        const held = values(list).filter((c) => c && !c.isCategory && !c.isVisible).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        try { return [...held, ...unlistedVoiceRooms(cid)]; } catch { return held; }
    }

    /**
     * Voice rooms the app was told about for this server whose channel it was
     * never sent. All that's known is who is in them, so they get a stand-in name.
     */
    function unlistedVoiceRooms(cid) {
        const client = api.client();
        let ids;
        try {
            ids = client?.conversations?.communityRoomStateCache?.get(BigInt(cid));
        } catch {}
        return [...(ids || [])]
            .filter((id) => !client.channels?.channels?.get(id) && (client.conversations.roomStates?.get(id)?.participants?.length || 0) > 0)
            .map((id) => ({ id, name: 'Hidden voice channel', type: 1, parentId: null, unlisted: true }));
    }

    /** What the app holds for this server, for the read-out in the plugin's settings. */
    function counts(cid) {
        let list;
        try {
            list = api.client()?.channels?.byCommunity?.get(BigInt(cid));
        } catch {}
        const channels = list ? values(list).filter((c) => c && !c.isCategory) : null;
        return {
            loaded: !!list,
            total: channels?.length || 0,
            hidden: channels?.filter((c) => !c.isVisible).length || 0,
            voiceOnly: unlistedVoiceRooms(cid).length,
        };
    }

    function participants(channel) {
        const client = api.client();
        const state = client?.conversations?.roomStates?.get(channel.id);
        return (state?.participants || []).map((p) => {
            const u = client.users?.users?.get(p.userId);
            return u?.name || u?.username || `User ${p.userId}`;
        });
    }

    /* ----------------------------------------------------------- details -- */

    function showDetails(channel) {
        const category = channel.parentId != null ? channelById(channel.parentId) : null;
        const inVoice = isVoice(channel) ? participants(channel) : [];
        const row = (label, value) => value && h('div', { class: 'osm-hc-detail' }, h('div', { class: 'osm-hc-detail-label' }, label), h('div', { class: 'osm-hc-detail-value' }, value));
        modal({
            title: channel.name || 'Hidden channel',
            subtitle: 'You don’t have permission to view this channel',
            className: 'osm-hc-modal',
            body: h('div', { class: 'osm-hc-details' },
                row('Type', TYPE_NAMES[channel.type] || 'Channel'),
                row('Category', category?.name),
                row('Topic', channel.description),
                isVoice(channel) && row('In voice', inVoice.length ? inVoice.join(', ') : 'Nobody right now'),
                row('Channel ID', String(channel.id)),
                h('div', { class: 'osm-setting-desc' }, channel.unlisted
                    ? 'Osmium was told who is in this voice room, but not the channel’s name.'
                    : 'Osmium was sent this channel’s name and topic, but not its messages.'),
            ),
        });
    }

    /* ------------------------------------------------------------ layout -- */

    const OURS = '.osm-hc-row, .osm-hc-cat';
    // State classes Osmium adds to a channel row; a borrowed class list must not carry them.
    const STATE_CLASS = /^(selected|unread|onCall|joinedCall)-/;
    let lastKey = null;

    const clear = () => document.querySelectorAll(OURS).forEach((el) => el.remove());

    function scrollerFor() {
        const nav = document.querySelector('[class*="communityTrigger-"]')?.closest('nav');
        return nav?.querySelector('[class*="scroller-"]') || null;
    }

    /** Where each drawn category keeps its rows: parent id (or 'none') → element to append to. */
    function categoryTargets(scroller, cid) {
        const targets = new Map();
        for (const block of scroller.querySelectorAll('[class*="categoryContainer-"]:not(.osm-hc-cat)')) {
            const link = block.querySelector(`a[href^="/${cid}/"]:not(.osm-hc-row)`);
            const channel = link && channelById(link.getAttribute('href').split('/')[2]);
            if (!channel) continue;
            const key = channel.parentId != null ? String(channel.parentId) : 'none';
            if (!targets.has(key)) targets.set(key, block.querySelector('ul') || block);
        }
        return targets;
    }

    function row(channel, itemClass) {
        const open = () => showDetails(channel);
        const count = isVoice(channel) ? participants(channel).length : 0;
        return h('a', {
            class: 'osm-hc-row', role: 'button', tabindex: '0', 'data-osm-hc': String(channel.id),
            'aria-label': `${channel.name} (hidden channel)`, title: 'Hidden channel: click for details',
            onclick: (e) => { e.preventDefault(); open(); },
            onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open()),
        },
            h('div', { class: `${itemClass} osm-hc-item` },
                h('span', { class: 'osm-hc-icon', html: isVoice(channel) ? ICON_VOICE : ICON_LOCK }),
                h('span', { class: 'osm-hc-name' }, channel.name || 'unnamed'),
                count > 0 && h('span', { class: 'osm-hc-count', title: `${count} in voice` }, String(count)),
            ),
        );
    }

    /** A category block of our own, for hidden channels whose category isn't drawn. */
    function categoryBlock(title, rows, classes) {
        const list = h('ul', { class: 'osm-hc-list' }, rows);
        const block = h('div', { class: `${classes.block} osm-hc-cat` });
        const header = h('div', {
            class: `${classes.header} osm-hc-cat-head`, role: 'button', tabindex: '0', 'aria-expanded': 'true',
            onclick: () => header.setAttribute('aria-expanded', String(block.classList.toggle('is-closed') === false)),
            onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), header.click()),
        }, h('span', { class: 'osm-hc-cat-lock', html: ICON_LOCK.replace(/width="16" height="16"/, 'width="12" height="12"') }), title);
        block.append(header, list);
        return block;
    }

    function apply() {
        const cid = communityId();
        const scroller = cid && scrollerFor();
        if (!scroller) {
            if (lastKey !== null) clear();
            lastKey = null;
            return;
        }

        const hidden = hiddenChannels(cid);
        const inline = api.settings.placement !== 'section';
        const targets = inline ? categoryTargets(scroller, cid) : new Map();
        const parentKey = (c) => (c.parentId != null ? String(c.parentId) : 'none');

        // Rebuild only when something that shows changed, or React dropped our rows.
        const key = JSON.stringify([
            cid, inline, !!api.settings.dim,
            hidden.map((c) => [String(c.id), c.name, c.type, parentKey(c), targets.has(parentKey(c)), isVoice(c) ? participants(c).length : 0]),
        ]);
        const drawn = document.querySelectorAll('.osm-hc-row').length;
        if (key === lastKey && drawn === hidden.length && [...document.querySelectorAll(OURS)].every((el) => scroller.contains(el))) return;
        lastKey = key;
        clear();
        scroller.classList.toggle('osm-hc-dim', !!api.settings.dim);
        if (!hidden.length) return;

        const sample = scroller.querySelector('[class*="channelListItem-"]:not(.osm-hc-item)');
        const itemClass = (sample?.className || '').split(/\s+/).filter((c) => c && !STATE_CLASS.test(c)).join(' ');
        const classes = {
            block: (scroller.querySelector('[class*="categoryContainer-"]:not(.osm-hc-cat)')?.className || '').trim(),
            header: (scroller.querySelector('[class*="categoryHeader-"]:not(.osm-hc-cat-head)')?.className || '').trim(),
        };

        const leftover = new Map(); // category title → rows
        for (const channel of hidden) {
            const target = targets.get(parentKey(channel));
            if (target) {
                target.append(row(channel, itemClass));
                continue;
            }
            const title = inline ? (channel.parentId != null && channelById(channel.parentId)?.name) || 'Hidden channels' : 'Hidden channels';
            if (!leftover.has(title)) leftover.set(title, []);
            leftover.get(title).push(row(channel, itemClass));
        }
        for (const [title, rows] of leftover) scroller.append(categoryBlock(title, rows, classes));
    }

    return {
        start() {
            api.onDom(apply);
            // Permissions and voice states change in the store without the list re-rendering.
            const timer = setInterval(apply, 3000);
            api.track(() => clearInterval(timer));
        },
        stop() {
            clear();
            lastKey = null;
            document.querySelectorAll('.osm-hc-dim').forEach((el) => el.classList.remove('osm-hc-dim'));
        },
        onSettings() {
            apply();
        },
        /** Says what Osmium actually sent, so an empty list can be told apart from a broken plugin. */
        renderInfo(el) {
            const cid = communityId();
            if (!cid) {
                el.append(h('div', { class: 'osm-setting-desc' }, 'Open a server to see how many of its channels are hidden from you.'));
                return;
            }
            const c = counts(cid);
            const name = api.client()?.communities?.communities?.get(BigInt(cid))?.name || 'This server';
            const found = c.hidden + c.voiceOnly;
            el.append(h('div', { class: 'osm-hc-info' },
                h('div', { class: 'osm-setting-label' }, name),
                h('div', { class: 'osm-setting-desc' }, !c.loaded
                    ? 'Osmium hasn’t loaded this server’s channels yet.'
                    : `Osmium was sent ${c.total} channel${c.total === 1 ? '' : 's'} here. ${c.hidden} of them ${c.hidden === 1 ? 'is' : 'are'} hidden from you`
                        + `${c.voiceOnly ? `, plus ${c.voiceOnly} active voice room${c.voiceOnly === 1 ? '' : 's'} in channels it wasn’t sent` : ''}.`),
                c.loaded && found === 0 && h('div', { class: 'osm-setting-desc' },
                    'Nothing to show: Osmium’s server only sent the channels you can view, so the rest aren’t on this computer. You also see every channel if you own the server or are an administrator.'),
            ));
        },
    };
});
