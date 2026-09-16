// TASK-702 - lets the app import ../shared (polyline codec, route tolerance).
//
// Metro only sees files under its watchFolders, which default to this project.
// Without this, `../../../shared/src/polyline` type-checks and runs under Node,
// then fails at bundle time with "Unable to resolve module".
//
// Keep ../shared import-free of npm packages: node_modules resolution from
// there walks up to the repo root, not to mobile/node_modules.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../shared')];

module.exports = config;
