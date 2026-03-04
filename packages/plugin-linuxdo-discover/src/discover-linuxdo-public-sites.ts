import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs, info, warn, error } from "@openclaw/core";

const execFileAsync = promisify(execFile);
const LINUXDO_HOST = "linux.do";
const DEFAULT_FEEDS = [
  "https://linux.do/latest.rss",
  "https://linux.do/top.rss"
];
const DEFAULT_KEYWORDS = [
  "\u7f8a\u6bdb",
  "\u8585\u7f8a\u6bdb",
  "\u516c\u76ca",
  "\u516c\u76ca\u7ad9",
  "\u767d\u5ad6",
  "\u514d\u8d39",
  "\u798f\u5229",
  "\u6ce8\u518c",
  "new api",
  "\u4e2d\u8f6c",
  "key",
  "\u989d\u5ea6"
];
const DEFAULT_EXCLUDED_HOSTS = new Set([
  "linux.do",
  "www.linux.do",
  "t.me",
  "telegram.me",
  "x.com",
  "twitter.com",
  "github.com",
  "gist.github.com",
  "imgur.com",
  "i.imgur.com",
  "cdn.discordapp.com",
  "discord.com",
  "youtube.com",
  "www.youtube.com",
  "youtu.be",
  "bilibili.com",
  "www.bilibili.com",
  "v2ex.com"
]);
const BROWSER_TOPIC_LIST_FN = `() => {
  const items = [];
  const seen = new Set();
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  for (const a of anchors) {
    const rawHref = a.getAttribute("href") || "";
    if (!rawHref) continue;
    const href = new URL(rawHref, location.origin).href;
    if (!/\\/t\\/(topic\\/)?\\d+|\\/t\\/[^/]+\\/\\d+/i.test(href)) continue;
    const title = (a.textContent || "").trim().replace(/\\s+/g, " ");
    if (!title || title.length < 2) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    items.push({ title, link: href });
  }
  return items;
}`;
const BROWSER_TOPIC_LINKS_FN = `() => {
  const links = [];
  const seen = new Set();
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  for (const a of anchors) {
    const href = new URL(a.getAttribute("href") || "", location.origin).href;
    if (!/^https?:\\/\\//i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    links.push(href);
  }
  return {
    title: document.title || "",
    links
  };
}`;

interface RssItem {
  title: string;
  link: string;
  description: string;
  content: string;
  guid: string;
  pubDate: string;
  categories: string[];
}

interface TopicEntry extends RssItem {
  keywordHits: string[];
}

interface TopicSummary {
  id: string;
  title: string;
  link: string;
  pubDate: string;
}

interface SiteEntry {
  host: string;
  origin: string;
  baseUrl: string;
  urls: string[];
  sources: TopicSummary[];
}

interface SiteEntryAccumulator {
  host: string;
  origin: string;
  baseUrl: string;
  urls: Set<string>;
  sources: TopicSummary[];
}

interface DiscoveryPayload {
  generatedAt: string;
  sources: string[];
  keywords: string[];
  stats: {
    topicCandidates: number;
    topicsScanned: number;
    sitesDiscovered: number;
  };
  sites: SiteEntry[];
}

function decodeXml(raw = ""): string {
  return String(raw)
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${escapeRegex(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`, "i");
  const matched = xml.match(regex);
  return decodeXml(matched?.[1] || "");
}

function readTagAll(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${escapeRegex(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`, "ig");
  const out: string[] = [];
  for (const matched of xml.matchAll(regex)) {
    out.push(decodeXml(matched[1] || ""));
  }
  return out;
}

function parseRssItems(xmlText: string): RssItem[] {
  const xml = String(xmlText || "");
  const items: RssItem[] = [];
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    items.push({
      title: readTag(block, "title"),
      link: readTag(block, "link"),
      description: readTag(block, "description"),
      content: readTag(block, "content:encoded"),
      guid: readTag(block, "guid"),
      pubDate: readTag(block, "pubDate"),
      categories: readTagAll(block, "category")
    });
  }
  return items;
}

function normalizeHost(hostname: string): string {
  return String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

function isTopicUrl(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    return normalizeHost(u.hostname) === LINUXDO_HOST && /\/t\//.test(u.pathname);
  } catch {
    return false;
  }
}

function extractTopicId(topicUrl: string): string {
  try {
    const u = new URL(topicUrl);
    const matched = u.pathname.match(/\/t\/(?:[^/]+\/)?(\d+)/i);
    return matched?.[1] || "";
  } catch {
    return "";
  }
}

function buildTopicRssUrl(topicUrl: string): string {
  const topicId = extractTopicId(topicUrl);
  if (!topicId) {
    return "";
  }
  return `https://${LINUXDO_HOST}/t/topic/${topicId}.rss`;
}

function splitCsv(value = ""): string[] {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toLowerText(value = ""): string {
  return String(value || "").toLowerCase();
}

function matchKeywords(text: string, keywords: string[]): string[] {
  const lowered = toLowerText(text);
  return keywords.filter((keyword) => lowered.includes(toLowerText(keyword)));
}

function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const regex = /(https?:\/\/[^\s"'<>\\]+)/gi;
  for (const matched of String(text || "").matchAll(regex)) {
    let candidate = matched[1];
    candidate = candidate.replace(/[),.;!?]+$/, "");
    urls.push(candidate);
  }
  return urls;
}

function isLikelyBinaryUrl(urlObj: URL): boolean {
  const pathname = urlObj.pathname.toLowerCase();
  return /\.(png|jpe?g|webp|gif|svg|pdf|zip|7z|rar|mp4|mp3|avi|mov|exe|apk)$/i.test(pathname);
}

function shouldKeepExternal(urlString: string, excludedHosts: Set<string>): boolean {
  try {
    const u = new URL(urlString);
    const host = normalizeHost(u.hostname);
    if (!["http:", "https:"].includes(u.protocol)) {
      return false;
    }
    if (host === LINUXDO_HOST || host.endsWith(`.${LINUXDO_HOST}`)) {
      return false;
    }
    if (excludedHosts.has(host)) {
      return false;
    }
    if (isLikelyBinaryUrl(u)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function guessBaseUrl(urlString: string): string {
  try {
    const u = new URL(urlString);
    const pathLower = u.pathname.toLowerCase();
    if (pathLower.startsWith("/console")) {
      return `${u.origin}/console`;
    }
    if (pathLower.startsWith("/dashboard")) {
      return `${u.origin}/dashboard`;
    }
    if (pathLower.startsWith("/panel")) {
      return `${u.origin}/panel`;
    }
    return u.origin;
  } catch {
    return "";
  }
}

function normalizeUrl(urlString: string): string {
  const u = new URL(urlString);
  u.hash = "";
  return u.toString();
}

function summarizeTopic(item: RssItem): TopicSummary {
  return {
    id: extractTopicId(item.link || ""),
    title: item.title || "",
    link: item.link || "",
    pubDate: item.pubDate || ""
  };
}

function parseMaybeJson(stdout: string): unknown {
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

async function runBrowserCommand(cliPath: string, browserProfile: string, browserArgs: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "node",
    [cliPath, "browser", "--browser-profile", browserProfile, ...browserArgs],
    {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024
    }
  );
  return String(stdout || "").trim();
}

async function openBrowserTab(cliPath: string, browserProfile: string, initialUrl: string): Promise<string> {
  const raw = await runBrowserCommand(cliPath, browserProfile, ["--json", "open", initialUrl]);
  const parsed = parseMaybeJson(raw) as { targetId?: string } | null;
  if (!parsed?.targetId) {
    throw new Error("failed to create browser tab");
  }
  return parsed.targetId;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "key-orchestrator/linuxdo-discovery"
    }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

async function ensureDirFor(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function toTopicLink(urlString: string): string {
  try {
    const u = new URL(urlString);
    const matched = u.pathname.match(/\/t\/(?:[^/]+\/)?(\d+)/i);
    if (!matched?.[1]) {
      return "";
    }
    return `${u.origin}/t/topic/${matched[1]}`;
  } catch {
    return "";
  }
}

interface DiscoverTopicsViaBrowserOptions {
  cliPath: string;
  browserProfile: string;
  keywords: string[];
  maxTopics: number;
}

async function discoverTopicsViaBrowser({ cliPath, browserProfile, keywords, maxTopics }: DiscoverTopicsViaBrowserOptions): Promise<TopicEntry[]> {
  const pages = [
    "https://linux.do/c/welfare/36",
    "https://linux.do/latest",
    "https://linux.do/top"
  ];
  const topicMap = new Map<string, TopicEntry>();
  const targetId = await openBrowserTab(cliPath, browserProfile, pages[0]);
  for (const page of pages) {
    info("browser fetch page", page);
    await runBrowserCommand(cliPath, browserProfile, ["navigate", page, "--target-id", targetId]);
    const raw = await runBrowserCommand(cliPath, browserProfile, [
      "evaluate",
      "--target-id",
      targetId,
      "--fn",
      BROWSER_TOPIC_LIST_FN
    ]);
    const list = parseMaybeJson(raw) as Array<{ title?: string; link?: string }> | unknown;
    for (const item of Array.isArray(list) ? list : []) {
      const link = toTopicLink((item as { link?: string }).link || "");
      if (!link) {
        continue;
      }
      const keywordHits = matchKeywords((item as { title?: string }).title || "", keywords);
      if (!keywordHits.length) {
        continue;
      }
      const id = extractTopicId(link) || link;
      if (!topicMap.has(id)) {
        topicMap.set(id, {
          title: (item as { title?: string }).title || "",
          link,
          description: "",
          content: "",
          guid: link,
          pubDate: "",
          categories: [],
          keywordHits
        });
      }
    }
  }

  const selected = Array.from(topicMap.values()).slice(0, maxTopics);
  const scanned: TopicEntry[] = [];
  for (const topic of selected) {
    info("browser scan topic", topic.link);
    await runBrowserCommand(cliPath, browserProfile, ["navigate", topic.link, "--target-id", targetId]);
    const raw = await runBrowserCommand(cliPath, browserProfile, [
      "evaluate",
      "--target-id",
      targetId,
      "--fn",
      BROWSER_TOPIC_LINKS_FN
    ]);
    const parsed = parseMaybeJson(raw) as { links?: unknown[] } | null;
    scanned.push({
      ...topic,
      description: "",
      content: Array.isArray(parsed?.links) ? parsed.links.join("\n") : ""
    });
  }
  return scanned;
}

function buildSiteListFromTopics(topics: TopicEntry[], excludedHosts: Set<string>): SiteEntry[] {
  const grouped = new Map<string, SiteEntryAccumulator>();
  for (const topic of topics) {
    const allText = [topic.title, topic.description, topic.content, topic.link].join("\n");
    const links = extractUrls(allText);
    for (const rawLink of links) {
      if (!shouldKeepExternal(rawLink, excludedHosts)) {
        continue;
      }
      const url = normalizeUrl(rawLink);
      const urlObj = new URL(url);
      const host = normalizeHost(urlObj.hostname);
      const item: SiteEntryAccumulator = grouped.get(host) || {
        host,
        origin: urlObj.origin,
        baseUrl: guessBaseUrl(url),
        urls: new Set(),
        sources: []
      };
      item.urls.add(url);
      item.baseUrl ||= guessBaseUrl(url);
      const topicSummary = summarizeTopic(topic);
      if (!item.sources.some((it) => it.link === topicSummary.link)) {
        item.sources.push(topicSummary);
      }
      grouped.set(host, item);
    }
  }
  return Array.from(grouped.values())
    .map((item) => ({
      host: item.host,
      origin: item.origin,
      baseUrl: item.baseUrl || item.origin,
      urls: Array.from(item.urls).sort(),
      sources: item.sources
    }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

export async function discoverLinuxdoPublicSites(argv: string[] = process.argv.slice(2)): Promise<DiscoveryPayload> {
  const args = parseArgs(argv);
  const cwd = process.cwd();
  const outPath = path.resolve(cwd, (args.out as string) || "data/linuxdo-public-sites.json");
  const feeds = splitCsv(args.feeds as string | undefined).length ? splitCsv(args.feeds as string | undefined) : DEFAULT_FEEDS;
  const keywords = splitCsv(args.keywords as string | undefined).length ? splitCsv(args.keywords as string | undefined) : DEFAULT_KEYWORDS;
  const maxTopics = Number(args["max-topics"] || 80);
  const browserFallback = args["browser-fallback"] !== "false";
  const browserProfile = (args["browser-profile"] as string) || "openclaw";
  const openclawCli = (args["openclaw-cli"] as string) || "C:\\Users\\KSG\\openclaw\\dist\\index.js";

  const excludedHosts = new Set(DEFAULT_EXCLUDED_HOSTS);
  for (const host of splitCsv(args["exclude-hosts"] as string | undefined)) {
    excludedHosts.add(normalizeHost(host));
  }

  const topicMap = new Map<string, TopicEntry>();
  let feedOkCount = 0;
  for (const feedUrl of feeds) {
    try {
      info("fetch feed", feedUrl);
      const xml = await fetchText(feedUrl);
      const items = parseRssItems(xml);
      feedOkCount += 1;
      for (const item of items) {
        if (!isTopicUrl(item.link)) {
          continue;
        }
        const keywordHits = matchKeywords(
          [item.title, item.description, item.categories.join(",")].join("\n"),
          keywords
        );
        if (!keywordHits.length) {
          continue;
        }
        const id = extractTopicId(item.link) || item.link;
        if (!topicMap.has(id)) {
          topicMap.set(id, {
            ...item,
            keywordHits
          });
        }
      }
    } catch (err) {
      warn("feed failed", `${feedUrl}: ${(err as Error).message}`);
    }
  }

  let scannedTopics: TopicEntry[] = [];
  let candidateTopicCount = 0;
  if (feedOkCount > 0 && topicMap.size > 0) {
    const candidateTopics = Array.from(topicMap.values()).slice(0, maxTopics);
    candidateTopicCount = candidateTopics.length;
    info("topic candidates", String(candidateTopics.length));
    for (const topic of candidateTopics) {
      const topicRssUrl = buildTopicRssUrl(topic.link);
      if (!topicRssUrl) {
        continue;
      }
      try {
        const xml = await fetchText(topicRssUrl);
        const topicItems = parseRssItems(xml);
        const merged: TopicEntry = {
          ...topic,
          description: [topic.description, ...topicItems.map((item) => item.description)].join("\n"),
          content: topicItems.map((item) => item.content).join("\n")
        };
        scannedTopics.push(merged);
        info("scanned topic", `${topic.title} (${topicRssUrl})`);
      } catch (err) {
        warn("topic rss failed", `${topicRssUrl}: ${(err as Error).message}`);
      }
    }
  } else if (browserFallback) {
    warn("rss unavailable", "switching to browser relay fallback");
    scannedTopics = await discoverTopicsViaBrowser({
      cliPath: openclawCli,
      browserProfile,
      keywords,
      maxTopics
    });
    candidateTopicCount = scannedTopics.length;
  } else {
    throw new Error("all RSS feeds failed and browser fallback is disabled");
  }

  const sites = buildSiteListFromTopics(scannedTopics, excludedHosts);
  const payload: DiscoveryPayload = {
    generatedAt: new Date().toISOString(),
    sources: feeds,
    keywords,
    stats: {
      topicCandidates: candidateTopicCount,
      topicsScanned: scannedTopics.length,
      sitesDiscovered: sites.length
    },
    sites
  };

  await ensureDirFor(outPath);
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  info("discovery done", `${outPath} sites=${sites.length}`);
  return payload;
}

// CLI self-execution
if (process.argv[1] && process.argv[1].includes("discover-linuxdo")) {
  discoverLinuxdoPublicSites().catch((err) => {
    error("discover failed", (err as Error).message);
    process.exitCode = 1;
  });
}
