// Must stay first, even before `expo`: installs Web Crypto before anything can need it.
import "./src/polyfills";

import { registerRootComponent } from "expo";

// Before the app: names the neutral look after this phone, before the list of looks is built.
import "./src/recipes/deviceLook";
import App from "./App";

// registerRootComponent registers "main" and sets up the dev-client environment.
registerRootComponent(App);
