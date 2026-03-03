import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./lib/args.mjs";
import { readJsonFile } from "./lib/json-file.mjs";
import { createStore } from "./lib/store.mjs";
import { createAdapter } from "./load-adapter.mjs";
import { error, info, warn } from "./lib/log.mjs";

function parseNumberArg(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockPath) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await fs.open(lockPath, "wx");
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  return handle;
}

async function releaseLock(lockPath, lockHandle) {
  try {
    await lockHandle?.close();
  } catch {}
  try {
    await fs.unlink(lockPath);
  } catch {}
}

async function syncSites(config, store) {
  const results = [];
  for (const site of config.sites || []) {
    if (!site.enabled) {
      results.push({ siteId: site.id, status: "skipped", reason: "disabled" });
      continue;
    }
    try {
      const adapter = createAdapter(site, store);
      const snapshot = await adapter.sync();
      store.upsertSiteSnapshot(site.id, snapshot);
      results.push({
        siteId: site.id,
        status: "ok",
        keys: Array.isArray(snapshot.keys) ? snapshot.keys.length : 0
      });
      info("synced", `${site.id} keys=${Array.isArray(snapshot.keys) ? snapshot.keys.length : 0}`);
    } catch (err) {
      results.push({ siteId: site.id, status: "failed", reason: err.message });
      warn("sync failed", `${site.id}: ${err.message}`);
    }
  }

  return {
    results,
    okCount: results.filter((item) => item.status === "ok").length,
    failedCount: results.filter((item) => item.status === "failed").length
  };
}

function applyProviderKeys(openclawConfig, targets, store) {
  openclawConfig.models ??= {};
  openclawConfig.models.providers ??= {};

  const applied = [];
  const missing = [];
  for (const target of targets) {
    const picked = store.pickKey(target.siteId, target.strategy || "highest_quota");
    if (!picked) {
      missing.push({ siteId: target.siteId, provider: target.provider });
      warn("no key for target", `${target.siteId} -> ${target.provider}`);
      continue;
    }
    openclawConfig.models.providers[target.provider] ??= {};
    openclawConfig.models.providers[target.provider].apiKey = picked.key;
    applied.push({
      siteId: target.siteId,
      provider: target.provider,
      keyId: picked.id || "",
      quotaRemaining: Number(picked.quotaRemaining || 0)
    });
    info("provider key applied", `${target.provider} <= ${target.siteId}:${picked.id || "unknown"}`);
  }

  return {
    applied,
    missing
  };
}

async function runOnce(opts) {
  const config = await readJsonFile(opts.configPath);
  const targetMap = await readJsonFile(opts.mapPath);
  const targets = Array.isArray(targetMap.targets) ? targetMap.targets : [];
  const store = await createStore(opts.storePath, opts.masterKey);

  const syncSummary = await syncSites(config, store);
  await store.save();

  const openclawConfig = await readJsonFile(opts.openclawConfigPath);
  const applySummary = applyProviderKeys(openclawConfig, targets, store);
  if (applySummary.applied.length < opts.minApplied) {
    throw new Error(
      `applied providers ${applySummary.applied.length} is below min-applied ${opts.minApplied}`
    );
  }

  await fs.mkdir(opts.backupDir, { recursive: true });
  const backupPath = path.join(opts.backupDir, `openclaw.json.bak.${Date.now()}`);
  await fs.copyFile(opts.openclawConfigPath, backupPath);
  await fs.writeFile(opts.openclawConfigPath, `${JSON.stringify(openclawConfig, null, 2)}\n`, "utf8");

  return {
    backupPath,
    sync: syncSummary,
    apply: applySummary
  };
}

async function writeReport(reportPath, payload) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const configPath = path.resolve(cwd, args.config || "config/sites.json");
  const mapPath = path.resolve(cwd, args.map || "config/provider-map.json");
  const storePath = path.resolve(cwd, args.store || "data/secrets.enc.json");
  const reportPath = path.resolve(cwd, args.report || "data/stable-cycle-report.json");
  const historyDir = path.resolve(cwd, args["history-dir"] || "data/stable-cycle-history");
  const backupDir = path.resolve(cwd, args["backup-dir"] || "data/backups");
  const lockPath = path.resolve(cwd, args.lock || "data/stable-cycle.lock");
  const openclawConfigPath = path.resolve(args["openclaw-config"] || "C:\\Users\\KSG\\.openclaw\\openclaw.json");

  const retries = parseNumberArg(args.retry, 3);
  const retryDelayMs = parseNumberArg(args["retry-delay-ms"], 5000);
  const minApplied = parseNumberArg(args["min-applied"], 1);
  const masterEnv = args["master-key-env"] || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (!masterKey) {
    throw new Error(`Missing env ${masterEnv}`);
  }

  let lockHandle;
  try {
    lockHandle = await acquireLock(lockPath);
  } catch {
    throw new Error(`another stable cycle is running (lock: ${lockPath})`);
  }

  const attempts = [];
  let finalResult = null;
  let finalError = null;

  try {
    for (let i = 1; i <= retries; i += 1) {
      const startedAt = new Date().toISOString();
      try {
        info("stable cycle attempt", `${i}/${retries}`);
        const result = await runOnce({
          configPath,
          mapPath,
          storePath,
          openclawConfigPath,
          backupDir,
          masterKey,
          minApplied
        });
        const attempt = {
          attempt: i,
          startedAt,
          endedAt: new Date().toISOString(),
          status: "ok",
          sync: result.sync,
          apply: {
            appliedCount: result.apply.applied.length,
            missingCount: result.apply.missing.length
          }
        };
        attempts.push(attempt);
        finalResult = result;
        break;
      } catch (err) {
        finalError = err;
        const attempt = {
          attempt: i,
          startedAt,
          endedAt: new Date().toISOString(),
          status: "failed",
          reason: err.message
        };
        attempts.push(attempt);
        warn("stable cycle failed", `attempt=${i} reason=${err.message}`);
        if (i < retries) {
          await sleep(retryDelayMs);
        }
      }
    }
  } finally {
    await releaseLock(lockPath, lockHandle);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    status: finalResult ? "ok" : "failed",
    attempts,
    final: finalResult
      ? {
          backupPath: finalResult.backupPath,
          syncedSites: finalResult.sync.okCount,
          failedSites: finalResult.sync.failedCount,
          appliedProviders: finalResult.apply.applied.map((item) => ({
            siteId: item.siteId,
            provider: item.provider,
            keyId: item.keyId
          }))
        }
      : {
          reason: finalError?.message || "unknown error"
        }
  };

  await writeReport(reportPath, payload);
  await fs.mkdir(historyDir, { recursive: true });
  const historyPath = path.join(historyDir, `stable-cycle-${Date.now()}.json`);
  await writeReport(historyPath, payload);

  if (!finalResult) {
    throw finalError || new Error("stable cycle failed");
  }

  info("stable cycle done", `report=${reportPath}`);
}

main().catch((err) => {
  error("stable cycle aborted", err.message);
  process.exitCode = 1;
});
