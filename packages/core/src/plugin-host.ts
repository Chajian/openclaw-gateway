import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAdapterRegistry } from "./adapter-registry.js";
import { createPipelineRegistry } from "./pipeline.js";
import { info, warn } from "./lib/log.js";
import type {
  PluginContext, PluginHandle, PluginModule,
  CommandHandler, ScheduleEntry,
  CommandRegistry as ICommandRegistry,
  ScheduleRegistry as IScheduleRegistry
} from "./types.js";

class CommandRegistry implements ICommandRegistry {
  private _map: Map<string, CommandHandler>;

  constructor() {
    this._map = new Map();
  }

  register(name: string, handler: CommandHandler): void {
    this._map.set(name, handler);
  }

  unregister(name: string): void {
    this._map.delete(name);
  }

  has(name: string): boolean {
    return this._map.has(name);
  }

  get(name: string): CommandHandler | undefined {
    return this._map.get(name);
  }

  list(): string[] {
    return Array.from(this._map.keys());
  }
}

class ScheduleRegistry implements IScheduleRegistry {
  private _map: Map<string, ScheduleEntry>;

  constructor() {
    this._map = new Map();
  }

  register(name: string, schedule: ScheduleEntry): void {
    this._map.set(name, schedule);
  }

  unregister(name: string): void {
    this._map.delete(name);
  }

  list(): Array<{ name: string } & ScheduleEntry> {
    return Array.from(this._map.entries()).map(([name, schedule]) => ({ name, ...schedule }));
  }
}

interface PluginsConfig {
  disabled?: string[];
  paths?: string[];
  [key: string]: unknown;
}

interface DiscoveredPlugin {
  name: string;
  dir: string;
  pkg: { name?: string; main?: string; openclaw?: { type?: string }; [key: string]: unknown };
}

async function readPluginsConfig(configPath: string): Promise<PluginsConfig> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { disabled: [], paths: [] };
    }
    throw err;
  }
}

async function discoverWorkspacePlugins(rootDir: string): Promise<DiscoveredPlugin[]> {
  const packagesDir = path.join(rootDir, "packages");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const plugins: DiscoveredPlugin[] = [];
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

async function discoverPathPlugins(paths: string[]): Promise<DiscoveredPlugin[]> {
  const plugins: DiscoveredPlugin[] = [];
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

export interface PluginHostResult {
  adapters: ReturnType<typeof createAdapterRegistry>;
  pipeline: ReturnType<typeof createPipelineRegistry>;
  commands: CommandRegistry;
  schedules: ScheduleRegistry;
  activated: string[];
  deactivateAll: () => Promise<void>;
}

export async function createPluginHost(options: { cwd?: string } = {}): Promise<PluginHostResult> {
  const cwd = options.cwd || process.cwd();

  // Resolve root: walk up from cwd to find root package.json with workspaces or pnpm-workspace.yaml
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
    // Also check for pnpm-workspace.yaml (pnpm workspaces without "workspaces" in package.json)
    try {
      await fs.access(path.join(dir, "pnpm-workspace.yaml"));
      rootDir = dir;
      break;
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
  const seen = new Set<string>();
  const uniquePlugins: DiscoveredPlugin[] = [];
  for (const plugin of allPlugins) {
    if (seen.has(plugin.name)) {
      continue;
    }
    seen.add(plugin.name);
    uniquePlugins.push(plugin);
  }

  // Activate plugins
  const activated: Array<{ name: string; handle: PluginHandle; ctx: PluginContext }> = [];
  for (const plugin of uniquePlugins) {
    if (disabled.has(plugin.name)) {
      info("plugin disabled", plugin.name);
      continue;
    }

    const entryPath = path.join(plugin.dir, plugin.pkg.main || "src/index.mjs");
    try {
      const entryUrl = pathToFileURL(entryPath).href;
      const mod = await import(entryUrl) as PluginModule;
      if (typeof mod.activate !== "function") {
        warn("plugin missing activate()", plugin.name);
        continue;
      }

      const ctx: PluginContext = {
        adapters,
        pipeline,
        commands,
        schedules,
        config: (pluginsConfig as Record<string, unknown>)[plugin.name] as Record<string, unknown> || {},
        core: {
          store: null,
          log: await import("./lib/log.js"),
          httpClient: await import("./lib/http-client.js"),
          readJsonFile: (await import("./lib/json-file.js")).readJsonFile,
          parseArgs: (await import("./lib/args.js")).parseArgs,
          getByPath: (await import("./lib/json-path.js")).getByPath
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
      warn("plugin activation failed", `${plugin.name}: ${(err as Error).message}`);
    }
  }

  async function deactivateAll(): Promise<void> {
    for (const entry of activated.reverse()) {
      try {
        if (entry.handle && typeof entry.handle.deactivate === "function") {
          await entry.handle.deactivate();
        }
      } catch (err) {
        warn("plugin deactivate failed", `${entry.name}: ${(err as Error).message}`);
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
