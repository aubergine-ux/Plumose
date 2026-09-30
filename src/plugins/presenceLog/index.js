'use strict';

const { Notification } = require('electron');

module.exports = {
    name: 'Friend Presence Log',
    description: 'Logs when friends come online, go idle or offline, start playing or listening to something, or change their status. Open it from the clock button on your account card.',
    settings: {
        logIdle: { type: 'boolean', default: true, label: 'Log idle / back', description: 'Also record friends going idle and coming back.' },
        logActivities: { type: 'boolean', default: true, label: 'Log activities', description: 'Playing, listening, watching and custom statuses.' },
        everyone: { type: 'boolean', default: false, label: 'Log everyone', description: 'Include people you share a community or group with, not just friends.' },
        notify: { type: 'boolean', default: true, label: 'Notify for watched friends', description: 'A desktop notification when a friend you’ve marked with the bell comes online.' },
        maxEntries: { type: 'number', default: 5000, min: 100, max: 100000, step: 100, label: 'Keep up to', description: 'Older entries are dropped.' },
        watched: { type: 'json', default: [], hidden: true },
    },

    main(ctx) {
        let log = ctx.readData('log', []);
        let saveTimer = null;

        const save = () => {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => ctx.writeData('log', log), 1000);
        };
        const trim = () => {
            const max = Math.max(100, Number(ctx.settings().maxEntries) || 5000);
            if (log.length > max) log = log.slice(log.length - max);
        };

        return {
            stop() {
                if (saveTimer) {
                    clearTimeout(saveTimer);
                    ctx.writeData('log', log);
                }
            },
            onSettings() {
                trim();
                save();
            },
            handlers: {
                list: () => log,
                append(_e, entries) {
                    if (!Array.isArray(entries) || entries.length === 0) return;
                    const clean = entries
                        .filter((e) => e && typeof e.kind === 'string' && typeof e.id === 'string')
                        .map((e) => ({
                            t: Number(e.t) || Date.now(),
                            id: e.id,
                            name: String(e.name || '').slice(0, 100),
                            username: e.username ? String(e.username).slice(0, 64) : undefined,
                            kind: e.kind,
                            detail: e.detail,
                        }));
                    log.push(...clean);
                    trim();
                    save();
                    ctx.emit('appended', clean);
                },
                clear() {
                    log = [];
                    ctx.writeData('log', log);
                    ctx.emit('cleared');
                },
                notify(_e, { title, body }) {
                    if (!Notification.isSupported()) return;
                    new Notification({ title: String(title).slice(0, 120), body: String(body || '').slice(0, 240), silent: false }).show();
                },
            },
        };
    },
};
