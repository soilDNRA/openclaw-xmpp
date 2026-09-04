import {
  defineChannelPluginEntry
} from "openclaw/plugin-sdk/channel-core";

import { xmppPlugin } from "./src/channel.js";
import { setXmppPluginRuntime } from "./src/inbound.js";

const xmppPluginEntry: ReturnType<
  typeof defineChannelPluginEntry<typeof xmppPlugin>
> = defineChannelPluginEntry({
  id: "xmpp",
  name: "XMPP",
  description: "Native XMPP direct-message channel for OpenClaw.",
  plugin: xmppPlugin,
  setRuntime: setXmppPluginRuntime,
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
