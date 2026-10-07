/**
 * DNR 会话规则的生命周期必须按 JS 上下文隔离（缺陷清单 EXTENDSI18N-3）。
 *
 * 事实前提：
 * - DNR 会话规则是**扩展级共享**的（`updateSessionRules` / `removeSessionRules`），
 *   而本模块的 `dnrRuleCache` 与 inflight 计数是**每个 JS 上下文各一份**；
 * - options 页与 offscreen 都会加载本模块（各自的 packages/downloader/utils/adapter.ts 实例），
 *   qBittorrent「绕过 CSRF」会让两边对同一 URL 产生同一组头（`origin: ""`）。
 *
 * 修复前：规则 id 只按 URL+method+headers 派生 ⇒ 两个上下文共用同一条规则、各自计数，
 * 一方请求结束就把另一方仍在复用的规则删掉；对方缓存里 inflight>0 于是不重装，
 * 后续请求静默丢掉被剥离的请求头。
 * 修复后：cacheKey 里带上上下文标识 ⇒ 跨上下文 id 不同，各自只删自己的规则。
 *
 * 这里用「同一份模块被加载两次」模拟两个 JS 上下文（`vi.resetModules()` + 动态 import），
 * 并用假的 background 规则表记录扩展级共享的 session rules。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessageMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn() }));

vi.mock("@/messages.ts", () => ({
  sendMessage: sendMessageMock,
  onMessage: vi.fn(),
}));

interface Interceptor {
  fulfilled: (value: any) => any;
  rejected?: (error: any) => any;
}

function createFakeAxios() {
  const requestInterceptors: Interceptor[] = [];
  const responseInterceptors: Interceptor[] = [];

  const instance: any = {
    interceptors: {
      request: {
        use: (fulfilled: Interceptor["fulfilled"], rejected?: Interceptor["rejected"]) =>
          requestInterceptors.push({ fulfilled, rejected }),
      },
      response: {
        use: (fulfilled: Interceptor["fulfilled"], rejected?: Interceptor["rejected"]) =>
          responseInterceptors.push({ fulfilled, rejected }),
      },
    },
    getUri: ({ baseURL, url, params }: any) => {
      const target = new URL(url, baseURL ?? "https://example.com/");
      for (const [key, value] of Object.entries(params ?? {})) {
        target.searchParams.set(key, String(value));
      }
      return target.href;
    },
  };

  return { instance, requestInterceptors, responseInterceptors };
}

function createHeaders(init: Record<string, string>) {
  const store = new Map(Object.entries(init));
  return {
    store,
    [Symbol.iterator]: () => store.entries(),
    delete: (key: string) => store.delete(key),
  };
}

/** 模拟「扩展级共享」的 DNR session rules：install 覆盖、remove 按 id 精确删除 */
const installedRules = new Map<number, any>();

function installSendMessageMock() {
  sendMessageMock.mockImplementation((type: string, payload: any) => {
    if (type === "updateDNRSessionRules") {
      installedRules.set(payload.rule.id, payload.rule);
      return Promise.resolve();
    }
    if (type === "removeDNRSessionRuleById") {
      installedRules.delete(payload);
      return Promise.resolve();
    }
    return Promise.reject(new Error(`unexpected message: ${type}`));
  });
}

function callsOf(type: string): any[][] {
  return sendMessageMock.mock.calls.filter(([callType]) => callType === type);
}

/** 每次 import 得到一份全新的模块实例 = 一个独立的 JS 上下文（独立的 dnrRuleCache） */
async function importFreshContext() {
  vi.resetModules();
  return await import("~/extends/axios/replaceUnsafeHeader.ts");
}

/** 两个上下文请求同一 URL、同一组不安全头（qBittorrent 绕过 CSRF 的典型形态） */
function makeConfig(): any {
  return {
    baseURL: "https://api.example.com",
    url: "/api/v2/torrents/info",
    method: "get",
    headers: createHeaders({ origin: "" }),
  };
}

describe("DNR 规则跨上下文隔离（EXTENDSI18N-3）", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    installedRules.clear();
    installSendMessageMock();
  });

  it("两个上下文对同一请求派生不同规则 id，一方释放不会删掉另一方的规则", async () => {
    const contextA = await importFreshContext();
    const contextB = await importFreshContext();

    const a = createFakeAxios();
    const b = createFakeAxios();
    contextA.setupReplaceUnsafeHeader(a.instance);
    contextB.setupReplaceUnsafeHeader(b.instance);

    const configA = makeConfig();
    const configB = makeConfig();

    await a.requestInterceptors[0]!.fulfilled(configA);
    await b.requestInterceptors[0]!.fulfilled(configB);

    const installs = callsOf("updateDNRSessionRules");
    expect(installs).toHaveLength(2);
    const idA = installs[0]![1].rule.id;
    const idB = installs[1]![1].rule.id;
    // 修复点：跨上下文（模块实例）id 必须不同，否则下面的删除会误伤对方
    expect(idA).not.toBe(idB);
    expect(configA.dummyHeaderRequestId).toBe(idA);
    expect(configB.dummyHeaderRequestId).toBe(idB);

    // A 的请求结束：只允许删除 A 自己装的规则
    a.responseInterceptors[0]!.fulfilled({ config: configA });
    const removes = callsOf("removeDNRSessionRuleById");
    expect(removes).toHaveLength(1);
    expect(removes[0]![1]).toBe(idA);
    // B 的规则仍在扩展级规则表里（修复前它和 A 共用 id，此处已被 A 删掉）
    expect(installedRules.has(idB)).toBe(true);
    expect(installedRules.has(idA)).toBe(false);

    // B 同一批次的后续请求：本地缓存 inflight>0 ⇒ 复用缓存、不重装规则。
    // 只有 id 隔离才能保证这条后续请求对应的规则仍然存在（即有 DNR 注入的请求头）。
    await b.requestInterceptors[0]!.fulfilled(makeConfig());
    expect(callsOf("updateDNRSessionRules")).toHaveLength(2);
    expect(installedRules.has(idB)).toBe(true);
  });

  it("同一上下文内同内容仍复用同一条规则（上下文标识不破坏 P1-9 的复用）", async () => {
    const contextA = await importFreshContext();
    const a = createFakeAxios();
    contextA.setupReplaceUnsafeHeader(a.instance);

    const first = makeConfig();
    const second = makeConfig();
    await a.requestInterceptors[0]!.fulfilled(first);
    await a.requestInterceptors[0]!.fulfilled(second);

    const installs = callsOf("updateDNRSessionRules");
    // 并发同 key 只装一次：复用收益保留
    expect(installs).toHaveLength(1);
    expect(first.dummyHeaderRequestId).toBe(second.dummyHeaderRequestId);
    expect(installedRules.size).toBe(1);
  });
});
