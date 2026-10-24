/**
 * WXT 内容脚本入口（manifest 注册，所有页面都会执行，必须保持轻量）。
 *
 * 实际逻辑在 `src/entries/content-script/index.ts`（模块顶层执行）：判断当前页面是不是已添加的
 * PT 站点 / 社交站点，是的话再请后台把内容脚本 UI（`cs-app.content.ts`）注入当前 frame。
 */
import "@/content-script/index.ts";

import { defineContentScript } from "wxt/utils/define-content-script";

export default defineContentScript({
  matches: ["*://*/*"],
  excludeMatches: ["*://*/*.xml", "*://*/*.xml?*"],
  // 不向页面 window.postMessage「脚本已启动」事件：页面脚本能据此探测扩展是否安装
  noScriptStartedPostMessage: true,
  main() {
    // 引导逻辑已在上面的模块顶层执行
  },
});
