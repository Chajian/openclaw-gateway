export class AdapterBase {
  constructor(siteConfig, store) {
    this.site = siteConfig;
    this.store = store;
  }

  async sync() {
    throw new Error(`Adapter ${this.site.type} must implement sync()`);
  }
}

