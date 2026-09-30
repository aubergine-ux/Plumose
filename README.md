# Plumose-Injector

A Vencord-style client mod for the **official Osmium desktop app**, with a plugin system and four
plugins:

| Plugin | What it does |
| --- | --- |
| **Spotify Controls** | Now playing, seek, skip and volume, docked above your account card. |
| **Pop-out Chat** | Opens any chat in its own window, with an always-on-top pin. |
| **Friend Presence Log** | Records friends coming online, going idle or offline, what they play or listen to, and status changes. Includes a "last seen" list. |
| **Server Folders** | Groups servers in the left rail into collapsible, coloured folders. |

It changes nothing inside Osmium's code. Like Vencord on Discord, it moves the official `app.asar`
aside and puts a small loader in its place. The loader starts the mod and then boots the untouched
official app.

The mod calls itself **Plumose-Injector V&lt;version&gt;** (for example `Plumose-InjectorV1.1.0`).
The version comes from `package.json`.

## Install

Needs Node 18+. Osmium lives in a root-owned folder, so on Linux use sudo:

```sh
sudo node scripts/install.js install      # finds /opt/osmium automatically
```

Then fully quit Osmium (including the tray icon) and start it again. A puzzle-piece button on your
account card opens the **Plumose** screen, where you turn plugins on and off and change their
settings. Changes apply instantly, with no restart.

Other commands:

```sh
node scripts/install.js status
sudo node scripts/install.js uninstall   # back to stock
sudo node scripts/install.js install /path/to/Osmium/resources   # non-standard install
```

The loader points at this folder, so **re-run `install` if you move or rename it**. If the folder goes
missing, Osmium still starts, just without the mod. Installs made under the old name
(OsmiumInjectClient) are recognised and upgraded in place, and their settings carry over.

### After Osmium updates

An update brings back a fresh `app.asar`, and Osmium starts stock again. It never breaks. Run
`install` again to re-inject. On Arch you can make that automatic:

```sh
sudo node scripts/install.js pacman-hook
```

That writes `/etc/pacman.d/hooks/plumose-injector.hook`, which re-injects after every `osmium`
upgrade. Delete the file to turn it off.

## Plugins

### Spotify Controls

Album art, title and artist (click either to open the track in Spotify), a seek bar, previous,
play/pause, next, and volume (scroll over it to nudge). The panel hides itself when nothing is
playing and uses Osmium's theme colours.

Hover the panel and click its sliders icon, or open it in the Plumose screen, to pick a source:

- **This computer:** the Spotify desktop app over MPRIS/D-Bus. No sign-in, no Premium. Linux only, and the default there. *Any media player* also follows browsers, mpv, etc.
- **Spotify account:** the Spotify Web API. Controls whichever device is active on your account and adds shuffle and repeat. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), add `http://127.0.0.1:8888/callback` as a redirect URI, paste its Client ID and click **Connect Spotify**. Sign-in uses PKCE, so no client secret is stored. The token is encrypted with your OS keyring. Playback control needs Premium.

Placement (docked or a draggable floating card), compact mode, and show-when-idle are in the same place.

### Pop-out Chat

- The pop-out button in a chat's header opens that chat in its own window. **Shift+click** or **middle-click** a chat in the sidebar does the same.
- In a pop-out, the pin button keeps it on top of other windows, and the dock button sends you back to the main window on that chat.
- Window size and position are remembered.

A pop-out runs a second copy of Osmium's web app in its own window. It signs in with the same desktop
identity as the main window. It deliberately does *not* take over things that belong to the main
window: now-playing and game detection, global keybinds (push-to-talk), the unread badge, deep links
and message notifications. Those all stay with the main window.

### Friend Presence Log

Open it from the clock button on your account card.

- **Activity:** a day-by-day feed. For example: *came online*, *went idle*, *is back*, *went offline*, *started playing X*, *is now listening to Song on Spotify*, *set their status to "brb"*, *is now your friend*. Filter it by name or type.
- **Friends:** everyone with their current status and activity, or when they were last seen.
- Click a name to open your DM. Click the bell on a row to get a desktop notification when that friend comes online.

Settings let you skip idle/back entries or activities, include everyone you share a server with
(not just friends), and choose how many entries to keep (5000 by default). The log is stored locally
in your Osmium profile. The first 15 seconds after startup aren't logged, because Osmium syncs
everyone's status at once then.

### Server Folders

- The folder button at the bottom of the server rail creates a folder: pick a name, a colour and its servers.
- Drag a server onto a folder to add it.
- Click a folder to open or close it. A closed folder shows its first four server icons, plus an unread dot or a mention dot.
- Right-click a folder to open or close it, edit it, recolour it or delete it. Deleting a folder puts its servers back in the rail.

A folder sits where its first server was in your server order. Osmium's own drag-to-reorder still
works for servers outside folders.

## Writing a plugin

A plugin is a folder in `src/plugins/`:

```
src/plugins/myPlugin/
    index.js      required: name, description, settings schema, optional main-process part
    renderer.js   optional: runs in Osmium's page
    style.css     optional: applied only while the plugin is on
```

```js
// index.js
module.exports = {
    name: 'My Plugin',
    description: 'Shown in the Plumose screen.',
    popout: false,              // also run the page part in pop-out chat windows?
    settings: {
        greeting: { type: 'string', default: 'hi', label: 'Greeting' },
        loud: { type: 'boolean', default: false, label: 'Shout it' },
        // also: number (min/max/step), select (options: [[value, label]]), hidden: true
    },
    main(ctx) {                 // optional, runs once in the main process
        return {
            start() {}, stop() {}, onSettings(next, prev) {},
            handlers: { hello: (event, name) => `${ctx.settings().greeting}, ${name}` },
        };
    },
};
```

```js
// renderer.js
PlumoseCore.definePlugin('myPlugin', (api) => ({
    start() {
        api.onDom(() => { /* re-apply your DOM changes whenever the page re-renders */ });
        api.invoke('hello', 'Osmium').then(console.log);
    },
    stop() {}, // listeners registered through api.on / api.onDom / api.track are removed for you
}));
```

The page API also gives you `api.settings`, `api.setSettings(patch)`, `api.on(event, cb)` for
events sent with `ctx.emit()`, and `api.client()`, which returns Osmium's own MobX store
(`window.Osmium()`). `PlumoseCore` itself provides `h()`, `icons`, `modal()`, `cardButton()` and
`status()`. In the main process, `ctx` provides `readData`/`writeData` for JSON files and
`readSecret`/`writeSecret` for keyring-encrypted values.

## How it works

```
scripts/install.js        moves app.asar → _app.asar, writes resources/app/{index.js,package.json}
src/main/index.js         main-process core: IPC, session preload, plugin manager
src/main/plugins.js       loads src/plugins/*, starts/stops them, routes handler calls
src/main/store.js         settings + plugin data in <Osmium profile>/Plumose/
src/preload.js            sandboxed preload: window.Plumose bridge, injects core + plugins
src/renderer/core.*       page core: plugin registry, shared DOM watcher, Plumose screen, modals
src/plugins/*             the plugins
```

- In Osmium's Electron build, `app.asar` takes priority over an `app/` folder. That's why the installer moves the original aside rather than just adding a folder.
- The mod's preload is added with `session.registerPreloadScript`, so it runs **alongside** Osmium's own preload. `contextIsolation` and the sandbox stay on. Only top-level `*.osmium.chat` frames get the bridge, and the main process rejects IPC from anywhere else.
- Osmium's CSS-module class names carry a hash that changes every build (`userInfoContainer-m5w2Fz`), so everything is found by class prefix (`[class*="userInfoContainer-"]`). One shared MutationObserver lets plugins re-apply their changes whenever React re-renders.
- Osmium's state lives in MobX stores. The presence log subscribes to MobX's own change events on user objects, rather than decoding network traffic or patching minified functions.
- Osmium's session token is tied to the desktop client's identity (`OsmiumNative.clientInfo`). Pop-outs therefore get a stand-in `OsmiumNative` carrying the same identity, with the main-window-only features stubbed out.

### Known limitations

- **Shuffle/repeat on the "This computer" Spotify source:** Spotify's Linux app reports both over MPRIS but ignores changes, so the buttons are hidden there.
- **Spotify Web API source:** not yet tested against a live Spotify developer app.
- **Windows and macOS:** the install paths are best guesses and untested. On macOS, editing the app bundle may trip Gatekeeper. On Windows, the Osmium installer replaces the whole folder on update, so run `install` again afterwards.
- **Folders:** stored locally, so they don't sync to Osmium on other devices.

### Development

Edits to `src/renderer/*` and `src/plugins/*/renderer.js|style.css` apply when the page reloads.
Edits to main-process files need an Osmium restart. To try changes without touching your real
session, run a second, isolated profile (with the mod installed):

```sh
OSMIUM_MOD_USER_DATA=/tmp/osmium-dev /opt/osmium/osmium --remote-debugging-port=9333
```

Then attach Chrome DevTools at `chrome://inspect` (port 9333). Logs are prefixed `[Plumose]`, and
`PlumoseCore.status()` lists the plugins and whether they're running.
