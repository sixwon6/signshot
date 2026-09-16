const { getDefaultConfig } = require("expo/metro-config");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Expo's defaults select the native MWA entry points. Web Crypto is installed in src/polyfills.ts.

module.exports = config;
