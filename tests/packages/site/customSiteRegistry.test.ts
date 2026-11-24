import { afterEach, describe, expect, it } from "vitest";

import {
  buildCustomSiteMetadata,
  getCustomSiteDefinition,
  isCustomSiteId,
  listCustomSiteIds,
  normalizeCustomSiteUrls,
  syncCustomSites,
} from "@ptd/site/customSiteRegistry.ts";
import { getDefinedSiteMetadata } from "@ptd/site";

afterEach(() => {
  syncCustomSites({});
});

describe("customSiteRegistry", () => {
  it("normalizes http/https urls, deduplicates, and rejects unsafe schemes", () => {
    const urls = normalizeCustomSiteUrls([
      "https://prowlarr.local:9696",
      "https://prowlarr.local:9696/",
      "http://192.168.1.10:9117/jackett",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "not-a-url",
    ]);
    expect(urls).toEqual(["https://prowlarr.local:9696/", "http://192.168.1.10:9117/jackett/"]);
  });

  it("builds Torznab and NexusPHP metadata properly", () => {
    const torznabMeta = buildCustomSiteMetadata(
      {
        id: "custom_prowlarr",
        name: "My Prowlarr",
        schema: "Torznab",
        type: "public",
        urls: ["http://127.0.0.1:9696"],
        apiPath: "/1/api",
        requiresApiKey: true,
      },
      { version: 1, name: "Torznab", type: "public", urls: [] },
    );

    expect(torznabMeta.id).toBe("custom_prowlarr");
    expect(torznabMeta.search?.requestConfig?.url).toBe("/1/api");
    expect(torznabMeta.userInputSettingMeta?.[0]?.name).toBe("apikey");

    const nexusMeta = buildCustomSiteMetadata(
      {
        id: "custom_nexus",
        name: "My Nexus",
        schema: "NexusPHP",
        type: "private",
        urls: ["https://pt.example.org"],
      },
      { version: 1, name: "NexusPHP", type: "private", urls: [] },
    );
    expect(nexusMeta.timezoneOffset).toBe("+0800");
    expect(nexusMeta.urls).toEqual(["https://pt.example.org/"]);
  });

  it("syncs runtime custom sites and resolves them via getDefinedSiteMetadata", async () => {
    syncCustomSites({
      custom_torznab_test: {
        id: "custom_torznab_test",
        name: "Test Torznab",
        schema: "Torznab",
        type: "public",
        urls: ["https://torznab.example.com"],
        apiPath: "/api/torznab",
      },
    });

    expect(isCustomSiteId("custom_torznab_test")).toBe(true);
    expect(listCustomSiteIds()).toContain("custom_torznab_test");
    expect(getCustomSiteDefinition("custom_torznab_test")?.name).toBe("Test Torznab");

    const resolved = await getDefinedSiteMetadata("custom_torznab_test");
    expect(resolved.id).toBe("custom_torznab_test");
    expect(resolved.schema).toBe("Torznab");
    expect(resolved.urls).toEqual(["https://torznab.example.com/"]);
  });
});
