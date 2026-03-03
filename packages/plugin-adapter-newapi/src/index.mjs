import { NewApiSiteAdapter } from "./new-api-site.mjs";
import { onboardNewapi } from "./onboard-newapi-site.mjs";

export function activate(ctx) {
  ctx.adapters.register("new-api", NewApiSiteAdapter);

  ctx.commands.register("onboard:newapi", {
    description: "Onboard a new-api site: add config, register/login, sync keys",
    run: (argv) => onboardNewapi(argv)
  });

  return {
    name: "@openclaw/plugin-adapter-newapi",
    deactivate() {
      ctx.adapters.unregister("new-api");
      ctx.commands.unregister("onboard:newapi");
    }
  };
}
