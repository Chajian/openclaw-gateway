import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./lib/args.mjs";
import { createStore } from "./lib/store.mjs";
import { readJsonFile } from "./lib/json-file.mjs";
import { error, info, warn } from "./lib/log.mjs";

async function readMap(mapPath) {
  const parsed = await readJsonFile(mapPath);
  if (!Array.isArray(parsed.targets)) {
    throw new Error("provider map requires targets[]");
  }
  return parsed.targets;
}

function updateProviderKey(openclawConfig, provider, apiKey) {
  openclawConfig.models ??= {};
  openclawConfig.models.providers ??= {};
  openclawConfig.models.providers[provider] ??= {};
  openclawConfig.models.providers[provider].apiKey = apiKey;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const storePath = path.resolve(cwd, args.store || "data/secrets.enc.json");
  const mapPath = path.resolve(cwd, args.map || "config/provider-map.json");
  const openclawPath = args["openclaw-config"];
  if (!openclawPath) {
    throw new Error("Missing --openclaw-config <path>");
  }

  const masterEnv = args["master-key-env"] || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (!masterKey) {
    throw new Error(`Missing env ${masterEnv}`);
  }

  const store = await createStore(storePath, masterKey);
  const targets = await readMap(mapPath);
  const absoluteOpenclawPath = path.resolve(openclawPath);
  const parsed = await readJsonFile(absoluteOpenclawPath);

  for (const target of targets) {
    const key = store.pickKey(target.siteId, target.strategy || "highest_quota");
    if (!key) {
      warn("skip target without key", `${target.siteId} -> ${target.provider}`);
      continue;
    }
    updateProviderKey(parsed, target.provider, key.key);
    info("provider updated", `${target.provider} <= ${target.siteId}:${key.id}`);
  }

  const backupPath = `${absoluteOpenclawPath}.bak.${Date.now()}`;
  await fs.copyFile(absoluteOpenclawPath, backupPath);
  await fs.writeFile(absoluteOpenclawPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  info("backup", backupPath);
  info("written", absoluteOpenclawPath);
}

main().catch((err) => {
  error("export aborted", err.message);
  process.exitCode = 1;
});
