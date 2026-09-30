'use strict';

module.exports = {
    name: 'Show Hidden Channels',
    description: 'Channels you can’t open show up in the channel list with a lock. Click one for its name, topic and who’s in voice. Messages stay out of reach.',
    enabledByDefault: false,
    settings: {
        placement: {
            type: 'select',
            default: 'inline',
            label: 'Where to show them',
            options: [['inline', 'In their own categories'], ['section', 'One section at the bottom']],
        },
        dim: { type: 'boolean', default: true, label: 'Dim hidden channels', description: 'Draw them fainter than channels you can open.' },
    },
};
