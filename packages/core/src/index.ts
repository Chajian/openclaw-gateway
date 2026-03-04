// @openclaw/core — public API

// Types
export type {
  SecretEntry, SiteKey, SiteSnapshot, StoreData, Store,
  SiteConfig, SitesConfig, ProviderTarget, ProviderMap,
  AdapterSyncResult, Adapter, AdapterConstructor,
  CommandHandler, ScheduleEntry, PipelineStep,
  PluginContext, PluginHandle, PluginModule, PluginCoreApi,
  AdapterRegistry as AdapterRegistryInterface,
  PipelineRegistry as PipelineRegistryInterface,
  CommandRegistry as CommandRegistryInterface,
  ScheduleRegistry as ScheduleRegistryInterface,
  EncryptedPayload, OpenClawConfig
} from "./types.js";

// Encrypted store
export { createStore } from "./lib/store.js";

// HTTP utilities
export { CookieJar, normalizeBaseUrl, joinUrl, requestJson } from "./lib/http-client.js";

// CLI args
export { parseArgs, requireArg } from "./lib/args.js";

// Logging
export { info, warn, error } from "./lib/log.js";

// JSON utilities
export { readJsonFile } from "./lib/json-file.js";
export { getByPath } from "./lib/json-path.js";

// Adapter system
export { AdapterBase } from "./adapters/adapter-base.js";
export { AdapterRegistry, createAdapterRegistry } from "./adapter-registry.js";

// Pipeline system
export { PipelineRegistry, createPipelineRegistry } from "./pipeline.js";

// Plugin host
export { createPluginHost } from "./plugin-host.js";

// Schemas (Zod)
export {
  SiteConfigSchema, SitesConfigSchema,
  ProviderTargetSchema, ProviderMapSchema
} from "./schemas/index.js";
