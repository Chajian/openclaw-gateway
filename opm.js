#!/usr/bin/env node
// opm-lite — OpenClaw LLM Provider Manager (lightweight, zero-dependency)
// Directly reads/writes openclaw.json + docker compose operations.
// Usage:  node opm.js [command] [options]
//         node opm.js            (interactive menu)

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");
const { execSync, spawn } = require("child_process");
const readline = require("readline");

// ─── Constants ───────────────────────────────────────────────────────────────

const CONFIG_PATH = "C:/Users/KSG/.openclaw/openclaw.json";
const COMPOSE_FILE = "C:/Users/KSG/openclaw/docker-compose.yml";
const COMPOSE_CMD = `docker compose -f "${COMPOSE_FILE}"`;
const GATEWAY_SERVICE = "openclaw-gateway";
const DEFAULT_UA = "curl/8.5.0";
const MENU_SEP = "=".repeat(40);

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_INPUTS = ["text", "image"];
const DEFAULT_API = "openai-completions";
const DEFAULT_TIMEOUT = 15; // seconds per request

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) { process.stdout.write(msg + "\n"); }
function err(msg) { process.stderr.write(msg + "\n"); }

function getProxy() {
  const p = process.env.https_proxy || process.env.HTTPS_PROXY
         || process.env.http_proxy  || process.env.HTTP_PROXY || "";
  if (!p) return null;
  try {
    const u = new URL(p);
    return { host: u.hostname, port: parseInt(u.port, 10) || 1080 };
  } catch { return null; }
}

// ─── HTTP with proxy support ─────────────────────────────────────────────────

function httpRequest(urlStr, opts = {}) {
  const { method = "GET", headers = {}, body = null, timeoutSec = DEFAULT_TIMEOUT } = opts;
  const parsed = new URL(urlStr);
  const proxy = getProxy();

  return new Promise((resolve, reject) => {
    const onResponse = (res) => {
      // Handle gzip / deflate / br decompression
      let stream = res;
      const encoding = (res.headers["content-encoding"] || "").toLowerCase();
      if (encoding === "gzip" || encoding === "x-gzip") {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === "deflate") {
        stream = res.pipe(zlib.createInflate());
      } else if (encoding === "br") {
        stream = res.pipe(zlib.createBrotliDecompress());
      }
      // Note: zstd not supported by Node.js zlib — will fall through as raw

      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve({ status: res.statusCode, text, headers: res.headers });
      });
      stream.on("error", (e) => {
        // Decompression failed — return raw buffer as text
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve({ status: res.statusCode, text, headers: res.headers });
      });
    };

    const reqHeaders = {
      "User-Agent": DEFAULT_UA,
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate, br",
      ...headers,
    };

    if (proxy && parsed.protocol === "https:") {
      // HTTP CONNECT tunnel
      const connectReq = http.request({
        host: proxy.host,
        port: proxy.port,
        method: "CONNECT",
        path: `${parsed.hostname}:${parsed.port || 443}`,
        headers: { Host: `${parsed.hostname}:${parsed.port || 443}` },
        timeout: timeoutSec * 1000,
      });
      connectReq.on("connect", (_res, socket) => {
        const req = https.request({
          socket,
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname + parsed.search,
          method,
          headers: reqHeaders,
          timeout: timeoutSec * 1000,
        }, onResponse);
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        if (body) req.write(body);
        req.end();
      });
      connectReq.on("error", reject);
      connectReq.on("timeout", () => { connectReq.destroy(); reject(new Error("proxy timeout")); });
      connectReq.end();
    } else {
      const mod = parsed.protocol === "https:" ? https : http;
      const req = mod.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: reqHeaders,
        timeout: timeoutSec * 1000,
      }, onResponse);
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      if (body) req.write(body);
      req.end();
    }
  });
}

// ─── Config Read/Write ───────────────────────────────────────────────────────

function loadConfig() {
  let raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  // Strip BOM if present
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

function saveConfig(cfg) {
  // backup
  const bak = CONFIG_PATH + ".bak";
  try { fs.copyFileSync(CONFIG_PATH, bak); } catch {}
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

function normalizeBaseUrl(url) {
  let u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(u)) throw new Error("base-url 必须以 http:// 或 https:// 开头");
  return u;
}

// ─── Provider API Interaction ────────────────────────────────────────────────

async function fetchModels(baseUrl, apiKey, timeoutSec = DEFAULT_TIMEOUT) {
  const base = normalizeBaseUrl(baseUrl);

  // Try the URL as-is first, then fallback with /v1 if it doesn't end with /v1 or /v1/
  const urls = [base];
  if (!/\/v1\/?$/.test(base)) urls.push(base + "/v1");

  for (const b of urls) {
    const url = `${b}/models`;
    try {
      const res = await httpRequest(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutSec,
      });
      if (res.status !== 200) {
        // If this is a non-JSON response (HTML page etc.), try next URL
        if (urls.indexOf(b) < urls.length - 1 && !res.text.trimStart().startsWith("{")) continue;
        return { ok: false, status: res.status, models: [], detail: res.text.slice(0, 500) };
      }
      let data;
      try { data = JSON.parse(res.text); } catch {
        // JSON parse failed — probably HTML, try next URL
        if (urls.indexOf(b) < urls.length - 1) continue;
        return { ok: false, status: res.status, models: [], detail: `非JSON响应: ${res.text.slice(0, 200)}` };
      }
      const items = (data && Array.isArray(data.data)) ? data.data : [];
      const ids = [];
      const seen = new Set();
      for (const item of items) {
        if (item && item.id && !seen.has(item.id)) {
          seen.add(item.id);
          ids.push(String(item.id));
        }
      }
      if (ids.length > 0) {
        // If we succeeded with /v1 fallback, remember effective base
        return { ok: true, status: res.status, models: ids, detail: "", effectiveBase: b };
      }
      return { ok: false, status: res.status, models: [], detail: "返回模型列表为空" };
    } catch (e) {
      // Network error on this URL — try next
      if (urls.indexOf(b) < urls.length - 1) continue;
      return { ok: false, status: null, models: [], detail: String(e) };
    }
  }
  return { ok: false, status: null, models: [], detail: "所有URL均失败" };
}

async function probeChatModel(baseUrl, apiKey, modelId, timeoutSec = DEFAULT_TIMEOUT) {
  const base = normalizeBaseUrl(baseUrl);
  const urls = [base];
  if (!/\/v1\/?$/.test(base)) urls.push(base + "/v1");

  for (const b of urls) {
    const url = `${b}/chat/completions`;
    const reqBody = JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 8,
    });
    try {
      const res = await httpRequest(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: reqBody,
        timeoutSec,
      });
      if (res.status === 200) return { ok: true, status: res.status, detail: res.text.slice(0, 200) };
      // If HTML response and we have fallback, try next
      if (urls.indexOf(b) < urls.length - 1 && !res.text.trimStart().startsWith("{")) continue;
      return { ok: false, status: res.status, detail: res.text.slice(0, 200) };
    } catch (e) {
      if (urls.indexOf(b) < urls.length - 1) continue;
      return { ok: false, status: 0, detail: String(e) };
    }
  }
  return { ok: false, status: 0, detail: "所有URL均失败" };
}

async function filterModelsByChat(baseUrl, apiKey, modelIds, { timeoutSec = DEFAULT_TIMEOUT, prefix = "" } = {}) {
  const ok = [];
  const bad = [];
  const total = modelIds.length;
  const pfx = prefix ? `[${prefix}] ` : "";

  for (let i = 0; i < total; i++) {
    const mid = modelIds[i];
    const result = await probeChatModel(baseUrl, apiKey, mid, timeoutSec);
    if (result.ok) {
      ok.push(mid);
      log(`${pfx}${i + 1}/${total} ✅ ${mid}`);
    } else {
      bad.push(mid);
      const c = result.status ? ` HTTP:${result.status}` : "";
      log(`${pfx}${i + 1}/${total} ❌ ${mid}${c}`);
    }
  }
  return { ok, bad };
}

// ─── Model Object Builder ────────────────────────────────────────────────────

function buildProviderModels(providerName, modelIds, inputs = DEFAULT_INPUTS, contextWindow = DEFAULT_CONTEXT_WINDOW, maxTokens = DEFAULT_MAX_TOKENS) {
  return modelIds.map((mid) => ({
    id: mid,
    name: `${providerName} / ${mid}`,
    input: [...inputs],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  }));
}

// ─── Docker Operations ───────────────────────────────────────────────────────

function dockerExec(action, live = false) {
  const cmds = {
    restart: `${COMPOSE_CMD} restart ${GATEWAY_SERVICE}`,
    start:   `${COMPOSE_CMD} up -d ${GATEWAY_SERVICE}`,
    stop:    `${COMPOSE_CMD} stop ${GATEWAY_SERVICE}`,
    status:  `${COMPOSE_CMD} ps ${GATEWAY_SERVICE}`,
    logs:    `${COMPOSE_CMD} logs ${GATEWAY_SERVICE} --tail 30`,
  };
  const cmd = cmds[action];
  if (!cmd) { err(`未知操作: ${action}`); return false; }

  try {
    if (live) {
      const result = execSync(cmd, { stdio: "inherit", timeout: 60000 });
      return true;
    } else {
      const out = execSync(cmd, { encoding: "utf-8", timeout: 60000 });
      log(out.trim());
      return true;
    }
  } catch (e) {
    err(`Docker 操作失败: ${e.message}`);
    return false;
  }
}

// ─── Readline Utility ────────────────────────────────────────────────────────

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

// ─── Commands ────────────────────────────────────────────────────────────────

// ── list ──
async function cmdList() {
  const cfg = loadConfig();
  const providers = (cfg.models && cfg.models.providers) || {};
  const defaultsModels = (cfg.agents && cfg.agents.defaults && cfg.agents.defaults.models) || {};
  const primary = (cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model && cfg.agents.defaults.model.primary) || "(未设置)";
  const names = Object.keys(providers).sort();

  log(`\nProvider 数量: ${names.length}`);
  log(`当前默认模型: ${primary}\n`);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const pobj = providers[name] || {};
    const modelCount = Array.isArray(pobj.models) ? pobj.models.length : 0;
    const regCount = Object.keys(defaultsModels).filter((k) => k.startsWith(name + "/")).length;
    log(`${i + 1}. ${name}: provider模型=${modelCount}, 已注册=${regCount}`);
  }
  log("");
  return 0;
}

// ── check ──
async function cmdCheck(providerSel) {
  const cfg = loadConfig();
  const providers = (cfg.models && cfg.models.providers) || {};
  const names = Object.keys(providers).sort();

  if (names.length === 0) {
    log("❌ 未找到已添加的 provider");
    return 1;
  }

  const targets = providerSel ? resolveProviders(providerSel, names) : names;
  if (targets.length === 0) {
    log("❌ 未匹配到有效 provider");
    return 1;
  }

  log(`\n检测目标 provider 数: ${targets.length}`);
  let okCount = 0, badCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const pname = targets[i];
    const pobj = providers[pname] || {};
    const baseUrl = pobj.baseUrl || "";
    const apiKey = pobj.apiKey || "";

    if (!baseUrl || !apiKey) {
      log(`${i + 1}. ❌ ${pname}  配置缺失(baseUrl/apiKey)`);
      badCount++;
      continue;
    }
    const result = await fetchModels(baseUrl, apiKey);
    if (result.ok) {
      log(`${i + 1}. ✅ ${pname}  HTTP:${result.status}  模型数:${result.models.length}`);
      okCount++;
    } else {
      log(`${i + 1}. ❌ ${pname}  HTTP:${result.status}  详情:${(result.detail || "").slice(0, 120)}`);
      badCount++;
    }
  }

  log(MENU_SEP);
  log(`检测结果：可用 ${okCount} 个，不可用 ${badCount} 个\n`);
  return badCount > 0 ? 2 : 0;
}

// ── add ──
async function cmdAdd({ name, baseUrl, apiKey, api = DEFAULT_API, inputs = DEFAULT_INPUTS, contextWindow = DEFAULT_CONTEXT_WINDOW, maxTokens = DEFAULT_MAX_TOKENS, noRestart = false, timeoutSec = DEFAULT_TIMEOUT } = {}) {
  const rl = createRL();
  try {
    if (!name) name = await ask(rl, "请输入 provider 名称: ");
    if (!name) { log("❌ provider name 不能为空"); return 1; }
    if (!baseUrl) baseUrl = await ask(rl, "请输入 base-url (如 https://api.xxx.com/v1): ");
    baseUrl = normalizeBaseUrl(baseUrl);
    if (!apiKey) apiKey = await ask(rl, "请输入 api-key: ");
    if (!apiKey) { log("❌ api-key 不能为空"); return 1; }
  } finally { rl.close(); }

  log(`\n➡️ 检测 API: ${baseUrl}`);
  const fm = await fetchModels(baseUrl, apiKey, timeoutSec);
  if (!fm.ok) {
    log(`❌ API 检测失败  HTTP:${fm.status}`);
    log(`详情: ${fm.detail.slice(0, 500)}`);
    return 2;
  }
  log(`✅ API 可用，模型数: ${fm.models.length}`);

  log(`\n➡️ 探测 chat/completions 可用模型...`);
  const { ok: okModels, bad: badModels } = await filterModelsByChat(baseUrl, apiKey, fm.models, { timeoutSec, prefix: name });

  if (badModels.length > 0) log(`⚠️ 已过滤 chat 不可用模型: ${badModels.length}`);
  if (okModels.length === 0) { log("❌ 过滤后没有可用模型，取消添加"); return 2; }

  const cfg = loadConfig();
  if (!cfg.models) cfg.models = {};
  if (!cfg.models.providers) cfg.models.providers = {};

  cfg.models.providers[name] = {
    baseUrl,
    apiKey,
    api,
    models: buildProviderModels(name, okModels, inputs, contextWindow, maxTokens),
  };

  // Register in agents.defaults.models
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.defaults) cfg.agents.defaults = {};
  if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};

  let added = 0;
  for (const mid of okModels) {
    const key = `${name}/${mid}`;
    if (!(key in cfg.agents.defaults.models)) {
      cfg.agents.defaults.models[key] = {};
      added++;
    }
  }

  saveConfig(cfg);

  if (!noRestart) {
    log("\n➡️ 重启 gateway...");
    dockerExec("restart", true);
  }

  log(`\n✅ 添加完成`);
  log(`provider: ${name}`);
  log(`可用模型: ${okModels.length}`);
  log(`新注册到 agents.defaults.models: ${added}\n`);
  return 0;
}

// ── remove ──
async function cmdRemove(nameSel) {
  const cfg = loadConfig();
  const providers = (cfg.models && cfg.models.providers) || {};
  const names = Object.keys(providers).sort();

  let targets = [];
  if (nameSel) {
    targets = resolveProviders(nameSel, names);
  } else {
    const rl = createRL();
    try {
      log("\n当前 provider 列表:");
      names.forEach((n, i) => log(`${i + 1}. ${n}`));
      const sel = await ask(rl, "\n请输入要删除的序号或名称 (空格分隔多个, q取消): ");
      if (sel.toLowerCase() === "q") { log("已取消"); return 0; }
      targets = resolveProviders(sel, names);
    } finally { rl.close(); }
  }

  if (targets.length === 0) { log("❌ 未匹配到要删除的 provider"); return 1; }

  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.defaults) cfg.agents.defaults = {};
  if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};
  const defaultsModels = cfg.agents.defaults.models;

  const removed = [];
  for (const pname of targets) {
    if (pname in providers) {
      delete providers[pname];
      removed.push(pname);
    }
    // Clean registered models
    for (const key of Object.keys(defaultsModels)) {
      if (key.startsWith(pname + "/")) delete defaultsModels[key];
    }
  }

  // If primary model belongs to removed provider, clear it
  const primary = (cfg.agents.defaults.model && cfg.agents.defaults.model.primary) || "";
  if (removed.some((p) => primary.startsWith(p + "/"))) {
    cfg.agents.defaults.model.primary = "";
    log("⚠️ 默认模型已属于被删除的 provider，已清空");
  }

  saveConfig(cfg);
  log(`\n✅ 已删除 provider: ${removed.length > 0 ? removed.join(", ") : "无"}`);

  log("\n➡️ 重启 gateway...");
  dockerExec("restart", true);
  return 0;
}

// ── sync ──
async function cmdSync(providerSel, { noRestart = false, timeoutSec = DEFAULT_TIMEOUT } = {}) {
  const cfg = loadConfig();
  const providers = (cfg.models && cfg.models.providers) || {};
  const names = Object.keys(providers).sort();

  const targets = providerSel ? resolveProviders(providerSel, names) : names;
  if (targets.length === 0) { log("❌ 未匹配到要同步的 provider"); return 1; }

  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.defaults) cfg.agents.defaults = {};
  if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};
  const defaultsModels = cfg.agents.defaults.models;

  let totalAdded = 0, totalRemoved = 0;

  for (const pname of targets) {
    const pobj = providers[pname] || {};
    const baseUrl = pobj.baseUrl || "";
    const apiKey = pobj.apiKey || "";

    if (!baseUrl || !apiKey) {
      log(`⚠️ ${pname}: 配置缺失，跳过`);
      continue;
    }

    // Fetch fresh model list from API
    log(`\n➡️ [${pname}] 拉取模型列表...`);
    const fm = await fetchModels(baseUrl, apiKey, timeoutSec);
    if (!fm.ok) {
      log(`❌ [${pname}] API 不可用 HTTP:${fm.status}  ${fm.detail.slice(0, 120)}`);
      continue;
    }
    log(`[${pname}] API 可用，模型数: ${fm.models.length}`);

    // Probe chat availability
    log(`[${pname}] 探测 chat 可用性...`);
    const { ok: okIds, bad: badIds } = await filterModelsByChat(baseUrl, apiKey, fm.models, { timeoutSec, prefix: pname });

    const validSet = new Set(okIds.map((m) => `${pname}/${m}`));

    // Update provider models in config
    pobj.models = buildProviderModels(pname, okIds, DEFAULT_INPUTS, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS);
    if (!pobj.api) pobj.api = DEFAULT_API;
    providers[pname] = pobj;

    // Remove invalid from defaults
    let rmThis = 0;
    for (const key of Object.keys(defaultsModels)) {
      if (key.startsWith(pname + "/") && !validSet.has(key)) {
        delete defaultsModels[key];
        totalRemoved++;
        rmThis++;
      }
    }

    // Add new valid models
    let addThis = 0;
    for (const mid of okIds) {
      const key = `${pname}/${mid}`;
      if (!(key in defaultsModels)) {
        defaultsModels[key] = {};
        totalAdded++;
        addThis++;
      }
    }

    const regNow = Object.keys(defaultsModels).filter((k) => k.startsWith(pname + "/")).length;
    log(`${pname}: API模型=${fm.models.length}, 可用=${okIds.length}, 不可用=${badIds.length}, 新增=${addThis}, 移除=${rmThis}, 已注册=${regNow}`);
  }

  saveConfig(cfg);

  if (!noRestart) {
    log("\n➡️ 重启 gateway...");
    dockerExec("restart", true);
  }

  log(`\n✅ 同步完成：新增可用模型 ${totalAdded}，移除不可用/失效模型 ${totalRemoved}\n`);
  return 0;
}

// ── switch ──
async function cmdSwitch({ provider, model, noRestart = false } = {}) {
  const cfg = loadConfig();
  const providers = (cfg.models && cfg.models.providers) || {};
  const names = Object.keys(providers).sort();
  const rl = createRL();

  try {
    // Select provider
    let pname = "";
    if (provider) {
      const sel = resolveProviders(provider, names);
      pname = sel[0] || provider;
    }
    if (!pname || !(pname in providers)) {
      log("\n请选择 provider:");
      names.forEach((n, i) => log(`${i + 1}. ${n}`));
      const inp = await ask(rl, "\nprovider (序号或名称, q取消): ");
      if (inp.toLowerCase() === "q") { log("已取消"); return 0; }
      const sel = resolveProviders(inp, names);
      pname = sel[0] || inp;
    }
    if (!(pname in providers)) { log(`❌ provider 不存在: ${pname}`); return 1; }

    const models = providers[pname].models || [];
    if (models.length === 0) { log(`❌ ${pname} 没有模型`); return 1; }

    // Select model
    let mid = null;
    if (model) {
      if (/^\d+$/.test(model)) {
        const idx = parseInt(model, 10);
        if (idx >= 1 && idx <= models.length) mid = models[idx - 1].id || models[idx - 1];
      } else {
        mid = model;
      }
    }
    if (!mid) {
      log(`\n模型列表 (${pname}):`);
      models.forEach((m, i) => {
        const id = typeof m === "object" ? m.id : m;
        log(`${i + 1}. ${id}`);
      });
      const inp = await ask(rl, "\n模型序号或名称 (空回车=第1个, q取消): ");
      if (inp.toLowerCase() === "q") { log("已取消"); return 0; }
      if (!inp) {
        mid = typeof models[0] === "object" ? models[0].id : models[0];
      } else if (/^\d+$/.test(inp)) {
        const idx = parseInt(inp, 10);
        if (idx >= 1 && idx <= models.length) {
          mid = typeof models[idx - 1] === "object" ? models[idx - 1].id : models[idx - 1];
        }
      } else {
        mid = inp;
      }
    }
    if (!mid) { log("❌ 无效的模型选择"); return 1; }

    const target = `${pname}/${mid}`;

    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (!cfg.agents.defaults.model) cfg.agents.defaults.model = {};
    cfg.agents.defaults.model.primary = target;

    saveConfig(cfg);
    log(`\n✅ 默认模型已切换为: ${target}`);

    if (!noRestart) {
      log("\n➡️ 重启 gateway...");
      dockerExec("restart", true);
    }
    return 0;
  } finally { rl.close(); }
}

// ── restart / status / logs ──
async function cmdRestart() { log("\n➡️ 重启 gateway..."); dockerExec("restart", true); return 0; }
async function cmdStatus()  { log(""); dockerExec("status"); return 0; }
async function cmdLogs()    { log(""); dockerExec("logs", true); return 0; }

// ─── Provider Selection Helper ───────────────────────────────────────────────

function resolveProviders(sel, names) {
  const tokens = String(sel).replace(/[,;]/g, " ").split(/\s+/).filter(Boolean);
  const result = [];
  const seen = new Set();
  for (const t of tokens) {
    let name = null;
    if (/^\d+$/.test(t)) {
      const idx = parseInt(t, 10);
      if (idx >= 1 && idx <= names.length) name = names[idx - 1];
    } else {
      if (names.includes(t)) name = t;
    }
    if (name && !seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

// ─── Interactive Menu ────────────────────────────────────────────────────────

async function menuLoop() {
  while (true) {
    const cfg = loadConfig();
    const providers = (cfg.models && cfg.models.providers) || {};
    const primary = (cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model && cfg.agents.defaults.model.primary) || "(未设置)";
    const providerCount = Object.keys(providers).length;

    log("");
    log(MENU_SEP);
    log("  OpenClaw Provider Manager (opm-lite)");
    log(MENU_SEP);
    log(`  Providers: ${providerCount}    默认模型: ${primary}`);
    log(MENU_SEP);
    log("  1. list     — 列出所有 provider");
    log("  2. check    — 检测 API 可用性");
    log("  3. add      — 添加新 provider");
    log("  4. sync     — 同步模型（拉取+探测+注册）");
    log("  5. switch   — 切换默认模型");
    log("  6. remove   — 删除 provider");
    log("  7. restart  — 重启 gateway");
    log("  8. status   — 查看容器状态");
    log("  9. logs     — 查看 gateway 日志");
    log("  0. exit     — 退出");
    log(MENU_SEP);

    const rl = createRL();
    let choice;
    try {
      choice = await ask(rl, "\n请选择操作 [0-9]: ");
    } finally { rl.close(); }

    let rc = 0;
    switch (choice) {
      case "1": rc = await cmdList(); break;
      case "2": rc = await cmdCheck(); break;
      case "3": rc = await cmdAdd(); break;
      case "4": rc = await cmdSync(); break;
      case "5": rc = await cmdSwitch(); break;
      case "6": rc = await cmdRemove(); break;
      case "7": rc = await cmdRestart(); break;
      case "8": rc = await cmdStatus(); break;
      case "9": rc = await cmdLogs(); break;
      case "0": case "q": case "exit":
        log("Bye!");
        return 0;
      default:
        log("❌ 无效选择");
    }

    // Pause before redrawing menu
    const rl2 = createRL();
    try { await ask(rl2, "\n按回车返回主菜单..."); } finally { rl2.close(); }
  }
}

// ─── CLI Argument Parser ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return { command: "__menu__" };

  const command = args[0];
  const opts = {};
  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      // Check if next arg is a value or another flag
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        opts[camelCase(key)] = args[i + 1];
        i += 2;
      } else {
        opts[camelCase(key)] = true;
        i++;
      }
    } else {
      // Positional arg — treat as provider/name selection
      if (!opts._positional) opts._positional = [];
      opts._positional.push(arg);
      i++;
    }
  }
  return { command, ...opts };
}

function camelCase(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const parsed = parseArgs(process.argv);
  const { command } = parsed;
  const positional = (parsed._positional || []).join(" ");

  try {
    switch (command) {
      case "__menu__":
        return await menuLoop();

      case "list": case "ls":
        return await cmdList();

      case "check":
        return await cmdCheck(positional || parsed.providers);

      case "add":
        return await cmdAdd({
          name: parsed.name,
          baseUrl: parsed.baseUrl,
          apiKey: parsed.apiKey,
          api: parsed.api || DEFAULT_API,
          noRestart: !!parsed.noRestart,
          timeoutSec: parsed.timeout ? parseInt(parsed.timeout, 10) : DEFAULT_TIMEOUT,
        });

      case "sync":
        return await cmdSync(positional || parsed.providers, {
          noRestart: !!parsed.noRestart,
          timeoutSec: parsed.timeout ? parseInt(parsed.timeout, 10) : DEFAULT_TIMEOUT,
        });

      case "switch":
        return await cmdSwitch({
          provider: parsed.provider || positional,
          model: parsed.model,
          noRestart: !!parsed.noRestart,
        });

      case "remove": case "rm":
        return await cmdRemove(parsed.name || positional);

      case "restart":
        return await cmdRestart();

      case "status": case "ps":
        return await cmdStatus();

      case "logs":
        return await cmdLogs();

      case "help": case "--help": case "-h":
        printHelp();
        return 0;

      default:
        log(`❌ 未知命令: ${command}`);
        printHelp();
        return 1;
    }
  } catch (e) {
    err(`\n❌ 错误: ${e.message}`);
    return 1;
  }
}

function printHelp() {
  log(`
opm-lite — OpenClaw LLM Provider Manager

用法:
  node opm.js                          交互菜单
  node opm.js list                     列出所有 provider
  node opm.js check [providers]        检测 API 可用性
  node opm.js add [--name X --base-url Y --api-key Z]
                                       添加 provider
  node opm.js sync [providers]         同步模型
  node opm.js switch [--provider X --model Y]
                                       切换默认模型
  node opm.js remove [--name X]        删除 provider
  node opm.js restart                  重启 gateway 容器
  node opm.js status                   查看容器状态
  node opm.js logs                     查看 gateway 日志

选项:
  --no-restart                         操作后不自动重启 gateway
  --timeout N                          请求超时秒数 (默认 ${DEFAULT_TIMEOUT})
  --api API_TYPE                       API 类型 (默认 ${DEFAULT_API})
  `);
}

main().then((code) => process.exit(code || 0)).catch((e) => { err(e.message); process.exit(1); });
