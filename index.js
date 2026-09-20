// Must stay first, even before `expo`: installs Web Crypto before anything can need it.
import "./src/polyfills";

import { registerRootComponent } from "expo";

// Before the app: names the look that adds nothing for this phone, ahead of the list of looks.
import "./src/recipes/deviceLook";
import App from "./App";

// registerRootComponent registers "main" and sets up the dev-client environment.
registerRootComponent(App);
