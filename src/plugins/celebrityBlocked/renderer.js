/*
 * Celebrity blocked. Osmium keeps every known user in a MobX store
 * (window.Osmium().users.users) and relationships in a second map of
 * id → RelationshipStatus, where BLOCKED is 4. The UI shows a member's
 * nickname, then user.name, then user.username, so swapping `name` on the
 * blocked user's object renames them everywhere the app draws it. The real
 * values are kept and put back on unblock or when the plugin is switched off.
 *
 * Only the local, in-memory copy changes. `username` is left alone so mentions
 * and search still resolve to the real account, and server nicknames win over
 * `name`, so a blocked user with a community nickname keeps it there.
 */
PlumoseCore.definePlugin('celebrityBlocked', (api) => {
    'use strict';

    const { waitFor } = PlumoseCore;
    const BLOCKED = 4; // RelationshipStatus.BLOCKED

    let client = null;
    let watchedUsers = null; // { map, off }
    let watchedRels = null;
    const disguised = new Map(); // user object → { name, photo, off }
    let writing = false;

    const isMapLike = (m) => m && typeof m.get === 'function' && typeof m.values === 'function';
    const mobx = (obj) => {
        if (!obj) return null;
        const sym = Object.getOwnPropertySymbols(obj).find((s) => s.description === 'mobx administration');
        return sym ? obj[sym] : null;
    };
    const observe = (target, cb) => {
        const adm = typeof target?.observe_ === 'function' ? target : mobx(target);
        return typeof adm?.observe_ === 'function' ? adm.observe_(cb) : null;
    };

    const celebrities = () => {
        const list = String(api.settings.names || '').split(',').map((s) => s.trim()).filter(Boolean);
        return list.length ? list : ['Donald Trump'];
    };

    /** The same account always gets the same celebrity, as long as the list doesn't change. */
    function celebrityFor(id) {
        const list = celebrities();
        let hash = 7;
        for (const c of String(id)) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
        return list[hash % list.length];
    }

    const isBlocked = (id) => {
        try {
            return client?.users?.relationships?.get(BigInt(id)) === BLOCKED;
        } catch {
            return false;
        }
    };

    /** Writes our values without our own watcher mistaking them for server updates. */
    function write(user, fields) {
        writing = true;
        try {
            for (const [k, v] of Object.entries(fields)) if (user[k] !== v) user[k] = v;
        } catch (err) {
            console.error('[Plumose:celebrityBlocked] write failed', err);
        } finally {
            writing = false;
        }
    }

    function apply(user) {
        const fake = { name: celebrityFor(user.id) };
        if (api.settings.hideAvatars) fake.photo = null;
        write(user, fake);
    }

    function disguise(user) {
        if (!user || typeof user !== 'object') return;
        if (!disguised.has(user)) {
            const entry = { name: user.name, photo: user.photo, off: null };
            // A profile update from the server overwrites our values; remember the real one and re-apply.
            entry.off = observe(user, (change) => {
                if (writing || (change.name !== 'name' && change.name !== 'photo')) return;
                entry[change.name] = change.newValue;
                queueMicrotask(() => disguised.has(user) && apply(user));
            });
            disguised.set(user, entry);
        }
        apply(user);
    }

    function reveal(user) {
        const entry = disguised.get(user);
        if (!entry) return;
        entry.off?.();
        disguised.delete(user);
        write(user, { name: entry.name, photo: entry.photo });
    }

    const revealAll = () => [...disguised.keys()].forEach(reveal);

    function userById(id) {
        try {
            return client?.users?.users?.get(typeof id === 'bigint' ? id : BigInt(id)) || null;
        } catch {
            return null;
        }
    }

    function sync() {
        const users = client?.users?.users;
        const rels = client?.users?.relationships;
        if (!isMapLike(users) || !isMapLike(rels)) return;
        for (const [id, status] of rels.entries()) if (status === BLOCKED) disguise(userById(id));
        for (const user of [...disguised.keys()]) if (!isBlocked(user.id) || users.get(user.id) !== user) reveal(user);
    }

    /** (Re)attaches to the current store. The web app can swap stores on reconnect, so this also runs periodically. */
    function attach() {
        client = api.client();
        const users = client?.users?.users;
        const rels = client?.users?.relationships;
        if (!isMapLike(users) || !isMapLike(rels)) return false;

        if (watchedUsers?.map !== users) {
            watchedUsers?.off?.();
            // Blocked accounts are often loaded lazily, after the relationship list.
            const off = observe(users, (change) => {
                if (change.type !== 'delete' && isBlocked(change.name)) disguise(change.newValue);
            });
            watchedUsers = { map: users, off };
        }
        if (watchedRels?.map !== rels) {
            watchedRels?.off?.();
            const off = observe(rels, (change) => {
                const user = userById(change.name);
                if (!user) return;
                if (change.type !== 'delete' && change.newValue === BLOCKED) disguise(user);
                else reveal(user);
            });
            watchedRels = { map: rels, off };
        }
        sync();
        return true;
    }

    return {
        start() {
            waitFor(attach, { timeout: 120000, interval: 500 }).then(() => {
                const timer = setInterval(attach, 5000);
                api.track(() => clearInterval(timer));
            }).catch(() => console.warn('[Plumose:celebrityBlocked] Osmium’s user store never showed up'));
        },

        stop() {
            watchedUsers?.off?.();
            watchedRels?.off?.();
            watchedUsers = watchedRels = null;
            revealAll();
        },

        onSettings() {
            // Put real avatars back first in case "Hide avatars" was just turned off.
            for (const [user, entry] of disguised) write(user, { photo: entry.photo });
            for (const user of disguised.keys()) apply(user);
        },
    };
});
