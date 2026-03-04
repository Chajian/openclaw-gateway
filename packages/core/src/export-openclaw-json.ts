import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./lib/args.js";
import { createStore } from "./lib/store.js";
import { readJsonFile } from "./lib/json-file.js";
import { error, info, warn } from "./lib/log.js";
import type { ProviderTarget, OpenClawConfig } from "./types.js";

async function readMap(mapPath: string): Promise<ProviderTarget[]> {
  const parsed = await readJsonFile(mapPath) as { targets?: ProviderTarget[] };
  if (!Array.isArray(parsed.targets)) {
    throw new Error("provider map requires targets[]");
  }
  return parsed.targets;
}

function updateProviderKey(openclawConfig: OpenClawConfig, provider: string, apiKey: string): void {
  openclawConfig.models ??= {};
  openclawConfig.models.providers ??= {};
  openclawConfig.models.providers[provider] ??= {};
  openclawConfig.models.providers[provider].apiKey = apiKey;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const storePath = path.resolve(cwd, (args.store as string) || "data/secrets.enc.json");
  const mapPath = path.resolve(cwd, (args.map as string) || "config/provider-map.json");
  const openclawPath = args["openclaw-config"] as string;
  if (!openclawPath) {
    throw new Error("Missing --openclaw-config <path>");
  }

  const masterEnv = (args["master-key-env"] as string) || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (!masterKey) {
    throw new Error(`Missing env ${masterEnv}`);
  }

  const store = await createStore(storePath, masterKey);
  const targets = await readMap(mapPath);
  const absoluteOpenclawPath = path.resolve(openclawPath);
  const parsed = await readJsonFile(absoluteOpenclawPath) as OpenClawConfig;

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
  error("export aborted", (err as Error).message);
  process.exitCode = 1;
});
