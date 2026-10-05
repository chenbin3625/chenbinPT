/**
 * 空状态插画统一为 antd 的「简洁线稿」（`EMPTY_PLACEHOLDER_IMAGE`）。
 *
 * 背景：`<a-empty>` 不传 `image` 时会渲染 184×152 的大灰图，而 antd 自己的内部空状态
 * （Table / Select 的 `defaultRenderEmpty`）用的是 64×41 的 simple 线稿 —— 同一个页面里
 * 两种空态观感不一致。现在所有空状态都从 `@/options/plugins/antd.ts` 取图。
 *
 * 两类断言：
 * 1. 行为断言：真实挂载 `NoDataPlaceholder`，检查 DOM 里出现的是简单线稿（`ant-empty-image`
 *    内 svg 宽 64），并且 antd 为 simple 插画追加的 `ant-empty-normal` 紧凑类生效；
 * 2. 静态守卫：扫描 `src/**\/*.vue` 里所有 `<a-empty>` 起始标签，每个都必须显式绑定统一插画，
 *    避免以后新增空状态时又退回默认大灰图（这类回归类型检查与构建都不会报错）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { mountOptionsView } from "../../helpers/optionsView.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** 统一插画在模板里的绑定写法（守卫按字面量匹配） */
const IMAGE_BINDING = ':image="EMPTY_PLACEHOLDER_IMAGE"';

function collectVueFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      collectVueFiles(full, acc);
    } else if (entry.endsWith(".vue")) {
      acc.push(full);
    }
  }
  return acc;
}

/** 抽出所有 `<a-empty ...>` 起始标签（支持跨行属性） */
function collectEmptyTags(text: string): string[] {
  return [...text.matchAll(/<a-empty\b[^>]*>/gs)].map((match) => match[0].replace(/\s+/g, " "));
}

describe("空状态插画", () => {
  it("NoDataPlaceholder 渲染 antd 简洁线稿，而不是默认大图", async () => {
    const { default: NoDataPlaceholder } = await import("@/options/components/NoDataPlaceholder.vue");
    const view = mountOptionsView(NoDataPlaceholder, { props: { description: "没有数据" } });

    // 插画是 simple 线稿：64×41；默认大图是 184×152
    const image = view.$(".ant-empty-image svg");
    expect(image, "空状态应渲染出插画").not.toBeNull();
    expect(image!.getAttribute("width")).toBe("64");
    expect(image!.getAttribute("height")).toBe("41");

    // antd 只在 simple 插画上追加 `-normal`（更紧凑的留白）
    expect(view.$(".ant-empty-normal"), "simple 插画应带上 ant-empty-normal").not.toBeNull();

    // 描述文案照常渲染
    expect(view.text()).toContain("没有数据");

    view.unmount();
  });

  it("compact 模式只收窄上下留白，插画仍是简洁线稿", async () => {
    const { default: NoDataPlaceholder } = await import("@/options/components/NoDataPlaceholder.vue");
    const compactView = mountOptionsView(NoDataPlaceholder, { props: { compact: true } });
    const normalView = mountOptionsView(NoDataPlaceholder);

    expect(compactView.$(".ant-empty")!.getAttribute("style")).toContain("padding: 8px 0");
    expect(normalView.$(".ant-empty")!.getAttribute("style")).toContain("padding: 32px 0");

    // 默认描述取 `common.noData`
    expect(compactView.text()).toContain("暂无数据");
    expect(compactView.$(".ant-empty-image svg")!.getAttribute("width")).toBe("64");

    compactView.unmount();
    normalView.unmount();
  });

  it("src 下每个 <a-empty> 都显式绑定统一插画", () => {
    const offenders: string[] = [];
    let total = 0;

    for (const file of collectVueFiles(resolve(repoRoot, "src"))) {
      for (const tag of collectEmptyTags(readFileSync(file, "utf8"))) {
        total += 1;
        if (!tag.includes(IMAGE_BINDING)) {
          offenders.push(`${relative(repoRoot, file)} :: ${tag}`);
        }
      }
    }

    // 扫描规则失效（例如标签写法变了）时，这条会让测试直接变红，而不是静默通过
    expect(total, "应至少扫到 NoDataPlaceholder / RecommendationMenu / content-script 三处").toBeGreaterThanOrEqual(3);
    expect(offenders, "新增空状态时请绑定 EMPTY_PLACEHOLDER_IMAGE").toEqual([]);
  });
});
