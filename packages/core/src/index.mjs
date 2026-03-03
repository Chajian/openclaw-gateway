// @openclaw/core — public API

// Encrypted store
export { createStore } from "./lib/store.mjs";

// HTTP utilities
export { CookieJar, normalizeBaseUrl, joinUrl, requestJson } from "./lib/http-client.mjs";

// CLI args
export { parseArgs, requireArg } from "./lib/args.mjs";

// Logging
export { info, warn, error } from "./lib/log.mjs";

// JSON utilities
export { readJsonFile } from "./lib/json-file.mjs";
export { getByPath } from "./lib/json-path.mjs";

// Adapter system
export { AdapterBase } from "./adapters/adapter-base.mjs";
export { AdapterRegistry, createAdapterRegistry } from "./adapter-registry.mjs";

// Pipeline system
export { PipelineRegistry, createPipelineRegistry } from "./pipeline.mjs";

// Plugin host
export { createPluginHost } from "./plugin-host.mjs";
