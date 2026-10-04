/**
 * 我的下载器页：进入页面自动刷新 + 首次加载。
 *
 * Q-3 改造：原用例后 3 条读 `MyClient/Index.vue` 源码文本（正则匹配
 * `startAutoRefresh,?[\s\S]*\}\s*=\s*useClientRefresh\(\)` / `onMounted(... startAutoRefresh(); ... loadTorrents();)`、
 * 以及进度列的 `width: "72"` 与 `normalizeTorrentProgress` 的写法）。那是"模板和脚本里写了这些字"。
 *
 * 现在**真实挂载视图并观察副作用**（只有 `@/messages.ts` 与 8 个子对话框被替换）：
 * - 首次加载：挂载后确实向后台发了 `getClientTorrents`，而且发请求时自动刷新**已经**在跑
 *   （顺序：startAutoRefresh 先于 loadTorrents）；
 * - 卸载：停止自动刷新并复位状态；
 * - 进度列：表头列宽稳定 72px，单元格展示的是**归一化后**的百分比（12.6 → 13%，120 → 100%）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

/**
 * `getDownloaderMetaData` 依赖 Vite 的 `import.meta.glob`（`requireContext`），
 * 在单测环境下拿不到实体模块；这里只替换这两个查询函数，枚举与类型保持原样。
 */
vi.mock("@ptd/downloader", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDownloaderMetaData: async (type: string) => ({ type, name: type, feature: {}, advanceAddTorrentOptions: {} }),
    getDownloaderIcon: () => "",
  };
});

// 子对话框都有各自的弹层与后台交互，本用例只关心页面装配与表格展示
vi.mock("@/options/views/Overview/MyClient/DeleteDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "DeleteDialogStub", setup: () => () => h("div") }) };
});
vi.mock("@/options/views/Overview/MyClient/PushToDownloaderDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "PushToDownloaderDialogStub", setup: () => () => h("div") }) };
});
vi.mock("@/options/views/Overview/MyClient/TorrentStateTd.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({ name: "TorrentStateTdStub", setup: () => () => h("span", { class: "stub-state" }) }),
  };
});
vi.mock("@/options/views/Overview/MyClient/ClientStatusDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "ClientStatusDialogStub", setup: () => () => h("div") }) };
});
vi.mock("@/options/views/Overview/MyClient/TorrentDetailDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "TorrentDetailDialogStub", setup: () => () => h("div") }) };
});
vi.mock("@/options/views/Overview/MyClient/SpeedLimitDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "SpeedLimitDialogStub", setup: () => () => h("div") }) };
});
vi.mock("@/options/views/Overview/MyClient/LabelDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "LabelDialogStub", setup: () => () => h("div") }) };
});
vi.mock("@/options/views/Overview/MyClient/RecheckConfirmDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "RecheckConfirmDialogStub", setup: () => () => h("div") }) };
});

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView";

/**
 * 后台返回的两个种子：一个正常进度、一个越界进度（必须被归一化）。
 * 字段按 CTorrent 给全：`filteredTorrents` 会读 infoHash / savePath / label，
 * 缺字段会让那个 computed 抛错、表格一行都不渲染（那样下面的断言就变成假通过）。
 */
const TORRENTS_FROM_CLIENT = [
  {
    clientId: "d1",
    id: "hash-1",
    infoHash: "hash-1",
    name: "正常进度",
    progress: 12.6,
    totalSize: 1024,
    savePath: "/downloads",
    label: "",
    state: "downloading",
    uploadSpeed: 0,
    downloadSpeed: 0,
    ratio: 1.5,
  },
  {
    clientId: "d1",
    id: "hash-2",
    infoHash: "hash-2",
    name: "越界进度",
    progress: 120,
    totalSize: 2048,
    savePath: "/downloads",
    label: "",
    state: "downloading",
    uploadSpeed: 0,
    downloadSpeed: 0,
  },
];

/** 发出 getClientTorrents 时自动刷新是否已经在跑（用来断言 onMounted 里的先后顺序） */
let autoRefreshRunningWhenLoaded: boolean[] = [];

let MyClientView: any;
let configStore: any;
let metadataStore: any;
let utils: any;

async function setupStores() {
  const pinia = prepareOptionsPinia();

  ({ useConfigStore: configStore } = await import("@/options/stores/config.ts"));
  ({ useMetadataStore: metadataStore } = await import("@/options/stores/metadata.ts"));
  utils = await import("@/options/views/Overview/MyClient/utils.ts");
  ({ default: MyClientView } = await import("@/options/views/Overview/MyClient/Index.vue"));

  const config = configStore();
  const meta = metadataStore();
  meta.downloaders["d1"] = {
    id: "d1",
    type: "qbittorrent",
    name: "qb",
    address: "http://qb.local",
    enabled: true,
  };

  // 模块级状态在同一文件的用例之间会保留，这里显式复位
  utils.autoRefreshRunning.value = false;
  utils.torrents.value = {};
  utils.selectedDownloaderIds.value = [];
  utils.globalRefreshInterval.value = utils.DEFAULT_CLIENT_REFRESH_INTERVAL_SECONDS;

  autoRefreshRunningWhenLoaded = [];
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async (type: string, payload: any) => {
    if (type === "getClientTorrents") {
      autoRefreshRunningWhenLoaded.push(utils.autoRefreshRunning.value);
      return JSON.parse(JSON.stringify(TORRENTS_FROM_CLIENT)); // 模拟结构化克隆
    }
    return undefined;
  });

  return { pinia, config, meta };
}

beforeEach(async () => {
  await setupStores();
});

describe("我的下载器页面自动刷新", () => {
  it("新配置默认进入页面即加载下载器种子", () => {
    const config = configStore();
    expect(config.download.initDownloaderTorrentOnEnter).toBe(true);
  });

  it("自动刷新默认开启为 30 秒间隔", () => {
    expect(utils.DEFAULT_CLIENT_REFRESH_INTERVAL_SECONDS).toBe(30);
    expect(utils.globalRefreshInterval.value).toBe(30);
  });

  it("页面打开：先启动自动刷新，再触发首次加载（后台真的收到了请求）", async () => {
    const { pinia } = await setupStores();

    expect(utils.autoRefreshRunning.value, "挂载前不应处于自动刷新状态").toBe(false);

    const view = mountOptionsView(MyClientView, { pinia, router: true });
    await view.settle(150);

    // 首次加载真的发生了
    const requestedIds = sendMessageMock.mock.calls
      .filter(([type]) => type === "getClientTorrents")
      .map(([, id]) => id);
    expect(requestedIds, "进入页面应加载已启用下载器的种子").toContain("d1");

    // 顺序：startAutoRefresh() 在 loadTorrents() 之前（否则首轮加载不会被纳入自动刷新状态）
    expect(autoRefreshRunningWhenLoaded.length).toBeGreaterThan(0);
    expect(
      autoRefreshRunningWhenLoaded.every((running) => running === true),
      "首次加载时自动刷新应已在运行",
    ).toBe(true);
    expect(utils.autoRefreshRunning.value).toBe(true);

    // 首轮数据确实落到了模块状态（证明后台往返链路可用，而不是只发了个请求）
    expect(utils.torrents.value["d1"]?.map((torrent: any) => torrent.id)).toEqual(["hash-1", "hash-2"]);

    await view.settle(80);
    view.unmount();
  });

  it("页面卸载：停止自动刷新并复位状态", async () => {
    const { pinia } = await setupStores();
    const view = mountOptionsView(MyClientView, { pinia, router: true });
    await view.settle(120);
    expect(utils.autoRefreshRunning.value).toBe(true);

    const callsBeforeUnmount = sendMessageMock.mock.calls.length;
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(utils.autoRefreshRunning.value, "卸载后不应再处于自动刷新状态").toBe(false);
    // 卸载后不再有新请求（定时器确实被清掉了）
    expect(sendMessageMock.mock.calls.length).toBe(callsBeforeUnmount);
  });
});

describe("我的下载器进度列展示", () => {
  it("分享率缺失 / 非法时兜底成 -，合法时保留两位小数（纯函数契约）", async () => {
    const { formatRatio } = await import("@/options/utils.ts");

    expect(formatRatio(1.5)).toBe("1.50");
    expect(formatRatio("2")).toBe("2.00");
    // 下载器实体不一定附带 ratio（ITorrent 未声明该字段），缺失/非法值不能变成 NaN 或抛错
    expect(formatRatio(undefined)).toBe("-");
    expect(formatRatio(null)).toBe("-");
    expect(formatRatio(Number.NaN)).toBe("-");
    expect(formatRatio("abc")).toBe("-");
    // 空串/空白串不能走 Number()（否则会得到 0，把「没有数据」显示成 "0.00"）
    expect(formatRatio("")).toBe("-");
    expect(formatRatio("   ")).toBe("-");
    // Infinity 与「事实上无限大」显示为 ∞，与 MyData 的 realFormatRatio 语义对齐
    // （分母为 0 时客户端确实能算出 Infinity：Aria2 的 uploadLength/totalLength、synology 的 upload/download）
    expect(formatRatio(Number.POSITIVE_INFINITY)).toBe("∞");
    expect(formatRatio(20000)).toBe("∞");
    // 字符串数字照常解析（颜色判定也走同一归一化，不会再出现「文本 2.50 却是危险色」）
    expect(formatRatio("2.5")).toBe("2.50");
  });

  it("分享率达标判定与文本同源（isRatioHealthy 契约）", async () => {
    const { isRatioHealthy } = await import("@/options/utils.ts");

    expect(isRatioHealthy(1)).toBe(true);
    expect(isRatioHealthy(1.5)).toBe(true);
    expect(isRatioHealthy("2.5"), "字符串数字必须与 formatRatio 一致地视为达标").toBe(true);
    expect(isRatioHealthy(Number.POSITIVE_INFINITY)).toBe(true);
    expect(isRatioHealthy(0.99)).toBe(false);
    expect(isRatioHealthy(0)).toBe(false);
    expect(isRatioHealthy(undefined)).toBe(false);
    expect(isRatioHealthy(null)).toBe(false);
    expect(isRatioHealthy("")).toBe(false);
    expect(isRatioHealthy(Number.NaN)).toBe(false);
  });

  it("进度值展示前会归一化并限制在 0-100（纯函数契约）", () => {
    const normalize = utils.normalizeTorrentProgress as (value: unknown) => number;
    const format = utils.formatTorrentProgressLabel as (value: unknown) => string;

    expect(normalize(50.4)).toBe(50.4);
    expect(normalize(120)).toBe(100);
    expect(normalize(-5)).toBe(0);
    expect(normalize(Number.NaN)).toBe(0);
    expect(normalize(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalize("67.8")).toBe(67.8);

    expect(format(12.6)).toBe("13%");
    expect(format(Number.NaN)).toBe("0%");
  });

  it("进度单元格：越界进度被夹到 0-100，分享率缺失时不崩且显示 -", async () => {
    const { pinia } = await setupStores();
    const view = mountOptionsView(MyClientView, { pinia, router: true });
    await view.settle(300);

    const headers = view.$$("th").map((th) => th.textContent?.trim() ?? "");
    expect(headers, "应渲染出「进度」列").toContain("进度");

    const bodyText = (view.$(".ant-table-tbody")?.textContent ?? "").replace(/\s+/g, " ");
    expect(bodyText, "表格应真的渲染出两行种子").toContain("正常进度");
    expect(bodyText, "表格应真的渲染出两行种子").toContain("越界进度");

    // 进度：文字必须来自 formatTorrentProgressLabel（经 :format 注入），即「归一化 + 取整」后的值。
    // 反回归：早先该格式化被放在默认插槽里，而 antd Progress 的文字来源是 format prop/插槽 →
    // 用户看到的是 antd 默认的 "12.6%"（且 36px 圆环放不下），也就是说那段格式化是死代码。
    expect(view.$$(".ant-progress").length, "每行一个圆形进度").toBeGreaterThanOrEqual(2);
    expect(view.$$(".ant-progress-text")[0]?.textContent?.trim(), "12.6 → 取整为 13%").toBe("13%");
    expect(bodyText, "不应原样显示越界进度").not.toContain("120%");
    // 越界值 120 被夹到 100 → 显示 100%
    expect(
      view.$$(".ant-progress-text").map((el) => el.textContent?.trim()),
      "越界进度夹到 0-100",
    ).toContain("100%");

    // 分享率列：有 ratio 时两位小数，缺失时 "-"（不是 NaN，也不让整张表渲染崩掉）
    const ratioIndex = headers.indexOf("分享率");
    expect(ratioIndex, "应渲染出「分享率」列").toBeGreaterThanOrEqual(0);
    const dataRows = view
      .$$(".ant-table-tbody tr")
      .filter((row) => row.querySelector("td"))
      // 排除 rc-table 的测量行（全空行）
      .filter((row) => (row.textContent ?? "").trim().length > 0);
    const ratioCells = dataRows.map((row) => Array.from(row.querySelectorAll("td"))[ratioIndex]?.textContent?.trim());
    expect(ratioCells, "分享率单元格：有 ratio 保留两位小数、缺失兜底成 -").toEqual(["1.50", "-"]);

    await view.settle(80);
    view.unmount();
  });

  /**
   * 保留的源码级断言（1 条）—— 为什么这里必须是源码级：
   *
   * 「进度列宽 72」是**列定义对象里的一个字段**（`{ title, key: "progress", align: "end", width: "72" }`），
   * 不是 DOM 上的东西：实测 mount 后 rc-table 只把 text-align 写到 `<th>`，
   * `<colgroup>` 里的 `<col>` 不带宽度（只有固定布局/横向滚动时 antd 才会下发宽度），
   * 而 `fullTableHeader` 是视图内的 computed，没有导出、外部无法读到。
   * 要行为化需要改 `src/**`（把列定义抽成可导入的模块）—— 已记入「需要源码配合」清单。
   */
  it("进度列在列定义里声明了稳定列宽（源码级，见上方说明）", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/entries/options/views/Overview/MyClient/Index.vue"),
      "utf8",
    );

    expect(source).toMatch(/\{ title: t\("MyClient\.table\.progress"\), key: "progress", align: "end", width: "72" \}/);
  });
});
