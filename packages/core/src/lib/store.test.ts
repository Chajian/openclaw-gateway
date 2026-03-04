import { describe, it, expect } from "vitest";
import { createStore } from "./store.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function tmpStorePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claw-test-"));
  return path.join(dir, "test-secrets.enc.json");
}

const MASTER_KEY = "test-master-key-for-vitest-12345";

describe("store", () => {
  it("creates a new store when file does not exist", async () => {
    const storePath = await tmpStorePath();
    const store = await createStore(storePath, MASTER_KEY);
    expect(store.raw.version).toBe(1);
    expect(store.raw.secrets).toEqual({});
    expect(store.raw.sites).toEqual({});
  });

  it("round-trips secrets through encrypt/decrypt", async () => {
    const storePath = await tmpStorePath();
    const store = await createStore(storePath, MASTER_KEY);
    store.setSecret("api_key", "sk-abc123");
    store.setSecret("password", "hunter2");
    await store.save();

    const store2 = await createStore(storePath, MASTER_KEY);
    expect(store2.getSecret("api_key")?.value).toBe("sk-abc123");
    expect(store2.getSecret("password")?.value).toBe("hunter2");
  });

  it("returns undefined for missing secret", async () => {
    const storePath = await tmpStorePath();
    const store = await createStore(storePath, MASTER_KEY);
    expect(store.getSecret("nonexistent")).toBeUndefined();
  });

  it("overwrites existing secret", async () => {
    const storePath = await tmpStorePath();
    const store = await createStore(storePath, MASTER_KEY);
    store.setSecret("key", "old");
    store.setSecret("key", "new");
    expect(store.getSecret("key")?.value).toBe("new");
  });

  it("throws on wrong master key", async () => {
    const storePath = await tmpStorePath();
    const store = await createStore(storePath, MASTER_KEY);
    store.setSecret("test", "data");
    await store.save();

    await expect(createStore(storePath, "wrong-key")).rejects.toThrow("KEYHUB_MASTER_KEY is incorrect");
  });

  it("upserts site snapshot and retrieves it", async () => {
    const storePath = await tmpStorePath();
    const store = await createStore(storePath, MASTER_KEY);
    store.upsertSiteSnapshot("site-1", {
      keys: [{ id: "1", key: "sk-test", status: "active", quotaRemaining: 1000, lastSeenAt: "2025-01-01" }]
    });
    const site = store.getSite("site-1");
    expect(site).toBeDefined();
    expect(site!.keys).toHaveLength(1);
    expect(site!.keys![0].key).toBe("sk-test");
    expect(site!.syncedAt).toBeDefined();
  });

  describe("pickKey", () => {
    it("returns null when site does not exist", async () => {
      const storePath = await tmpStorePath();
      const store = await createStore(storePath, MASTER_KEY);
      expect(store.pickKey("no-site")).toBeNull();
    });

    it("returns null when site has no keys", async () => {
      const storePath = await tmpStorePath();
      const store = await createStore(storePath, MASTER_KEY);
      store.upsertSiteSnapshot("empty", { keys: [] });
      expect(store.pickKey("empty")).toBeNull();
    });

    it("picks key with highest quota by default", async () => {
      const storePath = await tmpStorePath();
      const store = await createStore(storePath, MASTER_KEY);
      store.upsertSiteSnapshot("multi", {
        keys: [
          { id: "1", key: "sk-low", status: "active", quotaRemaining: 100, lastSeenAt: "2025-01-01" },
          { id: "2", key: "sk-high", status: "active", quotaRemaining: 9000, lastSeenAt: "2025-01-01" },
          { id: "3", key: "sk-mid", status: "active", quotaRemaining: 500, lastSeenAt: "2025-01-02" }
        ]
      });
      const picked = store.pickKey("multi");
      expect(picked).not.toBeNull();
      expect(picked!.key).toBe("sk-high");
    });

    it("picks latest_seen key when strategy specified", async () => {
      const storePath = await tmpStorePath();
      const store = await createStore(storePath, MASTER_KEY);
      store.upsertSiteSnapshot("time", {
        keys: [
          { id: "1", key: "sk-old", status: "active", quotaRemaining: 9000, lastSeenAt: "2025-01-01" },
          { id: "2", key: "sk-new", status: "active", quotaRemaining: 100, lastSeenAt: "2025-06-15" }
        ]
      });
      const picked = store.pickKey("time", "latest_seen");
      expect(picked).not.toBeNull();
      expect(picked!.key).toBe("sk-new");
    });

    it("skips revoked keys", async () => {
      const storePath = await tmpStorePath();
      const store = await createStore(storePath, MASTER_KEY);
      store.upsertSiteSnapshot("revoked", {
        keys: [
          { id: "1", key: "sk-revoked", status: "revoked", quotaRemaining: 9999, lastSeenAt: "2025-01-01" },
          { id: "2", key: "sk-active", status: "active", quotaRemaining: 10, lastSeenAt: "2025-01-01" }
        ]
      });
      const picked = store.pickKey("revoked");
      expect(picked).not.toBeNull();
      expect(picked!.key).toBe("sk-active");
    });
  });
});
