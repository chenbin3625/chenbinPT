import { onMessage } from "@/messages.ts";

let creating: Promise<void> | null = null; // A global promise to avoid concurrency issues

const offscreenPath = "src/entries/offscreen/offscreen.html";

export async function setupOffscreenDocument() {
  // Firefox 环境下不构建 offscreen
  if (__BROWSER__ == "firefox") {
    return;
  }

  // Check all windows controlled by the service worker to see if one
  // of them is the offscreen document with the given path
  const offscreenUrl = chrome.runtime.getURL(offscreenPath);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length > 0) {
    return;
  }

  // create offscreen document for DOM_PARSER / BLOBS and other reason ( f**k google )
  // Info-5：reasons 必须与真实用途一致（商店审核/排障都以 reasons 为准）：
  // - DOM_PARSER：`packages/site/utils/html.ts` 的 `createDocument()` / `favicon.ts` 用 DOMParser 解析页面；
  // - BLOBS：`offscreen/utils/download.ts` 与 `backup.ts` 用 `URL.createObjectURL()` 生成种子/备份 Blob URL。
  // 原 justification 里写的 CLIPBOARD 在 offscreen 内没有任何调用，已从文案移除。
  if (creating) {
    await creating;
  } else {
    const pending = chrome.offscreen.createDocument({
      url: offscreenPath,
      reasons: [chrome.offscreen.Reason.DOM_PARSER, chrome.offscreen.Reason.BLOBS],
      justification: "Parse HTML with DOMParser and create Blob URLs (torrent files / backups) in background.",
    });
    creating = pending;
    try {
      await pending;
    } finally {
      if (creating === pending) {
        creating = null;
      }
    }
  }
}

onMessage("ensureOffscreenDocument", async () => {
  await setupOffscreenDocument();
});

// 预热失败不能污染 creating；后续业务消息会通过 ensureOffscreenDocument 自动重试。
void setupOffscreenDocument().catch(() => undefined);
