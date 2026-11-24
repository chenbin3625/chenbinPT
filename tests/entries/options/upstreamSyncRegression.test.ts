/**
 * 上游同步批次回归测试（#1733 / #1745 / #1739）：
 * - formatTimeAgo：按 1 年 = 365 天 / 1 月 = 30 天逐级相减，消除月界倒退与恰好 30 天落入 `< 1 分钟` 的 bug，
 *   同时保留未来/非法时间统一返回 `"-"` 的本地保护；
 * - BonusFormatSpan：历史数据里的 `"N/A"`（含大小写与空白）及空串统一显示为 `"-"`，数值 `0` 仍显示 `"0.00"`；
 * - 无积分站点定义不再硬编码 `"N/A"` 或编造 `"0"`；
 * - SetMediaServer/Editor：飞牛影视新增的 `accessCode` 字段默认按凭据掩码显示。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

describe("formatTimeAgo 月界与边界分解 (#1745)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("按 365/30 天逐级分解，月界处不倒退，且保留未来时间返回 '-'", async () => {
    vi.useFakeTimers();
    // 选在 3 月 1 日之后，30 天前跨 2 月（日历月未满 1 月的场景）
    const now = new Date("2026-03-31T12:00:00Z");
    vi.setSystemTime(now);

    const { formatTimeAgo } = await import("@/options/utils.ts");
    const dayMs = 24 * 60 * 60 * 1000;

    // 恰好 30 天：不再落入 `< 1 分钟前`
    const thirtyDaysAgo = new Date(now.getTime() - 30 * dayMs);
    expect(formatTimeAgo(thirtyDaysAgo)).toMatch(/1\s+\S+\s+0\s+\S+/);
    expect(formatTimeAgo(thirtyDaysAgo)).not.toContain("< 1");

    // 90 / 91 天：月界单调递增（3 个月 0 天 → 3 个月 1 天），不倒退成 2 个月
    const ninetyDaysAgo = new Date(now.getTime() - 90 * dayMs);
    const ninetyOneDaysAgo = new Date(now.getTime() - 91 * dayMs);
    expect(formatTimeAgo(ninetyDaysAgo)).toMatch(/^3\s+\S+\s+0\s+\S+/);
    expect(formatTimeAgo(ninetyOneDaysAgo)).toMatch(/^3\s+\S+\s+1\s+\S+/);

    // 365 天：1 年 0 月
    const oneYearAgo = new Date(now.getTime() - 365 * dayMs);
    expect(formatTimeAgo(oneYearAgo)).toMatch(/^1\s+\S+\s+0\s+\S+/);

    // 未来时间与非法时间继续返回 "-"
    expect(formatTimeAgo(new Date(now.getTime() + 60_000))).toBe("-");
    expect(formatTimeAgo("not-a-date")).toBe("-");
  });
});

describe('BonusFormatSpan 与无积分站点统一显示 "-" (#1733)', () => {
  it('把空串、"N/A"（忽略大小写/空白）与 undefined 渲染为 "-"，保留数值 0 与正常文本', async () => {
    const pinia = prepareOptionsPinia();
    const { default: BonusFormatSpan } = await import("@/options/views/Overview/MyData/BonusFormatSpan.vue");

    const cases: Array<[number | string | undefined, string]> = [
      [undefined, "-"],
      ["", "-"],
      ["   ", "-"],
      ["N/A", "-"],
      [" n/a ", "-"],
      [0, "0.00"],
      [12.5, "12.50"],
      ["custom", "custom"],
    ];

    for (const [input, expected] of cases) {
      const view = mountOptionsView(
        defineComponent({
          setup() {
            return () => h(BonusFormatSpan, { num: input });
          },
        }),
        { pinia },
      );
      try {
        expect(view.text().trim(), `input=${String(input)}`).toBe(expected);
      } finally {
        view.unmount();
      }
    }
  });

  it("已清理的 7 个无积分站点/模板不再声明静态 'N/A' 或 '0' 的 bonus 选择器", async () => {
    const modules = await Promise.all([
      import("@ptd/site/definitions/karagarga.ts"),
      import("@ptd/site/definitions/pornolab.ts"),
      import("@ptd/site/definitions/redacted.ts"),
      import("@ptd/site/definitions/seedpool.ts"),
      import("@ptd/site/definitions/aidoruonline.ts"),
      import("@ptd/site/definitions/fappaizuri.ts"),
      import("@ptd/site/schemas/TCG.ts"),
    ]);

    for (const mod of modules) {
      const meta = (mod as any).siteMetadata ?? (mod as any).SchemaMetadata;
      const rootSelectors = meta.userInfo?.selectors ?? {};
      expect(rootSelectors.bonus?.text).not.toBe("N/A");
      expect(rootSelectors.bonus?.text).not.toBe("0");
      expect(rootSelectors.bonusPerHour?.text).not.toBe("N/A");
      for (const step of meta.userInfo?.process ?? []) {
        expect(step.selectors?.bonus?.text).not.toBe("N/A");
        expect(step.selectors?.bonusPerHour?.text).not.toBe("N/A");
      }
    }
  });
});

describe("SetMediaServer/Editor 飞牛影视 accessCode 字段掩码", () => {
  it("accessCode 与 password 默认渲染为 password 输入框", async () => {
    const pinia = prepareOptionsPinia();
    const { default: Editor } = await import("@/options/views/Settings/SetMediaServer/Editor.vue");
    const cfg = ref({
      id: "fnos-test",
      type: "fnos",
      name: "飞牛影视",
      address: "https://nas.example:5666",
      auth: { username: "alice", password: "pw", accessCode: "secret-code", parentId: "" },
      timeout: 5000,
    });

    const view = mountOptionsView(
      defineComponent({
        setup() {
          return () => h(Editor as any, { modelValue: cfg.value, "onUpdate:modelValue": (v: any) => (cfg.value = v) });
        },
      }),
      { pinia },
    );

    try {
      await view.settle(120);
      const findInput = (labelText: string) => {
        const item = Array.from(view.host.querySelectorAll(".ant-form-item")).find(
          (el) => el.querySelector("label")?.textContent?.trim() === labelText,
        );
        return item?.querySelector<HTMLInputElement>("input");
      };

      expect(findInput("password")?.type).toBe("password");
      expect(findInput("accessCode")?.type).toBe("password");
      expect(findInput("username")?.type).toBe("text");
      expect(findInput("parentId")?.type).toBe("text");
    } finally {
      view.unmount();
    }
  });
});
