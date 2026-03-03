import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, requireArg } from "./lib/args.mjs";
import { readJsonFile } from "./lib/json-file.mjs";
import { createStore } from "./lib/store.mjs";
import { createAdapter } from "./load-adapter.mjs";
import { error, info, warn } from "./lib/log.mjs";

function safeIdFromUrl(siteUrl) {
  const u = new URL(siteUrl);
  return u.hostname.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

async function readOrDefault(filePath, fallback) {
  try {
    return await readJsonFile(filePath);
  } catch (err) {
    if (err.code === "ENOENT") {
      return fallback;
    }
    throw err;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function upsertSiteConfig(config, site) {
  const idx = config.sites.findIndex((item) => item.id === site.id);
  if (idx >= 0) {
    config.sites[idx] = {
      ...config.sites[idx],
      ...site
    };
  } else {
    config.sites.push(site);
  }
}

function upsertProviderMap(map, target) {
  const idx = map.targets.findIndex((item) => item.siteId === target.siteId && item.provider === target.provider);
  if (idx >= 0) {
    map.targets[idx] = { ...map.targets[idx], ...target };
  } else {
    map.targets.push(target);
  }
}

function isAuthPendingError(err) {
  const message = String(err?.message || "").toLowerCase();
  if (message.includes("no usable auth")) {
    return true;
  }
  if (message.includes("secret") && message.includes("not found")) {
    return true;
  }
  if (message.includes("password registration has been disabled")) {
    return true;
  }
  if (message.includes("third-party account verification")) {
    return true;
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const siteUrl = requireArg(args, "site", "Missing --site <new-api-console-url>");
  const siteId = args["site-id"] || safeIdFromUrl(siteUrl);
  const provider = args.provider || "openai";

  const configPath = path.resolve(cwd, args.config || "config/sites.json");
  const mapPath = path.resolve(cwd, args.map || "config/provider-map.json");
  const storePath = path.resolve(cwd, args.store || "data/secrets.enc.json");
  const masterEnv = args["master-key-env"] || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (!masterKey) {
    throw new Error(`Missing env ${masterEnv}`);
  }

  const config = await readOrDefault(configPath, { sites: [] });
  const providerMap = await readOrDefault(mapPath, { targets: [] });
  const existingSite = (config.sites || []).find((item) => item.id === siteId) || {};
  const existingAuth = existingSite.auth || {};
  const existingSettings = existingSite.settings || {};

  const site = {
    id: siteId,
    type: "new-api",
    enabled: true,
    baseUrl: siteUrl,
    auth: {
      usernameSecret: args["username-secret"] ?? existingAuth.usernameSecret ?? `${siteId}_username`,
      passwordSecret: args["password-secret"] ?? existingAuth.passwordSecret ?? `${siteId}_password`,
      accessTokenSecret: args["access-token-secret"] ?? existingAuth.accessTokenSecret ?? `${siteId}_access_token`,
      userIdSecret: args["user-id-secret"] ?? existingAuth.userIdSecret ?? `${siteId}_user_id`,
      turnstileTokenSecret: args["turnstile-secret"] ?? existingAuth.turnstileTokenSecret ?? "",
      registerIfNeeded: args["register-if-needed"] !== undefined
        ? args["register-if-needed"] !== "false"
        : (existingAuth.registerIfNeeded ?? true)
    },
    settings: {
      autoCreateToken: args["auto-create-token"] !== undefined
        ? args["auto-create-token"] !== "false"
        : (existingSettings.autoCreateToken ?? true),
      autoTokenName: args["token-name"] ?? existingSettings.autoTokenName ?? "openclaw-auto",
      autoTokenUnlimited: args["token-unlimited"] !== undefined
        ? args["token-unlimited"] !== "false"
        : (existingSettings.autoTokenUnlimited ?? true),
      autoTokenRemainQuota: Number(args["token-remain-quota"] ?? existingSettings.autoTokenRemainQuota ?? 0)
    }
  };

  upsertSiteConfig(config, site);
  upsertProviderMap(providerMap, {
    siteId,
    provider,
    strategy: args.strategy || "highest_quota"
  });

  await writeJson(configPath, config);
  await writeJson(mapPath, providerMap);
  info("updated configs", `${configPath} | ${mapPath}`);

  const store = await createStore(storePath, masterKey);
  try {
    const adapter = createAdapter(site, store);
    const snapshot = await adapter.sync();
    store.upsertSiteSnapshot(site.id, snapshot);
    await store.save();
    info("site synced", `${siteId}: keys=${snapshot.keys?.length || 0}`);
  } catch (err) {
    if (isAuthPendingError(err)) {
      warn("site added but auth pending", `${siteId}: ${err.message}`);
      info("next", `import ${site.auth.accessTokenSecret} (and optional ${site.auth.userIdSecret}), then run cycle:auto`);
      return;
    }
    throw err;
  }

  if (args["openclaw-config"]) {
    info("next", "run export-openclaw-json.mjs to patch openclaw config");
  }
}

main().catch((err) => {
  error("onboard aborted", err.message);
  process.exitCode = 1;
});
