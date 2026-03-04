import { MockPublicSiteAdapter } from "./adapters/mock-public-site.js";
import { HttpPublicSiteAdapter } from "./adapters/http-public-site.js";
import type { SiteConfig, Store, Adapter, AdapterConstructor, AdapterRegistry as IAdapterRegistry } from "./types.js";

export class AdapterRegistry implements IAdapterRegistry {
  private _map: Map<string, AdapterConstructor>;

  constructor() {
    this._map = new Map();
  }

  register(typeName: string, AdapterClass: AdapterConstructor): void {
    this._map.set(typeName, AdapterClass);
  }

  unregister(typeName: string): void {
    this._map.delete(typeName);
  }

  has(typeName: string): boolean {
    return this._map.has(typeName);
  }

  create(siteConfig: SiteConfig, store: Store): Adapter {
    const Cls = this._map.get(siteConfig.type);
    if (!Cls) {
      throw new Error(`Unknown adapter: ${siteConfig.type}. Install the plugin that provides it.`);
    }
    return new Cls(siteConfig, store);
  }

  types(): string[] {
    return Array.from(this._map.keys());
  }
}

export function createAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register("mock", MockPublicSiteAdapter as unknown as AdapterConstructor);
  registry.register("http", HttpPublicSiteAdapter as unknown as AdapterConstructor);
  return registry;
}
