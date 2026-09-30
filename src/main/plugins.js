'use strict';

/**
 * Finds and runs plugins. A plugin is a folder in `src/plugins/`:
 *
 *   index.js      required. Exports the definition:
 *                   {
 *                     name, description,
 *                     enabledByDefault = true,
 *                     popout = false,       // also run the page part in pop-out chat windows
 *                     settings: { key: { type, default, label, description, options, hidden } },
 *                     main(ctx) {           // optional main-process part, called once at startup
 *                       return { start(), stop(), handlers: { name(event, ...args) } };
 *                     },
 *                   }
 *   renderer.js   optional page part; calls PlumoseCore.definePlugin(id, api => ({ start, stop }))
 *   style.css     optional; applied only while the plugin is enabled
 *
 * Setting types: boolean, string, number, select (options: [[value, label], ...]).
 */

const fs = require('fs');
const path = require('path');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

function readOptional(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

class PluginManager {
    constructor({ store, emit, log }) {
        this.store = store;
        this.emit = emit; // (pluginId, event, payload) → every Osmium window
        this.log = log;
        this.plugins = new Map();
    }

    load() {
        const ids = fs
            .readdirSync(PLUGINS_DIR, { withFileTypes: true })
            .filter((d) => d.isDirectory() && fs.existsSync(path.join(PLUGINS_DIR, d.name, 'index.js')))
            .map((d) => d.name)
            .sort();

        for (const id of ids) {
            try {
                const def = require(path.join(PLUGINS_DIR, id, 'index.js'));
                const defaults = { enabled: def.enabledByDefault !== false };
                for (const [key, spec] of Object.entries(def.settings || {})) defaults[key] = spec.default;
                this.store.setDefaults(id, defaults);
                this.plugins.set(id, { id, def, instance: null, running: false });
            } catch (err) {
                this.log(`Plugin "${id}" failed to load:`, err);
            }
        }
    }

    ctx(id) {
        const store = this.store;
        return {
            id,
            log: (...args) => this.log(`[${id}]`, ...args),
            settings: () => store.plugin(id),
            setSettings: (patch) => this.setSettings(id, patch),
            emit: (event, payload) => this.emit(id, event, payload),
            readData: (name, fallback) => store.readData(id, name, fallback),
            writeData: (name, value) => store.writeData(id, name, value),
            readSecret: (name) => store.readSecret(id, name),
            writeSecret: (name, value) => store.writeSecret(id, name, value),
            // markPopout(webContents), isPopout(webContents), isTrustedFrame(frame)
            windows: this.windows,
        };
    }

    /** Called once the app is ready: builds main-process parts and starts enabled plugins. */
    init() {
        for (const p of this.plugins.values()) {
            if (typeof p.def.main === 'function') {
                try {
                    p.instance = p.def.main(this.ctx(p.id)) || {};
                } catch (err) {
                    this.log(`Plugin "${p.id}" main part failed:`, err);
                    p.instance = {};
                }
            }
            if (this.store.plugin(p.id).enabled) this.start(p.id);
        }
    }

    start(id) {
        const p = this.plugins.get(id);
        if (!p || p.running) return;
        p.running = true;
        try {
            p.instance?.start?.();
        } catch (err) {
            this.log(`Plugin "${id}" failed to start:`, err);
        }
    }

    stop(id) {
        const p = this.plugins.get(id);
        if (!p || !p.running) return;
        p.running = false;
        try {
            p.instance?.stop?.();
        } catch (err) {
            this.log(`Plugin "${id}" failed to stop:`, err);
        }
    }

    stopAll() {
        for (const id of this.plugins.keys()) this.stop(id);
    }

    setSettings(id, patch) {
        if (!this.plugins.has(id)) throw new Error(`Unknown plugin: ${id}`);
        const before = this.store.plugin(id);
        const settings = this.store.setPlugin(id, patch);
        const now = this.store.plugin(id);
        if (before.enabled !== now.enabled) now.enabled ? this.start(id) : this.stop(id);
        else if (this.plugins.get(id).running) this.plugins.get(id).instance?.onSettings?.(now, before);
        return settings;
    }

    async invoke(id, name, event, args) {
        const p = this.plugins.get(id);
        if (!p) throw new Error(`Unknown plugin: ${id}`);
        if (!p.running) throw new Error(`${p.def.name || id} is turned off`);
        const handler = p.instance?.handlers?.[name];
        if (typeof handler !== 'function') throw new Error(`${id} has no handler "${name}"`);
        return handler(event, ...args);
    }

    /** Data running plugins want to hand to a specific window's preload (merged). */
    preloadData(webContents) {
        const out = {};
        for (const p of this.plugins.values()) {
            if (!p.running || typeof p.instance?.preloadData !== 'function') continue;
            try {
                Object.assign(out, p.instance.preloadData(webContents) || {});
            } catch (err) {
                this.log(`Plugin "${p.id}" preloadData failed:`, err);
            }
        }
        return out;
    }

    /** Everything the page needs: metadata, code and styles for each plugin. */
    sources({ popout }) {
        const out = [];
        for (const p of this.plugins.values()) {
            if (popout && !p.def.popout) continue;
            const dir = path.join(PLUGINS_DIR, p.id);
            out.push({
                id: p.id,
                name: p.def.name || p.id,
                description: p.def.description || '',
                settings: p.def.settings || {},
                js: readOptional(path.join(dir, 'renderer.js')),
                css: readOptional(path.join(dir, 'style.css')),
            });
        }
        return out;
    }
}

module.exports = { PluginManager };
