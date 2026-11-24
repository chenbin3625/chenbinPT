import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCustomSiteMetadata,
  getCustomSiteDefinition,
  isCustomSiteId,
  listCustomSiteIds,
  normalizeCustomSiteUrls,
  syncCustomSites,
} from "@ptd/site/customSiteRegistry.ts";
import { EResultParseStatus, getDefinedSiteMetadata, getSite } from "@ptd/site";
import { axios as siteAxios } from "@ptd/site/utils/adapter.ts";

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

  it("configures custom Unit3D with requiresApiKey to authenticate via Bearer token against /api/torrents/filter and /api/user", async () => {
    syncCustomSites({
      custom_unit3d_api: {
        id: "custom_unit3d_api",
        name: "My Unit3D",
        schema: "Unit3D",
        type: "private",
        urls: ["https://u3d.custom.example"],
        requiresApiKey: true,
      },
    });

    const resolvedMeta = await getDefinedSiteMetadata("custom_unit3d_api");
    expect(resolvedMeta.search?.requestConfig?.url).toBe("/api/torrents/filter");
    expect(resolvedMeta.search?.requestConfig?.responseType).toBe("json");
    expect(resolvedMeta.list?.[0]?.mergeSearchSelectors).toBe(false);
    expect(resolvedMeta.list?.[0]?.selectors?.title).toBeDefined();
    expect(resolvedMeta.userInfo?.process?.[0]?.requestConfig?.url).toBe("/api/user");

    const site = await getSite("custom_unit3d_api", {
      inputSetting: { apikey: "secret-u3d-key" },
    });

    const axiosSpy = vi.spyOn(siteAxios, "request").mockImplementation(async (config: any) => {
      if (String(config.url).includes("/api/torrents/filter")) {
        return {
          status: 200,
          headers: {},
          config,
          request: { responseURL: "https://u3d.custom.example/api/torrents/filter" },
          data: {
            data: [
              {
                id: 9527,
                attributes: {
                  name: "Sample.Movie.2026.2160p",
                  size: 10 * 1024 ** 3,
                  seeders: 12,
                  leechers: 2,
                  times_completed: 30,
                  created_at: "2026-01-02T03:04:05.000000Z",
                  download_link: "https://u3d.custom.example/torrents/download/9527.rsskey",
                  details_link: "https://u3d.custom.example/torrents/9527",
                  freeleech: "100%",
                  double_upload: true,
                  internal: true,
                },
              },
            ],
          },
        } as any;
      }
      return {
        status: 200,
        headers: {},
        config,
        request: { responseURL: "https://u3d.custom.example/api/user" },
        data: {
          username: "api_user",
          group: "Power User",
          uploaded: "2 TiB",
          downloaded: "500 GiB",
          ratio: "4.0",
          seedbonus: "1234.5",
          seeding: 20,
          leeching: 1,
        },
      } as any;
    });

    try {
      const searchRes = await site.getSearchResult("Sample");
      expect(searchRes.status).toBe(EResultParseStatus.success);
      expect(searchRes.data).toHaveLength(1);
      expect(searchRes.data[0]).toMatchObject({
        id: 9527,
        title: "Sample.Movie.2026.2160p",
        link: "https://u3d.custom.example/torrents/download/9527.rsskey",
        downloadVolumeFactor: 0,
        uploadVolumeFactor: 2,
      });

      const searchCallConfig = axiosSpy.mock.calls[0][0] as any;
      expect(searchCallConfig.url).toBe("/api/torrents/filter");
      expect(searchCallConfig.headers?.Authorization).toBe("Bearer secret-u3d-key");
      expect(searchCallConfig.headers?.Accept).toBe("application/json");

      const userInfoRes = await (site as any).getUserInfoResult({});
      expect(userInfoRes.status).toBe(EResultParseStatus.success);
      expect(userInfoRes.name).toBe("api_user");
      const userCallConfig = axiosSpy.mock.calls[1][0] as any;
      expect(userCallConfig.url).toBe("/api/user");
      expect(userCallConfig.headers?.Authorization).toBe("Bearer secret-u3d-key");

      // Missing API Key returns noUserInput instead of silently hitting HTML without credentials
      const siteWithoutKey = await getSite("custom_unit3d_api", { inputSetting: { apikey: "" } });
      const noKeyRes = await siteWithoutKey.getSearchResult("Sample");
      expect(noKeyRes.status).toBe(EResultParseStatus.noUserInput);
    } finally {
      axiosSpy.mockRestore();
    }
  });
});
