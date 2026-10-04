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

  // create offscreen document for DOM_PARSER and other reason ( f**k google )
  if (creating) {
    await creating;
  } else {
    const pending = chrome.offscreen.createDocument({
      url: offscreenPath,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: "Allow DOM_PARSER, CLIPBOARD, BLOBS in background.",
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
