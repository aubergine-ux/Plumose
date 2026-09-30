'use strict';

module.exports = {
    name: 'Voice Overview',
    description: 'One list of everyone in voice across your servers and chats, with who’s muted, deafened or sharing. Open it from the headphones button on your account card.',
    enabledByDefault: false,
    settings: {
        friendsFirst: { type: 'boolean', default: true, label: 'Friends first', description: 'Put calls with friends in them at the top.' },
    },
};
