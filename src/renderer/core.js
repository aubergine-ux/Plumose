/*
 * Page-side core of the mod. Runs in Osmium's page before the web app's own
 * scripts, and gives plugins a small API:
 *
 *   PlumoseCore.definePlugin('myPlugin', (api) => ({
 *       start() {},               // plugin switched on (also at page load)
 *       stop() {},                // plugin switched off; tracked subscriptions are cleaned up for you
 *       onSettings(next, prev) {},
 *       renderSettings(el) {},    // optional custom settings UI in the Mods screen
 *   }));
 *
 * api: id, settings, setSettings(patch), invoke(name, ...args), on(event, cb),
 *      onDom(cb), track(cleanup), client(), isPopout, log(...)
 * PlumoseCore also exposes h(), icons, modal(), waitFor() and find().
 */
(() => {
    'use strict';

    if (window.PlumoseCore || !window.Plumose) return;
    const Mod = window.Plumose;

    /* ------------------------------------------------------------- utils -- */

    function h(tag, props = {}, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (v == null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'html') el.innerHTML = v; // static markup (icons) only, never user data
            else if (k === 'style' && typeof v === 'object') for (const [prop, val] of Object.entries(v)) el.style.setProperty(prop.startsWith('--') ? prop : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), val);
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c);
        return el;
    }

    const stroke = (body, size = 18) =>
        `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

    // Lucide icons (ISC licence).
    const icons = {
        puzzle: stroke('<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>'),
        close: stroke('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
        chevron: stroke('<path d="m6 9 6 6 6-6"/>', 16),
        popout: stroke('<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/>'),
        pin: stroke('<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'),
        bell: stroke('<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>', 16),
        history: stroke('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
        search: stroke('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', 16),
        trash: stroke('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>', 16),
    };

    const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

    /** Osmium's CSS-module classes end in a per-build hash, so match on the stable prefix. */
    const find = (prefix, root = document) => root.querySelector(`[class*="${prefix}-"]`);

    /** Resolves once fn() returns something truthy. */
    function waitFor(fn, { timeout = 30000, interval = 250 } = {}) {
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const tick = () => {
                let value;
                try {
                    value = fn();
                } catch {}
                if (value) return resolve(value);
                if (Date.now() - started > timeout) return reject(new Error('Timed out'));
                setTimeout(tick, interval);
            };
            tick();
        });
    }

    /** Osmium's client state. The web app publishes it as window.Osmium(). */
    const client = () => {
        try {
            return typeof window.Osmium === 'function' ? window.Osmium() : null;
        } catch {
            return null;
        }
    };

    /* ------------------------------------------------ shared DOM watcher -- */

    // One MutationObserver for everyone, batched per frame. Osmium is a React app
    // and rebuilds parts of the page often, so plugins re-apply their changes here.
    const domListeners = new Set();
    let domQueued = false;
    const runDom = () => {
        domQueued = false;
        for (const cb of domListeners) {
            try {
                cb();
            } catch (err) {
                console.error('[Plumose] DOM listener failed', err);
            }
        }
    };
    const onDom = (cb) => {
        domListeners.add(cb);
        if (document.body) cb();
        return () => domListeners.delete(cb);
    };

    /* ------------------------------------------------------------- modal -- */

    const openModals = [];

    function modal({ title, subtitle, className = '', body, onClose, headerExtra }) {
        const close = () => {
            if (!overlay.isConnected) return;
            overlay.remove();
            openModals.splice(openModals.indexOf(api), 1);
            document.removeEventListener('keydown', onKey, true);
            onClose?.();
        };
        const onKey = (e) => {
            if (e.key === 'Escape' && openModals[openModals.length - 1] === api) {
                e.stopPropagation();
                e.preventDefault();
                close();
            }
        };
        const content = h('div', { class: 'osm-modal-body' });
        const panel = h('div', { class: `osm-modal ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
            h('div', { class: 'osm-modal-head' },
                h('div', { class: 'osm-modal-titles' },
                    h('div', { class: 'osm-modal-title' }, title),
                    subtitle && h('div', { class: 'osm-modal-subtitle' }, subtitle),
                ),
                headerExtra,
                h('button', { class: 'osm-icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close', html: icons.close, onclick: close }),
            ),
            content,
        );
        const overlay = h('div', { class: 'osm-overlay', onpointerdown: (e) => e.target === overlay && close() }, panel);
        const api = { close, content, panel };
        if (body) content.append(body);
        document.body.append(overlay);
        document.addEventListener('keydown', onKey, true);
        openModals.push(api);
        return api;
    }

    /* ----------------------------------------------------------- plugins -- */

    let settings = Mod.initialSettings;
    const meta = new Map(Mod.plugins.map((p) => [p.id, p]));
    const registry = new Map(); // id → { api, instance, running, cleanups }
    let pageReady = false;

    const pluginSettings = (id) => settings?.plugins?.[id] || {};
    const styleFor = (id) => document.querySelector(`style[data-plumose="${CSS.escape(id)}"]`);

    function startPlugin(id) {
        const p = registry.get(id);
        if (!p || p.running || !pluginSettings(id).enabled) return;
        p.running = true;
        const style = styleFor(id);
        if (style) style.disabled = false;
        try {
            p.instance.start?.();
        } catch (err) {
            console.error(`[Plumose] ${id} failed to start`, err);
        }
    }

    function stopPlugin(id) {
        const p = registry.get(id);
        if (!p || !p.running) return;
        p.running = false;
        try {
            p.instance.stop?.();
        } catch (err) {
            console.error(`[Plumose] ${id} failed to stop`, err);
        }
        for (const fn of p.cleanups.splice(0)) {
            try {
                fn();
            } catch {}
        }
        const style = styleFor(id);
        if (style) style.disabled = true;
    }

    function definePlugin(id, factory) {
        if (registry.has(id)) return;
        const entry = { running: false, cleanups: [], instance: {} };
        const track = (fn) => {
            if (entry.running) entry.cleanups.push(fn);
            return fn;
        };
        entry.api = {
            id,
            isPopout: Mod.popout,
            platform: Mod.platform,
            get settings() {
                return pluginSettings(id);
            },
            async setSettings(patch) {
                settings = await Mod.setSettings(id, patch);
                return pluginSettings(id);
            },
            invoke: (name, ...args) => Mod.invoke(id, name, ...args),
            on: (event, cb) => track(Mod.onEvent((pid, ev, payload) => pid === id && ev === event && cb(payload))),
            onDom: (cb) => track(onDom(cb)),
            track,
            client,
            log: (...args) => console.log(`[Plumose:${id}]`, ...args),
        };
        registry.set(id, entry);
        try {
            entry.instance = factory(entry.api) || {};
        } catch (err) {
            console.error(`[Plumose] ${id} failed to initialise`, err);
            return;
        }
        if (pageReady) startPlugin(id);
    }

    Mod.onSettings((next) => {
        const prev = settings;
        settings = next;
        for (const [id, p] of registry) {
            const was = prev?.plugins?.[id] || {};
            const now = pluginSettings(id);
            if (was.enabled && !now.enabled) stopPlugin(id);
            else if (!was.enabled && now.enabled) startPlugin(id);
            else if (p.running) p.instance.onSettings?.(now, was);
        }
        refreshModsModal();
    });

    /* --------------------------------------------------------- Mods UI -- */

    let modsModal = null;

    function settingControl(pluginId, key, spec, value) {
        const save = (v) => Mod.setSettings(pluginId, { [key]: v }).then((s) => (settings = s)).catch((e) => alert(cleanError(e)));
        let control;
        switch (spec.type) {
            case 'boolean':
                control = h('input', { type: 'checkbox', class: 'osm-switch', checked: !!value, onchange: (e) => save(e.target.checked) });
                break;
            case 'select':
                control = h('select', { class: 'osm-select', onchange: (e) => save(e.target.value) },
                    spec.options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
                break;
            case 'number':
                control = h('input', {
                    type: 'number', class: 'osm-input osm-input-number', value: String(value ?? ''),
                    min: spec.min, max: spec.max, step: spec.step,
                    onchange: (e) => save(Number(e.target.value)),
                });
                break;
            default:
                control = h('input', { type: 'text', class: 'osm-input', value: value ?? '', placeholder: spec.placeholder || '', spellcheck: 'false', onchange: (e) => save(e.target.value) });
        }
        const inline = spec.type === 'boolean' || spec.type === 'number';
        return h('label', { class: `osm-setting ${inline ? 'is-inline' : ''}` },
            h('div', { class: 'osm-setting-text' },
                h('div', { class: 'osm-setting-label' }, spec.label || key),
                spec.description && h('div', { class: 'osm-setting-desc' }, spec.description),
            ),
            control,
        );
    }

    function pluginCard(p) {
        const s = pluginSettings(p.id);
        const entry = registry.get(p.id);
        const hasSchema = Object.values(p.settings).some((spec) => !spec.hidden);
        const hasSettings = hasSchema || typeof entry?.instance?.renderSettings === 'function';

        const body = h('div', { class: 'osm-plugin-settings' });
        if (typeof entry?.instance?.renderSettings === 'function') {
            entry.instance.renderSettings(body);
        } else {
            for (const [key, spec] of Object.entries(p.settings)) {
                if (!spec.hidden) body.append(settingControl(p.id, key, spec, s[key]));
            }
        }

        const card = h('div', { class: `osm-plugin ${s.enabled ? 'is-enabled' : ''}`, 'data-plugin': p.id });
        const expand = hasSettings && h('button', {
            type: 'button', class: 'osm-icon-btn osm-plugin-expand', 'aria-label': 'Settings', title: 'Settings', html: icons.chevron,
            'aria-expanded': 'false',
            onclick: () => {
                const open = card.classList.toggle('is-open');
                expand.setAttribute('aria-expanded', String(open));
            },
        });
        card.append(
            h('div', { class: 'osm-plugin-head' },
                h('div', { class: 'osm-plugin-text' },
                    h('div', { class: 'osm-plugin-name' }, p.name),
                    h('div', { class: 'osm-plugin-desc' }, p.description),
                ),
                expand,
                h('input', {
                    type: 'checkbox', class: 'osm-switch', checked: !!s.enabled, 'aria-label': `Enable ${p.name}`,
                    onchange: (e) => Mod.setSettings(p.id, { enabled: e.target.checked }).then((next) => (settings = next)),
                }),
            ),
            hasSettings && body,
        );
        return card;
    }

    function renderMods() {
        const openIds = new Set([...(modsModal?.content.querySelectorAll('.osm-plugin.is-open') || [])].map((el) => el.dataset.plugin));
        const list = h('div', { class: 'osm-plugin-list' }, [...meta.values()].map(pluginCard));
        for (const id of openIds) list.querySelector(`[data-plugin="${CSS.escape(id)}"]`)?.classList.add('is-open');
        modsModal.content.replaceChildren(list);
    }

    function refreshModsModal() {
        // Don't rebuild while someone is typing into a field in it.
        if (!modsModal || modsModal.content.contains(document.activeElement) && document.activeElement.matches('input[type=text], input[type=number], textarea')) return;
        renderMods();
    }

    function openMods() {
        if (modsModal) return modsModal.close();
        modsModal = modal({
            title: 'Plumose',
            subtitle: `${Mod.name} · changes apply instantly`,
            className: 'osm-mods',
            onClose: () => (modsModal = null),
        });
        renderMods();
    }

    /** A "Mods" button on the account card, styled by borrowing Osmium's own button class. */
    function mountModsButton() {
        if (Mod.popout) return;
        const buttons = document.querySelector('[class*="userInfoContainer-"] [class*="userButtons-"]');
        if (!buttons || buttons.querySelector('.osm-mods-btn')) return;
        const native = [...buttons.children].find((el) => el.tagName === 'BUTTON' && !el.classList.contains('osm-card-btn'));
        const nativeClass = (native?.className || '').split(/\s+/).filter((c) => !/^disabled-/.test(c)).join(' ');
        const btn = h('button', {
            type: 'button', class: `${nativeClass} osm-card-btn osm-mods-btn`, 'aria-label': 'Plumose mods', title: 'Plumose mods',
            html: `<div class="osm-card-btn-inner">${icons.puzzle}</div>`,
            onclick: openMods,
        });
        buttons.append(btn);
    }

    /* ------------------------------------------------------------ export -- */

    Object.defineProperty(window, 'PlumoseCore', {
        value: Object.freeze({
            version: Mod.version,
            name: Mod.name,
            isPopout: Mod.popout,
            definePlugin,
            h,
            icons,
            modal,
            waitFor,
            find,
            client,
            cleanError,
            openMods,
            /** For debugging from DevTools: which plugins are loaded and running. */
            status: () => [...registry].map(([id, p]) => ({ id, running: p.running, enabled: !!pluginSettings(id).enabled, listeners: p.cleanups.length })),
            /** Adds a button to the account card, next to mute/deafen. Returns a remover. */
            cardButton({ id, label, icon, onclick }) {
                const mount = () => {
                    const buttons = document.querySelector('[class*="userInfoContainer-"] [class*="userButtons-"]');
                    if (!buttons || buttons.querySelector(`[data-osm-card="${id}"]`)) return;
                    const mods = buttons.querySelector('.osm-mods-btn');
                    const native = [...buttons.children].find((el) => el.tagName === 'BUTTON' && !el.classList.contains('osm-card-btn'));
                    const nativeClass = (native?.className || '').split(/\s+/).filter((c) => !/^disabled-/.test(c)).join(' ');
                    const btn = h('button', {
                        type: 'button', class: `${nativeClass} osm-card-btn`, 'data-osm-card': id, 'aria-label': label, title: label,
                        html: `<div class="osm-card-btn-inner">${icon}</div>`, onclick,
                    });
                    buttons.insertBefore(btn, mods || null);
                };
                const off = onDom(mount);
                return () => {
                    off();
                    document.querySelectorAll(`[data-osm-card="${CSS.escape(id)}"]`).forEach((el) => el.remove());
                };
            },
        }),
        enumerable: false,
    });

    function boot() {
        document.documentElement.classList.toggle('osm-popout', !!Mod.popout);
        new MutationObserver(() => {
            if (domQueued) return;
            domQueued = true;
            requestAnimationFrame(runDom);
        }).observe(document.body, { childList: true, subtree: true });
        onDom(mountModsButton);
        pageReady = true;
        for (const id of registry.keys()) startPlugin(id);
        console.log(`[Plumose] ${Mod.name} ready${Mod.popout ? ' (pop-out window)' : ''}: ${[...registry.keys()].join(', ')}`);
    }

    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
