'use strict';

module.exports = {
    name: 'Show Hidden Roles',
    description: 'Marks non-public roles on profiles, lists role IDs a member carries that Osmium doesn’t draw, and adds a role list for the whole server (shield button above the channel list).',
    settings: {
        markOnProfiles: { type: 'boolean', default: true, label: 'Mark on profiles', description: 'Flag non-public roles in the profile card and add the ones Osmium leaves out.' },
        showPermissions: { type: 'boolean', default: true, label: 'Show permissions', description: 'List what each role grants in the server role list.' },
    },
};
