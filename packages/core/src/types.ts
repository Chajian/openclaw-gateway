// @openclaw/core — shared type definitions

// ─── Store ───

export interface SecretEntry {
  value: string;
  updatedAt: string;
}

export interface SiteKey {
  id: string;
  key: string;
  status: string;
  quotaRemaining: number;
  quotaUnit?: string;
  lastSeenAt: string;
}

export interface SiteSnapshot {
  keys?: SiteKey[];
  syncedAt?: string;
  accountId?: string;
  profile?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StoreData {
  version: number;
  secrets: Record<string, SecretEntry>;
  sites: Record<string, SiteSnapshot>;
}

export interface Store {
  save(): Promise<void>;
  raw: StoreData;
  getSecret(name: string): SecretEntry | undefined;
  setSecret(name: string, value: string): void;
  upsertSiteSnapshot(siteId: string, snapshot: SiteSnapshot): void;
  getSite(siteId: string): SiteSnapshot | undefined;
  pickKey(siteId: string, strategy?: string): SiteKey | null;
}

// ─── Site config (sites.json) ───

export interface SiteConfig {
  id: string;
  type: string;
  enabled: boolean;
  baseUrl?: string;
  url?: string;
  auth?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  discovery?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SitesConfig {
  sites: SiteConfig[];
  [key: string]: unknown;
}

// ─── Provider map ───

export interface ProviderTarget {
  siteId: string;
  provider: string;
  strategy?: string;
}

export interface ProviderMap {
  targets: ProviderTarget[];
  [key: string]: unknown;
}

// ─── Adapter ───

export interface AdapterSyncResult {
  accountId?: string;
  keys: SiteKey[];
  profile?: Record<string, unknown>;
}

export interface Adapter {
  sync(): Promise<AdapterSyncResult>;
}

export type AdapterConstructor = new (site: SiteConfig, store: Store) => Adapter;

// ─── Registry types ───

export interface CommandHandler {
  description?: string;
  run: (argv: string[]) => unknown;
}

export interface ScheduleEntry {
  description?: string;
  intervalMs?: number;
  run: () => unknown;
}

export interface PipelineStep {
  description?: string;
  run: (ctx: unknown) => unknown;
  after?: string[];
  before?: string[];
}

// ─── Plugin ───

export interface PluginContext {
  adapters: AdapterRegistry;
  pipeline: PipelineRegistry;
  commands: CommandRegistry;
  schedules: ScheduleRegistry;
  config: Record<string, unknown>;
  core: PluginCoreApi;
}

export interface PluginHandle {
  name?: string;
  deactivate?(): void | Promise<void>;
}

export interface PluginModule {
  activate(ctx: PluginContext): PluginHandle | Promise<PluginHandle>;
}

export interface PluginCoreApi {
  store: Store | null;
  log: { info: typeof import("./lib/log.js").info; warn: typeof import("./lib/log.js").warn; error: typeof import("./lib/log.js").error };
  httpClient: typeof import("./lib/http-client.js");
  readJsonFile: typeof import("./lib/json-file.js").readJsonFile;
  parseArgs: typeof import("./lib/args.js").parseArgs;
  getByPath: typeof import("./lib/json-path.js").getByPath;
}

// ─── Registries (interfaces for external consumers) ───

export interface AdapterRegistry {
  register(typeName: string, AdapterClass: AdapterConstructor): void;
  unregister(typeName: string): void;
  has(typeName: string): boolean;
  create(siteConfig: SiteConfig, store: Store): Adapter;
  types(): string[];
}

export interface PipelineRegistry {
  register(name: string, step: PipelineStep): void;
  unregister(name: string): void;
  has(name: string): boolean;
  list(): Array<{ name: string; description: string; after: string[]; before: string[] }>;
  runAll(ctx: unknown): Promise<Array<{ name: string; status: string; startedAt: string; result?: unknown; error?: string }>>;
}

export interface CommandRegistry {
  register(name: string, handler: CommandHandler): void;
  unregister(name: string): void;
  has(name: string): boolean;
  get(name: string): CommandHandler | undefined;
  list(): string[];
}

export interface ScheduleRegistry {
  register(name: string, schedule: ScheduleEntry): void;
  unregister(name: string): void;
  list(): Array<{ name: string } & ScheduleEntry>;
}

// ─── Encrypted payload ───

export interface EncryptedPayload {
  version: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
  updatedAt: string;
}

// ─── OpenClaw config ───

export interface OpenClawConfig {
  models?: {
    providers?: Record<string, { apiKey?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
