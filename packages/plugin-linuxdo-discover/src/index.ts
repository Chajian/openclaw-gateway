import type { PluginContext, PluginHandle } from "@openclaw/core";
import { discoverLinuxdoPublicSites } from "./discover-linuxdo-public-sites.js";
import { upsertSitesFromDiscovery } from "./upsert-sites-from-discovery.js";

export function activate(ctx: PluginContext): PluginHandle {
  ctx.commands.register("discover:linuxdo", {
    description: "Discover new-api sites from LinuxDo RSS feeds",
    run: (argv) => discoverLinuxdoPublicSites(argv as string[])
  });

  ctx.commands.register("upsert:linuxdo", {
    description: "Upsert discovered LinuxDo sites into sites.json config",
    run: (argv) => upsertSitesFromDiscovery(argv as string[])
  });

  ctx.pipeline.register("linuxdo-discover", {
    description: "Discover new-api sites from LinuxDo RSS/browser",
    run: async () => {
      const config = (ctx.config || {}) as Record<string, unknown>;
      const argv: string[] = [];
      if (config.feeds) {
        argv.push("--feeds", (config.feeds as string[]).join(","));
      }
      if (config.keywords) {
        argv.push("--keywords", (config.keywords as string[]).join(","));
      }
      return discoverLinuxdoPublicSites(argv);
    }
  });

  ctx.pipeline.register("linuxdo-upsert", {
    description: "Upsert discovered sites into config",
    after: ["linuxdo-discover"],
    run: async () => {
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
