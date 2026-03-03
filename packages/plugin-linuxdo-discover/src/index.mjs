import { discoverLinuxdoPublicSites } from "./discover-linuxdo-public-sites.mjs";
import { upsertSitesFromDiscovery } from "./upsert-sites-from-discovery.mjs";

export function activate(ctx) {
  ctx.commands.register("discover:linuxdo", {
    description: "Discover new-api sites from LinuxDo RSS feeds",
    run: (argv) => discoverLinuxdoPublicSites(argv)
  });

  ctx.commands.register("upsert:linuxdo", {
    description: "Upsert discovered LinuxDo sites into sites.json config",
    run: (argv) => upsertSitesFromDiscovery(argv)
  });

  ctx.pipeline.register("linuxdo-discover", {
    description: "Discover new-api sites from LinuxDo RSS/browser",
    run: async (pipelineCtx) => {
      const config = ctx.config || {};
      const argv = [];
      if (config.feeds) {
        argv.push("--feeds", config.feeds.join(","));
      }
      if (config.keywords) {
        argv.push("--keywords", config.keywords.join(","));
      }
      return discoverLinuxdoPublicSites(argv);
    }
  });

  ctx.pipeline.register("linuxdo-upsert", {
    description: "Upsert discovered sites into config",
    after: ["linuxdo-discover"],
    run: async (pipelineCtx) => {
      return upsertSitesFromDiscovery([]);
    }
  });

  return {
    name: "@openclaw/plugin-linuxdo-discover",
    deactivate() {
      ctx.commands.unregister("discover:linuxdo");
      ctx.commands.unregister("upsert:linuxdo");
      ctx.pipeline.unregister("linuxdo-discover");
      ctx.pipeline.unregister("linuxdo-upsert");
    }
  };
}
