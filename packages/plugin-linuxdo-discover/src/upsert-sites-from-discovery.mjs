import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, readJsonFile, createStore, info, warn, error } from "@openclaw/core";

const DEFAULT_BLOCKED_HOSTS = new Set([
  "developers.google.com",
  "dev.coc.10086.cn",
  "love.p6m6.com",
  "idcflare.com"
]);

function normalizeHost(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

function safeIdFromHost(hostname) {
  return normalizeHost(hostname)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function looksLikeNewApi(candidate) {
  const host = normalizeHost(candidate.host);
  let score = 0;
  if (/(api|gpt|openai|claude|gemini|model|llm)/i.test(host)) {
    score += 2;
  }

  const sourceTopics = Array.isArray(candidate.sources) ? candidate.sources : [];
  const topicText = sourceTopics.map((item) => item.title || "").join("\n");
  if (/(api|new\s*api|openai|claude|gemini|key|token|\u516c\u76ca\u7ad9|\u4e2d\u8f6c)/i.test(topicText)) {
    score += 2;
  }

  const urls = Array.isArray(candidate.urls) ? candidate.urls : [];
  for (const raw of urls) {
    try {
      const u = new URL(raw);
      const pathLower = u.pathname.toLowerCase();
      if (pathLower.startsWith("/console") || pathLower.startsWith("/panel") || pathLower.startsWith("/dashboard")) {
        score += 2;
      }
      if (/(\/api\/|\/v1\/models|\/login|\/register|\/token)/i.test(pathLower)) {
        score += 1;
      }
    } catch {
      // ignore invalid URL
    }
  }
  return score >= 2;
}

function createUniqueSiteId(baseId, existingIds) {
  if (!existingIds.has(baseId)) {
    return baseId;
  }
  let counter = 2;
  while (existingIds.has(`${baseId}-${counter}`)) {
    counter += 1;
  }
  return `${baseId}-${counter}`;
}

function matchExistingSite(configSites, candidate) {
  const candidateHost = normalizeHost(candidate.host);
  return configSites.find((site) => {
    if (!site) {
      return false;
    }
    try {
      const host = normalizeHost(new URL(site.baseUrl || site.url || "").hostname);
      return host === candidateHost;
    } catch {
      return false;
    }
  }) || null;
}

function upsertProviderTarget(providerMap, target) {
  providerMap.targets ??= [];
  const idx = providerMap.targets.findIndex(
    (item) => item.siteId === target.siteId && item.provider === target.provider
  );
  if (idx >= 0) {
    providerMap.targets[idx] = { ...providerMap.targets[idx], ...target };
    return "updated";
  }
  providerMap.targets.push(target);
  return "created";
}

function buildSiteConfig(candidate, siteId, existingSite, registerIfNeeded) {
  const auth = existingSite?.auth || {};
  const settings = existingSite?.settings || {};
  return {
    id: siteId,
    type: "new-api",
    enabled: existingSite?.enabled ?? true,
    baseUrl: existingSite?.baseUrl || candidate.baseUrl || candidate.origin,
    auth: {
      ...auth,
      accessTokenSecret: auth.accessTokenSecret || `${siteId}_access_token`,
      userIdSecret: auth.userIdSecret || `${siteId}_user_id`,
      registerIfNeeded: auth.registerIfNeeded ?? registerIfNeeded
    },
    settings: {
      autoCreateToken: settings.autoCreateToken ?? true,
      autoTokenName: settings.autoTokenName || "openclaw-auto",
      autoTokenUnlimited: settings.autoTokenUnlimited ?? true,
      autoTokenRemainQuota: Number(settings.autoTokenRemainQuota ?? 0)
    },
    discovery: {
      from: "linuxdo-rss",
      discoveredAt: new Date().toISOString(),
      host: candidate.host,
      sourceTopics: candidate.sources || [],
      sampleUrls: candidate.urls || [],
      likelyNewApi: looksLikeNewApi(candidate)
    }
  };
}

function upsertSite(config, site) {
  config.sites ??= [];
  const idx = config.sites.findIndex((item) => item.id === site.id);
  if (idx >= 0) {
    config.sites[idx] = {
      ...config.sites[idx],
      ...site,
      auth: { ...(config.sites[idx].auth || {}), ...(site.auth || {}) },
      settings: { ...(config.sites[idx].settings || {}), ...(site.settings || {}) },
      discovery: { ...(config.sites[idx].discovery || {}), ...(site.discovery || {}) }
    };
    return "updated";
  }
  config.sites.push(site);
  return "created";
}

function isSiteRegistered(store, accessTokenSecret) {
  if (!store || !accessTokenSecret) {
    return false;
  }
  return Boolean(store.getSecret(accessTokenSecret)?.value);
}

function splitCsv(value = "") {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resetLinuxdoDiscovered(config, providerMap) {
  const removedIds = [];
  config.sites = (config.sites || []).filter((site) => {
    const matched = site?.discovery?.from === "linuxdo-rss";
    if (matched) {
      removedIds.push(site.id);
      return false;
    }
    return true;
  });
  const removedSet = new Set(removedIds);
  providerMap.targets = (providerMap.targets || []).filter((target) => !removedSet.has(target.siteId));
  return removedIds;
}

export async function upsertSitesFromDiscovery(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cwd = process.cwd();
  const discoveryPath = path.resolve(cwd, args.discovery || "data/linuxdo-public-sites.json");
  const configPath = path.resolve(cwd, args.config || "config/sites.json");
  const mapPath = path.resolve(cwd, args.map || "config/provider-map.json");
  const reportPath = path.resolve(cwd, args.report || "data/linuxdo-site-upsert-report.json");
  const storePath = path.resolve(cwd, args.store || "data/secrets.enc.json");
  const provider = args.provider || "openai";
  const strategy = args.strategy || "highest_quota";
  const registerIfNeeded = args["register-if-needed"] !== "false";
  const includeUnlikely = args["include-unlikely"] === true || args["include-unlikely"] === "true";
  const resetLinuxdo = args["reset-linuxdo"] === true || args["reset-linuxdo"] === "true";
  const dryRun = args["dry-run"] === true || args["dry-run"] === "true";
  const blockedHosts = new Set(DEFAULT_BLOCKED_HOSTS);
  for (const host of splitCsv(args["blocked-hosts"])) {
    blockedHosts.add(normalizeHost(host));
  }

  const discovery = await readJsonFile(discoveryPath);
  const config = await readOrDefault(configPath, { sites: [] });
  const providerMap = await readOrDefault(mapPath, { targets: [] });
  const candidates = Array.isArray(discovery.sites) ? discovery.sites : [];

  if (resetLinuxdo) {
    const removed = resetLinuxdoDiscovered(config, providerMap);
    info("reset linuxdo discovery", `removed=${removed.length}`);
  }

  let store = null;
  const masterEnv = args["master-key-env"] || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (masterKey) {
    store = await createStore(storePath, masterKey);
  } else {
    warn("master key missing", `skip registration state detection (${masterEnv})`);
  }

  const existingIds = new Set((config.sites || []).map((site) => site.id));
  const reportItems = [];
  let createdSites = 0;
  let updatedSites = 0;
  let registeredCount = 0;
  let skippedBlocked = 0;
  let skippedUnlikely = 0;

  for (const candidate of candidates) {
    const host = normalizeHost(candidate.host || "");
    if (blockedHosts.has(host)) {
      skippedBlocked += 1;
      reportItems.push({
        siteId: "",
        host: candidate.host,
        baseUrl: candidate.baseUrl || candidate.origin || "",
        existed: false,
        likelyNewApi: false,
        registered: false,
        onboardingNeeded: false,
        accessTokenSecret: "",
        userIdSecret: "",
        skipped: "blocked_host"
      });
      continue;
    }

    const likelyNewApi = looksLikeNewApi(candidate);
    if (!includeUnlikely && !likelyNewApi) {
      skippedUnlikely += 1;
      reportItems.push({
        siteId: "",
        host: candidate.host,
        baseUrl: candidate.baseUrl || candidate.origin || "",
        existed: false,
        likelyNewApi: false,
        registered: false,
        onboardingNeeded: false,
        accessTokenSecret: "",
        userIdSecret: "",
        skipped: "unlikely_site"
      });
      continue;
    }

    const existingSite = matchExistingSite(config.sites || [], candidate);
    const rawId = safeIdFromHost(candidate.host || "");
    if (!rawId) {
      continue;
    }
    const siteId = existingSite?.id || createUniqueSiteId(rawId, existingIds);
    existingIds.add(siteId);

    const siteConfig = buildSiteConfig(candidate, siteId, existingSite, registerIfNeeded);
    const result = upsertSite(config, siteConfig);
    if (result === "created") {
      createdSites += 1;
    } else {
      updatedSites += 1;
    }

    upsertProviderTarget(providerMap, {
      siteId,
      provider,
      strategy
    });

    const isRegistered = isSiteRegistered(store, siteConfig.auth.accessTokenSecret);
    if (isRegistered) {
      registeredCount += 1;
    }

    reportItems.push({
      siteId,
      host: candidate.host,
      baseUrl: siteConfig.baseUrl,
      existed: Boolean(existingSite),
      likelyNewApi: likelyNewApi,
      registered: isRegistered,
      onboardingNeeded: !isRegistered,
      accessTokenSecret: siteConfig.auth.accessTokenSecret,
      userIdSecret: siteConfig.auth.userIdSecret
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    source: discoveryPath,
    summary: {
      candidates: candidates.length,
      sitesCreated: createdSites,
      sitesUpdated: updatedSites,
      skippedBlocked,
      skippedUnlikely,
      registered: registeredCount,
      onboardingNeeded: reportItems.filter((item) => item.onboardingNeeded).length
    },
    items: reportItems
  };

  if (!dryRun) {
    await writeJson(configPath, config);
    await writeJson(mapPath, providerMap);
    await writeJson(reportPath, report);
  }

  info("upsert completed", `created=${createdSites} updated=${updatedSites} report=${reportPath}`);
  return report;
}

// CLI self-execution
if (process.argv[1] && process.argv[1].includes("upsert-sites")) {
  upsertSitesFromDiscovery().catch((err) => {
    error("upsert failed", err.message);
    process.exitCode = 1;
  });
}
