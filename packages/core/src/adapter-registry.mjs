import { MockPublicSiteAdapter } from "./adapters/mock-public-site.mjs";
import { HttpPublicSiteAdapter } from "./adapters/http-public-site.mjs";

export class AdapterRegistry {
  constructor() {
    this._map = new Map();
  }

  register(typeName, AdapterClass) {
    this._map.set(typeName, AdapterClass);
  }

  unregister(typeName) {
    this._map.delete(typeName);
  }

  has(typeName) {
    return this._map.has(typeName);
  }

  create(siteConfig, store) {
    const Cls = this._map.get(siteConfig.type);
    if (!Cls) {
      throw new Error(`Unknown adapter: ${siteConfig.type}. Install the plugin that provides it.`);
    }
    return new Cls(siteConfig, store);
  }

  types() {
    return Array.from(this._map.keys());
  }
}

export function createAdapterRegistry() {
  const registry = new AdapterRegistry();
  registry.register("mock", MockPublicSiteAdapter);
  registry.register("http", HttpPublicSiteAdapter);
  return registry;
}
