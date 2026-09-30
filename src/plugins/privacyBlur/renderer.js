/*
 * Privacy blur. The blurring is all in style.css; this file only decides
 * which classes sit on <html>: `osm-blur` while blurring is in effect, and one
 * `osm-blur-<part>` per part that's switched on.
 */
PlumoseCore.definePlugin('privacyBlur', (api) => {
    'use strict';

    const PARTS = ['messages', 'names', 'avatars', 'sidebar'];
    const root = document.documentElement;

    function sync() {
        const s = api.settings;
        const on = !!s.active && (!s.unfocusedOnly || !document.hasFocus());
        root.classList.toggle('osm-blur', on);
        for (const part of PARTS) root.classList.toggle(`osm-blur-${part}`, s[part] !== false);
        root.style.setProperty('--osm-blur', `${Math.min(20, Math.max(2, Number(s.strength) || 6))}px`);
    }

    function clear() {
        root.classList.remove('osm-blur', ...PARTS.map((p) => `osm-blur-${p}`));
        root.style.removeProperty('--osm-blur');
    }

    return {
        start() {
            sync();
            const onKey = (e) => {
                if (e.key?.toLowerCase() !== 'b' || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
                e.preventDefault();
                e.stopPropagation();
                api.setSettings({ active: !api.settings.active }).catch(() => {});
            };
            document.addEventListener('keydown', onKey, true);
            window.addEventListener('focus', sync);
            window.addEventListener('blur', sync);
            api.track(() => {
                document.removeEventListener('keydown', onKey, true);
                window.removeEventListener('focus', sync);
                window.removeEventListener('blur', sync);
            });
        },
        stop: clear,
        onSettings: sync,
    };
});
