// Must stay first, even before `expo`: installs Web Crypto before anything can need it.
import "./src/polyfills";

import { registerRootComponent } from "expo";

import App from "./App";

// registerRootComponent registers "main" and sets up the dev-client environment.
registerRootComponent(App);
