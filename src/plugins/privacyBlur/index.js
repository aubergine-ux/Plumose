'use strict';

module.exports = {
    name: 'Privacy Blur',
    description: 'Blurs messages, names and pictures until you point at them. Toggle with Ctrl+Shift+B, for when someone can see your screen.',
    enabledByDefault: false,
    popout: true,
    settings: {
        active: { type: 'boolean', default: true, label: 'Blur now', description: 'Same as pressing Ctrl+Shift+B.' },
        unfocusedOnly: { type: 'boolean', default: false, label: 'Only when Osmium isn’t focused', description: 'Blur while you’re in another window, and clear when you come back.' },
        messages: { type: 'boolean', default: true, label: 'Message text and media' },
        names: { type: 'boolean', default: true, label: 'Names' },
        avatars: { type: 'boolean', default: true, label: 'Profile pictures' },
        sidebar: { type: 'boolean', default: true, label: 'Chat list previews' },
        strength: { type: 'number', default: 6, min: 2, max: 20, step: 1, label: 'Blur strength', description: 'In pixels.' },
    },
};
