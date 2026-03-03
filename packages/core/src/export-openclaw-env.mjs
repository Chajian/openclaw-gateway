import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./lib/args.mjs";
import { createStore } from "./lib/store.mjs";
import { readJsonFile } from "./lib/json-file.mjs";
import { error, info, warn } from "./lib/log.mjs";

function normalizeProvider(provider) {
  return String(provider || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

async function readMap(mapPath) {
  const parsed = await readJsonFile(mapPath);
  if (!Array.isArray(parsed.targets)) {
    throw new Error("provider map requires targets[]");
  }
  return parsed.targets;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const storePath = path.resolve(cwd, args.store || "data/secrets.enc.json");
  const masterEnv = args["master-key-env"] || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (!masterKey) {
    throw new Error(`Missing env ${masterEnv}`);
  }

  const store = await createStore(storePath, masterKey);
  let targets = [];
  if (args.map) {
    targets = await readMap(path.resolve(cwd, args.map));
  } else if (args.site && args.provider) {
    targets = [{ siteId: args.site, provider: args.provider, strategy: args.strategy || "highest_quota" }];
  } else {
    throw new Error("Use --map <provider-map.json> or --site <siteId> --provider <provider>");
  }

  const lines = [];
  for (const target of targets) {
    const key = store.pickKey(target.siteId, target.strategy || "highest_quota");
    if (!key) {
      warn("no key for site", target.siteId);
      continue;
    }
    const provider = normalizeProvider(target.provider);
    lines.push(`OPENCLAW_PROVIDER_${provider}_API_KEY=${key.key}`);
    lines.push(`OPENCLAW_PROVIDER_${provider}_SOURCE=${target.siteId}:${key.id}`);
  }

  const outPath = path.resolve(cwd, args.out || "data/openclaw-provider.env");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${lines.join("\n")}\n`, "utf8");
  info("exported env", outPath);
}

main().catch((err) => {
  error("export aborted", err.message);
  process.exitCode = 1;
});
