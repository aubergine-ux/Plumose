'use strict';

module.exports = {
    name: 'Avatar Viewer',
    description: 'Ctrl+click any profile picture or server icon to open it full size, with copy and save. The image button above the channel list opens the current server’s icon.',
    popout: true,
    settings: {
        modifier: {
            type: 'select',
            default: 'ctrl',
            label: 'Open with',
            options: [['ctrl', 'Ctrl+click (Cmd+click on macOS)'], ['alt', 'Alt+click']],
        },
        serverButton: { type: 'boolean', default: true, label: 'Server icon button', description: 'An image button above the channel list that opens the server’s icon.' },
    },
};
