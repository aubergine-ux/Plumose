#!/usr/bin/env node
'use strict';

/**
 * Installs the mod into the official Osmium desktop app the way Vencord installs
 * into Discord: the official `app.asar` is moved aside to `_app.asar`, and a
 * small loader folder at `resources/app/` runs the mod and then boots the
 * official code from `_app.asar`. The official archive itself is never edited.
 *
 *   node scripts/install.js install   [path/to/Osmium/resources]
 *   node scripts/install.js uninstall [path/to/Osmium/resources]
 *   node scripts/install.js status    [path/to/Osmium/resources]
 *   node scripts/install.js pacman-hook          (Arch: re-inject after upgrades)
 *
 * An Osmium update brings back a fresh `app.asar`, which Electron prefers over
 * `app/`, so Osmium starts stock again (it never breaks). Run `install` again to
 * re-inject; it treats the new `app.asar` as the official one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MOD_ENTRY = path.resolve(__dirname, '..', 'src', 'main', 'index.js');
const PKG = require('../package.json');
const MOD_NAME = `${PKG.displayName}V${PKG.version}`;
const MARKER = 'plumose-injector';
// Installs made before the rename, when the mod was called OsmiumInjectClient.
const LEGACY_MARKERS = ['osmium-inject-client'];

function candidates() {
    const home = os.homedir();
    switch (process.platform) {
        case 'linux':
            return [
                '/opt/osmium/resources',
                '/opt/Osmium/resources',
                '/usr/lib/osmium/resources',
                '/usr/share/osmium/resources',
                path.join(home, '.local/share/osmium/resources'),
                path.join(home, 'Applications/Osmium/resources'),
            ];
        case 'win32': {
            const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
            const out = [
                path.join(local, 'Programs', 'osmium', 'resources'),
                path.join(local, 'Programs', 'Osmium', 'resources'),
            ];
            // Squirrel-style installs keep one app-<version> folder per update.
            for (const base of [path.join(local, 'osmium'), path.join(local, 'Osmium')]) {
                try {
                    const versions = fs.readdirSync(base).filter((d) => d.startsWith('app-')).sort().reverse();
                    out.push(...versions.map((v) => path.join(base, v, 'resources')));
                } catch {}
            }
            return out;
        }
        case 'darwin':
            return [
                '/Applications/Osmium.app/Contents/Resources',
                path.join(home, 'Applications/Osmium.app/Contents/Resources'),
            ];
        default:
            return [];
    }
}

const hasArchive = (dir) => ['app.asar', '_app.asar'].some((f) => fs.existsSync(path.join(dir, f)));

function findResources(explicit) {
    if (explicit) {
        const dir = path.resolve(explicit);
        const resolved = hasArchive(path.join(dir, 'resources')) ? path.join(dir, 'resources') : dir;
        if (!hasArchive(resolved)) {
            fail(`No app.asar in ${resolved}. Point me at Osmium's install or resources folder.`);
        }
        return resolved;
    }
    const found = candidates().find(hasArchive);
    if (!found) {
        fail(
            "Couldn't find Osmium. Pass its resources folder, e.g.\n" +
                '  node scripts/install.js install /path/to/Osmium/resources',
        );
    }
    return found;
}

/** Reads one file from an asar archive without depending on the asar package. */
function readFromAsar(asarPath, innerPath) {
    const fd = fs.openSync(asarPath, 'r');
    try {
        const head = Buffer.alloc(16);
        fs.readSync(fd, head, 0, 16, 0);
        // Layout: [u32 4][u32 headerPickleSize][u32 payloadSize][u32 jsonLength][json...]
        const headerSize = head.readUInt32LE(4);
        const jsonLength = head.readUInt32LE(12);
        const json = Buffer.alloc(jsonLength);
        fs.readSync(fd, json, 0, jsonLength, 16);
        let node = JSON.parse(json.toString('utf8'));
        for (const part of innerPath.split('/')) node = node?.files?.[part];
        if (!node || node.offset == null) throw new Error(`${innerPath} not found in ${asarPath}`);
        const data = Buffer.alloc(node.size);
        fs.readSync(fd, data, 0, node.size, 8 + headerSize + Number(node.offset));
        return data.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

function loaderSource() {
    return `'use strict';
// Written by ${MOD_NAME} (${MARKER}). Delete this folder, or run
// \`npm run uninject\` in the mod's folder, to go back to stock Osmium.
const path = require('path');
const { app } = require('electron');

const MOD_ENTRY = ${JSON.stringify(MOD_ENTRY)};
const ASAR = path.join(__dirname, '..', '_app.asar');

try {
    require(MOD_ENTRY)();
} catch (err) {
    // A missing or broken mod must never stop Osmium from starting.
    console.error('[Plumose] Failed to load, starting stock Osmium:', err);
}

// Hand over to the official app exactly as Electron would have.
const pkg = require(path.join(ASAR, 'package.json'));
app.setAppPath?.(ASAR);
if (pkg.version) app.setVersion?.(pkg.version);
require(path.join(ASAR, pkg.main || 'index.js'));
`;
}

function loaderPackage(resources) {
    const official = JSON.parse(readFromAsar(path.join(resources, '_app.asar'), 'package.json'));
    // Electron derives the app name, profile folder and Linux WM class from
    // these fields, so they must match the official app's.
    const pick = ['name', 'productName', 'version', 'desktopName', 'description', 'author', 'license'];
    const pkg = { [MARKER]: true };
    for (const key of pick) if (official[key] != null) pkg[key] = official[key];
    pkg.main = 'index.js';
    return JSON.stringify(pkg, null, 2) + '\n';
}

/**
 * stock    no loader
 * modded   loader in place and the official archive moved aside
 * updated  loader in place, but an update restored app.asar, so Osmium runs stock
 * foreign  something else owns resources/app
 */
function state(resources) {
    const appDir = path.join(resources, 'app');
    if (!fs.existsSync(appDir)) return 'stock';
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
        if (!pkg[MARKER] && !LEGACY_MARKERS.some((m) => pkg[m])) return 'foreign';
    } catch {
        return 'foreign';
    }
    return fs.existsSync(path.join(resources, 'app.asar')) ? 'updated' : 'modded';
}

function fail(msg, code = 1) {
    console.error(`✗ ${msg}`);
    process.exit(code);
}

function withPermissions(resources, fn) {
    try {
        fn();
    } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            const hint =
                process.platform === 'win32'
                    ? 'Run the terminal as Administrator and try again.'
                    : `Try again with sudo:\n  sudo node ${path.relative(process.cwd(), __filename) || __filename} ${process.argv.slice(2).join(' ')}`;
            fail(`No write access to ${resources}.\n${hint}`);
        }
        throw err;
    }
}

function install(resources) {
    const current = state(resources);
    if (current === 'foreign') {
        fail(`${path.join(resources, 'app')} exists and isn't ours (another mod?). Remove it first.`);
    }
    const asar = path.join(resources, 'app.asar');
    const moved = path.join(resources, '_app.asar');
    withPermissions(resources, () => {
        // A present app.asar is always the newest official build (first install,
        // or an update landed since), so it replaces whatever was moved aside before.
        if (fs.existsSync(asar)) fs.renameSync(asar, moved);
        if (!fs.existsSync(moved)) fail(`Neither app.asar nor _app.asar found in ${resources}.`);
        const appDir = path.join(resources, 'app');
        fs.mkdirSync(appDir, { recursive: true });
        fs.writeFileSync(path.join(appDir, 'package.json'), loaderPackage(resources));
        fs.writeFileSync(path.join(appDir, 'index.js'), loaderSource());
    });
    const verb = { stock: 'Installed', modded: 'Reinstalled', updated: 'Re-injected after an Osmium update' }[current];
    console.log(`✓ ${verb} ${MOD_NAME}: ${resources}`);
    console.log(`  Loader points at ${MOD_ENTRY}`);
    console.log('  Fully quit Osmium (including the tray icon) and start it again.');
}

function uninstall(resources) {
    const current = state(resources);
    if (current === 'foreign') fail(`${path.join(resources, 'app')} wasn't created by this mod. Leaving it alone.`);
    const asar = path.join(resources, 'app.asar');
    const moved = path.join(resources, '_app.asar');
    withPermissions(resources, () => {
        if (current !== 'stock') fs.rmSync(path.join(resources, 'app'), { recursive: true, force: true });
        if (fs.existsSync(moved)) {
            // After an update the moved-aside archive is stale; the new app.asar wins.
            if (fs.existsSync(asar)) fs.rmSync(moved);
            else fs.renameSync(moved, asar);
        }
    });
    console.log(`✓ Removed ${MOD_NAME}. Osmium is stock again (${resources}). Restart Osmium.`);
}

function status(resources) {
    const current = state(resources);
    const label = {
        stock: 'not installed',
        modded: 'installed',
        updated: 'installed, but an Osmium update disabled it. Run install again',
        foreign: 'another mod owns resources/app',
    }[current];
    console.log(`Osmium resources: ${resources}`);
    console.log(`State: ${label}`);
    if (current === 'modded' || current === 'updated') {
        const src = fs.readFileSync(path.join(resources, 'app', 'index.js'), 'utf8');
        const target = src.match(/const MOD_ENTRY = (".*?");/)?.[1];
        const entry = target ? JSON.parse(target) : null;
        console.log(`Loader target: ${entry}${entry && fs.existsSync(entry) ? '' : '  (missing! run install again)'}`);
    }
}

/** Arch Linux: re-inject automatically whenever pacman upgrades Osmium. */
function pacmanHook() {
    if (process.platform !== 'linux' || !fs.existsSync('/etc/pacman.d')) fail('pacman not found.');
    const resources = findResources();
    const hookFile = '/etc/pacman.d/hooks/plumose-injector.hook';
    const legacyHook = '/etc/pacman.d/hooks/osmium-inject-client.hook';
    const hook = `# Written by Plumose-Injector. Delete this file to stop auto re-injecting.
[Trigger]
Operation = Install
Operation = Upgrade
Type = Path
Target = ${path.relative('/', path.join(resources, 'app.asar'))}

[Action]
Description = Re-injecting Plumose-Injector into Osmium...
When = PostTransaction
Exec = ${process.execPath} ${__filename} install ${resources}
`;
    withPermissions('/etc/pacman.d/hooks', () => {
        fs.mkdirSync(path.dirname(hookFile), { recursive: true });
        fs.writeFileSync(hookFile, hook);
        fs.rmSync(legacyHook, { force: true });
    });
    console.log(`✓ Wrote ${hookFile}. Osmium upgrades will now re-inject the mod automatically.`);
}

const [command = 'install', explicit] = process.argv.slice(2);
const actions = { install, uninstall, status };
if (command === 'pacman-hook') pacmanHook();
else if (!actions[command]) fail(`Unknown command "${command}". Use install, uninstall, status or pacman-hook.`);
else actions[command](findResources(explicit));
