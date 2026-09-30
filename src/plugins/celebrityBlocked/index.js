'use strict';

module.exports = {
    name: 'Celebrity Blocked',
    description: 'Blocked accounts show up under celebrity names instead of their own. Only you see this; nothing is sent to Osmium.',
    enabledByDefault: false,
    settings: {
        names: {
            type: 'string',
            default: 'Donald Trump, Kanye West, Taylor Swift, Elon Musk, Kim Kardashian, Drake, Gordon Ramsay, Snoop Dogg, Shrek, Danny DeVito',
            label: 'Celebrities',
            description: 'Comma-separated. Each blocked account always gets the same one.',
        },
        hideAvatars: { type: 'boolean', default: true, label: 'Hide avatars', description: 'Show the default avatar instead of their real picture.' },
    },
};
