import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, requireArg, readJsonFile, createStore, info, warn, error } from "@openclaw/core";
import type { SiteConfig } from "@openclaw/core";
import { NewApiSiteAdapter } from "./new-api-site.js";

function safeIdFromUrl(siteUrl: string): string {
  const u = new URL(siteUrl);
  return u.hostname.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

async function readOrDefault(filePath: string, fallback: unknown): Promise<Record<string, unknown>> {
  try {
    return await readJsonFile(filePath) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback as Record<string, unknown>;
    }
    throw err;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function upsertSiteConfig(config: { sites: SiteConfig[] }, site: SiteConfig): void {
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

function upsertProviderMap(map: { targets: Array<{ siteId: string; provider: string; strategy?: string }> }, target: { siteId: string; provider: string; strategy?: string }): void {
  const idx = map.targets.findIndex((item) => item.siteId === target.siteId && item.provider === target.provider);
  if (idx >= 0) {
    map.targets[idx] = { ...map.targets[idx], ...target };
  } else {
    map.targets.push(target);
  }
}

function isAuthPendingError(err: unknown): boolean {
  const message = String((err as Error)?.message || "").toLowerCase();
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

export async function onboardNewapi(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const cwd = process.cwd();
  const siteUrl = requireArg(args, "site", "Missing --site <new-api-console-url>");
  const siteId = (args["site-id"] as string) || safeIdFromUrl(siteUrl);
  const provider = (args.provider as string) || "openai";

  const configPath = path.resolve(cwd, (args.config as string) || "config/sites.json");
  const mapPath = path.resolve(cwd, (args.map as string) || "config/provider-map.json");
  const storePath = path.resolve(cwd, (args.store as string) || "data/secrets.enc.json");
  const masterEnv = (args["master-key-env"] as string) || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (!masterKey) {
    throw new Error(`Missing env ${masterEnv}`);
  }

  const config = await readOrDefault(configPath, { sites: [] }) as { sites: SiteConfig[] };
  const providerMap = await readOrDefault(mapPath, { targets: [] }) as { targets: Array<{ siteId: string; provider: string; strategy?: string }> };
  const existingSite = (config.sites || []).find((item) => item.id === siteId) || {} as SiteConfig;
  const existingAuth = (existingSite.auth || {}) as Record<string, unknown>;
  const existingSettings = (existingSite.settings || {}) as Record<string, unknown>;

  const site: SiteConfig = {
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
    strategy: (args.strategy as string) || "highest_quota"
  });

  await writeJson(configPath, config);
  await writeJson(mapPath, providerMap);
  info("updated configs", `${configPath} | ${mapPath}`);

  const store = await createStore(storePath, masterKey);
  try {
    const adapter = new NewApiSiteAdapter(site, store);
    const snapshot = await adapter.sync();
    store.upsertSiteSnapshot(site.id, snapshot as import("@openclaw/core").SiteSnapshot);
    await store.save();
    info("site synced", `${siteId}: keys=${snapshot.keys?.length || 0}`);
  } catch (err) {
    if (isAuthPendingError(err)) {
      warn("site added but auth pending", `${siteId}: ${(err as Error).message}`);
      info("next", `import ${(site.auth as Record<string, unknown>).accessTokenSecret} (and optional ${(site.auth as Record<string, unknown>).userIdSecret}), then run cycle:auto`);
      return;
    }
    throw err;
  }

  if (args["openclaw-config"]) {
    info("next", "run export-openclaw-json.ts to patch openclaw config");
  }
}

// CLI self-execution
if (process.argv[1] && (process.argv[1].includes("onboard-newapi") || process.argv[1].includes("plugin-adapter-newapi"))) {
  onboardNewapi().catch((err) => {
    error("onboard aborted", (err as Error).message);
    process.exitCode = 1;
  });
}
