/**
 * SetMediaServer/OverviewDialog.vue：风险确认 → 按需拉取概览 → 渲染统计。
 *
 * 这里真实挂载 SFC，只把 `sendMessage` 换成受控 spy：
 * - 打开弹窗**不得**自动请求（整库遍历是高风险操作）；
 * - 确认后进入 loading，结果返回后渲染数字 / 观看统计 / 分布条 / 两个列表；
 * - reject 或 `None` 结果时给出提示且不再 loading；
 * - 关闭再打开回到未确认状态并清空旧结果；
 * - 关闭/重开之前发出的旧请求，其迟到结果必须被丢弃（generateToken 机制）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";

import { formatBitrate, type IMediaServerOverview } from "@ptd/mediaServer";
import { i18nInstance } from "@/options/plugins/i18n.ts";
import { formatDate, formatSize } from "@/options/utils.ts";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

const t = i18nInstance.global.t;

interface IDeferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): IDeferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createOverview(overrides: Partial<IMediaServerOverview> = {}): IMediaServerOverview {
  const totalSize = 2 * 1024 ** 3; // 2.00 GiB
  return {
    mediaServerId: "ms-1",
    generatedAt: Date.UTC(2024, 0, 2, 3, 4, 5),
    truncated: false,
    totalItems: 1234,
    totalSize,
    averageBitrate: 8_000_000,
    byResolution: [{ key: "1080p", count: 20, size: totalSize / 2 }],
    byCodec: [],
    byContainer: [],
    byRootPath: [{ key: "-", count: 3, size: 1 }],
    watch: { watched: 11, partial: 22, unwatched: 33, totalPlays: 44 },
    playsPerGb: 2.5,
    neverWatched: [{ name: "Big Movie", size: 1.5 * 1024 ** 3, productionYear: 2019 }],
    recentlyAdded: [{ name: "New Show", dateCreated: "2024-05-06T07:08:09.000Z" }],
    ...overrides,
  };
}

const modalBody = () => document.querySelector<HTMLElement>(".ant-modal-body");
const bodyText = () => modalBody()?.textContent ?? "";
const spinner = () => document.querySelector(".ant-modal-body .ant-spin");
const confirmButton = () => document.querySelector<HTMLButtonElement>(".ant-modal-body button.ant-btn-dangerous");
const regenerateButton = () => document.querySelector<HTMLButtonElement>(".ant-modal-title button");

async function mountDialog(mediaServerId = "ms-1") {
  const pinia = prepareOptionsPinia();
  const open = ref<boolean>(true);
  const { default: OverviewDialog } = await import("@/options/views/Settings/SetMediaServer/OverviewDialog.vue");

  const Host = defineComponent({
    name: "OverviewDialogHost",
    setup() {
      return () =>
        h(OverviewDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (value: boolean) => {
            open.value = value;
          },
          mediaServerId,
          mediaServerName: "Test Server",
        });
    },
  });

  const view = mountOptionsView(Host, { pinia });
  await view.settle(80);
  return { view, open };
}

describe("SetMediaServer/OverviewDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    sendMessageMock.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("打开时只显示风险提示，不自动请求概览", async () => {
    const { view } = await mountDialog();
    try {
      expect(bodyText()).toContain(t("SetMediaServer.Overview.warningTitle"));
      expect(bodyText()).toContain(t("SetMediaServer.Overview.warningLine1"));
      expect(bodyText()).toContain(t("SetMediaServer.Overview.warningConfirm"));
      expect(sendMessageMock, "未确认前不得发起整库遍历").not.toHaveBeenCalled();
      expect(spinner()).toBeNull();
      // 尚未确认，重新生成入口不应出现
      expect(regenerateButton()).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("确认后先进入 loading，结果返回后渲染概览数字、观看统计、分布条与两个列表", async () => {
    const overview = createOverview({ truncated: true });
    const pending = createDeferred<IMediaServerOverview>();
    sendMessageMock.mockImplementationOnce(() => pending.promise);

    const { view } = await mountDialog();
    try {
      confirmButton()!.click();
      await view.settle();

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith("getMediaServerOverview", { mediaServerId: "ms-1" });
      expect(spinner(), "请求进行中应显示 loading").not.toBeNull();
      expect(bodyText()).toContain(t("SetMediaServer.Overview.generating"));

      pending.resolve(overview);
      await vi.waitFor(() => expect(bodyText()).toContain("1234"));

      // 概览数字（C20）
      expect(bodyText()).toContain(formatSize(overview.totalSize));
      expect(bodyText()).toContain(formatBitrate(overview.averageBitrate)!);
      expect(bodyText()).toContain(t("SetMediaServer.Overview.playsPerGbValue", { value: 2.5 }));
      expect(spinner(), "结果返回后必须退出 loading").toBeNull();

      // 观看统计（C14 / C20）：四个标签各自带本地化文案与数值
      // （曾因语言包缺 watched/unwatched 两个 key 而直接显示 key 路径）
      const tagTexts = Array.from(document.querySelectorAll(".ant-modal-body .ant-tag")).map(
        (node) => node.textContent?.trim() ?? "",
      );
      expect(tagTexts).toEqual([
        `${t("SetMediaServer.Overview.watched")} 11`,
        `${t("SetMediaServer.Overview.partial")} 22`,
        `${t("SetMediaServer.Overview.unwatched")} 33`,
        `${t("SetMediaServer.Overview.totalPlays")} 44`,
      ]);

      // 分布条（C20）：byResolution / byRootPath 各一条，按总体积归一化
      expect(bodyText()).toContain(t("SetMediaServer.Overview.byResolution"));
      expect(bodyText()).toContain(t("SetMediaServer.Overview.countUnit", { count: 20 }));
      expect(bodyText(), 'key 为 "-" 时显示「未知」').toContain(t("SetMediaServer.Overview.unknownKey"));
      const bars = Array.from(document.querySelectorAll<HTMLElement>(".ant-modal-body .ant-progress-bg"));
      expect(bars).toHaveLength(2);
      expect(bars[0].style.width).toBe("50%");
      expect(bars[1].style.width, "小项至少保留 2% 宽度").toBe("2%");

      // 从未观看 / 最近入库
      expect(bodyText()).toContain(t("SetMediaServer.Overview.neverWatched"));
      expect(bodyText()).toContain("Big Movie");
      expect(bodyText()).toContain("2019");
      expect(bodyText()).toContain(formatSize(1.5 * 1024 ** 3));
      expect(bodyText()).toContain(t("SetMediaServer.Overview.recentlyAdded"));
      expect(bodyText()).toContain("New Show");
      expect(bodyText()).toContain(formatDate(new Date("2024-05-06T07:08:09.000Z").getTime()));

      // 截断提示与生成时间
      expect(bodyText()).toContain(t("SetMediaServer.Overview.truncated", { count: 1234 }));
      expect(bodyText()).toContain(
        t("SetMediaServer.Overview.generatedAt", { time: formatDate(overview.generatedAt) }),
      );

      // 已确认并拿到结果后，重新生成入口可用
      expect(regenerateButton()).not.toBeNull();
      expect(regenerateButton()!.disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("请求返回 undefined 时提示暂不支持概览，且退出 loading", async () => {
    sendMessageMock.mockResolvedValue(undefined);
    const { view } = await mountDialog();
    try {
      confirmButton()!.click();
      await vi.waitFor(() => expect(bodyText()).toContain(t("SetMediaServer.Overview.unsupported")));

      expect(spinner()).toBeNull();
      // 没有可渲染的概览内容
      expect(document.querySelector(".ant-modal-body .ant-progress")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("请求失败时显示错误信息且不再 loading", async () => {
    sendMessageMock.mockRejectedValue(new Error("media server unreachable"));
    const { view } = await mountDialog();
    try {
      confirmButton()!.click();
      await vi.waitFor(() => expect(bodyText()).toContain("media server unreachable"));

      expect(spinner()).toBeNull();
      expect(document.querySelector(".ant-modal-body .ant-alert-warning")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("关闭后重新打开回到未确认状态，旧结果被清空且不自动重发请求", async () => {
    sendMessageMock.mockResolvedValue(createOverview());
    const { view, open } = await mountDialog();
    try {
      confirmButton()!.click();
      await vi.waitFor(() => expect(bodyText()).toContain("1234"));

      open.value = false;
      await view.settle(120);
      open.value = true;
      await view.settle(120);

      expect(bodyText()).toContain(t("SetMediaServer.Overview.warningTitle"));
      expect(bodyText(), "重新打开后不应残留上一轮结果").not.toContain("1234");
      expect(sendMessageMock, "重新打开但仍未确认，不应自动请求").toHaveBeenCalledTimes(1);
      expect(regenerateButton()).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("关闭/重开之前发出的旧请求，其迟到结果会被丢弃", async () => {
    const first = createDeferred<IMediaServerOverview>();
    const second = createDeferred<IMediaServerOverview>();
    sendMessageMock.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const { view, open } = await mountDialog();
    try {
      confirmButton()!.click();
      await view.settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);

      // 请求 A 仍在途中：关闭再打开，然后重新确认（请求 B）
      open.value = false;
      await view.settle(120);
      open.value = true;
      await view.settle(120);
      confirmButton()!.click();
      await view.settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(spinner()).not.toBeNull();

      // A 迟到返回：不得覆盖 B 的加载状态，也不得渲染 A 的结果
      first.resolve(createOverview({ totalItems: 111 }));
      await view.settle(100);
      expect(bodyText()).not.toContain("111");
      expect(spinner(), "旧请求的 finally 不应关掉新一轮 loading").not.toBeNull();

      // B 返回后才渲染结果
      second.resolve(createOverview({ totalItems: 222 }));
      await vi.waitFor(() => expect(bodyText()).toContain("222"));
      expect(bodyText()).not.toContain("111");
      expect(spinner()).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("重新生成：请求进行中禁用，结果返回后恢复可用", async () => {
    sendMessageMock.mockResolvedValueOnce(createOverview());
    const { view } = await mountDialog();
    try {
      confirmButton()!.click();
      await vi.waitFor(() => expect(bodyText()).toContain("1234"));
      expect(regenerateButton()!.disabled).toBe(false);

      const pending = createDeferred<IMediaServerOverview>();
      sendMessageMock.mockImplementationOnce(() => pending.promise);

      regenerateButton()!.click();
      await view.settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(regenerateButton()!.disabled, "loading 期间重新生成应禁用").toBe(true);
      expect(spinner()).not.toBeNull();

      pending.resolve(createOverview({ totalItems: 4321 }));
      await vi.waitFor(() => expect(bodyText()).toContain("4321"));
      expect(regenerateButton()!.disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });
});
