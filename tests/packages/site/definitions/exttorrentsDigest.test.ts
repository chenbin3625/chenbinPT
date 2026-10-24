/**
 * exttorrents 换取磁力时的 token 摘要：SHA-256(`${torrentId}|${timestamp}|${pageToken}`) 的小写 hex。
 *
 * CryptoJS → @noble/hashes 迁移的兼容性锁定：期望值是迁移前用 `CryptoJS.SHA256(data).toString()`
 * 生成后硬编码的（与 tests/packages/backupServer/fixtures/cryptoGolden.ts 的 extDigest 同源）。
 * 摘要必须与站点前端脚本一致，否则 ajax 换磁力会被站点拒绝。
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { GOLDEN } from "../../backupServer/fixtures/cryptoGolden.ts";

// 站点模块会连带引入平台适配层（用到 __BROWSER__ 与 chrome API），因此在任何 import 之前把全局桩准备好。
vi.hoisted(() => {
  (globalThis as any).__BROWSER__ ??= "chrome";
  (globalThis as any).chrome ??= {
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    runtime: {
      id: "test",
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
      sendMessage: () => Promise.resolve(undefined),
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
  };
});

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  axios: { request: vi.fn(), getUri: (config: any) => `${config?.baseURL ?? ""}${config?.url ?? ""}` },
  isCloudflareBlocked: vi.fn(() => false),
  retrieve: vi.fn(async () => null),
  retrieveStore: vi.fn(async () => null),
  cookie: vi.fn(async () => null),
  sleep: vi.fn(async () => {}),
  store: vi.fn(async () => {}),
  logMessage: vi.fn(),
}));

const loadSite = async () => {
  const { default: ExtTorrents, siteMetadata } = await import("@ptd/site/definitions/exttorrents.ts");
  return new (ExtTorrents as any)({ ...(siteMetadata as any) }, {});
};

describe("exttorrents：token 摘要与 CryptoJS.SHA256 一致", () => {
  it("computeTokenDigest 输出与迁移前的 golden 值逐字节一致，且与 node:crypto 独立计算一致", async () => {
    const site = await loadSite();
    const digest = site.computeTokenDigest(123456, 1700000000, "pageTokenABC");
    expect(digest).toBe(GOLDEN.extDigest);
    expect(digest).toBe(createHash("sha256").update("123456|1700000000|pageTokenABC", "utf8").digest("hex"));
  });

  it("换磁力请求里携带的 hmac 字段就是该摘要（timestamp 取秒）", async () => {
    const site = await loadSite();
    site.request = vi.fn(async () => ({ data: { success: true, url: "magnet:?xt=urn:btih:abc" } }));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1700000000 * 1000 + 999);
    try {
      const link = await site.getTorrentDownloadLink({
        id: 123456,
        link: "pageTokenABC|csrf",
        url: "https://ext.to/x/",
      });
      expect(link).toBe("magnet:?xt=urn:btih:abc");
    } finally {
      nowSpy.mockRestore();
    }
    const config = site.request.mock.calls[0][0];
    expect(config.data).toMatchObject({
      torrent_id: 123456,
      timestamp: 1700000000,
      hmac: GOLDEN.extDigest,
      sessid: "csrf",
    });
  });
});
