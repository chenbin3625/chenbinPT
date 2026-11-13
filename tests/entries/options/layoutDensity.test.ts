/**
 * options 页面紧凑布局密度。
 *
 * Q-3 改造：原先这里对 `src/entries/options/style.css` 做**源码文本正则**断言
 * （`cssBlock("#ptd-topbar")` → `/height:\s*48px;/`），等价重构（改选择器写法、拆规则、
 * 用简写属性）会误报，而样式真被别的规则压掉时却照样通过。
 * 现在改为：把 style.css 作为真实样式表注入 happy-dom，按页面真实结构建 DOM，
 * 再读 `getComputedStyle` 的**计算值** —— 断言的是"用户最终看到的样子"，
 * 含选择器权重、规则先后、CSS 变量回退三者的相互作用。
 */
import { theme } from "ant-design-vue";
import { describe, expect, it } from "vitest";

import { buildThemeVars, useAntdConfig } from "@/options/plugins/antd.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { computedStyle, loadOptionsStyles, mountDom, prepareOptionsPinia } from "../../helpers/optionsView.ts";

/** 造一个和 options 页真实层级一致的外壳：顶栏 / 侧栏 / 主区，主区里可放内容 */
function mountShell(mainContent = ""): { root: HTMLElement; unmount: () => void } {
  return mountDom(`
    <div id="ptd-topbar"></div>
    <div id="ptd-navigation"></div>
    <div id="ptd-main">${mainContent}</div>
  `);
}

/** 一段 antd 表格的真实 DOM 结构（表头 / 表体 / 分页器） */
const TABLE_MARKUP = `
  <div class="page-toolbar">toolbar</div>
  <div class="ant-table-wrapper">
    <div class="ant-table">
      <div class="ant-table-container">
        <table>
          <thead class="ant-table-thead"><tr><th>标题</th></tr></thead>
          <tbody class="ant-table-tbody"><tr><td>内容</td></tr></tbody>
        </table>
      </div>
    </div>
    <ul class="ant-table-pagination ant-pagination"><li>1</li></ul>
  </div>
`;

describe("options 页面紧凑布局密度", () => {
  loadOptionsStyles();

  it("antd 主题启用 compactAlgorithm，保证表单/按钮/菜单密度统一", () => {
    prepareOptionsPinia();

    const configStore = useConfigStore();
    const { themeConfig } = useAntdConfig();

    configStore.theme = "light";
    const lightAlgorithms = themeConfig.value?.algorithm as Array<unknown>;
    expect(lightAlgorithms.slice(0, 2)).toEqual([theme.defaultAlgorithm, theme.compactAlgorithm]);
    expect(lightAlgorithms[2], "排版的最终覆盖必须在 compact 之后").toBeTypeOf("function");

    configStore.theme = "dark";
    const darkAlgorithms = themeConfig.value?.algorithm as Array<unknown>;
    expect(darkAlgorithms.slice(0, 2)).toEqual([theme.darkAlgorithm, theme.compactAlgorithm]);
    expect(darkAlgorithms[2], "排版的最终覆盖必须在 compact 之后").toBeTypeOf("function");
  });

  it("算法链的最终 token：正文 13px、行高 1.5、sm 控件 24px（theme.token 对 seed token 无效）", () => {
    prepareOptionsPinia();

    const configStore = useConfigStore();
    const { themeConfig } = useAntdConfig();
    configStore.theme = "light";

    // 复刻 antd 的 derivative 链：default → compact → 项目排版算法。
    // 不能用 theme.token 断言：antd 的 formatToken 会把 seed token（fontSize）从
    // algorithm 之后的 override 里剥掉，落到组件上的仍是 compact 的 12px（实测会变成 10px）。
    const algorithms = themeConfig.value?.algorithm as Array<(seed: any, map?: any) => any>;
    const resolved = algorithms.reduce<any>((map, algorithm) => algorithm(theme.defaultSeed, map), undefined);

    expect(resolved).toMatchObject({
      fontSize: 13,
      lineHeight: 1.5,
      fontSizeSM: 12,
      fontSizeLG: 15,
      fontSizeXL: 18,
      controlHeightSM: 24,
    });
  });

  it("buildThemeVars 输出最终生效的排版 token，而不是 compact / antd 默认的中间值", () => {
    for (const dark of [false, true]) {
      const vars = buildThemeVars(dark);
      // 13px / 1.5：与 ConfigProvider 里组件拿到的 token 相同（此前是 antd 默认的 14px / 1.5714）
      expect(vars["--ptd-font-size"], `dark=${dark}`).toBe("13px");
      expect(vars["--ptd-line-height"], `dark=${dark}`).toBe("1.5");
      expect(vars["--ptd-font-size-sm"], `dark=${dark}`).toBe("12px");
    }
  });

  it("主布局间距收紧，页面能展示更多内容", () => {
    // 两种形态一起断言：通用设置容器，以及 SetBase 在它之上再挂一个类收紧上边距的形态
    // （两条规则权重相同、后者在文件中靠后 —— 只断言其中一条无法发现顺序被调换）
    const shell = mountShell(
      `<div class="ptd-settings-form"></div><div class="ptd-settings-form ptd-set-base-form"></div>`,
    );

    expect(computedStyle(shell.root.querySelector("#ptd-topbar")!, "height")).toBe("48px");
    // 侧栏紧贴 48px 顶栏下沿（sticky 偏移），顶栏高度改了这里必须跟着改
    expect(computedStyle(shell.root.querySelector("#ptd-navigation")!, "top")).toBe("48px");
    const main = shell.root.querySelector("#ptd-main")!;
    expect(computedStyle(main, "padding")).toBe("12px");
    // #ptd-main 必须是真正的滚动容器：表头吸顶（antd sticky 的 getContainer）依赖它会滚
    expect(computedStyle(main, "overflow")).toBe("auto");
    // 高度钉在视口 − 48px（happy-dom 用自己的 768px 视口求值，浏览器实测见验收报告）
    expect(computedStyle(main, "height").replace(/\s+/g, "")).toMatch(/^calc\(\d+px-48px\)$/);

    const [genericForm, setBaseForm] = Array.from(shell.root.querySelectorAll<HTMLElement>(".ptd-settings-form"));
    expect(computedStyle(genericForm!, "padding"), "通用设置容器四边 16px").toBe("16px");
    expect(computedStyle(setBaseForm!, "padding"), "SetBase 页在上面再收紧上边距").toBe("12px 16px 16px");

    shell.unmount();
  });

  it("所有 options 页 a-table 都吃到统一紧凑表格样式（含弹层里的表格）", () => {
    // 关键：表格不是容器首元素（真实页面里上面还有工具条），
    // 且外层没有 #ptd-main 祖先（模拟弹层里的表格）
    const popup = mountDom(`<div class="ant-modal-body">${TABLE_MARKUP}</div>`);
    const scope = popup.root;

    expect(computedStyle(scope.querySelector(".ant-table-wrapper")!, "margin-top")).toBe("12px");
    expect(computedStyle(scope.querySelector(".ant-table-thead > tr > th")!, "padding")).toBe("2px 6px");
    expect(computedStyle(scope.querySelector(".ant-table-tbody > tr > td")!, "padding")).toBe("2px 6px");
    // 表头与单元格同一字号（13px），修复此前「表头 12px 比单元格 13px 还小」的倒挂
    expect(computedStyle(scope.querySelector(".ant-table-thead > tr > th")!, "font-size")).toBe("13px");
    expect(computedStyle(scope.querySelector(".ant-table-tbody > tr > td")!, "font-size")).toBe("13px");
    expect(computedStyle(scope.querySelector(".ant-table-pagination.ant-pagination")!, "margin")).toBe("8px 0px 0px");

    // 弹层里的表格不在 #ptd-main 内：表头不能吸顶（否则会贴到视口顶部盖住弹层标题）
    expect(computedStyle(scope.querySelector(".ant-table-thead > tr > th")!, "position")).not.toBe("sticky");

    popup.unmount();
  });

  it("正文基准 13px、次要文字 12px，全部来自 --ptd-* 变量回退值", () => {
    // 不塞 #ptd 时裸文本应是浏览器默认 16px；放进 #ptd 后由 token 决定
    const { root, unmount } = mountDom(`
      <span id="outside">页面外</span>
      <div id="ptd">
        <span id="body-text">正文</span>
        <span class="ptd-meta-text">次要</span>
      </div>
    `);

    expect(computedStyle(root.querySelector("#outside")!, "font-size")).not.toBe("13px");
    expect(computedStyle(root.querySelector("#ptd")!, "font-size")).toBe("13px");
    expect(computedStyle(root.querySelector("#body-text")!, "font-size")).toBe("13px");
    expect(computedStyle(root.querySelector(".ptd-meta-text")!, "font-size")).toBe("12px");

    unmount();
  });

  it("页面表格表头吸顶交给 antd sticky：滚动容器指向 #ptd-main，偏移回退主区内边距", async () => {
    // 不再用 CSS 给 th 写 sticky：带 scroll.x 的表格被 antd 内联 overflow-x:auto，
    // .ant-table-content 会成为 th 的最近滚动祖先，th 永远不吸顶，只能 !important 硬压。
    const { root, unmount } = mountDom(`
      <div id="ptd-main">
        <div class="ant-table-wrapper"><div class="ant-table-content">
          <table><thead class="ant-table-thead"><tr><th>标题</th></tr></thead></table>
        </div></div>
      </div>
    `);
    expect(computedStyle(root.querySelector(".ant-table-thead > tr > th")!, "position")).not.toBe("sticky");

    const { useMainTableSticky } = await import("@/options/views/Overview/utils/antdTable.ts");

    window.innerWidth = 1440;
    window.dispatchEvent(new Event("resize"));
    const sticky = useMainTableSticky();
    expect(sticky.value.getContainer(), "吸顶相对的滚动容器必须是 #ptd-main（window 不再滚动）").toBe(
      root.querySelector("#ptd-main"),
    );
    // 偏移 = 负的主区内边距：与上面断言的 #ptd-main padding 12px 同源
    expect(sticky.value.offsetHeader).toBe(-12);

    // 窄屏档与 style.css 的 @media (max-width: 840px) 同一阈值（840 本身属于窄屏）
    window.innerWidth = 840;
    window.dispatchEvent(new Event("resize"));
    expect(sticky.value.offsetHeader).toBe(-8);

    window.innerWidth = 1024;
    window.dispatchEvent(new Event("resize"));
    unmount();
  });

  it("表格是容器首元素时不额外留上边距（卡片标题 / 弹层标题下方不留空白）", () => {
    const wrapper = `<div class="ant-table-wrapper"><table><thead class="ant-table-thead"><tr><th>t</th></tr></thead></table></div>`;
    const firstChild = mountDom(`<div class="ant-card-body">${wrapper}</div>`);

    expect(computedStyle(firstChild.root.querySelector(".ant-table-wrapper")!, "margin-top")).toBe("0px");

    firstChild.unmount();
  });

  it("搜索结果页筛选栏与表格之间不额外留空白", () => {
    const view = mountDom(`
      <div>
        <div class="search-filter-bar">
          <div class="search-filter-chips"></div>
          <input class="search-filter-search" />
        </div>
        <div class="ant-table-wrapper">
          <table><thead class="ant-table-thead"><tr><th>t</th></tr></thead></table>
        </div>
      </div>
    `);

    expect(computedStyle(view.root.querySelector(".search-filter-bar")!, "margin-bottom")).toBe("0px");
    expect(computedStyle(view.root.querySelector(".ant-table-wrapper")!, "margin-top")).toBe("0px");

    view.unmount();
  });

  it("单元格文本限宽 + 单行省略，且调用点可用 CSS 变量覆盖兜底宽度", () => {
    const { root, unmount } = mountDom(`
      <span class="ptd-cell-ellipsis">默认兜底宽度</span>
      <span class="ptd-cell-ellipsis" style="--ptd-cell-max-width: 8rem">调用点覆盖</span>
    `);

    const [byDefault, overridden] = Array.from(root.querySelectorAll<HTMLElement>(".ptd-cell-ellipsis"));

    expect(computedStyle(byDefault!, "max-width")).toBe("320px"); // 20rem
    expect(computedStyle(byDefault!, "text-overflow")).toBe("ellipsis");
    expect(computedStyle(byDefault!, "white-space")).toBe("nowrap");
    // 变量确实生效（不是把 20rem 写死）
    expect(computedStyle(overridden!, "max-width")).toBe("128px"); // 8rem

    unmount();
  });

  it("全局样式只保留可复用的布局与文本工具类", () => {
    const { root, unmount } = mountDom(`
      <span class="ptd-inline-center"></span>
      <span class="ptd-secondary-text"></span>
      <span class="ptd-meta-text"></span>
    `);

    expect(computedStyle(root.querySelector(".ptd-inline-center")!, "display")).toBe("inline-flex");
    expect(computedStyle(root.querySelector(".ptd-inline-center")!, "align-items")).toBe("center");
    expect(computedStyle(root.querySelector(".ptd-secondary-text")!, "color")).toBe("rgba(0, 0, 0, 0.65)");
    expect(computedStyle(root.querySelector(".ptd-meta-text")!, "color")).toBe("rgba(0, 0, 0, 0.45)");

    unmount();
  });

  it("已删除的迁移残留工具类（.ptd-icon）不再带任何样式", () => {
    // 原断言是「style.css 里不得再出现 .ptd-icon 规则」。真正要守的是这条类名**不再有样式语义**：
    // 无论样式表怎么写，带上它和不带它的计算样式必须一致，否则说明这条全局工具类又回来了。
    const { root, unmount } = mountDom(`<span class="ptd-icon"></span><span></span>`);

    const [withClass, withoutClass] = Array.from(root.querySelectorAll("span"));
    for (const property of ["font-size", "color", "display", "line-height"]) {
      expect(computedStyle(withClass!, property), `.ptd-icon 不应再带来任何样式（${property}）`).toBe(
        computedStyle(withoutClass!, property),
      );
    }

    unmount();
  });

  it("按钮图标靠 order 排在文案之后，但状态按钮不参与该规则", () => {
    const { root, unmount } = mountDom(`
      <button class="ant-btn"><span class="anticon">i</span><span>文案</span></button>
      <button class="ant-btn ant-btn-icon-only"><span class="anticon">i</span></button>
      <button class="ant-btn status-btn"><span class="anticon">i</span></button>
    `);

    const [plain, iconOnly, status] = Array.from(root.querySelectorAll<HTMLElement>("button"));

    // 文字按钮：图标 order:1（视觉上排到文案后面）；布局靠 flex + gap 统一
    expect(computedStyle(plain!.querySelector(".anticon")!, "order")).toBe("1");
    expect(computedStyle(plain!, "display")).toBe("inline-flex");
    expect(computedStyle(plain!, "align-items")).toBe("center");
    expect(computedStyle(plain!, "gap")).toBe("8px");
    // 纯图标按钮：不参与「图标后置」
    expect(computedStyle(iconOnly!.querySelector(".anticon")!, "order")).toBe("");
    // 状态按钮：由 status-btn__item 自己控制内部排列，不吃「图标后置」也不吃 8px 间距
    expect(computedStyle(status!.querySelector(".anticon")!, "order")).toBe("");
    expect(computedStyle(status!, "gap")).toBe("6px");

    unmount();
  });

  it("状态按钮的紧凑间距同样作用于表格切换按钮，且不受更宽松的通用按钮规则影响", () => {
    // 原断言是「style.css 里必须有 .status-btn.status-btn { gap: 6px }」这条**选择器写法**。
    // 真正要守的是权重博弈的结果：.status-btn 必须压过 .ant-btn.ant-btn 的 8px。
    const { root, unmount } = mountDom(`
      <button class="table-switch-btn"></button>
      <button class="ant-btn status-btn"><span class="status-btn__item"><span class="anticon">i</span></span></button>
    `);

    const [tableSwitch, statusBtn] = Array.from(root.querySelectorAll<HTMLElement>("button"));
    const statusItem = statusBtn!.querySelector<HTMLElement>(".status-btn__item")!;

    expect(computedStyle(tableSwitch!, "gap")).toBe("6px");
    expect(computedStyle(statusBtn!, "gap")).toBe("6px");
    expect(computedStyle(statusItem, "display")).toBe("inline-flex");
    expect(computedStyle(statusItem, "gap")).toBe("4px");

    unmount();
  });
});
