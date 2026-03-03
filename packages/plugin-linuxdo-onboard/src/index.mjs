import { onboardLinuxdoOauthSites } from "./onboard-linuxdo-oauth-sites.mjs";

export function activate(ctx) {
  const config = ctx.config || {};

  ctx.commands.register("onboard:linuxdo", {
    description: "Automated LinuxDo OAuth browser onboarding for new-api sites",
    run: (argv) => onboardLinuxdoOauthSites(argv)
  });

  ctx.pipeline.register("linuxdo-onboard", {
    description: "Browser-automated OAuth onboarding for discovered LinuxDo sites",
    after: ["linuxdo-upsert"],
    run: async (pipelineCtx) => {
      const argv = [];
      if (config.browserProfile) {
        argv.push("--browser-profile", config.browserProfile);
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
