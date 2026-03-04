import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./lib/args.js";
import { readJsonFile } from "./lib/json-file.js";
import { createStore } from "./lib/store.js";
import { error, info, warn } from "./lib/log.js";
import { SitesConfigSchema, ProviderMapSchema } from "./schemas/index.js";
import type { SiteConfig, Store, Adapter, ProviderTarget, OpenClawConfig } from "./types.js";

async function syncSites(
  config: { sites?: SiteConfig[] },
  store: Store,
  createAdapterFn: (site: SiteConfig, store: Store) => Adapter
): Promise<number> {
  let count = 0;
  for (const site of config.sites || []) {
    if (!site.enabled) {
      continue;
    }
    try {
      const adapter = createAdapterFn(site, store);
      const snapshot = await adapter.sync();
      store.upsertSiteSnapshot(site.id, snapshot as import("./types.js").SiteSnapshot);
      count += 1;
      info("synced", `${site.id} keys=${snapshot.keys?.length || 0}`);
    } catch (err) {
      warn("sync failed", `${site.id}: ${(err as Error).message}`);
    }
  }
  return count;
}

function applyProviderKeys(openclawConfig: OpenClawConfig, targets: ProviderTarget[], store: Store): number {
  let applied = 0;
  openclawConfig.models ??= {};
  openclawConfig.models.providers ??= {};
  for (const target of targets) {
    const picked = store.pickKey(target.siteId, target.strategy || "highest_quota");
    if (!picked) {
      warn("no key for target", `${target.siteId} -> ${target.provider}`);
      continue;
    }
    openclawConfig.models.providers[target.provider] ??= {};
    openclawConfig.models.providers[target.provider].apiKey = picked.key;
    applied += 1;
    info("provider key applied", `${target.provider} <= ${target.siteId}:${picked.id}`);
  }
  return applied;
}

async function main(): Promise<void> {
  const { createPluginHost } = await import("./plugin-host.js");
  const host = await createPluginHost({ cwd: process.cwd() });

  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const configPath = path.resolve(cwd, (args.config as string) || "config/sites.json");
  const mapPath = path.resolve(cwd, (args.map as string) || "config/provider-map.json");
  const storePath = path.resolve(cwd, (args.store as string) || "data/secrets.enc.json");
  const openclawConfigPath = path.resolve((args["openclaw-config"] as string) || "/home/node/.openclaw/openclaw.json");
  const backupDir = path.resolve(cwd, (args["backup-dir"] as string) || "data/backups");

  const masterEnv = (args["master-key-env"] as string) || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (!masterKey) {
    throw new Error(`Missing env ${masterEnv}`);
  }

  const config = SitesConfigSchema.parse(await readJsonFile(configPath)) as { sites?: SiteConfig[] };
  const targets = (ProviderMapSchema.parse(await readJsonFile(mapPath)).targets || []) as ProviderTarget[];
  const store = await createStore(storePath, masterKey);

  const synced = await syncSites(config, store, (site, st) => host.adapters.create(site, st));
  await store.save();
  info("sync done", `sites=${synced}`);

  const openclawConfig = await readJsonFile(openclawConfigPath) as OpenClawConfig;
  const applied = applyProviderKeys(openclawConfig, targets, store);
  await fs.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `openclaw.json.bak.${Date.now()}`);
  await fs.copyFile(openclawConfigPath, backupPath);
  await fs.writeFile(openclawConfigPath, `${JSON.stringify(openclawConfig, null, 2)}\n`, "utf8");
  info("openclaw config updated", `applied=${applied}`);
  info("backup", backupPath);
}

main().catch((err) => {
  error("auto-cycle failed", (err as Error).message);
  process.exitCode = 1;
});
