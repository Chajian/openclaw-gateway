import type { PluginContext, PluginHandle } from "@openclaw/core";
import { NewApiSiteAdapter } from "./new-api-site.js";
import { onboardNewapi } from "./onboard-newapi-site.js";

export function activate(ctx: PluginContext): PluginHandle {
  ctx.adapters.register("new-api", NewApiSiteAdapter as never);

  ctx.commands.register("onboard:newapi", {
    description: "Onboard a new-api site: add config, register/login, sync keys",
    run: (argv) => onboardNewapi(argv as string[])
  });

  return {
    name: "@openclaw/plugin-adapter-newapi",
    deactivate() {
      ctx.adapters.unregister("new-api");
      ctx.commands.unregister("onboard:newapi");
    }
  };
}
