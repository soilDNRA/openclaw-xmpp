import {
  defineChannelPluginEntry
} from "openclaw/plugin-sdk/channel-core";

import { xmppPlugin } from "./src/channel.js";
import { setXmppPluginRuntime } from "./src/inbound.js";
import { registerOmemoOperatorCommand } from "./src/omemo/command.js";

import { registerOmemoAdmin } from "./src/omemo/admin.js";

const xmppPluginEntry: ReturnType<
  typeof defineChannelPluginEntry<typeof xmppPlugin>
> = defineChannelPluginEntry({
  id: "xmpp",
  name: "XMPP",
  description: "Native XMPP direct-message channel for OpenClaw.",
  plugin: xmppPlugin,
  setRuntime: setXmppPluginRuntime,
  registerFull: (api) => {
    registerOmemoOperatorCommand(api);
    registerOmemoAdmin(api);
  },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  }
});

export default xmppPluginEntry;

export { xmppPlugin } from "./src/channel.js";
