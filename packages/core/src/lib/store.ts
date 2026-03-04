import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Store, StoreData, SecretEntry, SiteSnapshot, SiteKey, EncryptedPayload } from "../types.js";

const STORE_VERSION = 1;

function defaultData(): StoreData {
  return {
    version: STORE_VERSION,
    secrets: {},
    sites: {}
  };
}

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(masterKey, salt, 200000, 32, "sha256");
}

function encrypt(plaintext: string, masterKey: string): EncryptedPayload {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(masterKey, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: STORE_VERSION,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
    updatedAt: new Date().toISOString()
  };
}

function decrypt(payload: EncryptedPayload, masterKey: string): string {
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const encrypted = Buffer.from(payload.data, "base64");
  const key = deriveKey(masterKey, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

async function ensureParent(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function createStore(storePath: string, masterKey: string): Promise<Store> {
  let data: StoreData = defaultData();
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const payload: EncryptedPayload = JSON.parse(raw);
    const json = decrypt(payload, masterKey);
    const parsed = JSON.parse(json);
    data = {
      ...defaultData(),
      ...parsed
    };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error && error.code !== "ENOENT") {
      const message = String(error?.message || "");
      const decryptFailed =
        message.includes("Unsupported state or unable to authenticate data") ||
        message.toLowerCase().includes("bad decrypt");
      if (decryptFailed) {
        throw new Error(
          `Failed to decrypt secret store at ${storePath}. KEYHUB_MASTER_KEY is incorrect for this encrypted file.`
        );
      }
      throw err;
    }
  }

  async function save(): Promise<void> {
    const plaintext = JSON.stringify(data, null, 2);
    const payload = encrypt(plaintext, masterKey);
    await ensureParent(storePath);
    await fs.writeFile(storePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  function getSecret(name: string): SecretEntry | undefined {
    return data.secrets[name];
  }

  function setSecret(name: string, value: string): void {
    data.secrets[name] = {
      value,
      updatedAt: new Date().toISOString()
    };
  }

  function upsertSiteSnapshot(siteId: string, snapshot: SiteSnapshot): void {
    const current = data.sites[siteId] || {};
    data.sites[siteId] = {
      ...current,
      ...snapshot,
      syncedAt: new Date().toISOString()
    };
  }

  function getSite(siteId: string): SiteSnapshot | undefined {
    return data.sites[siteId];
  }

  function pickKey(siteId: string, strategy: string = "highest_quota"): SiteKey | null {
    const site = data.sites[siteId];
    if (!site || !Array.isArray(site.keys)) {
      return null;
    }
    const active = site.keys.filter((item) => item && item.key && item.status !== "revoked");
    if (!active.length) {
      return null;
    }
    if (strategy === "latest_seen") {
      return active.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))[0];
    }
    return active.sort((a, b) => Number(b.quotaRemaining || 0) - Number(a.quotaRemaining || 0))[0];
  }

  return {
    save,
    raw: data,
    getSecret,
    setSecret,
    upsertSiteSnapshot,
    getSite,
    pickKey
  };
}
