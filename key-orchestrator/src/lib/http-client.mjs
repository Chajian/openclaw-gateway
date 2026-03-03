function trimCookiePart(part) {
  return String(part || "").trim();
}

export class CookieJar {
  constructor() {
    this.map = new Map();
  }

  setFromSetCookie(setCookieHeaders = []) {
    for (const header of setCookieHeaders) {
      const firstPair = String(header || "").split(";")[0];
      const idx = firstPair.indexOf("=");
      if (idx <= 0) {
        continue;
      }
      const name = trimCookiePart(firstPair.slice(0, idx));
      const value = trimCookiePart(firstPair.slice(idx + 1));
      if (!name) {
        continue;
      }
      this.map.set(name, value);
    }
  }

  toHeader() {
    return Array.from(this.map.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

export function normalizeBaseUrl(input) {
  const url = new URL(input);
  let pathname = url.pathname || "/";
  pathname = pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/console")) {
    pathname = pathname.slice(0, -"/console".length);
  }
  return `${url.origin}${pathname}`;
}

export function joinUrl(base, path, query = undefined) {
  const root = base.replace(/\/+$/, "");
  const tail = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${root}${tail}`);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") {
        continue;
      }
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    // keep json as null and pass text in error branch below
  }
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    text,
    json
  };
}

