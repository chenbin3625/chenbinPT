/**
 * 上游 3295c537（#1594）：时间轴 favicon 的绘制优化。
 *
 * - favicon 节点的 ref 稳定：拖动模糊滑块（只改 filters）不再让每个 favicon 重新 cache；
 * - 底图真的换了（改背景色 → 新的合成画布）时，只给这些节点重新 cache 一次；
 * - 合成画布按 (站点, 尺寸, 背景色) 缓存，同样的背景色不会每次渲染都新建 OffscreenCanvas。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, shallowRef } from "vue";

import { mountOptionsView } from "../../helpers/optionsView.ts";

const { initialControl, nodes, canvasCount, saveAsMock, showSnakebar, fakeStage } = vi.hoisted(() => ({
  initialControl: {
    title: "",
    backgroundColor: "#101010",
    userNameColor: "#FFFFFF",
    textColor: "#FFFFFF",
    faviconBlue: 0,
    dateFormat: "time_added",
    showTop: true,
    showTimeline: true,
    showField: { uploads: true },
    showPerSiteField: { siteName: true, name: true, level: true, uid: true },
    selectedSites: [] as string[],
  },
  /** 每个 Image 桩对应的「konva 节点」替身：记录 cache 次数与当前底图 */
  nodes: [] as Array<{ cacheCalls: number; image: unknown; cached: boolean }>,
  canvasCount: { value: 0 },
  saveAsMock: vi.fn(),
  showSnakebar: vi.fn(),
  /** Stage 替身：上游 #1623 的导出走 stage.toBlob() */
  fakeStage: { toBlob: vi.fn(async () => new Blob(["png"], { type: "image/png" })) },
}));

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));
vi.mock("@/options/stores/runtime.ts", () => ({ useRuntimeStore: () => ({ showSnakebar }) }));
vi.mock("@/options/stores/metadata.ts", () => ({
  useMetadataStore: () => ({
    sites: {},
    lastUserInfo: {},
    $onReady: async () => {},
    getSiteName: async (s: string) => s,
  }),
}));
vi.mock("@/options/stores/config.ts", async () => {
  const { reactive: vueReactive } = await import("vue");
  const store = vueReactive({
    userName: "tester",
    getUserNames: { perfName: "tester", names: {} },
    userDataTimelineControl: initialControl,
    $save: () => {},
  });
  return {
    useConfigStore: () => store,
    defaultTimelineBackgroundColor: "#101010",
    defaultTimelineUserNameColor: "#FFFFFF",
    defaultTimelineTextColor: "#FFFFFF",
  };
});
vi.mock("@/options/utils/saveAs.ts", () => ({ saveAs: saveAsMock }));
vi.mock("@vueuse/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vueuse/core")>();
  const { ref: vueRef } = await import("vue");
  return { ...actual, useElementSize: () => ({ width: vueRef(650) }) };
});
vi.mock("@/options/views/Overview/MyData/utils/siteMetadata.ts", () => ({
  allAddedSiteMetadata: { "site-a": { siteName: "A", isDead: false, faviconElement: { width: 24, height: 24 } } },
  loadAllAddedSiteMetadata: vi.fn(async () => ({})),
}));
vi.mock("@/options/views/Overview/MyData/UserDataTimeline/utils.ts", async () => {
  const { ref: vueRef } = await import("vue");
  const info = { site: "site-a", name: "u", joinTime: 1, uploaded: 1, uploads: 1 };
  return {
    canThisSiteShow: () => true,
    selectedSites: vueRef(["site-a"]),
    fixedLastUserInfo: vueRef({ "site-a": info }),
    timelineDataRef: {
      ref: shallowRef({
        createAt: new Date(),
        title: "timeline",
        siteInfo: [info],
        joinTimeInfo: { site: {}, time: 1, years: "0" },
        topInfo: { uploads: { site: { site: "site-a" }, subSite: {}, maxValue: 1, subValue: 0 } },
        totalInfo: { sites: 1, deadSites: 0, uploads: 1, ratio: 1 },
      }),
      reset: () => {},
    },
    topSiteRenderAttr: [{ iconFill: "#C9B037", siteKey: "site", valueKey: "maxValue" }],
    CTimelineUserInfoField: [{ name: "uploads", format: (x: number) => x }],
    image: (config: any) => ({ ...config }),
    text: (config: any) => ({ ...config }),
    divider: (config: any) => ({ ...config }),
    icon: (config: any) => ({ ...config }),
    loadFullData: async () => ({ "site-a": info }),
  };
});
vi.mock("konva/lib/Core", () => ({ default: { autoDrawEnabled: true } }));
vi.mock("vue-konva/core", async () => {
  const { defineComponent, h, watch } = await import("vue");
  const stub = (name: string) =>
    defineComponent({
      name: `Stub${name}`,
      props: { config: { type: Object, default: () => ({}) } },
      setup(props, { slots, expose }) {
        const node = { cacheCalls: 0, image: (props.config as any)?.image, cached: false };
        if (name === "Image") nodes.push(node);
        // 与 vue-konva 一致：config 变化时把属性写进节点（pre-flush watch）
        watch(
          () => (props.config as any)?.image,
          (image) => (node.image = image),
        );
        // 与真实 vue-konva 一样，getNode() 每次返回**同一个**节点对象（组件内用 WeakMap 按节点身份记账）
        const konvaNode = {
          cache: () => {
            node.cacheCalls += 1;
            node.cached = true;
          },
          isCached: () => node.cached,
          image: () => node.image,
          batchDraw: () => {},
        };
        expose({ getNode: () => konvaNode, getStage: () => fakeStage });
        return () => h("div", { class: `stub-konva-${name}` }, slots.default?.());
      },
    });
  return {
    Stage: stub("Stage"),
    Layer: stub("Layer"),
    Group: stub("Group"),
    Rect: stub("Rect"),
    Text: stub("Text"),
    Image: stub("Image"),
    Line: stub("Line"),
  };
});

class FakeOffscreenCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {
    canvasCount.value += 1;
  }
  getContext() {
    return { fillRect: () => {}, drawImage: () => {}, fillStyle: "" };
  }
}

beforeEach(() => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  vi.stubGlobal("__EXT_VERSION__", "v0.0.0");
  nodes.length = 0;
  canvasCount.value = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("时间轴 favicon 缓存（上游 #1594）", () => {
  it("改模糊值不重新 cache；改背景色只给换了底图的节点 cache 一次", async () => {
    const { default: TimelineIndex } = await import("@/options/views/Overview/MyData/UserDataTimeline/Index.vue");
    const { useConfigStore } = await import("@/options/stores/config.ts");
    // 必须改 store 里的响应式代理（直接改 hoisted 的原始对象不会触发重渲染）
    const control = useConfigStore().userDataTimelineControl;
    const view = mountOptionsView(TimelineIndex, { router: true });
    try {
      await view.settle(60);
      expect(nodes.length, "冠军站点 + 时间轴各有一个 favicon").toBe(2);
      expect(
        nodes.map((node) => node.cacheCalls),
        "挂载时每个 favicon cache 一次",
      ).toEqual([1, 1]);
      const canvasesAfterMount = canvasCount.value;

      // 拖动模糊滑块：只改 filters，不应该再 cache（konva 的滤镜在绘制时作用在 cache 画布上）
      for (const blur of [1, 2, 3]) {
        control.faviconBlue = blur;
        await nextTick();
        await view.settle(10);
      }
      expect(nodes.map((node) => node.cacheCalls)).toEqual([1, 1]);
      expect(canvasCount.value, "合成画布按背景色缓存，改模糊值不新建画布").toBe(canvasesAfterMount);

      // 改背景色：冠军站点的 favicon 底图是「带背景色的合成画布」，换了底图就要重新 cache
      control.backgroundColor = "#202020";
      await nextTick();
      await view.settle(20);
      const [topNode, siteNode] = nodes;
      expect(topNode!.cacheCalls, "底图换了的节点重新 cache 一次").toBe(2);
      expect(siteNode!.cacheCalls, "底图没变的节点不重复 cache").toBe(1);

      // 切回原来的背景色：命中合成画布缓存，不新建画布
      const before = canvasCount.value;
      control.backgroundColor = "#101010";
      await nextTick();
      await view.settle(20);
      expect(canvasCount.value).toBe(before);
    } finally {
      view.unmount();
    }
  });
});

describe("时间轴导出图片（上游 #1623）", () => {
  it("走 stage.toBlob（2 倍图）并以 Blob 交给 saveAs；编码失败时提示而不是静默", async () => {
    const { default: TimelineIndex } = await import("@/options/views/Overview/MyData/UserDataTimeline/Index.vue");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const view = mountOptionsView(TimelineIndex, { router: true });
    try {
      await view.settle(60);
      const exportButton = view
        .$$<HTMLButtonElement>("button")
        .find((button) => button.title === i18nInstance.global.t("common.exportImage"))!;
      expect(exportButton, "应渲染「导出图片」按钮").toBeDefined();

      saveAsMock.mockReset();
      fakeStage.toBlob.mockClear();
      exportButton.click();
      await view.settle(20);

      expect(fakeStage.toBlob).toHaveBeenCalledWith({ mimeType: "image/png", pixelRatio: 2 });
      expect(saveAsMock).toHaveBeenCalledTimes(1);
      const [data, filename] = saveAsMock.mock.calls[0]!;
      expect(data, "导出交给 saveAs 的是 Blob 而不是 base64 data URL").toBeInstanceOf(Blob);
      expect(filename).toMatch(/\.png$/);

      // 编码失败：不调用 saveAs，按钮退出 loading
      saveAsMock.mockReset();
      showSnakebar.mockReset();
      fakeStage.toBlob.mockRejectedValueOnce(new Error("Konva: toBlob() failed"));
      exportButton.click();
      await view.settle(20);
      expect(saveAsMock).not.toHaveBeenCalled();
      expect(showSnakebar).toHaveBeenCalledWith(expect.any(String), { color: "warning" });
      expect(exportButton.classList.contains("ant-btn-loading")).toBe(false);
    } finally {
      view.unmount();
    }
  });
});
