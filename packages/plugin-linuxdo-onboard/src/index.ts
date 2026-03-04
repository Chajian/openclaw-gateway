import { onboardLinuxdoOauthSites } from "./onboard-linuxdo-oauth-sites.js";
import type { PluginContext, PluginHandle } from "@openclaw/core";

export function activate(ctx: PluginContext): PluginHandle {
  const config = ctx.config || {};

  ctx.commands.register("onboard:linuxdo", {
    description: "Automated LinuxDo OAuth browser onboarding for new-api sites",
    run: (argv: string[]) => onboardLinuxdoOauthSites(argv)
  });

  ctx.pipeline.register("linuxdo-onboard", {
    description: "Browser-automated OAuth onboarding for discovered LinuxDo sites",
    after: ["linuxdo-upsert"],
    run: async (_pipelineCtx: unknown) => {
      const argv: string[] = [];
      if (config.browserProfile) {
        argv.push("--browser-profile", String(config.browserProfile));
      }
      return onboardLinuxdoOauthSites(argv);
    }
  });

  return {
    name: "@openclaw/plugin-linuxdo-onboard",
    deactivate() {
      ctx.commands.unregister("onboard:linuxdo");
      ctx.pipeline.unregister("linuxdo-onboard");
    }
  };
}
