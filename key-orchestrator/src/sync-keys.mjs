import path from "node:path";
import { parseArgs } from "./lib/args.mjs";
import { createStore } from "./lib/store.mjs";
import { createAdapter } from "./load-adapter.mjs";
import { readJsonFile } from "./lib/json-file.mjs";
import { error, info, warn } from "./lib/log.mjs";

async function readConfig(configPath) {
  const parsed = await readJsonFile(configPath);
  if (!Array.isArray(parsed.sites)) {
    throw new Error("config.sites must be an array");
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const configPath = path.resolve(cwd, args.config || "config/sites.json");
  const storePath = path.resolve(cwd, args.store || "data/secrets.enc.json");
  const masterEnv = args["master-key-env"] || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (!masterKey) {
    throw new Error(`Missing env ${masterEnv}`);
  }

  const config = await readConfig(configPath);
  const store = await createStore(storePath, masterKey);

  let okCount = 0;
  for (const site of config.sites) {
    if (!site.enabled) {
      info("skip disabled site", site.id);
      continue;
    }
    try {
      info("sync site", `${site.id} (${site.type})`);
      const adapter = createAdapter(site, store);
      const snapshot = await adapter.sync();
      store.upsertSiteSnapshot(site.id, snapshot);
      info("synced keys", `${site.id}: ${snapshot.keys?.length || 0}`);
      okCount += 1;
    } catch (err) {
      warn("sync failed", `${site.id}: ${err.message}`);
    }
  }

  await store.save();
  info("done", `sites_synced=${okCount}`);
}

main().catch((err) => {
  error("sync aborted", err.message);
  process.exitCode = 1;
});
