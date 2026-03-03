import { AdapterBase } from "@openclaw/core/adapters/adapter-base.mjs";
import { CookieJar, joinUrl, normalizeBaseUrl, requestJson } from "@openclaw/core/lib/http-client.mjs";

function bodySuccess(body) {
  if (!body || typeof body !== "object") {
    return false;
  }
  if (body.success === true || body.code === true) {
    return true;
  }
  return false;
}

function extractMessage(body, fallback = "request failed") {
  if (!body || typeof body !== "object") {
    return fallback;
  }
  return body.message || fallback;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function readSetCookie(headers) {
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

function normalizeKey(rawKey) {
  const key = String(rawKey || "").trim();
  if (!key) {
    return "";
  }
  return key.startsWith("sk-") ? key : `sk-${key}`;
}

function toPositiveInt(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.trunc(n);
}

export class NewApiSiteAdapter extends AdapterBase {
  get baseUrl() {
    const raw = this.site.baseUrl || this.site.url;
    if (!raw) {
      throw new Error(`site ${this.site.id}: baseUrl/url is required`);
    }
    return normalizeBaseUrl(raw);
  }

  get auth() {
    return this.site.auth || {};
  }

  get settings() {
    return this.site.settings || {};
  }

  getSecretValue(name, optional = false) {
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

  defaultAccessTokenSecretName() {
    return `${this.site.id}_access_token`;
  }

  defaultUserIdSecretName() {
    return `${this.site.id}_user_id`;
  }

  makeUserHeaders({ userId, accessToken, cookieJar }) {
    const headers = {
      Accept: "application/json",
      ...(this.settings.extraHeaders || {})
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

  loginQuery() {
    const q = {};
    const turnstileTokenSecret = this.auth.turnstileTokenSecret;
    if (turnstileTokenSecret) {
      const turnstile = this.getSecretValue(turnstileTokenSecret, true);
      if (turnstile) {
        q.turnstile = turnstile;
      }
    }
    return q;
  }

  async login({ username, password, cookieJar }) {
    const url = joinUrl(this.baseUrl, "/api/user/login", this.loginQuery());
    const res = await requestJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(this.settings.extraHeaders || {})
      },
      body: JSON.stringify({ username, password })
    });
    cookieJar.setFromSetCookie(readSetCookie(res.headers));
    if (!res.ok || !bodySuccess(res.json)) {
      throw new Error(`login failed: ${extractMessage(res.json, `http ${res.status}`)}`);
    }
    const data = res.json?.data || {};
    return {
      userId: data.id,
      username: data.username || username
    };
  }

  async register({ username, password, cookieJar }) {
    const payload = { username, password };
    if (this.auth.emailSecret) {
      payload.email = this.getSecretValue(this.auth.emailSecret, true);
    }
    if (this.auth.verificationCodeSecret) {
      payload.verification_code = this.getSecretValue(this.auth.verificationCodeSecret, true);
    }
    if (this.auth.affCodeSecret) {
      payload.aff_code = this.getSecretValue(this.auth.affCodeSecret, true);
    }

    const url = joinUrl(this.baseUrl, "/api/user/register", this.loginQuery());
    const res = await requestJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(this.settings.extraHeaders || {})
      },
      body: JSON.stringify(payload)
    });
    cookieJar.setFromSetCookie(readSetCookie(res.headers));
    if (!res.ok || !bodySuccess(res.json)) {
      throw new Error(`register failed: ${extractMessage(res.json, `http ${res.status}`)}`);
    }
  }

  async getSelf(authCtx) {
    const url = joinUrl(this.baseUrl, "/api/user/self");
    const res = await requestJson(url, {
      method: "GET",
      headers: this.makeUserHeaders(authCtx)
    });
    if (!res.ok || !bodySuccess(res.json)) {
      throw new Error(`get self failed: ${extractMessage(res.json, `http ${res.status}`)}`);
    }
    return res.json?.data || {};
  }

  async generateAccessToken(authCtx) {
    const url = joinUrl(this.baseUrl, "/api/user/token");
    const res = await requestJson(url, {
      method: "GET",
      headers: this.makeUserHeaders(authCtx)
    });
    if (!res.ok || !bodySuccess(res.json)) {
      throw new Error(`generate access token failed: ${extractMessage(res.json, `http ${res.status}`)}`);
    }
    const token = res.json?.data;
    if (!token) {
      throw new Error("generate access token failed: empty token");
    }
    return String(token);
  }

  parseTokenItems(body) {
    const data = body?.data;
    if (Array.isArray(data)) {
      return data;
    }
    if (data && Array.isArray(data.items)) {
      return data.items;
    }
    return [];
  }

  async listTokens(authCtx) {
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

  async createToken(authCtx) {
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

  async getTokenUsage(tokenKey) {
    const url = joinUrl(this.baseUrl, "/api/usage/token");
    const res = await requestJson(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenKey}`,
        Accept: "application/json",
        ...(this.settings.extraHeaders || {})
      }
    });
    if (!res.ok) {
      return {};
    }
    return res.json?.data || {};
  }

  resolveAuthFromSecrets() {
    const accessTokenSecret = this.auth.accessTokenSecret || this.defaultAccessTokenSecretName();
    const userIdSecret = this.auth.userIdSecret || this.defaultUserIdSecretName();
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

  deriveUserId(self) {
    if (!self || typeof self !== "object") {
      return 0;
    }
    return toPositiveInt(self.id || self.user_id || self.userId || self.uid);
  }

  async authenticate() {
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
      const authCtx = {
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

    const username = this.auth.usernameSecret ? this.getSecretValue(this.auth.usernameSecret, true) : "";
    const password = this.auth.passwordSecret ? this.getSecretValue(this.auth.passwordSecret, true) : "";
    if (!username || !password) {
      throw new Error(`site ${this.site.id}: no usable auth (need access token+user id or username/password secrets)`);
    }

    let loginInfo = null;
    try {
      loginInfo = await this.login({ username, password, cookieJar });
    } catch (err) {
      if (!this.auth.registerIfNeeded) {
        throw err;
      }
      await this.register({ username, password, cookieJar });
      loginInfo = await this.login({ username, password, cookieJar });
    }

    const authCtx = {
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

  async sync() {
    const { authCtx, secretsToPersist } = await this.authenticate();
    const self = await this.getSelf(authCtx);

    let tokens = await this.listTokens(authCtx);
    if (!tokens.length && this.settings.autoCreateToken !== false) {
      await this.createToken(authCtx);
      tokens = await this.listTokens(authCtx);
    }

    const keys = [];
    for (const token of toArray(tokens)) {
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
        username: self.username || "",
        linuxDoId: self.linux_do_id || "",
        quota: Number(self.quota || 0),
        usedQuota: Number(self.used_quota || 0)
      },
      keys
    };
  }
}
