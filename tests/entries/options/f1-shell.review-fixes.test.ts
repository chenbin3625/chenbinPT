/**
 * F1 修复回归：options 外壳 / 公共组件（2026-10-23 修复轮）。
 *
 * 覆盖审查报告 F1-options-shell-stores.md 的：
 * - [Medium]-F1-02：ContextMenuLinkPush 必须等 metadata store 水合后再解析站点；
 * - D2-Medium-02：Topbar 搜索 push 带 nonce（本文件用源码级断言，行为侧依赖 SearchEntity 的 watch，
 *   见 `searchEntity*.test.ts`；这里钉住「query 里必须有单调递增的 t」这一契约）；
 * - D1-Low-07：formValidateRules.require 放行数值 0；
 * - Info-I3：formatTimeAgo 对未来时间返回 "-"；
 * - Info-I7：DeleteDialog 的 confirmDelete 同步抛错也要走 allSettled 通道；
 * - D1-Low-09：CheckSwitchButton 的全选/反选保留 `all` 之外的已选项。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, defineComponent, h, nextTick, ref, watchEffect } from "vue";

const { getDefinedSiteMetadataMock } = vi.hoisted(() => ({
  getDefinedSiteMetadataMock: vi.fn(async (siteId: string) => ({
    id: siteId,
    name: `站点 ${siteId}`,
    urls: [`https://${siteId}.example/`],
    legacyUrls: [],
    isDead: false,
    category: [],
    searchEntry: { default: {} },
  })),
}));

vi.mock("@ptd/site", () => ({
  getHostFromUrl: (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  },
  getDefinedSiteMetadata: getDefinedSiteMetadataMock,
}));
// mountOptionsView 会 `app.use(Antd)`：保留真实导出，只替换 runtime store 用到的 message
vi.mock("ant-design-vue", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return { ...actual, message: { open: vi.fn() } };
});
vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(async () => undefined), onMessage: vi.fn() }));

// ContextMenuLinkPush 用到的 router：用真实实现，只固定 route.query.link
const routeLink = vi.hoisted(() => ({ value: "https://pt.example/torrents.php?id=123" }));
const routerSpies = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    useRoute: () => ({ query: { link: routeLink.value } }),
    useRouter: () => routerSpies,
  };
});

// 子对话框换成 stub：记录收到的 torrentItems / open，避免真的去发消息
const dialogState = vi.hoisted(() => ({ torrentItems: [] as any[], open: false, mounted: 0 }));
vi.mock("@/options/components/SentToDownloaderDialog/Index.vue", () => ({
  default: defineComponent({
    name: "SentToDownloaderDialogStub",
    props: { torrentItems: { type: Array, default: () => [] }, modelValue: { type: Boolean, default: false } },
    emits: ["update:modelValue", "done", "cancel"],
    setup(props) {
      dialogState.mounted += 1;
      watchEffect(() => {
        dialogState.torrentItems = props.torrentItems as any[];
        dialogState.open = props.modelValue;
      });
      return () => h("div", { class: "sent-to-downloader-stub" });
    },
  }),
}));

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

const { default: ContextMenuLinkPush } = await import("@/options/views/ContextMenuLinkPush.vue");
const { default: CheckSwitchButton } = await import("@/options/components/CheckSwitchButton.vue");
const { default: DeleteDialog } = await import("@/options/components/DeleteDialog.vue");
const { formValidateRules, formatTimeAgo } = await import("@/options/utils.ts");

beforeEach(() => {
  dialogState.torrentItems = [];
  dialogState.open = false;
  dialogState.mounted = 0;
  routerSpies.push.mockClear();
  routerSpies.replace.mockClear();
  routeLink.value = "https://pt.example/torrents.php?id=123";
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * F1-02：ContextMenuLinkPush 水合顺序
 * ------------------------------------------------------------------ */

describe("F1-02：ContextMenuLinkPush 在 metadata 水合完成后再解析站点", () => {
  it("$onReady 未完成时不读 siteHostMap；完成后再解析出 site 并打开弹窗", async () => {
    const pinia = prepareOptionsPinia();
    const metadataStore = useMetadataStore(pinia);
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnakebar").mockImplementation(() => {});

    // 水合尚未完成：$onReady 挂起，siteHostMap 为空
    metadataStore.siteHostMap = {};
    let resolveReady!: () => void;
    (metadataStore as any).$onReady = () => new Promise<void>((resolve) => (resolveReady = resolve));

    const view = mountOptionsView(ContextMenuLinkPush, { pinia });
    await view.settle(30);

    // 旧实现在这里就会读空 map 并直接打开弹窗（torrent.site 永远 undefined）
    expect(dialogState.open, "水合完成前不应打开发送对话框").toBe(false);
    expect(dialogState.torrentItems, "水合完成前不应构造 torrentItems").toHaveLength(0);
    expect(snackbar).not.toHaveBeenCalled();

    // 水合完成：siteHostMap 就绪
    metadataStore.siteHostMap = { "pt.example": "ptsite" };
    resolveReady();
    await view.settle(30);

    expect(dialogState.open).toBe(true);
    expect(dialogState.torrentItems).toHaveLength(1);
    expect(dialogState.torrentItems[0].site, "应从 siteHostMap 解析出站点").toBe("ptsite");
    expect(dialogState.torrentItems[0].link).toBe("https://pt.example/torrents.php?id=123");
    expect(snackbar).toHaveBeenCalledTimes(1); // 关键词提示
    expect(snackbar.mock.calls[0]![1]).toMatchObject({ color: "warning" });

    view.unmount();
  });

  it("链接非法时提示错误并退回下载记录页（不挂对话框）", async () => {
    routeLink.value = "";
    const pinia = prepareOptionsPinia();
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnakebar").mockImplementation(() => {});

    const view = mountOptionsView(ContextMenuLinkPush, { pinia });
    await view.settle(30);

    expect(snackbar).toHaveBeenCalledTimes(1);
    expect(snackbar.mock.calls[0]![1]).toMatchObject({ color: "error" });
    expect(dialogState.open).toBe(false);
    // window.close() 在 tab 里是 no-op，必须有兜底导航
    expect(routerSpies.replace).toHaveBeenCalledWith({ name: "DownloadHistory" });

    view.unmount();
  });
});

/* ------------------------------------------------------------------ *
 * D1-Low-07 / Info-I3：utils
 * ------------------------------------------------------------------ */

describe("formValidateRules.require：数值 0 是合法值", () => {
  it("0 通过校验，空串/undefined 仍给出必填提示", () => {
    const required = formValidateRules.require("必填");
    expect(required(0)).toBe(true);
    expect(required("0")).toBe(true);
    expect(required("")).toBe("必填");
    expect(required(undefined)).toBe("必填");
    expect(required(null)).toBe("必填");
    expect(required(false)).toBe("必填");
  });
});

describe("formatTimeAgo：未来时间不再显示「< 1 分钟前」", () => {
  it("未来时间返回 -，过去时间仍正常显示", () => {
    const now = Date.now();
    expect(formatTimeAgo(now + 3 * 24 * 3600 * 1000)).toBe("-");
    expect(formatTimeAgo(now - 5 * 60 * 1000)).toContain("分");
    expect(formatTimeAgo(new Date(now - 26 * 3600 * 1000))).toContain("时");
  });
});

/* ------------------------------------------------------------------ *
 * Info-I7：DeleteDialog 的同步抛错
 * ------------------------------------------------------------------ */

describe("Info-I7：confirmDelete 同步抛错不会逃逸成 unhandled rejection", () => {
  it("同步抛错的项被记为失败：提示 + 全部失败时保持弹窗打开", async () => {
    const open = ref(true);
    const allDelete = vi.fn();
    const pinia = prepareOptionsPinia();
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnakebar").mockImplementation(() => {});

    const confirmDelete = vi.fn((id: string) => {
      throw new Error(`sync boom ${id}`);
    });

    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(DeleteDialog as any, {
            modelValue: open.value,
            "onUpdate:modelValue": (v: boolean) => (open.value = v),
            toDeleteIds: ["a", "b"],
            confirmDelete,
            onAllDelete: allDelete,
          }),
      }),
      { pinia },
    );

    await view.settle();
    document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-dangerous")!.click();
    await view.settle();

    expect(confirmDelete).toHaveBeenCalledTimes(2);
    expect(snackbar).toHaveBeenCalledTimes(1);
    expect(snackbar.mock.calls[0]![0]).toContain("a");
    expect(snackbar.mock.calls[0]![0]).toContain("b");
    expect(open.value, "一个都没删掉时不能关窗").toBe(true);
    expect(allDelete).not.toHaveBeenCalled();

    view.unmount();
  });
});

/* ------------------------------------------------------------------ *
 * D1-Low-09：CheckSwitchButton 不得丢弃 all 之外的选择
 * ------------------------------------------------------------------ */

describe("D1-Low-09：CheckSwitchButton 保留 all 之外的已选项", () => {
  function mountCheckSwitch(initial: string[], all: string[]) {
    const selected = ref<string[]>([...initial]);
    const view = mountOptionsView(CheckSwitchButton as any, {
      props: {
        modelValue: selected.value,
        all,
        "onUpdate:modelValue": (v: string[]) => {
          selected.value = v;
        },
      },
    });
    return { view, selected };
  }

  it("全选 = 并入 all，不丢掉不可见项", async () => {
    const { view, selected } = mountCheckSwitch(["hidden"], ["a", "b"]);
    await view.settle(10);

    view.$$("button")[0]!.click();
    await view.settle(10);
    expect(selected.value).toEqual(["hidden", "a", "b"]);

    view.unmount();
  });

  it("反选只翻转 all 内的项，all 之外的保持原样", async () => {
    const { view, selected } = mountCheckSwitch(["hidden", "a"], ["a", "b"]);
    await view.settle(10);

    view.$$("button")[2]!.click();
    await view.settle(10);
    expect(selected.value).toEqual(["hidden", "b"]);

    view.unmount();
  });

  it("全不选是明确的清空语义（含不可见项）", async () => {
    const { view, selected } = mountCheckSwitch(["hidden", "a"], ["a", "b"]);
    await view.settle(10);

    view.$$("button")[1]!.click();
    await view.settle(10);
    expect(selected.value).toEqual([]);

    view.unmount();
  });
});

/* ------------------------------------------------------------------ *
 * D2-Medium-02：Topbar 复搜 nonce（源码契约）
 * ------------------------------------------------------------------ */

describe("D2-Medium-02：顶栏搜索 push 带 nonce", () => {
  it("Topbar.startSearchEntity 的 query 里有 `t`（单调递增 nonce）", () => {
    const topbarSource = readFileSync(resolve(process.cwd(), "src/entries/options/views/Layout/Topbar.vue"), "utf8");
    expect(topbarSource).toMatch(/flush:\s*1,[\s\S]{0,400}?t:\s*Date\.now\(\)/);
  });

  it("TorrentTitleTd 的「搜索同名」同样带 nonce", () => {
    const source = readFileSync(resolve(process.cwd(), "src/entries/options/components/TorrentTitleTd.vue"), "utf8");
    expect(source).toMatch(/flush:\s*1,[\s\S]{0,200}?t:\s*Date\.now\(\)/);
  });
});
