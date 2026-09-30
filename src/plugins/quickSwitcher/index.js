'use strict';

module.exports = {
    name: 'Quick Switcher',
    description: 'Press Ctrl+K (Cmd+K on macOS) to jump to any chat, channel or server by typing part of its name. Start with @ for chats, # for channels or * for servers.',
    settings: {
        unreadFirst: { type: 'boolean', default: true, label: 'Unread first', description: 'With nothing typed, list chats and channels with unread messages before the rest.' },
    },
};
