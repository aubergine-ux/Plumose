'use strict';

module.exports = {
    name: 'Server Folders',
    description: 'Group servers in the left rail into collapsible folders. Use the folder button at the bottom of the rail, drag a server onto a folder to add it, and right-click a folder for options.',
    enabledByDefault: false,
    settings: {
        showPreview: { type: 'boolean', default: true, label: 'Show server previews', description: 'A closed folder shows its first four server icons instead of a folder icon.' },
        folders: { type: 'json', default: [], hidden: true },
    },
};
