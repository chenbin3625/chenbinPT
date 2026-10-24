/**
 * 内容脚本 UI 的运行入口（被 src/entrypoints/cs-app.content.ts 调用）。
 *
 * 由后台 `scripting.executeScript` 注入；挂载参数由引导脚本通过 isolated world 的 globalThis 交接。
 * executeScript 在脚本求值完成时就返回，不会等待这里的挂载，所以挂载失败只能在本侧记录。
 */
import { claimContentScriptAppMount, takeContentScriptAppProps } from "@/shared/contentScriptApp.ts";

import { mountApp } from "./init.ts";

export function runContentScriptApp(): void {
  const props = takeContentScriptAppProps();
  if (!props) {
    // 只有引导脚本会请求注入；没有参数说明不是经由引导链进来的，不挂载。
    // 该脚本运行在宿主页面：页面控制台是唯一对开发者可见的诊断渠道（与引导脚本的兜底 catch 同理）。
    // eslint-disable-next-line no-console
    console.warn("[PTD] content script app injected without bootstrap props, skip mounting");
    return;
  }

  // 同一 frame 只挂载一次（重复注入时静默返回）
  if (!claimContentScriptAppMount()) {
    return;
  }

  try {
    mountApp(document, props);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[PTD] content script app failed to mount:", error);
  }
}
