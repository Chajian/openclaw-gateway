#!/usr/bin/env node
/**
 * LinuxDo 论坛公益帖/薅羊毛监控器
 * 自动监控 LinuxDo RSS，过滤公益/抽奖/免费帖子，推送到 Telegram
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ============== 配置 ==============
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "300", 10) * 1000;
const DATA_DIR = process.env.DATA_DIR || "/data";
const SEEN_FILE = path.join(DATA_DIR, "seen_posts.json");

const HTTP_PROXY = process.env.https_proxy || process.env.http_proxy || "";

const RSS_FEEDS = [
  "https://linux.do/latest.rss",
  "https://linux.do/top.rss",
];

// 高置信度：命中1个即推送
const HIGH_CONFIDENCE_KEYWORDS = [
  "薅羊毛", "白嫖", "公益服", "抽奖", "giveaway",
  "免费送", "免费领", "免费用", "免费拿", "免费得",
  "白送", "0元", "零元", "白给",
  "邀请码", "兑换码", "激活码", "优惠码", "promo code",
  "福利", "赠送", "羊毛", "公益", "免费分享",
  "限免", "买一送", "拼车", "合租", "车位",
];

// 中置信度：需要同时命中2个才推送
const MEDIUM_KEYWORDS = [
  "免费", "名额", "限时", "限量", "coupon",
  "试用", "体验金", "新人", "首月", "分享",
  "开源", "送", "领取",
];

const EXCLUDE_KEYWORDS = [
  "求助", "出售", "转让", "付费", "收费", "代购", "有偿",
  "求购", "收购", "购买", "招聘", "求职",
  "怎么", "如何", "报错", "bug", "求推荐",
];

// ============== 日志 ==============
function log(level, msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${ts} [${level}] ${msg}`);
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

// ============== HTTP 请求（支持代理）==============
function httpGet(urlStr, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);

    if (HTTP_PROXY) {
      // 通过代理请求
      const proxy = new URL(HTTP_PROXY);
      const opts = {
        hostname: proxy.hostname,
        port: proxy.port || 7890,
        path: urlStr,
        method: "GET",
        headers: {
          Host: url.hostname,
          "User-Agent": BROWSER_UA,
          "Accept": "application/rss+xml, application/xml, text/xml, */*",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        timeout,
      };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.end();
    } else {
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.get(urlStr, { timeout, headers: { "User-Agent": BROWSER_UA, "Accept": "application/rss+xml, application/xml, text/xml, */*" } }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    }
  });
}

function httpPost(urlStr, body, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = JSON.stringify(body);

    if (HTTP_PROXY) {
      const proxy = new URL(HTTP_PROXY);
      const opts = {
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
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(JSON.parse(data)));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.write(payload);
      req.end();
    } else {
      const mod = url.protocol === "https:" ? https : http;
      const opts = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout,
      };
      const req = mod.request(urlStr, opts, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(JSON.parse(data)));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.write(payload);
      req.end();
    }
  });
}

// ============== 简易 XML 解析 ==============
function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      // 支持 CDATA
      const r = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`);
      const m = block.match(r);
      return m ? m[1].trim() : "";
    };
    const getDc = (tag) => {
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
      items.push({ title, link, desc: desc.length >= 200 ? desc + "..." : desc, date: pubDate, author: creator, category });
    }
  }
  return items;
}

// ============== 已推送记录 ==============
function loadSeen() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(SEEN_FILE)) {
      return JSON.parse(fs.readFileSync(SEEN_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveSeen(seen) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const entries = Object.entries(seen);
  if (entries.length > 500) {
    entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    seen = Object.fromEntries(entries.slice(0, 500));
  }
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2), "utf-8");
}

function postId(link) {
  return crypto.createHash("md5").update(link).digest("hex").slice(0, 12);
}

// ============== 关键词匹配（双层过滤）==============
function matchesKeywords(post) {
  const text = `${post.title} ${post.desc} ${post.category}`.toLowerCase();

  // 先排除
  for (const kw of EXCLUDE_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) return false;
  }

  // 高置信度：命中任意一个即通过
  for (const kw of HIGH_CONFIDENCE_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) return true;
  }

  // 中置信度：需要命中2个以上
  let mediumHits = 0;
  for (const kw of MEDIUM_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) mediumHits++;
  }
  return mediumHits >= 2;
}

// ============== Telegram ==============
async function sendTelegram(text) {
  if (!BOT_TOKEN) {
    log("ERROR", "TELEGRAM_BOT_TOKEN 未设置！");
    return false;
  }
  if (!CHAT_ID) {
    log("ERROR", "TELEGRAM_CHAT_ID 未设置！");
    return false;
  }
  try {
    const result = await httpPost(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: false }
    );
    if (result.ok) {
      log("INFO", "Telegram 消息发送成功");
      return true;
    }
    log("ERROR", `Telegram API 错误: ${JSON.stringify(result)}`);
    return false;
  } catch (e) {
    log("ERROR", `Telegram 发送失败: ${e.message}`);
    return false;
  }
}

function formatMessage(post) {
  const text = `${post.title} ${post.desc}`.toLowerCase();
  const allKeywords = [...HIGH_CONFIDENCE_KEYWORDS, ...MEDIUM_KEYWORDS];
  const matched = allKeywords.filter((kw) => text.includes(kw.toLowerCase())).slice(0, 5);

  return [
    `🎯 <b>LinuxDo 羊毛速报</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `📌 <b>${escapeHtml(post.title)}</b>`,
    ``,
    `📝 ${escapeHtml(post.desc)}`,
    ``,
    `👤 作者: ${escapeHtml(post.author || "未知")}`,
    `🏷 分类: ${escapeHtml(post.category || "未知")}`,
    `🔑 关键词: ${matched.join(", ")}`,
    `⏰ ${post.date || ""}`,
    ``,
    `🔗 <a href="${post.link}">点击查看原帖</a>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🤖 by LinuxDo Monitor`,
  ].join("\n");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============== 主逻辑 ==============
async function checkOnce() {
  const seen = loadSeen();
  const newPosts = [];

  for (let i = 0; i < RSS_FEEDS.length; i++) {
    const feedUrl = RSS_FEEDS[i];
    log("INFO", `正在检查: ${feedUrl}`);
    try {
      // 请求间隔3秒，避免 Cloudflare 限流
      if (i > 0) await new Promise((r) => setTimeout(r, 3000));
      const xml = await httpGet(feedUrl);
      const posts = parseRssItems(xml);

      if (posts.length === 0) {
        log("WARN", `  返回0篇帖子，可能被限流，跳过`);
        continue;
      }
      log("INFO", `  获取到 ${posts.length} 篇帖子`);

      for (const post of posts) {
        const pid = postId(post.link);
        if (seen[pid]) continue;
        if (matchesKeywords(post)) {
          newPosts.push(post);
          seen[pid] = { ts: Date.now(), title: post.title };
        }
      }
    } catch (e) {
      log("ERROR", `获取 RSS 失败 ${feedUrl}: ${e.message}`);
    }
  }

  if (newPosts.length > 0) {
    log("INFO", `发现 ${newPosts.length} 篇新的羊毛帖子！`);
    for (const post of newPosts) {
      await sendTelegram(formatMessage(post));
      await new Promise((r) => setTimeout(r, 1000));
    }
  } else {
    log("INFO", "没有发现新的羊毛帖子");
  }

  saveSeen(seen);
  return newPosts.length;
}

async function main() {
  log("INFO", "=".repeat(50));
  log("INFO", "LinuxDo 羊毛监控器已启动！");
  log("INFO", `  Bot Token: ...${BOT_TOKEN.slice(-6)}`);
  log("INFO", `  Chat ID: ${CHAT_ID || "未设置"}`);
  log("INFO", `  检查间隔: ${CHECK_INTERVAL / 1000}秒`);
  log("INFO", `  RSS源: ${RSS_FEEDS.length}个`);
  log("INFO", `  包含关键词: 高置信${HIGH_CONFIDENCE_KEYWORDS.length}个 + 中置信${MEDIUM_KEYWORDS.length}个`);
  log("INFO", "=".repeat(50));

  if (!CHAT_ID) {
    log("ERROR", "❌ 请设置 TELEGRAM_CHAT_ID 环境变量！");
    process.exit(1);
  }
  if (!BOT_TOKEN) {
    log("ERROR", "❌ 请设置 TELEGRAM_BOT_TOKEN 环境变量！");
    process.exit(1);
  }

  // 启动通知
  await sendTelegram(
    `🚀 <b>LinuxDo 羊毛监控器已启动</b>\n` +
    `📡 监控 ${RSS_FEEDS.length} 个 RSS 源\n` +
    `🔑 高置信词 ${HIGH_CONFIDENCE_KEYWORDS.length} 个 + 中置信词 ${MEDIUM_KEYWORDS.length} 个\n` +
    `⏰ 每 ${CHECK_INTERVAL / 1000} 秒检查一次`
  );

  // 首次检查
  await checkOnce();

  // 定时循环
  setInterval(async () => {
    try {
      await checkOnce();
    } catch (e) {
      log("ERROR", `检查失败: ${e.message}`);
    }
  }, CHECK_INTERVAL);
}

// 单次模式
if (process.argv.includes("--once")) {
  if (!BOT_TOKEN || !CHAT_ID) {
    log("ERROR", "❌ --once 模式需要设置 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID");
    process.exit(1);
  }
  checkOnce().then((n) => {
    log("INFO", `完成，发现 ${n} 篇新帖`);
    process.exit(0);
  });
} else {
  main();
}
