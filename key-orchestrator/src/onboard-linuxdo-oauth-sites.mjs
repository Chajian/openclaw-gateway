import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "./lib/args.mjs";
import { readJsonFile } from "./lib/json-file.mjs";
import { createStore } from "./lib/store.mjs";
import { error, info, warn } from "./lib/log.mjs";

const execFileAsync = promisify(execFile);

const CLICK_OAUTH_ENTRY_FN = `() => {
  const words = [
    "linuxdo",
    "linux do",
    "oauth",
    "third-party",
    "third party",
    "signin",
    "sign in",
    "login",
    "login with",
    "\\u767b\\u5f55",
    "\\u4f7f\\u7528"
  ];
  const nodes = Array.from(document.querySelectorAll("a,button,[role='button'],input[type='button'],input[type='submit']"));
  const pick = (el) => {
    const text = (el.innerText || el.textContent || el.value || "").trim().toLowerCase();
    const href = (el.getAttribute && el.getAttribute("href")) || "";
    const hit = words.some((w) => text.includes(w)) || /linux\\.do|oauth/i.test(href);
    if (!hit) return null;
    return { el, text, href };
  };
  for (const node of nodes) {
    const matched = pick(node);
    if (!matched) continue;
    matched.el.click();
    return { clicked: true, text: matched.text.slice(0, 120), href: matched.href || "" };
  }
  const link = document.querySelector("a[href*='linux.do'], a[href*='oauth']");
  if (link) {
    link.click();
    return {
      clicked: true,
      text: (link.textContent || "").trim().slice(0, 120),
      href: link.getAttribute("href") || ""
    };
  }
  return { clicked: false, href: location.href, host: location.hostname };
}`;

const APPROVE_OAUTH_FN = `() => {
  const words = [
    "authorize",
    "allow",
    "continue",
    "confirm",
    "agree",
    "accept",
    "\\u540c\\u610f",
    "\\u6388\\u6743",
    "\\u5141\\u8bb8",
    "\\u786e\\u8ba4"
  ];
  const nodes = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit']"));
  for (const node of nodes) {
    const text = (node.innerText || node.textContent || node.value || "").trim().toLowerCase();
    if (words.some((w) => text.includes(w))) {
      node.click();
      return { clicked: true, text: text.slice(0, 120), href: location.href };
    }
  }
  return { clicked: false, href: location.href };
}`;

const PROBE_AUTH_FN = `async () => {
  const local = {};
  const session = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    local[key] = localStorage.getItem(key);
  }
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    session[key] = sessionStorage.getItem(key);
  }

  const tokenCandidates = [];
  const userIdCandidates = [];

  const pushToken = (key, value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length < 8) return;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return;
    tokenCandidates.push({ key, value: trimmed });
  };

  const pushUserId = (key, value) => {
    if (value === undefined || value === null) return;
    const str = String(value).trim();
    if (!str) return;
    userIdCandidates.push({ key, value: str });
  };

  const appendCandidates = (source) => {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== "string") continue;
      const lowerKey = key.toLowerCase();

      if (/token|access|auth/i.test(lowerKey)) {
        pushToken(key, value);
      }
      if (/user.?id|uid|member.?id/i.test(lowerKey)) {
        pushUserId(key, value);
      }

      if ((value.startsWith("{") || value.startsWith("[")) && value.length < 50000) {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === "object") {
            for (const [innerKey, innerValue] of Object.entries(parsed)) {
              const lowerInner = innerKey.toLowerCase();
              if (/token|access|auth/i.test(lowerInner)) {
                pushToken(key + "." + innerKey, String(innerValue ?? ""));
              }
              if (/user.?id|uid|member.?id/i.test(lowerInner)) {
                pushUserId(key + "." + innerKey, innerValue);
              }
            }
          }
        } catch {}
      }
    }
  };

  appendCandidates(local);
  appendCandidates(session);

  const selectUserIdSeed = () => {
    for (const item of userIdCandidates) {
      if (/^\\d+$/.test(item.value)) return item.value;
    }
    return userIdCandidates[0]?.value || "";
  };

  const userIdSeed = selectUserIdSeed();

  const selectBestToken = () => {
    const preferred = ["access_token", "accesstoken", "token", "authorization"];
    for (const name of preferred) {
      const hit = tokenCandidates.find((item) => item.key.toLowerCase().includes(name));
      if (hit && hit.value.length >= 16) return hit.value;
    }
    const sorted = tokenCandidates
      .filter((item) => item.value.length >= 16)
      .sort((a, b) => b.value.length - a.value.length);
    return sorted[0]?.value || "";
  };

  const parseSelf = async (res) => {
    const body = await res.json().catch(() => null);
    const ok = body && (body.success === true || body.code === true);
    if (!res.ok || !ok) return null;
    return body.data || null;
  };

  const trySelf = async (token, userIdHint, bearer) => {
    if (!token) return null;
    const headers = {
      Accept: "application/json",
      Authorization: bearer ? ("Bearer " + token) : token
    };
    if (userIdHint) {
      headers["New-Api-User"] = String(userIdHint);
    }
    try {
      const res = await fetch("/api/user/self", {
        method: "GET",
        credentials: "include",
        headers
      });
      return await parseSelf(res);
    } catch {
      return null;
    }
  };

  const candidateToken = selectBestToken();
  let verifiedToken = "";
  let verifiedSelf = null;

  if (candidateToken) {
    verifiedSelf =
      (await trySelf(candidateToken, userIdSeed, false)) ||
      (await trySelf(candidateToken, userIdSeed, true)) ||
      (await trySelf(candidateToken, "", false)) ||
      (await trySelf(candidateToken, "", true));
    if (verifiedSelf) {
      verifiedToken = candidateToken;
    }
  }

  if (!verifiedToken) {
    try {
      const tokenRes = await fetch("/api/user/token", {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" }
      });
      const tokenJson = await tokenRes.json().catch(() => null);
      const ok = tokenJson && (tokenJson.success === true || tokenJson.code === true);
      const apiToken = ok && tokenJson.data ? String(tokenJson.data) : "";
      if (apiToken) {
        const self =
          (await trySelf(apiToken, userIdSeed, false)) ||
          (await trySelf(apiToken, userIdSeed, true)) ||
          (await trySelf(apiToken, "", false)) ||
          (await trySelf(apiToken, "", true));
        if (self) {
          verifiedToken = apiToken;
          verifiedSelf = self;
        }
      }
    } catch {}
  }

  const verifiedUserId = verifiedSelf && (verifiedSelf.id || verifiedSelf.user_id || verifiedSelf.userId || verifiedSelf.uid)
    ? String(verifiedSelf.id || verifiedSelf.user_id || verifiedSelf.userId || verifiedSelf.uid)
    : userIdSeed;

  return {
    href: location.href,
    host: location.hostname,
    accessToken: verifiedToken,
    userId: verifiedUserId,
    hasAccessToken: Boolean(verifiedToken),
    hasUserId: Boolean(verifiedUserId),
    storageKeys: Object.keys(local).length + Object.keys(session).length
  };
}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHost(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

function hostFromUrl(urlString) {
  try {
    return normalizeHost(new URL(urlString).hostname);
  } catch {
    return "";
  }
}

function parseMaybeJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function runBrowserCommand(cliPath, browserProfile, browserArgs) {
  const { stdout, stderr } = await execFileAsync(
    "node",
    [cliPath, "browser", "--browser-profile", browserProfile, ...browserArgs],
    {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60_000
    }
  );
  if (stderr && stderr.trim()) {
    warn("browser stderr", stderr.trim());
  }
  return String(stdout || "").trim();
}

async function safeEvaluateOnTarget({ cliPath, browserProfile, targetId, fn }) {
  try {
    const raw = await runBrowserCommand(cliPath, browserProfile, [
      "evaluate",
      "--target-id",
      targetId,
      "--fn",
      fn
    ]);
    return {
      ok: true,
      value: parseMaybeJson(raw)
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err)
    };
  }
}

async function openBrowserTab(cliPath, browserProfile, initialUrl) {
  const raw = await runBrowserCommand(cliPath, browserProfile, ["--json", "open", initialUrl]);
  const parsed = parseMaybeJson(raw);
  if (!parsed?.targetId) {
    throw new Error("failed to open browser tab");
  }
  return parsed.targetId;
}

async function listBrowserPageTabs(cliPath, browserProfile) {
  try {
    const raw = await runBrowserCommand(cliPath, browserProfile, ["--json", "tabs"]);
    const parsed = parseMaybeJson(raw);
    const tabs = Array.isArray(parsed?.tabs) ? parsed.tabs : [];
    return tabs
      .filter((tab) => tab?.type === "page")
      .map((tab) => ({ ...tab, host: hostFromUrl(tab.url || "") }));
  } catch {
    return [];
  }
}

function getOrigin(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "";
  }
}

function buildLoginUrls(baseUrl) {
  const origin = getOrigin(baseUrl);
  if (!origin) {
    return [];
  }
  const urls = [
    `${origin}/login`,
    `${origin}/user/login`,
    `${origin}/auth/login`,
    `${origin}/oauth/linuxdo`,
    baseUrl,
    origin
  ];
  return Array.from(new Set(urls));
}

function selectSitesForOnboarding(config, report, store, includeAll) {
  const reportMap = new Map();
  for (const item of report?.items || []) {
    reportMap.set(item.siteId, item);
  }

  const out = [];
  for (const site of config.sites || []) {
    if (site.type !== "new-api" || site.enabled === false) {
      continue;
    }
    const accessTokenSecret = site.auth?.accessTokenSecret || `${site.id}_access_token`;
    const already = Boolean(store?.getSecret(accessTokenSecret)?.value);
    const reportItem = reportMap.get(site.id);
    if (!includeAll) {
      // In scheduled mode, only onboard sites from the latest upsert report.
      if (!reportItem) {
        continue;
      }
      if (reportItem.onboardingNeeded === false) {
        continue;
      }
      if (already) {
        continue;
      }
    }
    out.push(site);
  }
  return out;
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

function buildTargetCandidates(tabs, primaryTargetId, siteHost) {
  const out = [];
  const seen = new Set();
  const pushTab = (tab) => {
    if (!tab?.targetId || seen.has(tab.targetId)) {
      return;
    }
    seen.add(tab.targetId);
    out.push(tab);
  };

  const primary = tabs.find((tab) => tab.targetId === primaryTargetId);
  if (primary) {
    pushTab(primary);
  }
  for (const tab of tabs) {
    if (tab.host === siteHost) {
      pushTab(tab);
    }
  }
  for (const tab of tabs) {
    if (tab.host && siteHost && tab.host.endsWith(`.${siteHost}`)) {
      pushTab(tab);
    }
  }
  for (const tab of tabs) {
    if (tab.host === "linux.do") {
      pushTab(tab);
    }
  }
  for (const tab of tabs) {
    pushTab(tab);
  }
  return out;
}

async function probeAcrossTargets({ cliPath, browserProfile, primaryTargetId, siteHost, approve }) {
  const tabs = await listBrowserPageTabs(cliPath, browserProfile);
  const candidates = buildTargetCandidates(tabs, primaryTargetId, siteHost);

  if (approve) {
    for (const tab of candidates) {
      if (tab.host !== "linux.do") {
        continue;
      }
      await safeEvaluateOnTarget({
        cliPath,
        browserProfile,
        targetId: tab.targetId,
        fn: APPROVE_OAUTH_FN
      });
    }
  }

  for (const tab of candidates) {
    if (tab.host === "linux.do") {
      continue;
    }
    if (siteHost && tab.host && tab.host !== siteHost && !tab.host.endsWith(`.${siteHost}`)) {
      continue;
    }

    if (approve) {
      await safeEvaluateOnTarget({
        cliPath,
        browserProfile,
        targetId: tab.targetId,
        fn: APPROVE_OAUTH_FN
      });
    }

    const probeRes = await safeEvaluateOnTarget({
      cliPath,
      browserProfile,
      targetId: tab.targetId,
      fn: PROBE_AUTH_FN
    });
    if (!probeRes.ok) {
      continue;
    }
    const probe = probeRes.value;
    if (probe?.hasAccessToken) {
      return {
        targetId: tab.targetId,
        probe
      };
    }
  }
  return null;
}

async function attemptOnboardSite(site, opts) {
  const accessTokenSecret = site.auth?.accessTokenSecret || `${site.id}_access_token`;
  const userIdSecret = site.auth?.userIdSecret || `${site.id}_user_id`;
  const loginUrls = buildLoginUrls(site.baseUrl || site.url || "");
  if (!loginUrls.length) {
    return {
      siteId: site.id,
      status: "failed",
      reason: "invalid baseUrl"
    };
  }

  const siteHost = hostFromUrl(site.baseUrl || site.url || "");
  let targetId = await openBrowserTab(opts.cliPath, opts.browserProfile, loginUrls[0]);

  const preProbe = await probeAcrossTargets({
    cliPath: opts.cliPath,
    browserProfile: opts.browserProfile,
    primaryTargetId: targetId,
    siteHost,
    approve: false
  });
  if (preProbe?.probe?.hasAccessToken) {
    return {
      siteId: site.id,
      status: "success",
      accessToken: preProbe.probe.accessToken,
      userId: preProbe.probe.userId || "",
      accessTokenSecret,
      userIdSecret,
      currentUrl: preProbe.probe.href || "",
      host: preProbe.probe.host || ""
    };
  }

  let entryClicked = false;
  for (const loginUrl of loginUrls) {
    info("navigate", `${site.id} -> ${loginUrl}`);
    await runBrowserCommand(opts.cliPath, opts.browserProfile, ["navigate", loginUrl, "--target-id", targetId]);

    const afterNavProbe = await probeAcrossTargets({
      cliPath: opts.cliPath,
      browserProfile: opts.browserProfile,
      primaryTargetId: targetId,
      siteHost,
      approve: false
    });
    if (afterNavProbe?.probe?.hasAccessToken) {
      return {
        siteId: site.id,
        status: "success",
        accessToken: afterNavProbe.probe.accessToken,
        userId: afterNavProbe.probe.userId || "",
        accessTokenSecret,
        userIdSecret,
        currentUrl: afterNavProbe.probe.href || "",
        host: afterNavProbe.probe.host || ""
      };
    }

    const clickRes = await safeEvaluateOnTarget({
      cliPath: opts.cliPath,
      browserProfile: opts.browserProfile,
      targetId,
      fn: CLICK_OAUTH_ENTRY_FN
    });
    const clickResult = clickRes.ok ? clickRes.value : null;
    if (clickResult?.clicked) {
      entryClicked = true;
      info("oauth entry clicked", `${site.id} ${clickResult.text || ""}`.trim());
      await sleep(1200);

      const probeAfterClick = await probeAcrossTargets({
        cliPath: opts.cliPath,
        browserProfile: opts.browserProfile,
        primaryTargetId: targetId,
        siteHost,
        approve: true
      });
      if (probeAfterClick?.probe?.hasAccessToken) {
        return {
          siteId: site.id,
          status: "success",
          accessToken: probeAfterClick.probe.accessToken,
          userId: probeAfterClick.probe.userId || "",
          accessTokenSecret,
          userIdSecret,
          currentUrl: probeAfterClick.probe.href || "",
          host: probeAfterClick.probe.host || ""
        };
      }
      break;
    }

    const hrefRes = await safeEvaluateOnTarget({
      cliPath: opts.cliPath,
      browserProfile: opts.browserProfile,
      targetId,
      fn: "() => location.href"
    });
    const currentUrl = hrefRes.ok ? hrefRes.value : "";
    if (typeof currentUrl === "string" && /linux\\.do/i.test(currentUrl)) {
      entryClicked = true;
      break;
    }
  }

  if (!entryClicked) {
    const finalProbe = await probeAcrossTargets({
      cliPath: opts.cliPath,
      browserProfile: opts.browserProfile,
      primaryTargetId: targetId,
      siteHost,
      approve: false
    });
    if (finalProbe?.probe?.hasAccessToken) {
      return {
        siteId: site.id,
        status: "success",
        accessToken: finalProbe.probe.accessToken,
        userId: finalProbe.probe.userId || "",
        accessTokenSecret,
        userIdSecret,
        currentUrl: finalProbe.probe.href || "",
        host: finalProbe.probe.host || ""
      };
    }
    return {
      siteId: site.id,
      status: "manual_required",
      reason: "oauth entry not found"
    };
  }

  for (let i = 0; i < opts.maxPoll; i += 1) {
    const polled = await probeAcrossTargets({
      cliPath: opts.cliPath,
      browserProfile: opts.browserProfile,
      primaryTargetId: targetId,
      siteHost,
      approve: true
    });
    if (polled?.probe?.hasAccessToken) {
      return {
        siteId: site.id,
        status: "success",
        accessToken: polled.probe.accessToken,
        userId: polled.probe.userId || "",
        accessTokenSecret,
        userIdSecret,
        currentUrl: polled.probe.href || "",
        host: polled.probe.host || ""
      };
    }
    await sleep(opts.pollIntervalMs);
  }

  return {
    siteId: site.id,
    status: "manual_required",
    reason: "timeout waiting for oauth callback/token"
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const configPath = path.resolve(cwd, args.config || "config/sites.json");
  const reportPath = path.resolve(cwd, args.report || "data/linuxdo-site-upsert-report.json");
  const storePath = path.resolve(cwd, args.store || "data/secrets.enc.json");
  const outPath = path.resolve(cwd, args.out || "data/linuxdo-onboard-report.json");
  const cliPath = args["openclaw-cli"] || "C:\\Users\\KSG\\openclaw\\dist\\index.js";
  const browserProfile = args["browser-profile"] || "openclaw";
  const maxPoll = Number(args["max-poll"] || 20);
  const pollIntervalMs = Number(args["poll-interval-ms"] || 3000);
  const limit = Number(args.limit || 20);
  const includeAll = args["include-all"] === true || args["include-all"] === "true";
  const siteFilter = new Set(splitCsv(args["site-id"] || args.site || ""));
  const dryRun = args["dry-run"] === true || args["dry-run"] === "true";

  const masterEnv = args["master-key-env"] || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (!masterKey && !dryRun) {
    throw new Error(`Missing env ${masterEnv}`);
  }

  const config = await readJsonFile(configPath);
  let report = null;
  try {
    report = await readJsonFile(reportPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  const store = masterKey ? await createStore(storePath, masterKey) : null;
  let targets = selectSitesForOnboarding(config, report, store, includeAll);
  if (siteFilter.size) {
    targets = targets.filter((site) => siteFilter.has(site.id));
  }
  targets = targets.slice(0, limit);
  info("onboarding targets", String(targets.length));

  const results = [];
  for (const site of targets) {
    try {
      const result = await attemptOnboardSite(site, {
        cliPath,
        browserProfile,
        maxPoll,
        pollIntervalMs
      });
      if (result.status === "success" && !dryRun) {
        store.setSecret(result.accessTokenSecret, result.accessToken);
        if (result.userId) {
          store.setSecret(result.userIdSecret, String(result.userId));
        }
      }
      results.push({
        siteId: result.siteId,
        status: result.status,
        reason: result.reason || "",
        accessTokenSecret: result.accessTokenSecret || site.auth?.accessTokenSecret || `${site.id}_access_token`,
        userIdSecret: result.userIdSecret || site.auth?.userIdSecret || `${site.id}_user_id`,
        currentUrl: result.currentUrl || ""
      });
      info("onboard result", `${site.id} ${result.status}`);
    } catch (err) {
      warn("onboard error", `${site.id}: ${err.message}`);
      results.push({
        siteId: site.id,
        status: "failed",
        reason: err.message,
        accessTokenSecret: site.auth?.accessTokenSecret || `${site.id}_access_token`,
        userIdSecret: site.auth?.userIdSecret || `${site.id}_user_id`,
        currentUrl: ""
      });
    }
  }

  if (!dryRun && store) {
    await store.save();
  }

  const summary = {
    total: results.length,
    success: results.filter((item) => item.status === "success").length,
    manualRequired: results.filter((item) => item.status === "manual_required").length,
    failed: results.filter((item) => item.status === "failed").length
  };
  const payload = {
    generatedAt: new Date().toISOString(),
    summary,
    results
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  info("onboarding done", `${outPath} success=${summary.success}`);
}

main().catch((err) => {
  error("onboard failed", err.message);
  process.exitCode = 1;
});
