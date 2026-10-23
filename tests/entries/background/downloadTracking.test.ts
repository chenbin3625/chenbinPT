import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
  getItem: vi.fn(),
  setItem: vi.fn(),
  downloadSearch: vi.fn(),
  downloadChanged: undefined as ((delta: any) => void) | undefined,
}));

vi.mock("@/messages.ts", () => ({
  onMessage: mocks.onMessage,
  sendMessage: mocks.sendMessage,
}));

vi.mock("@/storage.ts", () => ({
  extStorage: {
    getItem: mocks.getItem,
    setItem: mocks.setItem,
  },
}));

vi.mock("@/shared/storagePath.ts", () => ({
  getValueByPath: (value: any, path: any) => {
    const parts = Array.isArray(path) ? path : String(path).split(".");
    return parts.reduce((current: any, part: string) => current?.[part], value);
  },
  parsePath: (path: any) => (Array.isArray(path) ? path : String(path).split(".")),
  removeValueByPath: vi.fn(),
  setValueByPath: vi.fn(),
}));

const session = new Map<string, unknown>();
let holdNextTrackingSet: (() => Promise<void>) | null = null;

vi.stubGlobal("chrome", {
  downloads: {
    onChanged: {
      addListener: (listener: (delta: any) => void) => {
        mocks.downloadChanged = listener;
      },
    },
    download: vi.fn(),
    search: mocks.downloadSearch,
  },
  storage: {
    session: {
      get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        const snapshot = structuredClone(items);
        if (Object.hasOwn(snapshot, "ptd_downloadTracking") && holdNextTrackingSet) {
          const hold = holdNextTrackingSet;
          holdNextTrackingSet = null;
          await hold();
        }
        Object.entries(snapshot).forEach(([key, value]) => session.set(key, value));
      },
    },
    onChanged: { addListener: vi.fn() },
  },
  runtime: {
    id: "extension-id",
    getURL: (path: string) => `chrome-extension://extension-id/${path}`,
  },
});

const handlers = new Map<string, any>();
await import("@/background/utils/base.ts");

for (const [type, handler] of mocks.onMessage.mock.calls) {
  handlers.set(type, handler);
}

describe("service worker 下载追踪", () => {
  beforeEach(() => {
    session.clear();
    holdNextTrackingSet = null;
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.downloadSearch.mockReset();
    mocks.downloadSearch.mockResolvedValue([{ state: "in_progress" }]);
  });

  it("下载进入 complete 后，通过 offscreen 消息回写终态并移除追踪记录", async () => {
    const register = handlers.get("registerDownloadTracking");
    await register({
      data: {
        chromeDownloadId: 42,
        downloadId: 7,
        reservation: { site: "siteA", at: 10, previous: 0 },
      },
    });

    mocks.downloadChanged!({ id: 42, state: { current: "complete" } });
    await vi.waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith("settleBrowserDownload", {
        downloadId: 7,
        state: "complete",
        reservation: { site: "siteA", at: 10, previous: 0 },
      }),
    );
    expect(session.get("ptd_downloadTracking")).toEqual({});
  });

  it("下载在映射登记前已经完成时，登记阶段主动查询并回写终态", async () => {
    mocks.downloadSearch.mockResolvedValue([{ id: 43, state: "complete" }]);
    const register = handlers.get("registerDownloadTracking");

    await register({
      data: {
        chromeDownloadId: 43,
        downloadId: 8,
      },
    });

    expect(mocks.downloadSearch).toHaveBeenCalledWith({ id: 43 });
    expect(mocks.sendMessage).toHaveBeenCalledWith("settleBrowserDownload", {
      downloadId: 8,
      state: "complete",
      reservation: undefined,
    });
    expect(session.get("ptd_downloadTracking")).toEqual({});
  });

  it("站点下载间隔的 reserve/rollback 在 SW session storage 中保持 CAS 语义", async () => {
    const reserve = handlers.get("reserveSiteDownloadAt");
    const get = handlers.get("getSiteDownloadAt");
    const rollback = handlers.get("rollbackSiteDownloadAt");

    await expect(reserve({ data: { site: "siteA", at: 100 } })).resolves.toBe(0);
    await expect(get({ data: "siteA" })).resolves.toBe(100);
    await rollback({ data: { site: "siteA", at: 99, previous: 0 } });
    await expect(get({ data: "siteA" })).resolves.toBe(100);
    await rollback({ data: { site: "siteA", at: 100, previous: 0 } });
    await expect(get({ data: "siteA" })).resolves.toBe(0);
  });

  it("两个并发登记即使首次存储写入挂起，也不会被旧快照覆盖", async () => {
    const register = handlers.get("registerDownloadTracking");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    holdNextTrackingSet = () => gate;

    const first = register({ data: { chromeDownloadId: 81, downloadId: 11 } });
    await vi.waitFor(() => expect(holdNextTrackingSet).toBeNull());
    const second = register({ data: { chromeDownloadId: 82, downloadId: 12 } });
    release();
    await Promise.all([first, second]);

    expect(session.get("ptd_downloadTracking")).toMatchObject({
      81: { downloadId: 11 },
      82: { downloadId: 12 },
    });
    mocks.downloadChanged!({ id: 81, state: { current: "complete" } });
    mocks.downloadChanged!({ id: 82, state: { current: "complete" } });
    await vi.waitFor(() => expect(session.get("ptd_downloadTracking")).toEqual({}));
  });
});
