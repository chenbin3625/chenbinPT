/**
 * Telegram legacy Markdown 转义（task-12 / REVIEW-FINDINGS P2）。
 *
 * `vite/sendToTgChannel.ts` 用 legacy Markdown 发版：围栏代码块**内**（pre）与围栏**外**的转义规则不同。
 * 旧实现把围栏外那套 `\ _ * ` [ ]` 全量转义也用在 commit body 上，用户会在代码块里看到多出来的反斜杠。
 * 这里断言两个纯函数（`vite/telegramMarkdown.ts`）的语义，避免脚本再退回「pre 内全量转义」。
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error TS6305：vite/** 属于 tsconfig.node 的 composite project，主项目引用其源文件时要求先构建。
// 方案 B（把测试并入 tsconfig.node.json 的 include）实测会让该 directive 在 check:node 里变成 TS2578 unused，故保留行级豁免（task-12）。
import { escapeLegacyMarkdown, escapeLegacyMarkdownPre } from "../../vite/telegramMarkdown.ts";

describe("Telegram legacy Markdown 转义", () => {
  it("围栏外：转义 * _ ` [ ] 与反斜杠本身", () => {
    expect(escapeLegacyMarkdown("a*b_c`d[e]f\\g")).toBe("a\\*b\\_c\\`d\\[e\\]f\\\\g");
    // 模板里的 [文本](链接) / *粗体* 由模板自己控制，不经过本函数
    expect(escapeLegacyMarkdown("[标题](https://example.com)")).toBe("\\[标题\\](https://example.com)");
  });

  it("围栏内（pre）：只转义反引号与反斜杠，`*`/`_`/`[`/`]` 保持字面量", () => {
    expect(escapeLegacyMarkdownPre("```js\nconst x = *a* [_b_]\n```")).toBe(
      "\\`\\`\\`js\nconst x = *a* [_b_]\n\\`\\`\\`",
    );
    expect(escapeLegacyMarkdownPre("C:\\path\\file")).toBe("C:\\\\path\\\\file");
    expect(escapeLegacyMarkdownPre("fix: `x` *y* [z]")).toBe("fix: \\`x\\` *y* [z]");
  });

  it("pre 内容不会被围栏外规则二次转义（旧实现的回归形态）", () => {
    const commitBody = "fix: `x` *y* [z]";
    const inPre = escapeLegacyMarkdownPre(commitBody);
    // 旧实现（escapeLegacyMarkdown）会得到 "fix: \`x\` \*y\* \[z\]"，Telegram 在 pre 内不解析这些转义
    expect(inPre).not.toContain("\\*");
    expect(inPre).not.toContain("\\[");
    expect(inPre).toContain("*y*");
    expect(inPre).toContain("[z]");
  });
});
