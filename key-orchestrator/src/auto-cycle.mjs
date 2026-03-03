import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./lib/args.mjs";
import { readJsonFile } from "./lib/json-file.mjs";
import { createStore } from "./lib/store.mjs";
import { createAdapter } from "./load-adapter.mjs";
import { error, info, warn } from "./lib/log.mjs";

async function syncSites(config, store) {
  let count = 0;
  for (const site of config.sites || []) {
    if (!site.enabled) {
      continue;
    }
    try {
      const adapter = createAdapter(site, store);
      const snapshot = await adapter.sync();
      store.upsertSiteSnapshot(site.id, snapshot);
      count += 1;
      info("synced", `${site.id} keys=${snapshot.keys?.length || 0}`);
    } catch (err) {
      warn("sync failed", `${site.id}: ${err.message}`);
    }
  }
  return count;
}

function applyProviderKeys(openclawConfig, targets, store) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const configPath = path.resolve(cwd, args.config || "config/sites.json");
  const mapPath = path.resolve(cwd, args.map || "config/provider-map.json");
  const storePath = path.resolve(cwd, args.store || "data/secrets.enc.json");
  const openclawConfigPath = path.resolve(args["openclaw-config"] || "/home/node/.openclaw/openclaw.json");
  const backupDir = path.resolve(cwd, args["backup-dir"] || "data/backups");

  const masterEnv = args["master-key-env"] || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (!masterKey) {
    throw new Error(`Missing env ${masterEnv}`);
  }

  const config = await readJsonFile(configPath);
  const targets = (await readJsonFile(mapPath)).targets || [];
  const store = await createStore(storePath, masterKey);

  const synced = await syncSites(config, store);
  await store.save();
  info("sync done", `sites=${synced}`);

  const openclawConfig = await readJsonFile(openclawConfigPath);
  const applied = applyProviderKeys(openclawConfig, targets, store);
  await fs.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `openclaw.json.bak.${Date.now()}`);
  await fs.copyFile(openclawConfigPath, backupPath);
  await fs.writeFile(openclawConfigPath, `${JSON.stringify(openclawConfig, null, 2)}\n`, "utf8");
  info("openclaw config updated", `applied=${applied}`);
  info("backup", backupPath);
}

main().catch((err) => {
  error("auto-cycle failed", err.message);
  process.exitCode = 1;
});

