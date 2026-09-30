/*
 * Custom CSS. One <style> element at the end of <head>, so its rules win over
 * Osmium's and over other plugins' at equal specificity. The editor applies
 * what you type straight away and saves when you stop typing.
 */
PlumoseCore.definePlugin('customCss', (api) => {
    'use strict';

    const { h, cleanError } = PlumoseCore;
    const SAVE_DELAY = 600;
    const EXAMPLE = '/* Osmium’s class names end in a hash that changes every build,\n   so match on the part before it: */\n[class*="channelListItem-"] { border-radius: 4px; }';

    let style = null;
    let saveTimer = null;

    function apply(css) {
        if (!style || !style.isConnected) {
            style = h('style', { 'data-plumose-custom-css': '' });
            document.head.append(style);
        }
        if (style.textContent !== css) style.textContent = css;
    }

    return {
        start() {
            apply(String(api.settings.css || ''));
        },
        stop() {
            clearTimeout(saveTimer);
            style?.remove();
            style = null;
        },
        onSettings(next) {
            apply(String(next.css || ''));
        },
        renderSettings(el) {
            const status = h('div', { class: 'osm-setting-desc' }, 'Applies as you type.');
            const area = h('textarea', {
                class: 'osm-input', spellcheck: 'false', rows: '12', placeholder: EXAMPLE, 'aria-label': 'Custom CSS',
                oninput: () => {
                    // Only the running plugin has a style element; the text is still saved either way.
                    if (api.settings.enabled) apply(area.value);
                    status.textContent = 'Saving…';
                    clearTimeout(saveTimer);
                    saveTimer = setTimeout(() => {
                        api.setSettings({ css: area.value })
                            .then(() => (status.textContent = 'Saved.'))
                            .catch((e) => (status.textContent = cleanError(e)));
                    }, SAVE_DELAY);
                },
                onkeydown: (e) => {
                    if (e.key !== 'Tab' || e.shiftKey) return;
                    e.preventDefault();
                    area.setRangeText('    ', area.selectionStart, area.selectionEnd, 'end');
                    area.dispatchEvent(new Event('input'));
                },
            });
            area.value = String(api.settings.css || '');
            el.append(area, status);
        },
    };
});
