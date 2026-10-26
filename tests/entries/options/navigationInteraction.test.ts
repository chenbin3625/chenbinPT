import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { PlusOutlined } from "@ant-design/icons-vue";
import { mountOptionsView } from "../../helpers/optionsView.ts";

const state = vi.hoisted(() => ({ config: undefined as any, display: undefined as any }));
vi.mock("@/options/stores/config.ts", async () => {
  const { reactive } = await import("vue");
  state.config = reactive({ isNavBarOpen: true, autoToggleNavBarOnDisplayChange: false, $save: vi.fn() });
  return { useConfigStore: () => state.config };
});
vi.mock("@/options/composables/useDisplay.ts", async () => {
  const { ref } = await import("vue");
  state.display = { smAndUp: ref(false), mdAndUp: ref(false), smAndDown: ref(true) };
  return { useDisplay: () => state.display };
});
vi.mock("@/options/plugins/router", () => ({
  routes: [
    {
      name: "Overview",
      meta: { isMainMenu: true },
      children: [{ name: "SearchEntity" }, { name: "MyClient" }],
    },
  ],
}));
vi.mock("~/helper.ts", () => ({ isDebug: false }));

import Navigation from "@/options/views/Layout/Navigation.vue";
import NavButton from "@/options/components/NavButton.vue";

let view: ReturnType<typeof mountOptionsView>;
async function mountNavigation() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/search-entity", name: "SearchEntity", component: { render: () => null } },
      { path: "/my-client", name: "MyClient", component: { render: () => null } },
    ],
  });
  await router.push("/search-entity");
  view = mountOptionsView(Navigation, { plugins: [router] });
  await view.settle();
  return router;
}

beforeEach(() => {
  state.config.isNavBarOpen = true;
  state.config.$save.mockClear();
  state.display.smAndUp.value = false;
  state.display.mdAndUp.value = false;
});
afterEach(() => view?.unmount());

describe("窄屏导航", () => {
  it("隐藏文字的工具栏按钮保留操作名称", async () => {
    view = mountOptionsView(NavButton, { props: { text: "增加", icon: PlusOutlined } });
    await view.settle();
    const button = view.$<HTMLButtonElement>("button")!;
    expect(button.textContent).not.toContain("增加");
    expect(button.getAttribute("aria-label")).toBe("增加");
  });

  it("首次打开时收起侧栏，保留桌面端的展开偏好", async () => {
    await mountNavigation();
    expect(view.$("#ptd-navigation")?.classList.contains("ant-layout-sider-collapsed")).toBe(true);
    expect(state.config.isNavBarOpen).toBe(true);
    expect(state.config.$save).not.toHaveBeenCalled();
  });

  it("展开菜单后选择页面会自动收起，且不修改桌面偏好", async () => {
    const router = await mountNavigation();
    view.$<HTMLElement>(".ant-layout-sider-zero-width-trigger")!.click();
    await view.settle();
    expect(view.$("#ptd-navigation")?.classList.contains("ant-layout-sider-collapsed")).toBe(false);
    view
      .$$<HTMLElement>(".ant-menu-item")
      .find((item) => item.textContent?.includes("下载器"))!
      .click();
    await view.settle();
    expect(router.currentRoute.value.name).toBe("MyClient");
    expect(view.$("#ptd-navigation")?.classList.contains("ant-layout-sider-collapsed")).toBe(true);
    expect(state.config.isNavBarOpen).toBe(true);
  });

  it("点击遮罩关闭菜单", async () => {
    await mountNavigation();
    view.$<HTMLElement>(".ant-layout-sider-zero-width-trigger")!.click();
    await view.settle();
    const backdrop = view.$<HTMLButtonElement>(".ptd-navigation-backdrop");
    expect(backdrop).not.toBeNull();
    backdrop!.click();
    await view.settle();
    expect(view.$(".ptd-navigation-backdrop")).toBeNull();
    expect(view.$("#ptd-navigation")?.classList.contains("ant-layout-sider-collapsed")).toBe(true);
  });

  it("桌面端仍恢复并保存原有折叠偏好", async () => {
    state.display.smAndUp.value = true;
    state.display.mdAndUp.value = true;
    state.config.isNavBarOpen = false;
    await mountNavigation();
    expect(view.$("#ptd-navigation")?.classList.contains("ant-layout-sider-collapsed")).toBe(true);
    view.$<HTMLElement>(".ant-layout-sider-trigger")!.click();
    await view.settle();
    expect(state.config.isNavBarOpen).toBe(true);
    expect(state.config.$save).toHaveBeenCalledTimes(1);
  });
});
