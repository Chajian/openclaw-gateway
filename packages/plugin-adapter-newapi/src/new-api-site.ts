import { AdapterBase } from "@openclaw/core";
import { CookieJar, joinUrl, normalizeBaseUrl, requestJson } from "@openclaw/core";
import type { AdapterSyncResult, SiteKey } from "@openclaw/core";

function bodySuccess(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  const b = body as Record<string, unknown>;
  if (b.success === true || b.code === true) {
    return true;
  }
  return false;
}

function extractMessage(body: unknown, fallback = "request failed"): string {
  if (!body || typeof body !== "object") {
    return fallback;
  }
  return ((body as Record<string, unknown>).message as string) || fallback;
}

function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

function readSetCookie(headers: Headers | null): string[] {
  if (!headers) {
    return [];
  }
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  if (!raw) {
    return [];
  }
  return [raw];
}

function normalizeKey(rawKey: unknown): string {
  const key = String(rawKey || "").trim();
  if (!key) {
    return "";
  }
  return key.startsWith("sk-") ? key : `sk-${key}`;
}

function toPositiveInt(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.trunc(n);
}

interface AuthCtx {
  userId: number;
  accessToken: string;
  cookieJar: CookieJar;
}

interface AuthResult {
  authCtx: AuthCtx;
  secretsToPersist: {
    accessTokenSecret: string;
    userIdSecret: string;
    accessToken: string;
    userId: string;
  } | null;
}

export class NewApiSiteAdapter extends AdapterBase {
  get baseUrl(): string {
    const raw = this.site.baseUrl || (this.site as Record<string, unknown>).url as string;
    if (!raw) {
      throw new Error(`site ${this.site.id}: baseUrl/url is required`);
    }
    return normalizeBaseUrl(raw);
  }

  get auth(): Record<string, unknown> {
    return (this.site.auth || {}) as Record<string, unknown>;
  }

  get settings(): Record<string, unknown> {
    return (this.site.settings || {}) as Record<string, unknown>;
  }

  getSecretValue(name: string | undefined, optional = false): string {
    if (!name) {
      if (optional) {
        return "";
      }
      throw new Error(`site ${this.site.id}: missing secret name`);
    }
    const v = this.store.getSecret(name)?.value;
    if (!v && !optional) {
      throw new Error(`site ${this.site.id}: secret ${name} not found`);
    }
    return v || "";
  }

  defaultAccessTokenSecretName(): string {
    return `${this.site.id}_access_token`;
  }

  defaultUserIdSecretName(): string {
    return `${this.site.id}_user_id`;
  }

  makeUserHeaders({ userId, accessToken, cookieJar }: AuthCtx): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(this.settings.extraHeaders as Record<string, string> || {})
    };
    if (userId) {
      headers["New-Api-User"] = String(userId);
    }
    if (accessToken) {
      headers.Authorization = accessToken;
    }
    const cookie = cookieJar?.toHeader();
    if (cookie) {
      headers.Cookie = cookie;
    }
    return headers;
  }

  loginQuery(): Record<string, unknown> {
    const q: Record<string, unknown> = {};
    const turnstileTokenSecret = this.auth.turnstileTokenSecret as string | undefined;
    if (turnstileTokenSecret) {
      const turnstile = this.getSecretValue(turnstileTokenSecret, true);
      if (turnstile) {
        q.turnstile = turnstile;
      }
    }
    return q;
  }

  async login({ username, password, cookieJar }: { username: string; password: string; cookieJar: CookieJar }): Promise<{ userId: number; username: string }> {
    const url = joinUrl(this.baseUrl, "/api/user/login", this.loginQuery());
    const res = await requestJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(this.settings.extraHeaders as Record<string, string> || {})
      },
      body: JSON.stringify({ username, password })
    });
    cookieJar.setFromSetCookie(readSetCookie(res.headers));
    if (!res.ok || !bodySuccess(res.json)) {
      throw new Error(`login failed: ${extractMessage(res.json, `http ${res.status}`)}`);
    }
    const data = ((res.json as Record<string, unknown>)?.data || {}) as Record<string, unknown>;
    return {
      userId: data.id as number,
      username: (data.username as string) || username
    };
  }

  async register({ username, password, cookieJar }: { username: string; password: string; cookieJar: CookieJar }): Promise<void> {
    const payload: Record<string, unknown> = { username, password };
    if (this.auth.emailSecret) {
      payload.email = this.getSecretValue(this.auth.emailSecret as string, true);
    }
    if (this.auth.verificationCodeSecret) {
      payload.verification_code = this.getSecretValue(this.auth.verificationCodeSecret as string, true);
    }
    if (this.auth.affCodeSecret) {
      payload.aff_code = this.getSecretValue(this.auth.affCodeSecret as string, true);
    }

    const url = joinUrl(this.baseUrl, "/api/user/register", this.loginQuery());
    const res = await requestJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(this.settings.extraHeaders as Record<string, string> || {})
      },
      body: JSON.stringify(payload)
    });
    cookieJar.setFromSetCookie(readSetCookie(res.headers));
    if (!res.ok || !bodySuccess(res.json)) {
      throw new Error(`register failed: ${extractMessage(res.json, `http ${res.status}`)}`);
    }
  }

  async getSelf(authCtx: AuthCtx): Promise<Record<string, unknown>> {
    const url = joinUrl(this.baseUrl, "/api/user/self");
    const res = await requestJson(url, {
      method: "GET",
      headers: this.makeUserHeaders(authCtx)
    });
    if (!res.ok || !bodySuccess(res.json)) {
      throw new Error(`get self failed: ${extractMessage(res.json, `http ${res.status}`)}`);
    }
    return ((res.json as Record<string, unknown>)?.data || {}) as Record<string, unknown>;
  }

  async generateAccessToken(authCtx: AuthCtx): Promise<string> {
    const url = joinUrl(this.baseUrl, "/api/user/token");
    const res = await requestJson(url, {
      method: "GET",
      headers: this.makeUserHeaders(authCtx)
    });
    if (!res.ok || !bodySuccess(res.json)) {
      throw new Error(`generate access token failed: ${extractMessage(res.json, `http ${res.status}`)}`);
    }
    const token = (res.json as Record<string, unknown>)?.data;
    if (!token) {
      throw new Error("generate access token failed: empty token");
    }
    return String(token);
  }

  parseTokenItems(body: unknown): Record<string, unknown>[] {
    const b = body as Record<string, unknown> | null;
    const data = b?.data;
    if (Array.isArray(data)) {
      return data;
    }
    if (data && Array.isArray((data as Record<string, unknown>).items)) {
      return (data as Record<string, unknown>).items as Record<string, unknown>[];
    }
    return [];
  }

  async listTokens(authCtx: AuthCtx): Promise<Record<string, unknown>[]> {
    const url = joinUrl(this.baseUrl, "/api/token/");
    const res = await requestJson(url, {
      method: "GET",
      headers: this.makeUserHeaders(authCtx)
    });
    if (!res.ok || !bodySuccess(res.json)) {
      throw new Error(`list tokens failed: ${extractMessage(res.json, `http ${res.status}`)}`);
    }
    return this.parseTokenItems(res.json);
  }

  async createToken(authCtx: AuthCtx): Promise<void> {
    const payload = {
      name: this.settings.autoTokenName || "openclaw-auto",
      expired_time: -1,
      unlimited_quota: this.settings.autoTokenUnlimited !== false,
      remain_quota: Number(this.settings.autoTokenRemainQuota || 0),
      model_limits_enabled: false
    };
    const url = joinUrl(this.baseUrl, "/api/token/");
    const res = await requestJson(url, {
      method: "POST",
      headers: {
        ...this.makeUserHeaders(authCtx),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok || !bodySuccess(res.json)) {
      throw new Error(`create token failed: ${extractMessage(res.json, `http ${res.status}`)}`);
    }
  }

  async getTokenUsage(tokenKey: string): Promise<Record<string, unknown>> {
    const url = joinUrl(this.baseUrl, "/api/usage/token");
    const res = await requestJson(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenKey}`,
        Accept: "application/json",
        ...(this.settings.extraHeaders as Record<string, string> || {})
      }
    });
    if (!res.ok) {
      return {};
    }
    return ((res.json as Record<string, unknown>)?.data || {}) as Record<string, unknown>;
  }

  resolveAuthFromSecrets(): { accessTokenSecret: string; userIdSecret: string; accessToken: string; userId: number } {
    const accessTokenSecret = (this.auth.accessTokenSecret as string) || this.defaultAccessTokenSecretName();
    const userIdSecret = (this.auth.userIdSecret as string) || this.defaultUserIdSecretName();
    const accessToken = this.getSecretValue(accessTokenSecret, true);
    const userIdRaw = this.getSecretValue(userIdSecret, true);
    const userId = toPositiveInt(userIdRaw);
    return {
      accessTokenSecret,
      userIdSecret,
      accessToken,
      userId
    };
  }

  deriveUserId(self: unknown): number {
    if (!self || typeof self !== "object") {
      return 0;
    }
    const s = self as Record<string, unknown>;
    return toPositiveInt(s.id || s.user_id || s.userId || s.uid);
  }

  async authenticate(): Promise<AuthResult> {
    const cookieJar = new CookieJar();
    const resolved = this.resolveAuthFromSecrets();
    if (resolved.accessToken && resolved.userId) {
      return {
        authCtx: {
          userId: resolved.userId,
          accessToken: resolved.accessToken,
          cookieJar
        },
        secretsToPersist: null
      };
    }

    if (resolved.accessToken && !resolved.userId) {
      const authCtx: AuthCtx = {
        userId: 0,
        accessToken: resolved.accessToken,
        cookieJar
      };
      const self = await this.getSelf(authCtx);
      const userId = this.deriveUserId(self);
      if (!userId) {
        throw new Error(`site ${this.site.id}: access token works but user id missing in /api/user/self response`);
      }
      return {
        authCtx: {
          ...authCtx,
          userId
        },
        secretsToPersist: {
          accessTokenSecret: resolved.accessTokenSecret,
          userIdSecret: resolved.userIdSecret,
          accessToken: resolved.accessToken,
          userId: String(userId)
        }
      };
    }

    const username = this.auth.usernameSecret ? this.getSecretValue(this.auth.usernameSecret as string, true) : "";
    const password = this.auth.passwordSecret ? this.getSecretValue(this.auth.passwordSecret as string, true) : "";
    if (!username || !password) {
      throw new Error(`site ${this.site.id}: no usable auth (need access token+user id or username/password secrets)`);
    }

    let loginInfo: { userId: number; username: string } | null = null;
    try {
      loginInfo = await this.login({ username, password, cookieJar });
    } catch (err) {
      if (!this.auth.registerIfNeeded) {
        throw err;
      }
      await this.register({ username, password, cookieJar });
      loginInfo = await this.login({ username, password, cookieJar });
    }

    const authCtx: AuthCtx = {
      userId: loginInfo.userId,
      cookieJar,
      accessToken: ""
    };
    const accessToken = await this.generateAccessToken(authCtx);
    authCtx.accessToken = accessToken;

    return {
      authCtx,
      secretsToPersist: {
        accessTokenSecret: resolved.accessTokenSecret,
        userIdSecret: resolved.userIdSecret,
        accessToken,
        userId: String(loginInfo.userId)
      }
    };
  }

  async sync(): Promise<AdapterSyncResult> {
    const { authCtx, secretsToPersist } = await this.authenticate();
    const self = await this.getSelf(authCtx);

    let tokens = await this.listTokens(authCtx);
    if (!tokens.length && this.settings.autoCreateToken !== false) {
      await this.createToken(authCtx);
      tokens = await this.listTokens(authCtx);
    }

    const keys: SiteKey[] = [];
    for (const token of toArray<Record<string, unknown>>(tokens)) {
      const raw = token?.key;
      if (!raw) {
        continue;
      }
      const key = normalizeKey(raw);
      const usage = await this.getTokenUsage(key);
      const quotaFromUsage = Number(usage.total_available || usage.total_granted || 0);
      const quotaRemaining = quotaFromUsage || Number(token?.remain_quota || 0);
      keys.push({
        id: String(token.id ?? ""),
        key,
        status: Number(token.status || 1) === 1 ? "active" : "disabled",
        quotaRemaining,
        quotaUnit: "quota",
        lastSeenAt: new Date().toISOString()
      });
    }

    if (secretsToPersist) {
      this.store.setSecret(secretsToPersist.accessTokenSecret, secretsToPersist.accessToken);
      this.store.setSecret(secretsToPersist.userIdSecret, secretsToPersist.userId);
    }

    return {
      accountId: String(authCtx.userId),
      profile: {
        username: (self.username as string) || "",
        linuxDoId: (self.linux_do_id as string) || "",
        quota: Number(self.quota || 0),
        usedQuota: Number(self.used_quota || 0)
      },
      keys
    };
  }
}
