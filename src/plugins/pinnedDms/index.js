'use strict';

module.exports = {
    name: 'Pinned DMs',
    description: 'Keep chosen chats at the top of your Direct Messages list. Hover a chat and click the pin to pin or unpin it.',
    settings: {
        order: {
            type: 'select',
            default: 'pinned',
            label: 'Order of pinned chats',
            options: [['pinned', 'The order you pinned them'], ['recent', 'Latest message first']],
        },
        showLabel: { type: 'boolean', default: true, label: 'Show a "Pinned" heading', description: 'A small heading above the pinned chats and a line under them.' },
        pins: { type: 'json', default: [], hidden: true },
    },
};
