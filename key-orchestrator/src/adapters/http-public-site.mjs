import { AdapterBase } from "./adapter-base.mjs";
import { getByPath } from "../lib/json-path.mjs";

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

export class HttpPublicSiteAdapter extends AdapterBase {
  authHeaders() {
    const tokenSecret = this.site.auth?.tokenSecret;
    if (!tokenSecret) {
      throw new Error(`site ${this.site.id}: auth.tokenSecret is required`);
    }
    const token = this.store.getSecret(tokenSecret)?.value;
    if (!token) {
      throw new Error(`site ${this.site.id}: secret ${tokenSecret} not found`);
    }
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    };
  }

  async getJson(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`GET ${url} failed: ${res.status}`);
    }
    return res.json();
  }

  normalizeKey(raw) {
    const idField = this.site.settings?.keyIdField || "id";
    const keyField = this.site.settings?.keyValueField || "apiKey";
    const quotaField = this.site.settings?.quotaField || "remaining";
    return {
      id: raw?.[idField],
      key: raw?.[keyField],
      quotaRemaining: Number(raw?.[quotaField] || 0),
      quotaUnit: this.site.settings?.quotaUnit || "credits",
      status: raw?.status || "active",
      lastSeenAt: new Date().toISOString()
    };
  }

  async fillQuota(baseUrl, headers, item) {
    const tpl = this.site.settings?.quotaPathTemplate;
    if (!tpl || !item.id) {
      return item;
    }
    const endpoint = tpl.replace("{keyId}", encodeURIComponent(item.id));
    const data = await this.getJson(`${baseUrl}${endpoint}`, headers);
    const body = getByPath(data, this.site.settings?.quotaDataPath, data);
    const field = this.site.settings?.quotaResponseField || "remaining";
    return {
      ...item,
      quotaRemaining: Number(body?.[field] || item.quotaRemaining || 0)
    };
  }

  async sync() {
    const baseUrl = this.site.baseUrl;
    if (!baseUrl) {
      throw new Error(`site ${this.site.id}: baseUrl is required`);
    }
    const listPath = this.site.settings?.listKeysPath;
    if (!listPath) {
      throw new Error(`site ${this.site.id}: settings.listKeysPath is required`);
    }

    const headers = this.authHeaders();
    const listResp = await this.getJson(`${baseUrl}${listPath}`, headers);
    const payload = getByPath(listResp, this.site.settings?.keysDataPath, listResp);
    const rawKeys = toArray(payload);
    const normalized = rawKeys.map((raw) => this.normalizeKey(raw)).filter((item) => item.id && item.key);
    const withQuota = [];
    for (const key of normalized) {
      withQuota.push(await this.fillQuota(baseUrl, headers, key));
    }

    return {
      accountId: getByPath(listResp, this.site.settings?.accountIdPath, this.site.id),
      keys: withQuota
    };
  }
}

