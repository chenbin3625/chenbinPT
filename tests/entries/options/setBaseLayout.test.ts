/**
 * 常规设置（SetBase）的布局与路由行为。
 *
 * Q-3 改造：原先本文件对 `router.ts` / `Index.vue` / `BackupWindow.vue` / `style.css` 做
 * **源码文本正则**断言（`toMatch(/const isSetBaseTab = /)`、`toMatch(/<a-card class="...">/)`…），
 * 重构即红、行为坏掉却可能照样绿。现在改为：
 * - 路由滚动行为 → 直接调用 `router.scrollBehavior`（vue-router 真正执行的那个函数）看返回值；
 * - 模板结构 → 真实挂载 SFC 后查 DOM / 计算样式；
 * - 「不再有 PTPP 导入入口」→ 挂载后断言界面上找不到该入口（而不是断言源码里没有某个字符串）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { routerInstance } from "@/options/plugins/router.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import {
  prepareOptionsPinia,
  computedStyle,
  loadOptionsStyles,
  mountDom,
  mountOptionsView,
} from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

/** 造一个 vue-router 传给 scrollBehavior 的已解析路由（只用到 name） */
const routeNamed = (name: string) => ({ name }) as any;

describe("SetBase 页签切换的滚动行为", () => {
  const scrollBehavior = routerInstance.options.scrollBehavior!;

  it("浏览器前进 / 后退时恢复历史滚动位置", () => {
    const saved = { left: 0, top: 320 };

    // savedPosition 存在时优先返回它（此时不应再去做「滚到 #ptd-main 顶部」）
    expect(scrollBehavior(routeNamed("SetBaseDownload"), routeNamed("MyData"), saved)).toEqual(saved);
    expect(scrollBehavior(routeNamed("MyData"), routeNamed("SetBaseUi"), saved)).toEqual(saved);
  });

  it("在常规设置的页签之间切换时只滚到顶部，而不是保留上一页签的 scrollY", () => {
    // 这是本用例要守的核心行为：长页签（下载设置）底部 → 短页签（界面设置）时，
    // 若沿用 window.scrollY，浏览器会把它夹到新内容底部，看起来像自动跳到底部。
    // 同时反证旧写法（返回 false = 不做任何滚动）已不存在。
    const result = scrollBehavior(routeNamed("SetBaseDownload"), routeNamed("SetBaseUi"), null);

    expect(result).toEqual({ top: 0 });
    expect(result).not.toBe(false);
  });

  it("进入 / 离开常规设置时滚动到主内容区顶部", () => {
    // 不是「页签之间」的切换 → 回到 #ptd-main 顶部
    expect(scrollBehavior(routeNamed("MyData"), routeNamed("SearchEntity"), null)).toEqual({
      el: "#ptd-main",
      top: 0,
    });
    expect(scrollBehavior(routeNamed("SetBaseUi"), routeNamed("MyData"), null)).toEqual({
      el: "#ptd-main",
      top: 0,
    });
  });
});

describe("SetBase 页面布局钩子", () => {
  loadOptionsStyles();

  it("渲染出专用布局钩子：紧凑卡片 + 顶部页签 + 表单容器", async () => {
    const pinia = prepareOptionsPinia();
    const { default: SetBaseIndex } = await import("@/options/views/Settings/SetBase/Index.vue");

    const view = mountOptionsView(SetBaseIndex, { pinia, router: "SetBaseUi" });
    await view.settle();

    const card = view.$(".ptd-set-base-card");
    const tabs = view.$(".set-base-tabs");
    const form = view.$(".ptd-set-base-form");

    // 钩子类真的落在了对应组件上（不是写在注释 / 未使用的 class 里）
    expect(card, "SetBase 卡片应带 .ptd-set-base-card").not.toBeNull();
    expect(card!.classList.contains("ant-card"), "该钩子应挂在 a-card 渲染出的 .ant-card 上").toBe(true);
    expect(tabs, "SetBase 页签应带 .set-base-tabs").not.toBeNull();
    expect(form, "每个页签的内容容器应带 .ptd-set-base-form").not.toBeNull();
    expect(form!.classList.contains("ptd-settings-form")).toBe(true);

    // tab-position="top" 的实际效果就是渲染出 .ant-tabs-top（写成 left/right 会渲染 .ant-tabs-left 等）
    expect(tabs!.classList.contains("ant-tabs-top"), '页签应位于顶部（tab-position="top"）').toBe(true);

    view.unmount();
  });

  it("紧凑卡片与表单容器的计算样式符合预期", async () => {
    const pinia = prepareOptionsPinia();
    const { default: SetBaseIndex } = await import("@/options/views/Settings/SetBase/Index.vue");

    const view = mountOptionsView(SetBaseIndex, { pinia, router: "SetBaseUi" });
    await view.settle();

    const cardBody = view.$(".ptd-set-base-card > .ant-card-body");
    expect(cardBody, "a-card 应渲染出 .ant-card-body").not.toBeNull();
    expect(computedStyle(cardBody!, "display")).toBe("flex");
    expect(computedStyle(cardBody!, "flex-direction")).toBe("column");
    expect(computedStyle(view.$(".ptd-set-base-form")!, "padding")).toBe("12px 16px 16px");

    // 页面内容区已渲染 `.ptd-settings-grid` 时，grid 在表单内水平居中（受 960px 上限约束）
    const grid = mountDom(`<div class="ptd-set-base-form"><div class="ptd-settings-grid"></div></div>`);
    expect(computedStyle(grid.root.querySelector(".ptd-settings-grid")!, "margin")).toBe("0px auto");
    expect(computedStyle(grid.root.querySelector(".ptd-settings-grid")!, "max-width")).toBe("960px");
    grid.unmount();

    view.unmount();
  });

  it("写盘失败时不能提示保存成功", async () => {
    const pinia = prepareOptionsPinia();
    const config = useConfigStore(pinia);
    const runtime = useRuntimeStore(pinia);
    const save = vi.fn().mockRejectedValue(new Error("quota exceeded"));
    config.$save = save;
    const notice = vi.spyOn(runtime, "showSnakebar").mockImplementation(() => undefined);
    const { default: SetBaseIndex } = await import("@/options/views/Settings/SetBase/Index.vue");
    const view = mountOptionsView(SetBaseIndex, { pinia, router: "SetBaseUi" });
    await view.settle();

    view.$<HTMLButtonElement>(".set-base-save")!.click();
    await vi.waitFor(() => expect(notice).toHaveBeenCalled());
    expect(notice).toHaveBeenCalledWith(expect.any(String), { color: "error" });
    expect(notice).not.toHaveBeenCalledWith(expect.any(String), { color: "success" });

    view.unmount();
    notice.mockRestore();
  });
});

describe("SetBase 备份设置不再提供 PTPP 导入入口", () => {
  it("界面上既没有选择备份文件的入口，也不出现旧版 PTPP 导入文案", async () => {
    const pinia = prepareOptionsPinia();
    const { default: BackupWindow } = await import("@/options/views/Settings/SetBase/BackupWindow.vue");

    const view = mountOptionsView(BackupWindow, { pinia });
    await view.settle();

    // 备份设置本身要能正常渲染（否则「找不到导入入口」的断言会因为整页渲染失败而假通过）
    expect(view.text().trim().length, "备份设置应渲染出内容").toBeGreaterThan(0);

    // 行为断言：选择文件 / 上传控件不存在（旧版 PTPP 导入靠它们承载）
    expect(view.$('input[type="file"]')).toBeNull();
    expect(view.$(".ant-upload")).toBeNull();
    // 也没有「导入 / 选择备份文件」这类可见文案，以及任何可点的导入入口
    expect(view.text()).not.toMatch(/导入|Import|选择备份文件/);
    expect(view.$$("button").filter((button) => /导入|Import/.test(button.textContent ?? ""))).toEqual([]);

    view.unmount();
  });

  it("备份设置模块不再静态引入 PTPP 恢复对话框与 JSZip（依赖图契约）", () => {
    // 这一条保留为源码级断言：它守的是**依赖图**（JSZip 若被静态 import 就会进 options 入口
    // chunk / 让 `npm run check:bundle` 预算变紧），DOM 上不可观测，也无法用行为测试表达。
    // 对照组件的存在性断言已在上一条用「界面上没有导入入口」的行为断言替代。
    const source = readFileSync(
      resolve(process.cwd(), "src/entries/options/views/Settings/SetBase/BackupWindow.vue"),
      "utf8",
    );

    expect(source, "不应再引入 PTPP 恢复对话框").not.toMatch(/RestorePtppUserDataDialog/);
    expect(source, "不应再静态 import JSZip").not.toMatch(/from\s+"jszip"|require\("jszip"\)/);
  });
});
