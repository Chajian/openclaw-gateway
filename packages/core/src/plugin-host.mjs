import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAdapterRegistry } from "./adapter-registry.mjs";
import { createPipelineRegistry } from "./pipeline.mjs";
import { info, warn } from "./lib/log.mjs";

class CommandRegistry {
  constructor() {
    this._map = new Map();
  }

  register(name, handler) {
    this._map.set(name, handler);
  }

  unregister(name) {
    this._map.delete(name);
  }

  has(name) {
    return this._map.has(name);
  }

  get(name) {
    return this._map.get(name);
  }

  list() {
    return Array.from(this._map.keys());
  }
}

class ScheduleRegistry {
  constructor() {
    this._map = new Map();
  }

  register(name, schedule) {
    this._map.set(name, schedule);
  }

  unregister(name) {
    this._map.delete(name);
  }

  list() {
    return Array.from(this._map.entries()).map(([name, schedule]) => ({ name, ...schedule }));
  }
}

async function readPluginsConfig(configPath) {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      return { disabled: [], paths: [] };
    }
    throw err;
  }
}

async function discoverWorkspacePlugins(rootDir) {
  const packagesDir = path.join(rootDir, "packages");
  let entries;
  try {
    entries = await fs.readdir(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const plugins = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("plugin-")) {
      continue;
    }
    const pluginDir = path.join(packagesDir, entry.name);
    const pkgPath = path.join(pluginDir, "package.json");
    try {
      const raw = await fs.readFile(pkgPath, "utf8");
      const pkg = JSON.parse(raw);
      if (pkg.openclaw?.type === "plugin") {
        plugins.push({
          name: pkg.name || entry.name,
          dir: pluginDir,
          pkg
        });
      }
    } catch {
      // not a valid plugin, skip
    }
  }
  return plugins;
}

async function discoverPathPlugins(paths) {
  const plugins = [];
  for (const pluginPath of paths) {
    const resolved = path.resolve(pluginPath);
    const pkgPath = path.join(resolved, "package.json");
    try {
      const raw = await fs.readFile(pkgPath, "utf8");
      const pkg = JSON.parse(raw);
      if (pkg.openclaw?.type === "plugin") {
        plugins.push({
          name: pkg.name || path.basename(resolved),
          dir: resolved,
          pkg
        });
      }
    } catch {
      warn("plugin path invalid", resolved);
    }
  }
  return plugins;
}

export async function createPluginHost(options = {}) {
  const cwd = options.cwd || process.cwd();

  // Resolve root: walk up from cwd to find root package.json with workspaces
  let rootDir = cwd;
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const raw = await fs.readFile(pkgPath, "utf8");
      const pkg = JSON.parse(raw);
      if (pkg.workspaces) {
        rootDir = dir;
        break;
      }
    } catch {}
    if (dir === path.dirname(dir)) {
      break;
    }
  }

  const adapters = createAdapterRegistry();
  const pipeline = createPipelineRegistry();
  const commands = new CommandRegistry();
  const schedules = new ScheduleRegistry();

  const pluginsConfigPath = path.join(cwd, "config", "plugins.json");
  const pluginsConfig = await readPluginsConfig(pluginsConfigPath);
  const disabled = new Set(pluginsConfig.disabled || []);

  // Discover plugins
  const workspacePlugins = await discoverWorkspacePlugins(rootDir);
  const pathPlugins = await discoverPathPlugins(pluginsConfig.paths || []);
  const allPlugins = [...workspacePlugins, ...pathPlugins];

  // Deduplicate by name
  const seen = new Set();
  const uniquePlugins = [];
  for (const plugin of allPlugins) {
    if (seen.has(plugin.name)) {
      continue;
    }
    seen.add(plugin.name);
    uniquePlugins.push(plugin);
  }

  // Activate plugins
  const activated = [];
  for (const plugin of uniquePlugins) {
    if (disabled.has(plugin.name)) {
      info("plugin disabled", plugin.name);
      continue;
    }

    const entryPath = path.join(plugin.dir, plugin.pkg.main || "src/index.mjs");
    try {
      const entryUrl = pathToFileURL(entryPath).href;
      const mod = await import(entryUrl);
      if (typeof mod.activate !== "function") {
        warn("plugin missing activate()", plugin.name);
        continue;
      }

      const ctx = {
        adapters,
        pipeline,
        commands,
        schedules,
        config: pluginsConfig[plugin.name] || {},
        core: {
          store: null, // filled later when store is created
          log: await import("./lib/log.mjs"),
          httpClient: await import("./lib/http-client.mjs"),
          readJsonFile: (await import("./lib/json-file.mjs")).readJsonFile,
          parseArgs: (await import("./lib/args.mjs")).parseArgs,
          getByPath: (await import("./lib/json-path.mjs")).getByPath
        }
      };

      const handle = await mod.activate(ctx);
      activated.push({
        name: plugin.name,
        handle,
        ctx
      });
      info("plugin activated", plugin.name);
    } catch (err) {
      warn("plugin activation failed", `${plugin.name}: ${err.message}`);
    }
  }

  async function deactivateAll() {
    for (const entry of activated.reverse()) {
      try {
        if (entry.handle && typeof entry.handle.deactivate === "function") {
          await entry.handle.deactivate();
        }
      } catch (err) {
        warn("plugin deactivate failed", `${entry.name}: ${err.message}`);
      }
    }
  }

  return {
    adapters,
    pipeline,
    commands,
    schedules,
    activated: activated.map((e) => e.name),
    deactivateAll
  };
}
