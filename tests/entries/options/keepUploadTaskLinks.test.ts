/**
 * 辅种任务页不再提供「如何使用」外链。
 *
 * Q-3 改造：原断言读 `KeepUploadTask/Index.vue` 源码文本，检查不含
 * `PT-Plugin-Plus/wiki/keep-upload-task` 与 `common.howToUse`。
 * 那是"源码里没有某个字符串"，而不是"用户看不到这个入口"——例如把链接挪进子组件、
 * 用变量拼 URL、或在别处渲染，断言都会失真。
 * 现在真实挂载该视图，断言**渲染结果里不存在指向旧 wiki 的链接**。
 */
import { describe, expect, it, vi } from "vitest";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

describe("KeepUploadTask 页面链接", () => {
  it("渲染结果里没有指向旧 PTPP wiki 的「如何使用」外链", async () => {
    const pinia = prepareOptionsPinia();
    sendMessageMock.mockResolvedValue([]);

    const { default: KeepUploadTask } = await import("@/options/views/Overview/KeepUploadTask/Index.vue");
    const view = mountOptionsView(KeepUploadTask, { pinia });
    await view.settle(60);

    // 页面渲染成功（避免"整页没渲染出来"导致下面的断言假通过）
    expect(view.text().trim().length).toBeGreaterThan(0);

    // 行为断言：页面里不存在指向旧仓库 wiki 的链接
    const links = Array.from(view.host.querySelectorAll<HTMLAnchorElement>("a[href]")).map((a) => a.href);
    expect(
      links.filter((href) => /PT-Plugin-Plus\/wiki/.test(href)),
      "不应再有旧 wiki 链接",
    ).toEqual([]);
    expect(links.filter((href) => /keep-upload-task/i.test(href))).toEqual([]);

    // 也不出现「如何使用」这类文案入口
    expect(view.text()).not.toMatch(/如何使用|How to use/i);

    view.unmount();
  });
});

// ── F4（N11 / N12 / N13）：辅种批量发送、基准种子与选中集 ───────────────────

const { showSnakebarMock } = vi.hoisted(() => ({ showSnakebarMock: vi.fn() }));

function makeTask(overrides: Record<string, any> = {}) {
  const items: Array<{
    site: string;
    title: string;
    subTitle?: string;
    link: string;
    url: string;
    size: number;
  }> = [1, 2, 3].map((index) => ({
    site: "s1",
    title: `item-${index}`,
    link: `https://example.com/detail-${index}`,
    url: `https://example.com/download-${index}`,
    size: 1024 * index,
  }));
  return {
    id: "task-1",
    time: Date.now(),
    title: "task-title",
    size: 6144,
    downloadOptions: { downloaderId: "d1", clientName: "QB", savePath: "/downloads" },
    items,
    ...overrides,
  };
}

async function mountKeepUpload(sendImpl: (type: string, data: any) => any, task = makeTask()) {
  const pinia = prepareOptionsPinia();
  const { useMetadataStore } = await import("@/options/stores/metadata.ts");
  const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
  const meta = useMetadataStore(pinia);
  meta.downloaders = {
    d1: { id: "d1", type: "qbittorrent", name: "QB", address: "http://qb.local", enabled: true },
  } as any;
  // 发送循环里的占位符替换会解析站点名；这里用 merge.name 让它不必动态加载站点定义
  meta.sites = { s1: { merge: { name: "站点1" } } } as any;

  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async (type: string, data: any) => {
    if (type === "getKeepUploadTasks") return [task];
    return sendImpl(type, data);
  });

  const runtimeStore = useRuntimeStore(pinia);
  vi.spyOn(runtimeStore, "showSnakebar").mockImplementation(showSnakebarMock);

  const { default: KeepUploadTask } = await import("@/options/views/Overview/KeepUploadTask/Index.vue");
  const view = mountOptionsView(KeepUploadTask, { pinia });
  await view.settle(120);

  const t = (await import("@/options/plugins/i18n.ts")).i18nInstance.global.t;
  const clickConfirm = async () => {
    const ok = Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal-confirm .ant-btn-primary")).at(-1);
    expect(ok, "应弹出确认框").not.toBeUndefined();
    ok!.click();
    await view.settle(80);
  };

  return { view, t, clickConfirm, meta };
}

describe("N11：辅种批量发送不中途中止，并汇总成功/失败/待重试", () => {
  it("summarizeKeepUploadSendOutcomes 区分成功 / 失败 / 待重试并保留首个原因", async () => {
    const { summarizeKeepUploadSendOutcomes } = await import("@/options/views/Overview/KeepUploadTask/utils.ts");
    const summary = summarizeKeepUploadSendOutcomes([
      { status: "success" },
      { status: "success", warningMessage: "label skipped" },
      { status: "failed", reason: "boom" },
      { status: "pending" },
      { status: "failed", reason: "second" },
    ]);
    expect(summary).toMatchObject({
      succeeded: 2,
      failed: 2,
      pending: 1,
      warned: 1,
      firstFailureReason: "boom",
      firstWarningMessage: "label skipped",
    });
  });

  it("第 2 项失败后仍继续发送其余项，提示里带成功数与失败数", async () => {
    const { view, t, clickConfirm } = await mountKeepUpload((type, data) => {
      if (type !== "downloadTorrent") return undefined;
      if (data.torrent.title === "item-2") {
        return { downloadStatus: "failed", errorMessage: "站点下载间隔未到" };
      }
      return { downloadStatus: "completed" };
    });

    try {
      const sendAllBtn = view.$<HTMLButtonElement>(`.ant-table button[title="${t("KeepUploadTask.sendAllTorrents")}"]`);
      expect(sendAllBtn).not.toBeNull();
      sendAllBtn!.click();
      await view.settle(60);
      await clickConfirm();

      const downloadCalls = sendMessageMock.mock.calls.filter(([type]) => type === "downloadTorrent");
      expect(downloadCalls, "第 2 项失败后不应中止后续项").toHaveLength(3);

      const [message, options] = showSnakebarMock.mock.calls.at(-1)!;
      expect(message).toContain("2"); // 成功 2
      expect(message).toContain("1"); // 失败 1
      expect(message).toContain("站点下载间隔未到");
      expect(options).toMatchObject({ color: "warning" });
    } finally {
      view.unmount();
    }
  });
});

describe("N12：设为基准种子持久化失败时回滚", () => {
  it("updateKeepUploadTask 失败后列表顺序保持不变", async () => {
    const { view, t } = await mountKeepUpload((type) => {
      if (type === "updateKeepUploadTask") throw new Error("storage quota exceeded");
      return undefined;
    });

    try {
      // 展开任务行
      const expander = view.$<HTMLElement>(".ant-table-row-expand-icon");
      expect(expander, "应能展开任务行").not.toBeNull();
      expander!.click();
      await view.settle(60);

      const setBaseButtons = view.$$<HTMLButtonElement>(
        `.ant-table button[title="${t("KeepUploadTask.setAsBaseTorrent")}"]`,
      );
      expect(setBaseButtons.length, "展开行里每个子种子一个「设为基准种子」按钮").toBe(3);

      setBaseButtons[1]!.click(); // 把 item-2 设为基准
      await view.settle(80);

      const firstItemTitle = view.$(".ant-table-expanded-row .ant-list-item a")?.textContent?.trim();
      expect(firstItemTitle, "持久化失败时不应改动内存顺序").toBe("item-1");
      expect(showSnakebarMock).toHaveBeenCalledWith(t("KeepUploadTask.setBaseError"), { color: "error" });
    } finally {
      view.unmount();
    }
  });
});

describe("N13：删除后清理选中集", () => {
  it("删除单条已选任务后，批量删除按钮回到禁用", async () => {
    const { view, t, clickConfirm } = await mountKeepUpload((type) => {
      if (type === "deleteKeepUploadTask") return undefined;
      return undefined;
    });

    try {
      const rowCheckbox = view.$<HTMLInputElement>(".ant-table-tbody input[type=checkbox]");
      expect(rowCheckbox).not.toBeNull();
      rowCheckbox!.click();
      await view.settle(40);

      const batchDeleteBtn = () =>
        Array.from(view.$$<HTMLButtonElement>("button")).find(
          (button) => button.textContent?.includes(t("common.remove")) && !button.closest(".ant-table"),
        );
      expect(batchDeleteBtn()?.disabled, "选中一条后批量删除可用").toBe(false);

      const rowDeleteBtn = view.$<HTMLButtonElement>(`.ant-table-tbody button[title="${t("common.remove")}"]`);
      expect(rowDeleteBtn).not.toBeNull();
      rowDeleteBtn!.click();
      await view.settle(40);
      await clickConfirm();

      expect(batchDeleteBtn()?.disabled, "删除后选中集应被清理，批量删除回到禁用").toBe(true);
    } finally {
      view.unmount();
    }
  });
});

// ── OUI-4 / L2 / D：占位符路径安全化、发送汇总文案 ─────────────────────────────

describe("OUI-4：辅种发送的 savePath/label 占位符替换值必须做路径安全化", () => {
  it("标题/副标题里的 `..`、`/` 等不会逃出用户配置的目录", async () => {
    const task = makeTask({
      downloadOptions: {
        downloaderId: "d1",
        clientName: "QB",
        savePath: "/downloads/$torrent.title$/$torrent.subTitle$",
      },
    });
    // 页面解析出来的恶意/被污染标题：目录穿越 + 路径分隔符 + Windows 非法字符
    task.items[0]!.title = "../../escape/evil";
    task.items[0]!.subTitle = "a/b:c";

    const { view, t, clickConfirm } = await mountKeepUpload((type) => {
      if (type !== "downloadTorrent") return undefined;
      return { downloadStatus: "completed" };
    }, task);

    try {
      const sendAllBtn = view.$<HTMLButtonElement>(`.ant-table button[title="${t("KeepUploadTask.sendAllTorrents")}"]`);
      expect(sendAllBtn).not.toBeNull();
      sendAllBtn!.click();
      await view.settle(60);
      await clickConfirm();

      const call = sendMessageMock.mock.calls.find(([type]) => type === "downloadTorrent");
      const savePath = (call?.[1]?.addTorrentOptions as Record<string, any>)?.savePath as string;
      expect(savePath, "应下发出 savePath").toBeTypeOf("string");
      expect(savePath, "替换值不得引入目录穿越").not.toContain("..");
      expect(savePath, "替换值不得引入额外路径分隔符（模板里的 /downloads/ 除外）").toBe(
        "/downloads/.-.-escape-evil/a-b-c",
      );
    } finally {
      view.unmount();
    }
  });

  it("label 模板同样使用清洗后的替换值", async () => {
    const task = makeTask({
      downloadOptions: {
        downloaderId: "d1",
        clientName: "QB",
        addTorrentOptions: { label: "site-$torrent.title$" },
      },
    });
    task.items[0]!.title = "x/../../y";

    const { view, t, clickConfirm } = await mountKeepUpload((type) => {
      if (type !== "downloadTorrent") return undefined;
      return { downloadStatus: "completed" };
    }, task);

    try {
      view.$<HTMLButtonElement>(`.ant-table button[title="${t("KeepUploadTask.sendAllTorrents")}"]`)!.click();
      await view.settle(60);
      await clickConfirm();

      const call = sendMessageMock.mock.calls.find(([type]) => type === "downloadTorrent");
      const label = (call?.[1]?.addTorrentOptions as Record<string, any>)?.label as string;
      expect(label).toBe("site-x-.-.-y");
    } finally {
      view.unmount();
    }
  });
});

describe("D / L2：KeepUploadTask 发送汇总文案与真实结果对齐", () => {
  it("D：单条发送 pending（站点下载间隔未到）必须提示 warning，不能显示绿色成功", async () => {
    const singleItemTask = makeTask({ items: [makeTask().items[0]] });
    const { view, t, clickConfirm } = await mountKeepUpload((type) => {
      if (type !== "downloadTorrent") return undefined;
      return { downloadStatus: "pending" };
    }, singleItemTask);

    try {
      view.$<HTMLButtonElement>(`.ant-table button[title="${t("KeepUploadTask.sendAllTorrents")}"]`)!.click();
      await view.settle(60);
      await clickConfirm();
      // 单条任务（items.length === 1）会走 sendTorrentsToDownloader 的单条汇总分支
      const [message, options] = showSnakebarMock.mock.calls.at(-1)!;
      expect(message).toContain(t("KeepUploadTask.sendSingleSuccess"));
      expect(message).toContain(t("SentToDownloaderDialog.sendSummaryPending", { count: 1 }));
      expect(options).toMatchObject({ color: "warning" });
    } finally {
      view.unmount();
    }
  });

  it("D：单条发送 warned（下载器降级）必须带 warning 提示", async () => {
    const singleItemTask = makeTask({ items: [makeTask().items[0]] });
    const { view, t, clickConfirm } = await mountKeepUpload((type) => {
      if (type !== "downloadTorrent") return undefined;
      return { downloadStatus: "completed", warningMessage: "label skipped" };
    }, singleItemTask);

    try {
      view.$<HTMLButtonElement>(`.ant-table button[title="${t("KeepUploadTask.sendAllTorrents")}"]`)!.click();
      await view.settle(60);
      await clickConfirm();
      const [message, options] = showSnakebarMock.mock.calls.at(-1)!;
      expect(message).toContain("label skipped");
      expect(options).toMatchObject({ color: "warning" });
    } finally {
      view.unmount();
    }
  });

  it("L2：批量全部成功时使用 KeepUploadTask.sendSummary 专用文案", async () => {
    const { view, t } = await mountKeepUpload((type) => {
      if (type !== "downloadTorrent") return undefined;
      return { downloadStatus: "completed" };
    });

    try {
      view.$<HTMLButtonElement>(`.ant-table button[title="${t("KeepUploadTask.sendAllTorrents")}"]`)!.click();
      await view.settle(60);
      await (async () => {
        const ok = Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal-confirm .ant-btn-primary")).at(
          -1,
        );
        ok!.click();
        await view.settle(80);
      })();

      expect(showSnakebarMock).toHaveBeenLastCalledWith(t("KeepUploadTask.sendSummary"), { color: "success" });
    } finally {
      view.unmount();
    }
  });
});
