import path from "node:path";
import { definePluginEntry, type OpenClawPluginService } from "openclaw/plugin-sdk/core";
import { pluginConfigSchema, resolvePluginConfig } from "./src/config.js";
import { getPluginManager } from "./src/manager.js";

const PLUGIN_ID = "llm-logger-openclaw-plugin";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "LLM Logger OpenClaw Plugin",
  description: "Logs OpenClaw LLM request payloads and responses to a JSONL file.",
  configSchema: pluginConfigSchema,
  register(api) {
    const pluginConfig = resolvePluginConfig(api.pluginConfig);
    const manager = getPluginManager();
    manager.setRegistrationLogger(api.logger);
    manager.setPluginConfig(pluginConfig);

    const service: OpenClawPluginService = {
      id: PLUGIN_ID,
      async start(ctx) {
        await manager.start({
          pluginId: PLUGIN_ID,
          stateDir: ctx.stateDir,
          workspaceDir: ctx.workspaceDir,
          defaultLogFile: path.join(ctx.stateDir, "logs", `${PLUGIN_ID}.jsonl`),
          logger: ctx.logger,
        });
      },
      async stop() {
        await manager.stop();
      },
    };

    api.registerService(service);

    api.on("llm_input", (event, ctx) => {
      manager.recordLlmInput(event, ctx);
    });

    api.on("llm_output", (event, ctx) => {
      manager.recordLlmOutput(event, ctx);
    });
  },
});
