import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { xmppPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(xmppPlugin);
export { xmppPlugin };
