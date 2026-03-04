import type { SiteConfig, Store, AdapterSyncResult } from "../types.js";

export abstract class AdapterBase {
  site: SiteConfig;
  store: Store;

  constructor(siteConfig: SiteConfig, store: Store) {
    this.site = siteConfig;
    this.store = store;
  }

  async sync(): Promise<AdapterSyncResult> {
    throw new Error(`Adapter ${this.site.type} must implement sync()`);
  }
}
