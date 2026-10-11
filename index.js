// Must stay first: installs Web Crypto before any import can need it.
import "./src/polyfills";

import { registerRootComponent } from "expo";

// Before App: names the neutral look after this phone before the look list is built.
import "./src/recipes/deviceLook";
import App from "./App";

registerRootComponent(App);
