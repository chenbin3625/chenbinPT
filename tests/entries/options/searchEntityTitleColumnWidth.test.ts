/**
 * 搜索结果表格的列宽自适应。
 *
 * 回归的是「取消部分列展示后标题右侧留下大片空白」：
 * 标题列在 `table-layout: auto` 下会被撑到远超内容需要，而标题单元格上的 `max-width`
 * 只约束内容、不约束列宽，于是列内右侧出现大片空白（#1556 的复发形态）。
 * 这里真实挂载搜索结果页，断言桌面端**没有**给标题单元格写内联 max-width（即不限宽、
 * 由列宽分配把剩余宽度全给标题列），同时移动端仍然保留 32vw 上限。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn().mockResolvedValue(undefined), onMessage: vi.fn() }));

/** happy-dom 的视口宽度（jsdom/happy-dom 默认 1024）→ 桌面端形态 */
const DESKTOP_WIDTH = 1024;
/** 低于 useDisplay 的 md 阈值（840）→ 移动端形态 */
const MOBILE_WIDTH = 600;

let SearchEntityView: any;

async function mountSearchEntity(viewportWidth: number) {
  // useDisplay 走 @vueuse/core 的 useWindowSize，改窗口尺寸即可切换断点
  window.innerWidth = viewportWidth;
  window.dispatchEvent(new Event("resize"));

  const pinia = prepareOptionsPinia();
  const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
  const { useMetadataStore } = await import("@/options/stores/metadata.ts");
  const metadataStore = useMetadataStore(pinia);
  // 站点列会按 siteId 查站点元数据，未添加的站点会让该方法抛错（未处理的 rejection）
  metadataStore.sites = { mteam: { id: "mteam", url: "https://example.com/" } } as any;

  const runtimeStore = useRuntimeStore(pinia);
  runtimeStore.search = {
    ...runtimeStore.search,
    searchKey: "matrix",
    searchResult: [
      {
        site: "mteam",
        id: "1",
        uniqueId: "mteam-1",
        title: "The.Matrix.1999.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.7.1.Atmos-FGT",
        size: 1024 * 1024 * 1024,
        seeders: 3,
        leechers: 1,
        completed: 100,
        comments: 2,
        time: Date.now(),
        url: "https://example.com/torrent/1",
      },
    ],
  } as any;

  const view = mountOptionsView(SearchEntityView, { pinia, router: true });
  await view.settle(80);
  return view;
}

/** 标题列单元格里那个承载标题内容的容器（TorrentTitleTd 的根元素） */
function titleCellWrapper(view: { host: HTMLElement }): HTMLElement | null {
  const cells = Array.from(view.host.querySelectorAll(".ant-table-tbody tr.ant-table-row td"));
  const titleCell = cells[2];
  return (titleCell?.firstElementChild as HTMLElement) ?? null;
}

describe("搜索结果表格：标题列宽度自适应", () => {
  beforeEach(async () => {
    // 视图的模块求值期就会 useXxxStore()（见 utils/filter.ts），必须先有 active pinia
    prepareOptionsPinia();
    SearchEntityView = (await import("@/options/views/Overview/SearchEntity/Index.vue")).default;
  });

  afterEach(() => {
    window.innerWidth = DESKTOP_WIDTH;
  });

  it("桌面端不给标题单元格写 max-width，让标题列吃满剩余宽度", async () => {
    const view = await mountSearchEntity(DESKTOP_WIDTH);

    // 先确认整张表真的渲染出来了，避免「选择器没命中」导致下面的断言假通过
    expect(view.host.querySelectorAll(".ant-table-tbody tr.ant-table-row").length).toBeGreaterThan(0);

    const wrapper = titleCellWrapper(view);
    expect(wrapper, "应能定位到标题列的容器").not.toBeNull();
    expect(wrapper!.style.maxWidth, "桌面端标题内容不应再有宽度上限（否则隐藏列后列内留大片空白）").toBe("");

    view.unmount();
  });

  it("移动端仍保留 32vw 上限，避免标题独占窄屏可视宽度", async () => {
    const view = await mountSearchEntity(MOBILE_WIDTH);

    const wrapper = titleCellWrapper(view);
    expect(wrapper, "应能定位到标题列的容器").not.toBeNull();
    expect(wrapper!.style.maxWidth).toBe("32vw");

    view.unmount();
  });
});
