/**
 * 设置 → 站点 → 一键导入（移植自上游 7f8cb48a）。
 *
 * - 边读边渲染：生成器还没读完时已读到的站点就出现在列表里，标题栏显示加载进度；
 * - 卡片懒挂载：只有进入视口（IntersectionObserver 报告可见）的卡片才挂载内容（含 SiteFavicon）；
 * - 「包含公开站点（N）」开关：默认不列出 public 站点，打开后列出并参与「全选」；
 *   关闭时已选中的 public 站点被移出「已选择」；已离线站点始终不列出；
 * - utils：`iterateCanAddedSiteMetadata` 按 definitionList 顺序产出、跳过已添加站点。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const meta = vi.hoisted(() => ({
  sites: {} as Record<string, any>,
  getAddedSiteIds: [] as string[],
  addSite: vi.fn(async () => {}),
  removeSite: vi.fn(async () => {}),
  getSiteUserConfig: vi.fn(async () => ({})),
  buildSiteMapCache: vi.fn(async () => {}),
}));
vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => meta }));
vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(async () => undefined), onMessage: vi.fn() }));

/** 可控的站点定义来源：测试按需放行，模拟「读到一半」 */
const feed = vi.hoisted(() => ({
  sites: [] as any[],
  gate: null as null | Promise<void>,
  gateAfter: Infinity,
}));
vi.mock("@/options/views/Settings/SetSite/utils.ts", () => ({
  getCanAddedSiteMetadata: vi.fn(async () => ({})),
  iterateCanAddedSiteMetadata: async function* () {
    for (const [index, site] of feed.sites.entries()) {
      if (index === feed.gateAfter && feed.gate) await feed.gate;
      yield site;
    }
  },
}));

const faviconMounts = vi.hoisted(() => ({ siteIds: [] as string[] }));
vi.mock("@/options/components/SiteFavicon/Index.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { siteId: String },
      setup(props) {
        faviconMounts.siteIds.push(props.siteId!);
        return () => h("i", { class: "favicon-stub" });
      },
    }),
  };
});

/** 可控的 IntersectionObserver：记录被观察的元素，由测试决定哪些进入视口 */
const observed = vi.hoisted(() => ({ entries: [] as Array<{ target: Element; callback: Function; observer: any }> }));
class ControlledIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    observed.entries.push({ target, callback: this.callback, observer: this });
  }
  disconnect() {
    observed.entries = observed.entries.filter((entry) => entry.observer !== this);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}

function revealAll() {
  for (const { target, callback, observer } of [...observed.entries]) {
    callback([{ isIntersecting: true, target }], observer);
  }
}

const site = (id: string, extra: Record<string, any> = {}) => ({
  id,
  name: `Site ${id}`,
  type: "private",
  urls: [`https://${id}.example/`],
  ...extra,
});

async function openDialog() {
  const pinia = prepareOptionsPinia();
  const { default: OneClickImportDialog } = await import("@/options/views/Settings/SetSite/OneClickImportDialog.vue");
  const open = ref(false);
  const Root = defineComponent({
    setup: () => () =>
      h(OneClickImportDialog as any, {
        modelValue: open.value,
        "onUpdate:modelValue": (v: boolean) => (open.value = v),
      }),
  });
  const view = mountOptionsView(Root, { pinia });
  open.value = true;
  await view.settle(80);
  const instance = () => (view.app as any)._instance.subTree.component.setupState;
  return { view, instance };
}

const cardNames = () =>
  Array.from(document.querySelectorAll(".ant-list-item strong")).map((element) => element.textContent?.trim());

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", ControlledIntersectionObserver);
  observed.entries = [];
  faviconMounts.siteIds = [];
  feed.gate = null;
  feed.gateAfter = Infinity;
  feed.sites = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("一键导入 dialog", () => {
  it("卡片只在进入视口后挂载（含 SiteFavicon）", async () => {
    feed.sites = [site("a"), site("b")];
    const { view } = await openDialog();

    expect(cardNames()).toEqual([]);
    expect(faviconMounts.siteIds).toEqual([]);
    expect(observed.entries.length).toBe(2);

    revealAll();
    await view.settle(20);
    expect(cardNames()).toEqual(["Site a", "Site b"]);
    expect(faviconMounts.siteIds).toEqual(["a", "b"]);
    view.unmount();
  });

  it("边读边渲染：读到第 16 条就先刷入列表并显示加载进度，读完后进度消失", async () => {
    feed.sites = Array.from({ length: 20 }, (_, index) => site(`s${index}`));
    let release!: () => void;
    feed.gate = new Promise<void>((resolve) => (release = resolve));
    feed.gateAfter = 16;

    const { view, instance } = await openDialog();
    expect(instance().displayedSites.length).toBe(16);
    expect(document.body.textContent).toContain("正在加载站点定义…（已加载 16 个）");

    release();
    await view.settle(40);
    expect(instance().displayedSites.length).toBe(20);
    expect(document.body.textContent).not.toContain("正在加载站点定义");
    view.unmount();
  });

  it("public 站点默认不列出；开关显示数量，打开后参与「全选」，关闭时移出已选择；离线站点始终不列出", async () => {
    feed.sites = [
      site("priv"),
      site("pub", { type: "public" }),
      site("manual", { userInputSettingMeta: [{ name: "passkey" }] }),
      site("dead", { isDead: true }),
    ];
    const { view, instance } = await openDialog();
    revealAll();
    await view.settle(20);

    expect(cardNames()).toEqual(["Site priv", "Site manual"]);
    expect(document.body.textContent).toContain("包含公开站点（1）");
    // 「全选」范围：已列出、无需手动录入、尚未成功导入
    expect(instance().selectableSiteIds).toEqual(["priv"]);

    const publicSwitch = document.querySelector<HTMLButtonElement>(".one-click-import__public-switch .ant-switch")!;
    publicSwitch.click();
    await view.settle(20);
    revealAll();
    await view.settle(20);

    expect(cardNames()).toEqual(["Site priv", "Site pub", "Site manual"]);
    expect(instance().selectableSiteIds).toEqual(["priv", "pub"]);

    const selectAll = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "全选",
    )!;
    selectAll.click();
    await view.settle(20);
    expect(instance().importStatus.toWork).toEqual(["priv", "pub"]);

    publicSwitch.click();
    await view.settle(20);
    expect(cardNames()).toEqual(["Site priv", "Site manual"]);
    expect(instance().importStatus.toWork, "关闭开关后看不见的 public 站点不应再被导入").toEqual(["priv"]);
    view.unmount();
  });
});

describe("iterateCanAddedSiteMetadata", () => {
  it("按 definitionList 顺序产出，跳过已添加的站点", async () => {
    vi.resetModules();
    vi.doUnmock("@/options/views/Settings/SetSite/utils.ts");
    vi.doMock("@ptd/site", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      definitionList: ["a", "b", "c", "d"],
    }));
    vi.doMock("@/options/views/Overview/MyData/utils/siteMetadataCache.ts", () => ({
      getCachedSiteMetadata: async (siteId: string) => ({ id: siteId }),
    }));
    meta.getAddedSiteIds = ["b"];

    const { iterateCanAddedSiteMetadata } = await import("@/options/views/Settings/SetSite/utils.ts");
    const ids: string[] = [];
    for await (const siteMetadata of iterateCanAddedSiteMetadata()) ids.push(siteMetadata.id);
    expect(ids).toEqual(["a", "c", "d"]);
    meta.getAddedSiteIds = [];
  });
});
