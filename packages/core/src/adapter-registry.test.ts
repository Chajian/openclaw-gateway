import { describe, it, expect } from "vitest";
import { AdapterRegistry, createAdapterRegistry } from "./adapter-registry.js";
import type { SiteConfig, Store, AdapterConstructor } from "./types.js";

function mockStore(): Store {
  return {
    save: async () => {},
    raw: { version: 1, secrets: {}, sites: {} },
    getSecret: () => undefined,
    setSecret: () => {},
    upsertSiteSnapshot: () => {},
    getSite: () => undefined,
    pickKey: () => null
  };
}

describe("AdapterRegistry", () => {
  it("registers and checks adapter type", () => {
    const registry = new AdapterRegistry();
    const FakeAdapter = class { constructor(_site: SiteConfig, _store: Store) {} async sync() { return { keys: [] }; } };
    registry.register("fake", FakeAdapter as unknown as AdapterConstructor);
    expect(registry.has("fake")).toBe(true);
    expect(registry.has("other")).toBe(false);
  });

  it("unregisters an adapter type", () => {
    const registry = new AdapterRegistry();
    const FakeAdapter = class { constructor(_site: SiteConfig, _store: Store) {} async sync() { return { keys: [] }; } };
    registry.register("fake", FakeAdapter as unknown as AdapterConstructor);
    registry.unregister("fake");
    expect(registry.has("fake")).toBe(false);
  });

  it("creates adapter instance for registered type", () => {
    const registry = new AdapterRegistry();
    const FakeAdapter = class {
      site: SiteConfig;
      store: Store;
      constructor(site: SiteConfig, store: Store) { this.site = site; this.store = store; }
      async sync() { return { keys: [] }; }
    };
    registry.register("fake", FakeAdapter as unknown as AdapterConstructor);

    const config: SiteConfig = { id: "test", type: "fake", enabled: true };
    const adapter = registry.create(config, mockStore());
    expect(adapter).toBeInstanceOf(FakeAdapter);
  });

  it("throws on unknown adapter type", () => {
    const registry = new AdapterRegistry();
    const config: SiteConfig = { id: "test", type: "unknown", enabled: true };
    expect(() => registry.create(config, mockStore())).toThrow("Unknown adapter: unknown");
  });

  it("lists registered types", () => {
    const registry = new AdapterRegistry();
    const FakeAdapter = class { constructor(_site: SiteConfig, _store: Store) {} async sync() { return { keys: [] }; } };
    registry.register("a", FakeAdapter as unknown as AdapterConstructor);
    registry.register("b", FakeAdapter as unknown as AdapterConstructor);
    expect(registry.types()).toEqual(["a", "b"]);
  });
});

describe("createAdapterRegistry", () => {
  it("pre-registers mock and http adapters", () => {
    const registry = createAdapterRegistry();
    expect(registry.has("mock")).toBe(true);
    expect(registry.has("http")).toBe(true);
    expect(registry.types()).toContain("mock");
    expect(registry.types()).toContain("http");
  });
});
