/*
 * Avatar viewer. Osmium downloads a profile picture or server icon once, at
 * full size, and shows that same image everywhere, scaled down:
 *   <div class="avatar-…">            (or communityAvatar-…)
 *     <svg role="img" aria-label="Name's avatar">
 *       <foreignObject filter="url(#avatarBlur)"?>   ← blurred while only the tiny preview has loaded
 *         <img src="blob:…">
 * Its own "open avatar" on a profile card just shows that blob larger. This
 * plugin does the same for any avatar or server icon on the page, so nothing
 * extra is downloaded.
 */
PlumoseCore.definePlugin('avatarViewer', (api) => {
    'use strict';

    const { h, modal, cleanError } = PlumoseCore;
    // Avatars, server icons in the rail, and anything else Osmium names "…Avatar-…".
    const HOLDER = '[class*="avatar-"], [class*="Avatar-"], [class*="communityListScroller-"] > a';
    const ICON_IMAGE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';

    let view = null;

    const isPreview = (img) => /avatarBlur/.test(img?.closest('foreignObject')?.getAttribute('filter') || '');
    const labelOf = (holder) => holder?.querySelector('svg[aria-label]')?.getAttribute('aria-label') || holder?.getAttribute('aria-label') || 'Avatar';
    const fileName = (label) => `${label.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-') || 'avatar'}.png`;

    /** The picture as a real PNG, whatever format the server stored it in. */
    async function toPng(img) {
        await img.decode?.();
        const canvas = h('canvas', { width: String(img.naturalWidth), height: String(img.naturalHeight) });
        canvas.getContext('2d').drawImage(img, 0, 0);
        return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t read the image'))), 'image/png'));
    }

    /** @param holder the element on the page holding the avatar's <img> */
    function open(holder) {
        const source = holder?.querySelector('img');
        if (!source?.src) return false;
        view?.close();

        const label = labelOf(holder);
        const img = h('img', { class: 'osm-av-img', src: source.src, alt: label, draggable: 'false' });
        const status = h('span', { class: 'osm-av-status' });
        const say = (text) => (status.textContent = text);
        img.addEventListener('load', () => !isPreview(holder.querySelector('img')) && say(`${img.naturalWidth} × ${img.naturalHeight}`));

        // If only the blurred preview had loaded, swap in the real picture when the app gets it.
        let waited = 0;
        const timer = setInterval(() => {
            const now = holder.isConnected ? holder.querySelector('img') : null;
            if (now?.src && now.src !== img.src) img.src = now.src;
            if (!now || !isPreview(now) || (waited += 300) > 10000) clearInterval(timer);
        }, 300);
        if (isPreview(source)) say('Loading full size…');

        view = modal({
            title: label,
            className: 'osm-av-modal',
            body: h('div', { class: 'osm-av' },
                h('div', { class: 'osm-av-frame' }, img),
                h('div', { class: 'osm-av-bar' },
                    status,
                    h('button', {
                        type: 'button', class: 'osm-button',
                        onclick: () => toPng(img)
                            .then((png) => navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]))
                            .then(() => say('Copied.'))
                            .catch((e) => say(cleanError(e))),
                    }, 'Copy image'),
                    h('button', {
                        type: 'button', class: 'osm-button is-primary',
                        onclick: () => toPng(img).then((png) => {
                            const url = URL.createObjectURL(png);
                            h('a', { href: url, download: fileName(label) }).click();
                            setTimeout(() => URL.revokeObjectURL(url), 10000);
                        }).catch((e) => say(cleanError(e))),
                    }, 'Save'),
                ),
            ),
            onClose: () => {
                clearInterval(timer);
                view = null;
            },
        });
        return true;
    }

    /* ------------------------------------------------- profile button -- */

    function mountProfileButtons() {
        if (api.settings.profileButton === false) return;
        for (const card of document.querySelectorAll('[class*="userProfileWrapper-"]')) {
            if (card.querySelector('.osm-av-profile-btn')) continue;
            const holder = card.querySelector(HOLDER);
            if (!holder?.querySelector('img')?.src) continue;
            const anchor = holder.parentElement || holder;
            anchor.classList.add('osm-av-anchor');
            anchor.append(h('button', {
                type: 'button', class: 'osm-av-profile-btn',
                'aria-label': 'View avatar', title: 'View avatar',
                html: ICON_IMAGE.replace('width="18" height="18"', 'width="14" height="14"'),
                onclick: (e) => { e.stopPropagation(); open(holder); },
            }));
        }
    }

    function clearProfileButtons() {
        document.querySelectorAll('.osm-av-profile-btn').forEach((el) => el.remove());
        document.querySelectorAll('.osm-av-anchor').forEach((el) => el.classList.remove('osm-av-anchor'));
    }

    /* ---------------------------------------------------- server button -- */

    function communityId() {
        const fromNav = api.client()?.navigation?.params?.communityId;
        if (fromNav != null) return String(fromNav);
        return location.pathname.match(/^\/(\d+)(\/|$)/)?.[1] || null;
    }

    function openServerIcon() {
        const cid = communityId();
        const holder = cid && document.querySelector(`[class*="communityListScroller-"] > a[href="/${cid}"]`);
        if (open(holder)) return;
        modal({ title: 'Server icon', className: 'osm-av-modal', body: h('div', { class: 'osm-empty' }, 'This server has no icon.') });
    }

    function mountButton() {
        const header = document.querySelector('[class*="communityTrigger-"]')?.parentElement;
        const existing = header?.querySelector('.osm-av-btn');
        if (api.settings.serverButton === false) return existing?.remove();
        if (!header || existing) return;
        header.append(h('button', { type: 'button', class: 'osm-av-btn', 'aria-label': 'View server icon', title: 'View server icon', html: ICON_IMAGE, onclick: openServerIcon }));
    }

    return {
        start() {
            const wanted = (e) => (api.settings.modifier === 'alt' ? e.altKey && !e.ctrlKey && !e.metaKey : (e.ctrlKey || e.metaKey) && !e.altKey);
            const onClick = (e) => {
                if (e.button !== 0 || e.shiftKey || !wanted(e)) return;
                const holder = e.target.closest?.(HOLDER);
                // No picture (a letter avatar): leave the click to Osmium.
                if (!holder || holder.closest('.osm-modal') || !open(holder)) return;
                e.preventDefault();
                e.stopPropagation();
            };
            document.addEventListener('click', onClick, true);
            api.track(() => document.removeEventListener('click', onClick, true));
            if (!api.isPopout) api.onDom(mountButton);
            api.onDom(mountProfileButtons);
        },
        stop() {
            view?.close();
            document.querySelectorAll('.osm-av-btn').forEach((el) => el.remove());
            clearProfileButtons();
        },
        onSettings() {
            if (!api.isPopout) mountButton();
            if (api.settings.profileButton === false) clearProfileButtons();
            else mountProfileButtons();
        },
    };
});
