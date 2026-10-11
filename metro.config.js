const { getDefaultConfig } = require("expo/metro-config");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Expo's defaults resolve the native MWA entry points; Web Crypto comes from src/polyfills.ts.

module.exports = config;
