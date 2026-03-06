#!/usr/bin/env node
/**
 * LinuxDo forum welfare post monitor.
 * - Poll RSS feeds and detect potential giveaway/free posts
 * - Push matched posts to Telegram
 * - Support lightweight subscription via /sub <code> and /unsub
 */

import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ============== Config ==============
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const SUB_CODE = (process.env.SUB_CODE || "").trim();
const PUSH_MODE = resolvePushMode(process.env.PUSH_MODE || "auto");
const TELEGRAM_POLL_INTERVAL_MS = parseInt(process.env.TELEGRAM_POLL_INTERVAL_MS || "5000", 10);
const CHECK_INTERVAL = resolveCheckIntervalMs();
const DATA_DIR = process.env.DATA_DIR || "/data";
const SEEN_FILE = path.join(DATA_DIR, "seen_posts.json");
const SUBSCRIBERS_FILE = resolveSubscribersFile();
const HTTP_PROXY = process.env.https_proxy || process.env.http_proxy || "";

const RSS_FEEDS = [
  "https://linux.do/latest.rss",
  "https://linux.do/top.rss",
];

const HIGH_CONFIDENCE_KEYWORDS = [
  "羊毛", "白嫖", "公益", "抽奖", "giveaway",
  "免费送", "免费领", "免费用", "免费撸", "免费薅",
  "白送", "0元", "零元", "白给",
  "邀请码", "兑换码", "激活码", "优惠码", "promo code",
  "福利", "赠送", "免费分享",
  "限免", "买一送一", "拼车", "合租", "车位",
];

const MEDIUM_KEYWORDS = [
  "免费", "名额", "限时", "限量", "coupon",
  "试用", "体验", "新人", "首月", "分享",
  "开源", "送", "领取",
];

const EXCLUDE_KEYWORDS = [
  "求助", "出售", "转让", "付费", "收费", "代购", "有偿",
  "求购", "收购", "购买", "招聘", "求职",
  "怎么", "如何", "报错", "bug", "求推荐",
];

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

type PushMode = "auto" | "fixed" | "subscribers" | "both";

interface RssPost {
  title: string;
  link: string;
  desc: string;
  date: string;
  author: string;
  category: string;
}

interface SeenRecord {
  ts: number;
  title: string;
}

interface SubscribersData {
  users: string[];
  updatedAt?: string;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

interface TelegramUser {
  id: number;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  from?: TelegramUser;
  chat: TelegramChat;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface SendResult {
  ok: boolean;
  errorCode?: number;
  description?: string;
}

let subscribers = loadSubscribers();
let updateOffset = 0;
let pollingUpdates = false;

function resolvePushMode(raw: string): PushMode {
  const mode = (raw || "auto").trim().toLowerCase();
  if (mode === "fixed" || mode === "subscribers" || mode === "both" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function resolveCheckIntervalMs(): number {
  const monitorIntervalMs = parseInt(process.env.MONITOR_INTERVAL_MS || "", 10);
  if (!Number.isNaN(monitorIntervalMs) && monitorIntervalMs > 0) {
    return monitorIntervalMs;
  }
  const checkIntervalSec = parseInt(process.env.CHECK_INTERVAL || "300", 10);
  return Math.max(10, Number.isNaN(checkIntervalSec) ? 300 : checkIntervalSec) * 1000;
}

function resolveSubscribersFile(): string {
  const raw = (process.env.SUBSCRIBERS_FILE || "subscribers.json").trim();
  if (path.isAbsolute(raw)) {
    return raw;
  }
  return path.join(DATA_DIR, raw);
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${ts} [${level}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function safeParseJson(text: string): unknown {
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON response: ${(err as Error).message}`);
  }
}

function httpGet(urlStr: string, timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);

    if (HTTP_PROXY) {
      const proxy = new URL(HTTP_PROXY);
      const opts: http.RequestOptions = {
        hostname: proxy.hostname,
        port: proxy.port || 7890,
        path: urlStr,
        method: "GET",
        headers: {
          Host: url.hostname,
          "User-Agent": BROWSER_UA,
          Accept: "application/rss+xml, application/xml, text/xml, */*",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        timeout,
      };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.end();
      return;
    }

    const mod = url.protocol === "https:" ? https : http;
    const req = mod.get(
      urlStr,
      {
        timeout,
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "application/rss+xml, application/xml, text/xml, */*",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function httpPost(urlStr: string, body: unknown, timeout = 10000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = JSON.stringify(body);

    if (HTTP_PROXY) {
      const proxy = new URL(HTTP_PROXY);
      const opts: http.RequestOptions = {
        hostname: proxy.hostname,
        port: proxy.port || 7890,
        path: urlStr,
        method: "POST",
        headers: {
          Host: url.hostname,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout,
      };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(safeParseJson(data));
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.write(payload);
      req.end();
      return;
    }

    const mod = url.protocol === "https:" ? https : http;
    const opts: http.RequestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout,
    };
    const req = mod.request(urlStr, opts, (res) => {
      let data = "";
      res.on("data", (chunk: string) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(safeParseJson(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(payload);
    req.end();
  });
}

function parseRssItems(xml: string): RssPost[] {
  const items: RssPost[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const get = (tag: string): string => {
      const r = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`);
      const m = block.match(r);
      return m ? m[1].trim() : "";
    };

    const getDc = (tag: string): string => {
      const r = new RegExp(`<dc:${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/dc:${tag}>`);
      const m = block.match(r);
      return m ? m[1].trim() : "";
    };

    const title = get("title");
    const link = get("link");
    const desc = get("description")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    const pubDate = get("pubDate");
    const creator = getDc("creator");
    const category = get("category");

    if (title && link) {
      items.push({
        title,
        link,
        desc: desc.length >= 200 ? `${desc}...` : desc,
        date: pubDate,
        author: creator,
        category,
      });
    }
  }
  return items;
}

function loadSeen(): Record<string, SeenRecord> {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(SEEN_FILE)) {
      return JSON.parse(fs.readFileSync(SEEN_FILE, "utf-8")) as Record<string, SeenRecord>;
    }
  } catch (err) {
    log("WARN", `load seen file failed: ${(err as Error).message}`);
  }
  return {};
}

function saveSeen(seen: Record<string, SeenRecord>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let entries = Object.entries(seen);
  if (entries.length > 500) {
    entries = entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)).slice(0, 500);
  }
  const limited = Object.fromEntries(entries);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(limited, null, 2), "utf-8");
}

function loadSubscribers(): Set<string> {
  try {
    fs.mkdirSync(path.dirname(SUBSCRIBERS_FILE), { recursive: true });
    if (!fs.existsSync(SUBSCRIBERS_FILE)) {
      return new Set();
    }
    const raw = fs.readFileSync(SUBSCRIBERS_FILE, "utf-8").trim();
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as Partial<SubscribersData>;
    const users = Array.isArray(parsed.users) ? parsed.users : [];
    return new Set(users.map((id) => String(id).trim()).filter(Boolean));
  } catch (err) {
    log("WARN", `load subscribers failed: ${(err as Error).message}`);
    return new Set();
  }
}

function saveSubscribers(next: Set<string>): void {
  fs.mkdirSync(path.dirname(SUBSCRIBERS_FILE), { recursive: true });
  const data: SubscribersData = {
    users: Array.from(next).sort(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function addSubscriber(userId: string): boolean {
  if (subscribers.has(userId)) {
    return false;
  }
  subscribers.add(userId);
  saveSubscribers(subscribers);
  return true;
}

function removeSubscriber(userId: string): boolean {
  const existed = subscribers.delete(userId);
  if (existed) {
    saveSubscribers(subscribers);
  }
  return existed;
}

function postId(link: string): string {
  return crypto.createHash("md5").update(link).digest("hex").slice(0, 12);
}

function matchesKeywords(post: RssPost): boolean {
  const text = `${post.title} ${post.desc} ${post.category}`.toLowerCase();

  for (const kw of EXCLUDE_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) {
      return false;
    }
  }

  for (const kw of HIGH_CONFIDENCE_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) {
      return true;
    }
  }

  let mediumHits = 0;
  for (const kw of MEDIUM_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) {
      mediumHits += 1;
    }
  }
  return mediumHits >= 2;
}

async function telegramRequest<T>(method: string, payload: Record<string, unknown>): Promise<TelegramApiResponse<T>> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  return await httpPost(url, payload) as TelegramApiResponse<T>;
}

async function sendTelegramToChat(chatId: string, text: string): Promise<SendResult> {
  if (!BOT_TOKEN) {
    return { ok: false, description: "TELEGRAM_BOT_TOKEN is empty" };
  }

  try {
    const result = await telegramRequest<unknown>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });

    if (result.ok) {
      return { ok: true };
    }
    return {
      ok: false,
      errorCode: result.error_code,
      description: result.description || "telegram api failed",
    };
  } catch (err) {
    return { ok: false, description: (err as Error).message };
  }
}

function getPushTargets(): string[] {
  const subscriberTargets = Array.from(subscribers);
  const fixedTargets = CHAT_ID ? [CHAT_ID] : [];

  if (PUSH_MODE === "fixed") {
    return fixedTargets;
  }
  if (PUSH_MODE === "subscribers") {
    return subscriberTargets;
  }
  if (PUSH_MODE === "both") {
    return Array.from(new Set([...fixedTargets, ...subscriberTargets]));
  }
  // auto
  return subscriberTargets.length > 0 ? subscriberTargets : fixedTargets;
}

async function sendTelegramToTargets(text: string): Promise<void> {
  const targets = getPushTargets();
  if (targets.length === 0) {
    log("WARN", "no push targets available, skip message");
    return;
  }

  let okCount = 0;
  for (const chatId of targets) {
    const result = await sendTelegramToChat(chatId, text);
    if (result.ok) {
      okCount += 1;
    } else {
      log("WARN", `push failed chat_id=${chatId} err=${result.errorCode || "-"} ${result.description || ""}`);
      if (result.errorCode === 403 && subscribers.has(chatId)) {
        removeSubscriber(chatId);
        log("INFO", `removed blocked subscriber ${chatId}`);
      }
    }
    await sleep(250);
  }
  log("INFO", `push finished success=${okCount}/${targets.length}`);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatMessage(post: RssPost): string {
  const text = `${post.title} ${post.desc}`.toLowerCase();
  const allKeywords = [...HIGH_CONFIDENCE_KEYWORDS, ...MEDIUM_KEYWORDS];
  const matched = allKeywords.filter((kw) => text.includes(kw.toLowerCase())).slice(0, 5);

  return [
    "🎯 <b>LinuxDo 羊毛速报</b>",
    "━━━━━━━━━━━━━━━━━━",
    `📰 <b>${escapeHtml(post.title)}</b>`,
    "",
    `📝 ${escapeHtml(post.desc)}`,
    "",
    `👤 作者: ${escapeHtml(post.author || "未知")}`,
    `🏷 分类: ${escapeHtml(post.category || "未知")}`,
    `🔍 关键词: ${escapeHtml(matched.join(", ") || "无")}`,
    `⏰ ${escapeHtml(post.date || "")}`,
    "",
    `🔗 <a href="${post.link}">点击查看原帖</a>`,
    "━━━━━━━━━━━━━━━━━━",
    "🤖 by LinuxDo Monitor",
  ].join("\n");
}

function parseCommand(text: string): { command: string; arg: string } {
  const m = text.trim().match(/^\/([a-zA-Z]+)(?:@\w+)?(?:\s+([\s\S]+))?$/);
  if (!m) {
    return { command: "", arg: "" };
  }
  return {
    command: m[1].toLowerCase(),
    arg: (m[2] || "").trim(),
  };
}

async function sendUsage(chatId: string): Promise<void> {
  const usage = [
    "👋 <b>LinuxDo 监控订阅机器人</b>",
    "",
    "可用命令：",
    "• <code>/sub 订阅码</code> 开启推送",
    "• <code>/unsub</code> 取消推送",
    "• <code>/me</code> 查看当前状态",
  ].join("\n");
  await sendTelegramToChat(chatId, usage);
}

async function handleCommand(message: TelegramMessage): Promise<void> {
  if (!message.text || !message.text.trim().startsWith("/")) {
    return;
  }

  const { command, arg } = parseCommand(message.text);
  if (!command) {
    return;
  }

  const chatId = String(message.chat.id);
  const userId = String(message.from?.id || message.chat.id);
  const isPrivate = message.chat.type === "private";
  const needsPrivate = command === "sub" || command === "unsub" || command === "me";

  if (needsPrivate && !isPrivate) {
    await sendTelegramToChat(chatId, "请私聊机器人执行订阅命令。");
    return;
  }

  if (command === "start" || command === "help") {
    await sendUsage(chatId);
    if (arg && SUB_CODE && arg === SUB_CODE) {
      const added = addSubscriber(userId);
      await sendTelegramToChat(chatId, added ? "✅ 订阅成功，后续会收到新帖推送。" : "✅ 你已在订阅列表中。");
    }
    return;
  }

  if (command === "sub") {
    if (!SUB_CODE) {
      await sendTelegramToChat(chatId, "❌ 当前未开放订阅，请联系管理员。");
      return;
    }
    if (!arg) {
      await sendTelegramToChat(chatId, "用法：<code>/sub 订阅码</code>");
      return;
    }
    if (arg !== SUB_CODE) {
      await sendTelegramToChat(chatId, "❌ 订阅码无效。");
      return;
    }

    const added = addSubscriber(userId);
    await sendTelegramToChat(chatId, added ? "✅ 订阅成功，后续会收到 LinuxDo 新帖推送。" : "✅ 你已在订阅列表中。");
    return;
  }

  if (command === "unsub") {
    const removed = removeSubscriber(userId);
    await sendTelegramToChat(chatId, removed ? "✅ 已取消订阅。" : "ℹ️ 当前不在订阅列表中。");
    return;
  }

  if (command === "me") {
    const text = subscribers.has(userId)
      ? `✅ 当前状态：已订阅\n📊 当前订阅人数：${subscribers.size}`
      : "ℹ️ 当前状态：未订阅";
    await sendTelegramToChat(chatId, text);
  }
}

async function pollTelegramUpdates(): Promise<void> {
  if (!BOT_TOKEN || pollingUpdates) {
    return;
  }

  pollingUpdates = true;
  try {
    const result = await telegramRequest<TelegramUpdate[]>("getUpdates", {
      offset: updateOffset,
      limit: 100,
      timeout: 0,
      allowed_updates: ["message"],
    });

    if (!result.ok || !Array.isArray(result.result)) {
      if (!result.ok) {
        log("WARN", `getUpdates failed: ${result.error_code || "-"} ${result.description || ""}`);
      }
      return;
    }

    for (const update of result.result) {
      updateOffset = Math.max(updateOffset, update.update_id + 1);
      if (update.message) {
        await handleCommand(update.message);
      }
    }
  } catch (err) {
    log("WARN", `poll updates error: ${(err as Error).message}`);
  } finally {
    pollingUpdates = false;
  }
}

function startCommandPolling(): void {
  if (!BOT_TOKEN) {
    return;
  }
  void pollTelegramUpdates();
  setInterval(() => {
    void pollTelegramUpdates();
  }, Math.max(1000, TELEGRAM_POLL_INTERVAL_MS));
}

async function checkOnce(): Promise<number> {
  const seen = loadSeen();
  const newPosts: RssPost[] = [];

  for (let i = 0; i < RSS_FEEDS.length; i += 1) {
    const feedUrl = RSS_FEEDS[i];
    log("INFO", `checking ${feedUrl}`);
    try {
      if (i > 0) {
        await sleep(3000);
      }
      const xml = await httpGet(feedUrl);
      const posts = parseRssItems(xml);

      if (posts.length === 0) {
        log("WARN", "rss returned 0 items, skip this feed");
        continue;
      }
      log("INFO", `fetched ${posts.length} posts`);

      for (const post of posts) {
        const pid = postId(post.link);
        if (seen[pid]) {
          continue;
        }
        if (!matchesKeywords(post)) {
          continue;
        }
        newPosts.push(post);
        seen[pid] = { ts: Date.now(), title: post.title };
      }
    } catch (err) {
      log("ERROR", `fetch rss failed ${feedUrl}: ${(err as Error).message}`);
    }
  }

  if (newPosts.length === 0) {
    log("INFO", "no new matched posts");
    saveSeen(seen);
    return 0;
  }

  log("INFO", `found ${newPosts.length} new posts`);
  for (const post of newPosts) {
    await sendTelegramToTargets(formatMessage(post));
    await sleep(1000);
  }
  saveSeen(seen);
  return newPosts.length;
}

function validateStartup(): void {
  if (!BOT_TOKEN) {
    log("ERROR", "TELEGRAM_BOT_TOKEN is required");
    process.exit(1);
  }
  if (PUSH_MODE === "fixed" && !CHAT_ID) {
    log("ERROR", "PUSH_MODE=fixed requires TELEGRAM_CHAT_ID");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  validateStartup();

  log("INFO", "=".repeat(56));
  log("INFO", "LinuxDo monitor started");
  log("INFO", `push mode: ${PUSH_MODE}`);
  log("INFO", `subscribers: ${subscribers.size} (${SUBSCRIBERS_FILE})`);
  log("INFO", `fixed chat id: ${CHAT_ID || "not set"}`);
  log("INFO", `sub code: ${SUB_CODE ? "configured" : "not configured"}`);
  log("INFO", `check interval: ${CHECK_INTERVAL / 1000}s`);
  log("INFO", `telegram poll interval: ${Math.max(1000, TELEGRAM_POLL_INTERVAL_MS)}ms`);
  log("INFO", "=".repeat(56));

  startCommandPolling();

  if (CHAT_ID) {
    await sendTelegramToChat(
      CHAT_ID,
      [
        "🚀 <b>LinuxDo 监控器已启动</b>",
        `推送模式: <code>${PUSH_MODE}</code>`,
        `订阅人数: <code>${subscribers.size}</code>`,
        `检查间隔: <code>${CHECK_INTERVAL / 1000}s</code>`,
      ].join("\n")
    );
  }

  await checkOnce();
  setInterval(() => {
    void checkOnce().catch((err) => {
      log("ERROR", `check failed: ${(err as Error).message}`);
    });
  }, CHECK_INTERVAL);
}

if (process.argv.includes("--once")) {
  validateStartup();
  checkOnce()
    .then((count) => {
      log("INFO", `done, new matched posts=${count}`);
      process.exit(0);
    })
    .catch((err) => {
      log("ERROR", `once mode failed: ${(err as Error).message}`);
      process.exit(1);
    });
} else {
  void main();
}
