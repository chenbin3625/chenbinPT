/**
 * gazellegames 覆写路径的 H-6 零命中守卫回归（第五波）：
 *
 * GazelleJSONAPI 在 `getUserBaseInfo` / `getUserExtendInfo` 两个调用点都补了
 * `assertUserInfoFieldsMatched`，但 gg 的 `getUserExtendInfo` 是**整段覆写**（不调 super），
 * 因此必须在这个覆写里补同一判据：API 返回 `{status:"success"}` 却没有 response
 * （服务端软错误 / 改版）时，不能把 getFieldsData 回落出的全空字段当成成功写回，
 * 否则会覆盖当日历史与 metadata.lastUserInfo。
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

const { default: GazelleGames, siteMetadata } = await import("@ptd/site/definitions/gazellegames.ts");
const { EResultParseStatus } = await import("@ptd/site/types.ts");

/** GGn `/api.php?request=quick_user` 的正常响应（走基类 getUserBaseInfo） */
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
      seedingSize: 1024,
    },
  },
};

/** GGn `/api.php?request=user&id=` 的正常响应（含 GGn 特有的 gold / hourlyGold / seedSize / totalPoints） */
const validUserResponse = {
  status: "success",
  response: {
    stats: { joinedDate: "2020-01-02 03:04:05", lastAccess: "2026-10-06 01:02:03", gold: 1000 },
    community: { seeding: 3, uploaded: 4, invited: 7, hourlyGold: 5, seedSize: 1024 },
    achievements: { totalPoints: 600 },
  },
};

class TestGazelleGames extends GazelleGames {
  public apiResponses: Record<string, any> = {};

  protected override async requestApi(_action: any, _params: any): Promise<any> {
    return { data: this.apiResponses[_action] };
  }

  public async runExtend(userId: number) {
    return this.getUserExtendInfo(userId);
  }
}

function makeSite(indexResponse: any, userResponse?: any): TestGazelleGames {
  const site = new TestGazelleGames(siteMetadata as any, { inputSetting: { token: "test-token" } } as any);
  site.apiResponses = { quick_user: indexResponse };
  if (userResponse !== undefined) {
    site.apiResponses.user = userResponse;
  }
  return site;
}

describe("gazellegames：覆写的 getUserExtendInfo 必须带零命中守卫（H-6 家族）", () => {
  beforeEach(() => {
    mocks.logMessage.mockReset();
  });

  it("action=user 返回 {status:'success'} 但没有 response → parseError，而不是 success + 覆盖 index 字段", async () => {
    const site = makeSite(validIndexResponse, { status: "success" });

    const result = await site.getUserInfoResult({});

    // 覆写里没有守卫时：这里会是 success，且 index 已解析的字段被空值覆盖
    expect(result.status).toBe(EResultParseStatus.parseError);
    expect(result.statusMsg).toMatch(/未命中任何字段/);
    // index 里已经拿到的字段要保留，不能被 user 接口的空值覆盖
    expect(result.uploaded).toBe(100);
    expect(result.joinTime).toBeUndefined();
    expect(result.lastAccessAt).toBeUndefined();
    expect(mocks.logMessage).toHaveBeenCalled();
  });

  it("直接调用覆写方法：零命中必须 reject（与父类调用点同判据）", async () => {
    const site = makeSite(validIndexResponse, { status: "success" });

    await expect(site.runExtend(12345)).rejects.toThrow(/未命中任何字段/);
  });

  it("正常响应 → success，且 GGn 特有字段（gold / hourlyGold / seedSize / totalPoints）都解析出来", async () => {
    const site = makeSite(validIndexResponse, validUserResponse);

    const result = await site.getUserInfoResult({});

    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.id).toBe(12345);
    expect(result.uploaded).toBe(100);
    expect(result.seeding).toBe(3);
    expect(result.uploads).toBe(4);
    expect(result.invited).toBe(7);
    expect(result.bonus).toBe(1000);
    expect(result.bonusPerHour).toBe(5);
    expect(result.seedingSize).toBe(1024);
    expect(result.seedingBonus).toBe(600);
    expect(result.joinTime).toBeGreaterThan(0);
    expect(result.lastAccessAt).toBeGreaterThan(0);
  });

  it("字段存在且值为 0 仍算命中 → 守卫不能过严（0 不是零命中）", async () => {
    const site = makeSite(validIndexResponse, {
      status: "success",
      response: { community: { seeding: 0 } },
    });

    const extend = await site.runExtend(12345);

    expect(extend.seeding).toBe(0);
  });
});
