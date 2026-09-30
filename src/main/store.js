'use strict';

/**
 * Settings and plugin data, kept in the Osmium profile under `Plumose/` so
 * they follow the app's own user data and never touch Osmium's settings file.
 *
 * settings.json: { plugins: { <pluginId>: { enabled, ...pluginSettings } } }
 * data/<pluginId>/<name>.json: free-form per-plugin data (logs, window bounds, ...)
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
    if (!isObject(over)) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = isObject(base[k]) && isObject(v) ? merge(base[k], v) : v;
    return out;
}

function writeAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
}

class Store {
    constructor() {
        this.dir = path.join(app.getPath('userData'), 'Plumose');
        // Carried over from before the rename (the mod was called OsmiumInjectClient).
        const legacy = path.join(app.getPath('userData'), 'OsmiumMod');
        if (!fs.existsSync(this.dir) && fs.existsSync(legacy)) {
            try {
                fs.renameSync(legacy, this.dir);
            } catch {}
        }
        this.settingsFile = path.join(this.dir, 'settings.json');
        fs.mkdirSync(this.dir, { recursive: true });
        this.defaults = { plugins: {} };
        this.saved = this.migrate(this.readJson(this.settingsFile) || {});
        this.settings = merge(this.defaults, this.saved);
    }

    /** v1.0 kept Spotify settings at the top level, before plugins existed. */
    migrate(raw) {
        if (isObject(raw.spotify)) {
            raw = { ...raw, plugins: { ...(raw.plugins || {}), spotify: { ...raw.spotify, ...(raw.plugins?.spotify || {}) } } };
            delete raw.spotify;
        }
        return raw;
    }

    readJson(file) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return null;
        }
    }

    /** Plugins register their defaults at load; saved values always win. */
    setDefaults(pluginId, defaults) {
        this.defaults.plugins[pluginId] = defaults;
        this.settings = merge(this.defaults, this.saved);
    }

    get() {
        return this.settings;
    }

    plugin(id) {
        return this.settings.plugins[id] || {};
    }

    setPlugin(id, patch) {
        this.saved = merge(this.saved, { plugins: { [id]: patch } });
        this.settings = merge(this.defaults, this.saved);
        writeAtomic(this.settingsFile, JSON.stringify(this.saved, null, 2));
        return this.settings;
    }

    dataFile(pluginId, name) {
        return path.join(this.dir, 'data', pluginId, `${name}.json`);
    }

    readData(pluginId, name, fallback = null) {
        const value = this.readJson(this.dataFile(pluginId, name));
        return value == null ? fallback : value;
    }

    writeData(pluginId, name, value) {
        writeAtomic(this.dataFile(pluginId, name), JSON.stringify(value));
    }

    /** Small secrets (OAuth tokens), encrypted with the OS keyring when available. */
    readSecret(pluginId, name) {
        try {
            const raw = fs.readFileSync(path.join(this.dir, 'data', pluginId, `${name}.bin`));
            return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8'));
        } catch {
            return null;
        }
    }

    writeSecret(pluginId, name, value) {
        const file = path.join(this.dir, 'data', pluginId, `${name}.bin`);
        if (value == null) return fs.rmSync(file, { force: true });
        const text = JSON.stringify(value);
        writeAtomic(file, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : text);
    }
}

module.exports = { Store };
