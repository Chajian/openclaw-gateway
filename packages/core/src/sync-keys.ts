import path from "node:path";
import { parseArgs } from "./lib/args.js";
import { createStore } from "./lib/store.js";
import { readJsonFile } from "./lib/json-file.js";
import { error, info, warn } from "./lib/log.js";
import { SitesConfigSchema } from "./schemas/index.js";
import type { SiteConfig, SiteSnapshot, Store, Adapter } from "./types.js";

interface SyncConfig {
  sites: SiteConfig[];
  [key: string]: unknown;
}

export async function syncSites(
  config: SyncConfig,
  store: Store,
  createAdapterFn: (site: SiteConfig, store: Store) => Adapter
): Promise<number> {
  let okCount = 0;
  for (const site of config.sites) {
    if (!site.enabled) {
      info("skip disabled site", site.id);
      continue;
    }
    try {
      info("sync site", `${site.id} (${site.type})`);
      const adapter = createAdapterFn(site, store);
      const snapshot = await adapter.sync();
      store.upsertSiteSnapshot(site.id, snapshot as SiteSnapshot);
      info("synced keys", `${site.id}: ${snapshot.keys?.length || 0}`);
      okCount += 1;
    } catch (err) {
      warn("sync failed", `${site.id}: ${(err as Error).message}`);
    }
  }
  return okCount;
}

async function readConfig(configPath: string): Promise<SyncConfig> {
  const raw = await readJsonFile(configPath);
  const parsed = SitesConfigSchema.parse(raw);
  return parsed as SyncConfig;
}

async function main(): Promise<void> {
  const { createPluginHost } = await import("./plugin-host.js");
  const host = await createPluginHost({ cwd: process.cwd() });

  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const configPath = path.resolve(cwd, (args.config as string) || "config/sites.json");
  const storePath = path.resolve(cwd, (args.store as string) || "data/secrets.enc.json");
  const masterEnv = (args["master-key-env"] as string) || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (!masterKey) {
    throw new Error(`Missing env ${masterEnv}`);
  }

  const config = await readConfig(configPath);
  const store = await createStore(storePath, masterKey);

  const okCount = await syncSites(config, store, (site, st) => host.adapters.create(site, st));

  await store.save();
  info("done", `sites_synced=${okCount}`);
}

main().catch((err) => {
  error("sync aborted", (err as Error).message);
  process.exitCode = 1;
});
