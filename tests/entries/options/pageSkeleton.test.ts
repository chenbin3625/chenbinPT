/**
 * PageSkeleton.vue：骨架屏形态按 variant 选择、list/masonry 的重复数量与网格容器、
 * chart 的画布高度与无标题、title / rows 透传到 a-skeleton。
 *
 * 真实挂载 SFC（这里断言的是 antd 实际渲染出的 DOM 与容器内联样式，
 * 而不是 `.vue` 源码里的字符串）。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { mountOptionsView } from "../../helpers/optionsView.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

async function mountSkeleton(props: Record<string, unknown> = {}) {
  const { default: PageSkeleton } = await import("@/options/components/PageSkeleton.vue");
  const view = mountOptionsView(PageSkeleton, { props });
  await view.settle();
  return view;
}

describe("PageSkeleton 默认（table）", () => {
  it("只渲染一个骨架块，且带标题占位", async () => {
    const view = await mountSkeleton();
    try {
      expect(view.$$(".ant-skeleton")).toHaveLength(1);
      expect(view.$(".ant-skeleton-title"), "默认 title=true 应渲染标题占位").not.toBeNull();
      // 默认 rows=6
      expect(view.$$(".ant-skeleton-paragraph li")).toHaveLength(6);
    } finally {
      view.unmount();
    }
  });

  it("title=false 时不渲染标题占位", async () => {
    const view = await mountSkeleton({ title: false });
    try {
      expect(view.$(".ant-skeleton")).not.toBeNull();
      expect(view.$(".ant-skeleton-title")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("rows 透传到骨架段落行数", async () => {
    const view = await mountSkeleton({ rows: 3 });
    try {
      expect(view.$$(".ant-skeleton-paragraph li")).toHaveLength(3);
    } finally {
      view.unmount();
    }
  });
});

describe("PageSkeleton 列表 / 瀑布流", () => {
  it.each(["list", "masonry"] as const)(
    "variant=%s 按 count 渲染多个骨架块，容器为 grid 且 gap 16px",
    async (variant) => {
      const view = await mountSkeleton({ variant, count: 3 });
      try {
        expect(view.$$(".ant-skeleton")).toHaveLength(3);

        const container = view.host.firstElementChild as HTMLElement;
        expect(container.style.display).toBe("grid");
        expect(container.style.gap).toBe("16px");
        expect(container.style.gridTemplateColumns).toBe("repeat(auto-fill, minmax(220px, 1fr))");
      } finally {
        view.unmount();
      }
    },
  );

  it("count=1 时列表形态也只渲染一个骨架块", async () => {
    const view = await mountSkeleton({ variant: "list", count: 1, rows: 2 });
    try {
      expect(view.$$(".ant-skeleton")).toHaveLength(1);
      expect(view.$$(".ant-skeleton-paragraph li")).toHaveLength(2);
    } finally {
      view.unmount();
    }
  });
});

describe("PageSkeleton 图表", () => {
  it("variant=chart 的容器撑起 320px 画布，且不渲染标题", async () => {
    const view = await mountSkeleton({ variant: "chart" });
    try {
      const container = view.host.firstElementChild as HTMLElement;
      expect(container.style.minHeight).toBe("320px");
      expect(view.$$(".ant-skeleton")).toHaveLength(1);
      // 图表形态固定无标题，避免画布高度被标题占位挤压
      expect(view.$(".ant-skeleton-title")).toBeNull();
      expect(view.$$(".ant-skeleton-paragraph li")).toHaveLength(6);
    } finally {
      view.unmount();
    }
  });

  it("variant=chart 即使显式传 title=true 也不渲染标题", async () => {
    const view = await mountSkeleton({ variant: "chart", title: true });
    try {
      expect(view.$(".ant-skeleton-title")).toBeNull();
    } finally {
      view.unmount();
    }
  });
});
