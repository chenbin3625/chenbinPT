import { onMessage } from "@/messages.ts";
import { getExtStoragePathCached, logBackgroundError } from "./base.ts";

const MINI_POPUP_PATH = "mini-popup.html";

export async function syncToolbarPopup(): Promise<boolean> {
  try {
    const enabled = Boolean(await getExtStoragePathCached("config", "enableToolbarPopup", false));
    if (typeof chrome !== "undefined" && typeof chrome.action?.setPopup === "function") {
      await chrome.action.setPopup({ popup: enabled ? MINI_POPUP_PATH : "" });
    }
    return enabled;
  } catch (e) {
    logBackgroundError("Failed to sync toolbar popup setting", e);
    return false;
  }
}

onMessage("syncToolbarPopup", async () => {
  return await syncToolbarPopup();
});

// SW 启动时同步一次，配置变化时自动跟随
void syncToolbarPopup();

if (typeof chrome !== "undefined" && chrome.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && "config" in changes) {
      void syncToolbarPopup();
    }
  });
}
