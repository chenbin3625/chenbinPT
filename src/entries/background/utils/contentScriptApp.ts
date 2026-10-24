import { onMessage } from "@/messages.ts";
import { CONTENT_SCRIPT_APP_FILE } from "@/shared/contentScriptApp.ts";

/**
 * 把内容脚本 UI 注入「发起请求的那个 frame」。
 *
 * - 目标只取自 `sender`（tab / documentId / frameId），消息不带参数，页面无法借此把脚本注入别的标签页；
 * - 只接受本扩展内容脚本发来的请求：必须带 `sender.tab`，且 `sender.id` 是本扩展；
 * - 有 `sender.documentId` 时用 `documentIds` 锁定文档：引导与注入之间如果发生了导航，注入会失败而不是落到新页面上。
 *   `MessageSender.documentId` 与 `InjectionTarget.documentIds` 在同一版本引入（Chrome 106 / Firefox 153，
 *   见 MDN browser-compat-data），旧版 Firefox（最低支持 133）拿不到 documentId，回落到 frameId。
 */
export function getContentScriptAppInjectionTarget(
  sender: chrome.runtime.MessageSender | undefined,
): chrome.scripting.InjectionTarget {
  if (!sender || sender.id !== chrome.runtime.id || typeof sender.tab?.id !== "number") {
    throw new Error("injectContentScriptApp must be sent from a content script of this extension");
  }

  if (typeof sender.documentId === "string" && sender.documentId.length > 0) {
    return { tabId: sender.tab.id, documentIds: [sender.documentId] };
  }
  return { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
}

onMessage("injectContentScriptApp", async ({ sender }) => {
  await chrome.scripting.executeScript({
    target: getContentScriptAppInjectionTarget(sender),
    files: [CONTENT_SCRIPT_APP_FILE],
  });
});
