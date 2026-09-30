'use strict';

module.exports = {
    name: 'Custom Status',
    description: 'Set a status message that shows under your name, like “brb” or “in a meeting”. Open it from the speech-bubble button on your account card.',
    settings: {
        text: { type: 'string', default: '', label: 'Status message', placeholder: 'What’s up?', description: 'Leave empty for no status.' },
        expiresAt: { type: 'json', default: null, hidden: true },
        recent: { type: 'json', default: [], hidden: true },
    },
};
