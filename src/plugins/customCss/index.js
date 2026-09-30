'use strict';

module.exports = {
    name: 'Custom CSS',
    description: 'Your own CSS, applied to Osmium as you type. Edit it in this plugin’s settings.',
    enabledByDefault: false,
    popout: true,
    settings: {
        css: { type: 'string', default: '', hidden: true },
    },
};
