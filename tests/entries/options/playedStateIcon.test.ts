/**
 * PlayedStateIcon.vue：观看状态（played / partial / unplayed）到图标的映射，以及 size 的透传。
 *
 * 状态判定以 `@ptd/mediaServer` 的 `getPlayedState` 实际实现为准：
 * - `percent >= 100` → played（进度优先于滞后的 IsPlayed 标记）；
 * - `!percent || percent <= 0` → 仅当 isPlayed 为真时 played，否则 unplayed；
 * - 其余（0 < percent < 100）→ partial（即使 isPlayed 为 true，进度仍优先）。
 *
 * 圆形进度的百分比没有文本（show-info=false），这里从 antd 渲染出的
 * `.ant-progress-circle-path` 的 `stroke-dasharray` 反推填充比例。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { mountOptionsView } from "../../helpers/optionsView.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

async function mountIcon(props: Record<string, unknown>) {
  const { default: PlayedStateIcon } = await import("@/options/views/Overview/MediaServerEntity/PlayedStateIcon.vue");
  const view = mountOptionsView(PlayedStateIcon, { props });
  await view.settle();
  return view;
}

/** 从圆环路径的 stroke-dasharray（填充长度 / 整圈长度）读出百分比 */
function readProgressPercent(view: Awaited<ReturnType<typeof mountIcon>>): number {
  const paths = view.$$<SVGPathElement>(".ant-progress-circle-path");
  expect(paths.length, "圆环应渲染出进度路径").toBeGreaterThan(0);

  for (const path of paths) {
    const dasharray = path.style.strokeDasharray;
    const [filled, total] = dasharray.split(/\s+/).map((part) => Number.parseFloat(part));
    if (filled > 0 && total > 0) return (filled / total) * 100;
  }
  // 进度为 0 时 antd 会给路径 opacity=0、dasharray 首段为 0
  return 0;
}

describe("PlayedStateIcon 已看完", () => {
  it("isPlayed=true 渲染勾图标", async () => {
    const view = await mountIcon({ isPlayed: true });
    try {
      expect(view.$(".anticon-check")).not.toBeNull();
      expect(view.$(".ant-progress")).toBeNull();
      expect(view.$(".anticon-minus-circle")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("percent=100 时即使 isPlayed=false 也按已看完处理（进度优先）", async () => {
    const view = await mountIcon({ percent: 100, isPlayed: false });
    try {
      expect(view.$(".anticon-check")).not.toBeNull();
      expect(view.$(".ant-progress")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("percent=0 且 isPlayed=true 时按已看完处理（无真实进度时以 IsPlayed 为准）", async () => {
    const view = await mountIcon({ percent: 0, isPlayed: true });
    try {
      expect(view.$(".anticon-check")).not.toBeNull();
      expect(view.$(".ant-progress")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("size 决定勾图标的 font-size", async () => {
    const view = await mountIcon({ isPlayed: true, size: 24 });
    try {
      const icon = view.$<HTMLElement>(".anticon-check")!;
      expect(icon.style.fontSize).toBe("24px");
    } finally {
      view.unmount();
    }
  });
});

describe("PlayedStateIcon 部分观看", () => {
  it.each([40, 12.5, 99])("percent=%s 渲染圆环且填充比例正确", async (percent) => {
    const view = await mountIcon({ percent });
    try {
      expect(view.$(".ant-progress.ant-progress-circle")).not.toBeNull();
      expect(view.$(".anticon-check")).toBeNull();
      expect(view.$(".anticon-minus-circle")).toBeNull();
      expect(readProgressPercent(view)).toBeCloseTo(percent, 4);
    } finally {
      view.unmount();
    }
  });

  it("percent=40 且 isPlayed=true 时仍按部分观看处理（进度优先于滞后的标记）", async () => {
    const view = await mountIcon({ percent: 40, isPlayed: true });
    try {
      expect(view.$(".ant-progress.ant-progress-circle")).not.toBeNull();
      expect(view.$(".anticon-check")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("size 决定圆环尺寸", async () => {
    const view = await mountIcon({ percent: 30, size: 24 });
    try {
      const inner = view.$<HTMLElement>(".ant-progress-inner")!;
      expect(inner.style.width).toBe("24px");
      expect(inner.style.height).toBe("24px");
      // 与图标同尺寸：字号按 antd 圆环规则随直径缩放
      expect(inner.style.fontSize).toBe(`${24 * 0.15 + 6}px`);
    } finally {
      view.unmount();
    }
  });

  it("默认 size=14 时圆环走小尺寸（inline-circle）分支", async () => {
    const view = await mountIcon({ percent: 50 });
    try {
      expect(view.$(".ant-progress.ant-progress-inline-circle")).not.toBeNull();
      expect(view.$<HTMLElement>(".ant-progress-inner")!.style.width).toBe("14px");
    } finally {
      view.unmount();
    }
  });
});

describe("PlayedStateIcon 未观看", () => {
  it.each([
    ["percent=0", { percent: 0 }],
    ["percent 未提供且 isPlayed=false", { isPlayed: false }],
    ["percent 为负", { percent: -10 }],
  ])("%s 渲染减号圆圈图标", async (_label, props) => {
    const view = await mountIcon(props);
    try {
      expect(view.$(".anticon-minus-circle")).not.toBeNull();
      expect(view.$(".ant-progress")).toBeNull();
      expect(view.$(".anticon-check")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("size 决定减号图标的 font-size", async () => {
    const view = await mountIcon({ percent: 0, size: 18 });
    try {
      expect(view.$<HTMLElement>(".anticon-minus-circle")!.style.fontSize).toBe("18px");
    } finally {
      view.unmount();
    }
  });
});
