/**
 * Telegram **legacy Markdown**（`parse_mode: "Markdown"`，v1）的文本转义（task-12 / P2）。
 *
 * 发布脚本 `vite/sendToTgChannel.ts` 用 legacy Markdown 发版：`*粗体*`、`` `code` ``、`[文本](链接)`、
 * 以及 ``` ``` ``` 围栏代码块。两类上下文的转义规则不同：
 *
 * - **围栏外**：`\ _ * ` [ ]` 都是实体语法字符，用户内容（commit author 等）必须全部转义；
 * - **围栏内（pre）**：Telegram 不解析 `*`/`_`/`[`/`]`，若仍按围栏外规则加反斜杠，用户会看到
 *   多出来的 `\`（旧实现把 `escapeLegacyMarkdown` 用在了围栏内 commit body 上）。pre 内只需要
 *   转义会提前结束/破坏围栏的反引号与反斜杠本身。
 *
 * 拆成纯函数放这里，便于 `tests/i18n/telegramMarkdown.test.ts` 直接断言（脚本本身 import 即执行，
 * 依赖 bot token / 网络，不能作为单测入口）。
 */

/** 围栏外文本：转义 legacy Markdown 的全部实体字符（`\ _ * ` [ ]`） */
export function escapeLegacyMarkdown(text: string): string {
  return text.replace(/([\\_*`[\]])/g, "\\$1");
}

/** 围栏代码块（pre）内文本：只转义反斜杠与反引号，避免提前闭合围栏；`*`/`_` 等保持字面量 */
export function escapeLegacyMarkdownPre(text: string): string {
  return text.replace(/([\\`])/g, "\\$1");
}
