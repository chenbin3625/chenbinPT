/**
 * 内容脚本 UI（Vue + antd + 站点解析）。
 *
 * `registration: "runtime"`：不写进 manifest 的 content_scripts，而是由后台在引导脚本确认
 * 「当前页面是已添加的 PT / 社交站点」后，用 `scripting.executeScript` 注入到发起请求的 frame
 * （见 src/entries/background/utils/contentScriptApp.ts）。普通网页只会执行轻量的 content.ts。
 *
 * 与引导脚本运行在同一个 isolated world，挂载参数经 src/entries/shared/contentScriptApp.ts 交接。
 */
import { defineContentScript } from "wxt/utils/define-content-script";

import { runContentScriptApp } from "@/content-script/app/entry.ts";

export default defineContentScript({
  matches: ["*://*/*"],
  registration: "runtime",
  // 样式由 init.ts 以内联字符串写进 shadow root，不需要 WXT 注入/暴露 CSS 文件
  cssInjectionMode: "manual",
  noScriptStartedPostMessage: true,
  main() {
    runContentScriptApp();
  },
});
