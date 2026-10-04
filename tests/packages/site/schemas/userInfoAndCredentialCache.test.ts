/**
 * 用户信息刷新 / 凭据缓存的健壮性测试：
 *
 * - 问题4：Unit3D 与 GazelleJSONAPI 的 getUserInfoResult 仍手写 catch，
 *   把网络/CF 错误标成 parseError 且不写 statusMsg；改为复用 classifySiteError。
 * - 问题5：GazelleJSONAPI 的 authkey/passkey、Rartracker 的 passkey 为空时
 *   不应写入带 12h TTL 的 runtimeSettings 缓存。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  store: vi.fn(async (_siteId: string, _key: string, _value: any) => {}),
  retrieve: vi.fn(async () => null),
  logMessage: vi.fn(),
}));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  axios: { request: mocks.request },
  isCloudflareBlocked: vi.fn(() => false),
  retrieve: mocks.retrieve,
  sleep: vi.fn(async () => {}),
  store: mocks.store,
  logMessage: mocks.logMessage,
}));

vi.stubGlobal("__BROWSER__", "chrome");
vi.stubGlobal("chrome", {
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
  cookies: { get: () => Promise.resolve(null), set: () => Promise.resolve(), getAll: () => Promise.resolve([]) },
});

const { default: Unit3D } = await import("@ptd/site/schemas/Unit3D.ts");
const { default: GazelleJSONAPI } = await import("@ptd/site/schemas/GazelleJSONAPI.ts");
const { default: Rartracker } = await import("@ptd/site/schemas/Rartracker.ts");
const { EResultParseStatus } = await import("@ptd/site/types.ts");
const { NetworkError } = await import("@ptd/site/utils/error.ts");

describe("问题4：用户信息刷新的错误分类", () => {
  beforeEach(() => {
    mocks.logMessage.mockReset();
  });

  it("Unit3D：网络错误 -> unknownError + statusMsg（不再是 parseError）", async () => {
    class TestUnit3D extends Unit3D {
      protected override async getUserNameFromSite(): Promise<string> {
        return "tester";
      }
      protected override async getUserInfoFromDetailsPage(_userName: string): Promise<any> {
        throw new NetworkError("Network Error: timeout of 30000ms exceeded");
      }
    }

    const site = new TestUnit3D({
      id: "unit3d-test",
      name: "Unit3D Test",
      type: "private",
      urls: ["https://example.com/"],
      userInfo: {},
    } as any);

    const result = await site.getUserInfoResult({});
    expect(result.status).toBe(EResultParseStatus.unknownError);
    expect(result.statusMsg).toBe("Network Error: timeout of 30000ms exceeded");
    expect(mocks.logMessage).toHaveBeenCalled();
  });

  it("Unit3D：解析错误仍然是 parseError，并带上 statusMsg", async () => {
    class TestUnit3D extends Unit3D {
      protected override async getUserNameFromSite(): Promise<string> {
        return "tester";
      }
      protected override async getUserInfoFromDetailsPage(_userName: string): Promise<any> {
        throw new TypeError("Cannot read properties of null (reading 'querySelector')");
      }
    }

    const site = new TestUnit3D({
      id: "unit3d-test",
      name: "Unit3D Test",
      type: "private",
      urls: ["https://example.com/"],
      userInfo: {},
    } as any);

    const result = await site.getUserInfoResult({});
    expect(result.status).toBe(EResultParseStatus.parseError);
    expect(result.statusMsg).toContain("querySelector");
  });

  it("GazelleJSONAPI：网络错误 -> unknownError + statusMsg", async () => {
    class TestGazelleJSONAPI extends GazelleJSONAPI {
      protected override async getUserBaseInfo(): Promise<any> {
        throw new NetworkError("Network Error: 503 Service Unavailable");
      }
    }

    const site = new TestGazelleJSONAPI({
      id: "gazelle-json-test",
      name: "Gazelle JSON Test",
      type: "private",
      urls: ["https://example.com/"],
      userInfo: { selectors: {} },
    } as any);

    const result = await site.getUserInfoResult({});
    expect(result.status).toBe(EResultParseStatus.unknownError);
    expect(result.statusMsg).toBe("Network Error: 503 Service Unavailable");
  });
});

describe("问题5：空凭据不写入 12h 缓存", () => {
  beforeEach(() => {
    mocks.store.mockClear();
    mocks.retrieve.mockResolvedValue(null);
  });

  it("GazelleJSONAPI：authkey 为空时不写缓存，合法凭据才写（并 trim）", async () => {
    class TestGazelleJSONAPI extends GazelleJSONAPI {
      public apiInfoResponse: any = { response: { authkey: "", passkey: "pk" } };
      protected override async requestApiInfo(): Promise<any> {
        return this.apiInfoResponse;
      }
      public async runGetAuthKey() {
        return await this.getAuthKey();
      }
    }

    const metadata = {
      id: "gazelle-json-test",
      name: "Gazelle JSON Test",
      type: "private",
      urls: ["https://example.com/"],
      userInfo: { selectors: {} },
    } as any;

    const empty = new TestGazelleJSONAPI(metadata, {});
    await empty.runGetAuthKey();
    expect(mocks.store).not.toHaveBeenCalled();

    const valid = new TestGazelleJSONAPI(metadata, {});
    valid.apiInfoResponse = { response: { authkey: " ak ", passkey: " pk " } };
    const authKey = await valid.runGetAuthKey();
    expect(authKey).toEqual({ authkey: "ak", passkey: "pk" });
    expect(mocks.store).toHaveBeenCalledTimes(1);
    expect(mocks.store.mock.calls[0][1]).toBe("authKey");
    expect(mocks.store.mock.calls[0][2]).toMatchObject({ authkey: "ak", passkey: "pk" });
  });

  it("Rartracker：空 passkey 不写缓存，合法 passkey 才写", async () => {
    class TestRartracker extends Rartracker {
      public async runParseLink(id: string) {
        return await this.parseTorrentRowForLink({ id } as any);
      }
    }

    const metadata = {
      id: "rartracker-test",
      name: "Rartracker Test",
      type: "private",
      urls: ["https://example.com/"],
      userInfo: {},
    } as any;

    mocks.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      request: { responseURL: "https://example.com/api/v1/status" },
      data: { user: { passkey: "   " } },
    });
    const empty = new TestRartracker(metadata, {});
    const emptyTorrent = await empty.runParseLink("42");
    expect(emptyTorrent.link).toBe("/api/v1/torrents/download/42/");
    expect(mocks.store).not.toHaveBeenCalled();

    mocks.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      request: { responseURL: "https://example.com/api/v1/status" },
      data: { user: { passkey: " realkey " } },
    });
    const valid = new TestRartracker(metadata, {});
    const torrent = await valid.runParseLink("42");
    expect(torrent.link).toBe("/api/v1/torrents/download/42/realkey");
    expect(mocks.store).toHaveBeenCalledTimes(1);
    expect(mocks.store.mock.calls[0][1]).toBe("passKey");
    expect(mocks.store.mock.calls[0][2]).toMatchObject({ passkey: "realkey" });
  });
});
