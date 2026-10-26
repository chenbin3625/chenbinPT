/**
 * OUI-3 + L1 + G（复检 Medium / P1-9 / REVIEW-FINDINGS P2-6）：SetBase 草稿与副作用。
 *
 * - OUI-3：「重置系统设置」只 `configStore.$reset()`，不会重建 SetBase 的 draft/baseline。
 *   重置后页签仍显示重置前的值；重置前未保存的草稿编辑会在之后点保存时被写回，部分撤销重置。
 * - L1（REVIEW-FINDINGS P1-9）：beforeSave 只挂在当前页签实例上。切走页签后组件被
 *   `destroy-inactive-tab-pane` 卸载，在下载页签关掉「记住上次下载服务器」再切到别的页签保存，
 *   旧值不会被清理。
 * - G（REVIEW-FINDINGS P2-6）：冷启动不等 `configStore.$onReady()`，草稿可能基于未水合值。
 *
 * 这里用真实 vue-router（父级 = SetBase/Index.vue，子路由 = 真实页签组件）挂载整页，
 * 通过真实点击/导航断言以上三条行为，而不是读源码。
 */
import Antd from "ant-design-vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { RouterView, createMemoryHistory, createRouter } from "vue-router";

import { prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

const sleep = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function mountSetBase(initialRoute = "SetBaseUi", configSetup?: (configStore: any) => void) {
  const pinia = prepareOptionsPinia();
  const { useConfigStore } = await import("@/options/stores/config.ts");
  const { useMetadataStore } = await import("@/options/stores/metadata.ts");
  const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
  const { i18nInstance } = await import("@/options/plugins/i18n.ts");
  const { setBaseChildren } = await import("@/options/plugins/router.ts");
  const { default: SetBaseIndex } = await import("@/options/views/Settings/SetBase/Index.vue");

  const configStore = useConfigStore(pinia);
  configSetup?.(configStore);
  const metadataStore = useMetadataStore(pinia);
  (metadataStore as any).$save = vi.fn(async () => undefined);
  const runtimeStore = useRuntimeStore(pinia);
  const configSave = vi.fn(async () => undefined);
  (configStore as any).$save = configSave;
  const snackbar = vi.spyOn(runtimeStore, "showSnakebar").mockImplementation(() => undefined);

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: SetBaseIndex as any, children: setBaseChildren as any }],
  });
  await router.push({ name: initialRoute });

  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(RouterView) });
  app.use(pinia);
  app.use(i18nInstance);
  app.use(Antd as any);
  app.use(router);
  app.mount(host);
  await sleep(150);

  return {
    app,
    host,
    router,
    pinia,
    configStore,
    metadataStore,
    runtimeStore,
    snackbar,
    configSave,
    t: i18nInstance.global.t,
  };
}

/** 在含指定文案的设置行里找开关 */
function switchForLabel(label: string): HTMLElement | null {
  const row = Array.from(document.querySelectorAll<HTMLElement>(".ptd-settings-row")).find((node) =>
    node.textContent?.includes(label),
  );
  return row?.querySelector<HTMLElement>(".ant-switch") ?? null;
}

const isSwitchOn = (element: HTMLElement | null) => element?.classList.contains("ant-switch-checked") ?? false;

describe("OUI-3：「重置系统设置」后 SetBase 草稿同步重建", () => {
  let harness: Awaited<ReturnType<typeof mountSetBase>>;

  beforeEach(async () => {
    document.body.innerHTML = "";
    harness = await mountSetBase("SetBaseUi");
  });

  afterEach(() => {
    harness.app.unmount();
    harness.host.remove();
  });

  it("重置后页签显示默认值；重置前的旧草稿不会在保存时复活", async () => {
    const { configStore, router, t } = harness;

    // 默认 true，UI 页签显示为开
    expect(configStore.saveTableBehavior).toBe(true);
    expect(isSwitchOn(switchForLabel(t("SetBase.ui.saveTableBehavior")))).toBe(true);

    // 在草稿里关掉开关（不保存）：store 不应被写
    switchForLabel(t("SetBase.ui.saveTableBehavior"))!.click();
    await sleep();
    expect(configStore.saveTableBehavior, "草稿编辑不应实时写回 store").toBe(true);

    // 切到「插件重置」页签执行重置系统设置
    await router.push({ name: "SetBaseReset" });
    await sleep(150);
    const resetItem = Array.from(document.querySelectorAll<HTMLElement>(".ant-list-item")).find((node) =>
      node.textContent?.includes(t("SetBase.reset.resetSystemSettings")),
    );
    expect(resetItem, "应渲染出「重置系统设置」项").toBeTruthy();
    resetItem!.querySelector("button")!.click();
    await sleep(80);
    document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-dangerous")!.click();
    await sleep(200);
    expect(configStore.saveTableBehavior, "重置后 store 应恢复默认值").toBe(true);

    // 回到 UI 页签：草稿必须已重建，显示默认值（修复前仍显示重置前的 false）
    await router.push({ name: "SetBaseUi" });
    await sleep(180);
    expect(
      isSwitchOn(switchForLabel(t("SetBase.ui.saveTableBehavior"))),
      "重置后页签必须显示默认值（草稿未重建时会显示重置前的 false）",
    ).toBe(true);

    // 点保存：不得把重置前的旧草稿写回（修复前会把 false 合并回 store）
    document.querySelector<HTMLButtonElement>(".set-base-save")!.click();
    await sleep(150);
    expect(configStore.saveTableBehavior, "保存不得复活重置前的旧草稿").toBe(true);
  });
});

describe("L1：切走页签后，之前页签的 beforeSave 副作用仍会执行", () => {
  it("在下载页签关掉「记住上次下载服务器」，切到 UI 页签保存也会清空旧值", async () => {
    document.body.innerHTML = "";
    // 打开「记住上次下载服务器」再模拟用户在草稿里关掉它（默认值是 false，需要先打开）
    const harness = await mountSetBase("SetBaseDownload", (configStore) => {
      configStore.download.saveLastDownloader = true;
    });
    const { metadataStore, router, t } = harness;
    try {
      // 模拟历史遗留的「上次使用」记录
      metadataStore.lastDownloader = { d1: true } as any;
      metadataStore.lastKeepUpload = { t1: { site: "s1", title: "x" } } as any;

      expect(isSwitchOn(switchForLabel(t("SetBase.download.saveLastDownloader")))).toBe(true);
      switchForLabel(t("SetBase.download.saveLastDownloader"))!.click();
      await sleep();
      expect(isSwitchOn(switchForLabel(t("SetBase.download.saveLastDownloader")))).toBe(false);
      expect(metadataStore.lastDownloader, "关闭开关本身不应立即清空（保存时才生效）").toEqual({ d1: true });

      // 切到另一个页签：DownloadWindow 被 destroy-inactive-tab-pane 卸载
      await router.push({ name: "SetBaseUi" });
      await sleep(180);

      document.querySelector<HTMLButtonElement>(".set-base-save")!.click();
      await sleep(150);

      expect(metadataStore.lastDownloader, "切页签保存也必须执行下载页签的 beforeSave 副作用").toEqual({});
      expect(metadataStore.lastKeepUpload).toEqual({});
    } finally {
      harness.app.unmount();
      harness.host.remove();
    }
  });
});

describe("G：冷启动等 config store 水合完成后再建草稿", () => {
  it("$onReady 之后 resolve 的新值会重建草稿（不会把未水合默认值当成用户数据）", async () => {
    document.body.innerHTML = "";
    // 让 $onReady 延迟 resolve，模拟 storage 尚未水合
    const { useConfigStore } = await import("@/options/stores/config.ts");
    const pinia = prepareOptionsPinia();
    const configStore = useConfigStore(pinia);
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => (resolveReady = resolve));
    (configStore as any).$onReady = () => ready;
    (configStore as any).$save = async () => undefined;
    const { setBaseChildren } = await import("@/options/plugins/router.ts");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const { default: SetBaseIndex } = await import("@/options/views/Settings/SetBase/Index.vue");
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: SetBaseIndex as any, children: setBaseChildren as any }],
    });
    await router.push({ name: "SetBaseUi" });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(RouterView) });
    app.use(pinia);
    app.use(i18nInstance);
    app.use(Antd as any);
    app.use(router);
    app.mount(host);
    await sleep(80);

    // 水合完成后 store 里的值（模拟已保存配置）与初始默认不同
    configStore.saveTableBehavior = false;
    resolveReady();
    await nextTick();
    await sleep(120);

    expect(
      isSwitchOn(switchForLabel(i18nInstance.global.t("SetBase.ui.saveTableBehavior"))),
      "水合完成后草稿应重建为 store 里的已保存值",
    ).toBe(false);

    app.unmount();
    host.remove();
  });
});

it("常规设置保存期间显示忙碌状态，连续点击仅保存一次", async () => {
  const harness = await mountSetBase();
  let finish!: () => void;
  harness.configSave.mockImplementation(
    () =>
      new Promise<undefined>((resolve) => {
        finish = () => resolve(undefined);
      }),
  );
  try {
    const save = harness.host.querySelector<HTMLButtonElement>(".set-base-save")!;
    save.click();
    save.click();
    await sleep();
    expect(harness.configSave).toHaveBeenCalledTimes(1);
    expect(save.classList.contains("ant-btn-loading")).toBe(true);
  } finally {
    finish();
    await sleep();
    harness.app.unmount();
    harness.host.remove();
  }
});
