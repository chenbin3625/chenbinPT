/**
 * site-core-2（第四波）回归：
 *
 * - H-6 家族：GazelleJSONAPI 的 `/ajax.php?action=index|user` 只校验 `status`，
 *   返回 HTTP 200 + `{status:"success"}`（没有 response 对象 / 软错误页）时，
 *   不得再写成 success + 全空字段覆盖 metadata.lastUserInfo 与当日历史。
 * - SITECORE-6 同型死兜底：yzyy / torrenting 的 `detail.title` 兜底选择器
 *   `html > body > title` 恒不命中（`<title>` 在 `<head>`），已改为 `head > title`。
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

const { default: GazelleJSONAPI, SchemaMetadata } = await import("@ptd/site/schemas/GazelleJSONAPI.ts");
const { EResultParseStatus } = await import("@ptd/site/types.ts");

/** Gazelle `/ajax.php?action=index` 的正常响应（id/userstats 都是真实值） */
const validIndexResponse = {
  status: "success",
  response: {
    id: 12345,
    username: "tester",
    authkey: "ak",
    passkey: "pk",
    notifications: { messages: 7 },
    userstats: {
      uploaded: 100,
      downloaded: 50,
      ratio: 2,
      class: "Power User",
      bonusPoints: 1000,
      bonusPointsPerHour: 5,
      seedingSize: 1024,
    },
  },
};

/** Gazelle `/ajax.php?action=user&id=` 的正常响应 */
const validUserResponse = {
  status: "success",
  response: {
    stats: { joinedDate: "2020-01-02 03:04:05", lastAccess: "2026-10-06 01:02:03" },
    community: { seeding: 3, uploaded: 4, perfectFlacs: 5, groups: 6, invited: 7 },
  },
};

class TestGazelleJSONAPI extends GazelleJSONAPI {
  public indexResponse: any = { status: "success" };
  public userResponse: any = { status: "success" };

  protected override async requestApiInfo(): Promise<any> {
    return this.indexResponse;
  }

  protected override async requestApi(_action: any, _params: any): Promise<any> {
    return { data: this.userResponse };
  }
}

function makeSite(indexResponse: any, userResponse: any = validUserResponse): TestGazelleJSONAPI {
  const site = new TestGazelleJSONAPI(
    {
      id: "gazelle-json-fix-test",
      name: "Gazelle JSON Fix Test",
      type: "private",
      urls: ["https://example.com/"],
      timezoneOffset: "+0000",
      userInfo: { ...SchemaMetadata.userInfo },
    } as any,
    {},
  );
  site.indexResponse = indexResponse;
  site.userResponse = userResponse;
  return site;
}

describe("H-6 家族：GazelleJSONAPI 用户信息接口零命中不得报 success", () => {
  beforeEach(() => {
    mocks.logMessage.mockReset();
  });

  it("action=index 返回 {status:'success'} 但没有 response → parseError + statusMsg，而不是 success + 全空", async () => {
    const site = makeSite({ status: "success" });

    const result = await site.getUserInfoResult({});

    expect(result.status).toBe(EResultParseStatus.parseError);
    expect(result.statusMsg).toMatch(/未命中任何字段/);
    // 不能把「未命中」回落成的空值/0 当成解析结果交给上层写历史
    expect(result.uploaded).toBeUndefined();
    expect(result.ratio).toBeUndefined();
    expect(mocks.logMessage).toHaveBeenCalled();
  });

  it("action=user 零命中（index 正常）→ parseError，不用空值覆盖 joinTime/lastAccessAt", async () => {
    const site = makeSite(validIndexResponse, { status: "success" });

    const result = await site.getUserInfoResult({});

    expect(result.status).toBe(EResultParseStatus.parseError);
    expect(result.statusMsg).toMatch(/未命中任何字段/);
    // index 里已经拿到的字段要保留，不能被 user 接口的空值覆盖
    expect(result.uploaded).toBe(100);
    expect(result.joinTime).toBeUndefined();
    expect(result.lastAccessAt).toBeUndefined();
  });

  it("字段存在且值为 0 时仍算命中 → success（守卫不能过严）", async () => {
    const site = makeSite({
      ...validIndexResponse,
      response: {
        ...validIndexResponse.response,
        userstats: { ...validIndexResponse.response.userstats, uploaded: 0, downloaded: 0, ratio: 0 },
      },
    });

    const result = await site.getUserInfoResult({});

    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.uploaded).toBe(0);
    expect(result.downloaded).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it("正常响应 → success，且各字段按选择器解析出来", async () => {
    const site = makeSite(validIndexResponse, validUserResponse);

    const result = await site.getUserInfoResult({});

    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.id).toBe(12345);
    expect(result.name).toBe("tester");
    expect(result.messageCount).toBe(7);
    expect(result.uploaded).toBe(100);
    expect(result.groups).toBe(6);
    expect(result.joinTime).toBeGreaterThan(0);
  });
});

describe("SITECORE-6：detail.title 的兜底选择器必须在 <head> 命中", () => {
  function docWithTitle(title: string): Document {
    const doc = new DOMParser().parseFromString("<html><head><title></title></head><body></body></html>", "text/html");
    doc.title = title;
    return doc;
  }

  it("yzyy：主选择器失配时从 head > title 取到帖子标题", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/yzyy.ts");
    const query = siteMetadata.detail!.selectors!.title as any;
    const doc = docWithTitle("Some Thread Title");

    // 原实现 `html > body > title` 在真实文档里恒不命中，find 会返回 undefined（本用例即变红）
    const matched = (query.selector as string[]).find((sel) => doc.querySelector(sel));
    expect(matched).toBe("head > title");
    expect(doc.querySelector(matched!)!.textContent).toBe("Some Thread Title");
  });

  it("torrenting：h1 失配时从 head > title 取到标题", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/torrenting.ts");
    const query = siteMetadata.detail!.selectors!.title as any;
    const doc = docWithTitle("Another Title");

    const matched = (query.selector as string[]).find((sel) => doc.querySelector(sel));
    expect(matched).toBe("head > title");
    expect(doc.querySelector(matched!)!.textContent).toBe("Another Title");
  });
});
