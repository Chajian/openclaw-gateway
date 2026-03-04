import { AdapterBase } from "./adapter-base.js";
import { getByPath } from "../lib/json-path.js";
import type { AdapterSyncResult, SiteKey } from "../types.js";

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

export class HttpPublicSiteAdapter extends AdapterBase {
  authHeaders(): Record<string, string> {
    const tokenSecret = (this.site.auth as Record<string, unknown> | undefined)?.tokenSecret as string | undefined;
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

  async getJson(url: string, headers: Record<string, string>): Promise<unknown> {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`GET ${url} failed: ${res.status}`);
    }
    return res.json();
  }

  normalizeKey(raw: Record<string, unknown>): SiteKey {
    const settings = (this.site.settings || {}) as Record<string, unknown>;
    const idField = (settings.keyIdField as string) || "id";
    const keyField = (settings.keyValueField as string) || "apiKey";
    const quotaField = (settings.quotaField as string) || "remaining";
    return {
      id: raw?.[idField] as string,
      key: raw?.[keyField] as string,
      quotaRemaining: Number(raw?.[quotaField] || 0),
      quotaUnit: (settings.quotaUnit as string) || "credits",
      status: (raw?.status as string) || "active",
      lastSeenAt: new Date().toISOString()
    };
  }

  async fillQuota(baseUrl: string, headers: Record<string, string>, item: SiteKey): Promise<SiteKey> {
    const settings = (this.site.settings || {}) as Record<string, unknown>;
    const tpl = settings.quotaPathTemplate as string | undefined;
    if (!tpl || !item.id) {
      return item;
    }
    const endpoint = tpl.replace("{keyId}", encodeURIComponent(item.id));
    const data = await this.getJson(`${baseUrl}${endpoint}`, headers);
    const body = getByPath(data, settings.quotaDataPath as string, data) as Record<string, unknown> | null;
    const field = (settings.quotaResponseField as string) || "remaining";
    return {
      ...item,
      quotaRemaining: Number(body?.[field] || item.quotaRemaining || 0)
    };
  }

  async sync(): Promise<AdapterSyncResult> {
    const baseUrl = this.site.baseUrl;
    if (!baseUrl) {
      throw new Error(`site ${this.site.id}: baseUrl is required`);
    }
    const settings = (this.site.settings || {}) as Record<string, unknown>;
    const listPath = settings.listKeysPath as string | undefined;
    if (!listPath) {
      throw new Error(`site ${this.site.id}: settings.listKeysPath is required`);
    }

    const headers = this.authHeaders();
    const listResp = await this.getJson(`${baseUrl}${listPath}`, headers);
    const payload = getByPath(listResp, settings.keysDataPath as string, listResp);
    const rawKeys = toArray(payload) as Record<string, unknown>[];
    const normalized = rawKeys.map((raw) => this.normalizeKey(raw)).filter((item) => item.id && item.key);
    const withQuota: SiteKey[] = [];
    for (const key of normalized) {
      withQuota.push(await this.fillQuota(baseUrl, headers, key));
    }

    return {
      accountId: getByPath(listResp, settings.accountIdPath as string, this.site.id) as string,
      keys: withQuota
    };
  }
}
