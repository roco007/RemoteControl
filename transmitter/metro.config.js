const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Expo watches workspace packages automatically; shared/ is a sibling source folder.
// Watch it explicitly so regenerated protocol constants reach the phone immediately.
config.watchFolders = [...new Set([...config.watchFolders, path.resolve(__dirname, '../shared')])];

module.exports = config;
