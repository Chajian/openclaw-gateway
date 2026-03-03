import crypto from "node:crypto";
import { AdapterBase } from "./adapter-base.mjs";

function makeHash(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export class MockPublicSiteAdapter extends AdapterBase {
  async sync() {
    const seed = this.site.settings?.seed || this.site.id;
    const tokenRef = this.site.auth?.tokenSecret || "not-configured";
    const token = this.store.getSecret(tokenRef)?.value || "token-missing";
    const digest = makeHash(`${seed}:${token}`);

    const keys = [0, 1, 2].map((idx) => {
      const id = `${this.site.id}-k${idx + 1}`;
      const key = `sk-${digest.slice(idx * 16, idx * 16 + 20)}`;
      const quotaRemaining = Math.max(0, 120000 - idx * 25000);
      return {
        id,
        key,
        status: "active",
        quotaRemaining,
        quotaUnit: "credits",
        lastSeenAt: new Date().toISOString()
      };
    });

    return {
      accountId: `${this.site.id}-owner`,
      keys
    };
  }
}
