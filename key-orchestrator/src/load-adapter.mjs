// Compatibility re-export: delegates to core's AdapterRegistry.
// During the transition period, key-orchestrator scripts still import from here.
import { createAdapterRegistry } from "@openclaw/core";

const registry = createAdapterRegistry();

// Also register new-api adapter (still local during Phase 3 migration)
import { NewApiSiteAdapter } from "./adapters/new-api-site.mjs";
registry.register("new-api", NewApiSiteAdapter);

export function createAdapter(site, store) {
  return registry.create(site, store);
}
