import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

import type { IUpdateCheckState } from "@/shared/updateCheck.ts";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const sendMessageMock = vi.hoisted(() => vi.fn());

vi.mock("@/messages.ts", () => ({
  sendMessage: sendMessageMock,
  onMessage: vi.fn(),
}));

import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import UpdateGuideModal from "@/options/components/UpdateGuideModal.vue";
import Topbar from "@/options/views/Layout/Topbar.vue";
import UpdateWindow from "@/options/views/Settings/SetBase/UpdateWindow.vue";

const AVAILABLE_STATE: IUpdateCheckState = {
  currentVersion: "0.0.27",
  checkedAt: Date.UTC(2026, 10, 24, 7, 0, 0),
  status: "update-available",
  latest: {
    version: "0.0.28",
    tagName: "v0.0.28",
    name: "v0.0.28",
    releaseUrl: "https://github.com/chenbin3625/chenbinPT/releases/tag/v0.0.28",
    publishedAt: "2026-11-24T06:00:00Z",
    notes: "更新说明\n<script>window.__xss=1</script>",
    source: "manifest",
    asset: {
      name: "extension-chrome.zip",
      url: "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension-chrome.zip",
      size: 4_600_000,
      sha256: "f".repeat(64),
    },
    allAssets: [
      {
        name: "extension-chrome.zip",
        url: "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension-chrome.zip",
        size: 4_600_000,
        sha256: "f".repeat(64),
      },
      {
        name: "extension.crx",
        url: "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension.crx",
        size: 4_700_000,
      },
    ],
  },
};

beforeEach(() => {
  sendMessageMock.mockReset();
  vi.stubGlobal("__BROWSER__", "chrome");
  vi.stubGlobal("__EXT_VERSION__", "v0.0.27+0b798c3");
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("版本更新设置页（UpdateWindow）", () => {
  it("展示新版本信息、更新说明按纯文本防 XSS、支持一键下载与忽略此版本", async () => {
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getUpdateCheckState") return AVAILABLE_STATE;
      if (type === "downloadExtensionUpdate") {
        return { downloadId: 7, filename: "chenbinPT-v0.0.28-extension-chrome.zip" };
      }
      if (type === "patchExtStoragePath") return undefined;
      return undefined;
    });

    const pinia = prepareOptionsPinia();
    const configStore = useConfigStore(pinia);
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnackbar").mockImplementation(() => undefined);

    const view = mountOptionsView(UpdateWindow, { pinia });
    try {
      await view.settle(80);

      // 展示版本与 SHA-256
      expect(view.text()).toContain("v0.0.27+0b798c3");
      expect(view.text()).toContain("v0.0.28");
      expect(view.text()).toContain("f".repeat(64));

      // 更新说明中的 <script> 必须作为纯文本渲染，不能注入 DOM script 标签
      expect(view.$("script")).toBeNull();
      expect(view.text()).toContain("<script>window.__xss=1</script>");

      // 一键下载按钮触发 downloadExtensionUpdate
      const downloadBtn = view.$$("button").find((btn) => btn.textContent?.includes("extension-chrome.zip"));
      expect(downloadBtn, "应渲染匹配当前浏览器的一键下载按钮").toBeDefined();
      downloadBtn!.click();
      await view.settle(60);

      expect(sendMessageMock).toHaveBeenCalledWith("downloadExtensionUpdate", {
        url: AVAILABLE_STATE.latest!.asset!.url,
        filename: "extension-chrome.zip",
      });
      expect(snackbar).toHaveBeenCalledWith(expect.stringContaining("chenbinPT-v0.0.28-extension-chrome.zip"), {
        color: "success",
      });

      // 点击忽略此版本会立刻持久化并同步 store
      const ignoreBtn = view.$$("button").find((btn) => btn.textContent?.includes("忽略此版本"));
      expect(ignoreBtn).toBeDefined();
      ignoreBtn!.click();
      await view.settle(60);

      expect(configStore.updateCheck.ignoredVersion).toBe("0.0.28");
      expect(sendMessageMock).toHaveBeenCalledWith("patchExtStoragePath", {
        key: "config",
        path: "updateCheck.ignoredVersion",
        value: "0.0.28",
      });
    } finally {
      view.unmount();
    }
  });

  it("点击「立即检查更新」触发强制检测并在出错时显示 error alert", async () => {
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getUpdateCheckState") {
        return { currentVersion: "0.0.27", checkedAt: 0, status: "idle" } satisfies IUpdateCheckState;
      }
      if (type === "checkExtensionUpdate") {
        return {
          currentVersion: "0.0.27",
          checkedAt: Date.now(),
          status: "error",
          error: "HTTP 503 Service Unavailable",
        } satisfies IUpdateCheckState;
      }
      return undefined;
    });

    const pinia = prepareOptionsPinia();
    const runtimeStore = useRuntimeStore(pinia);
    vi.spyOn(runtimeStore, "showSnackbar").mockImplementation(() => undefined);

    const view = mountOptionsView(UpdateWindow, { pinia });
    try {
      await view.settle(60);
      const checkBtn = view.$$("button").find((btn) => btn.textContent?.includes("立即检查更新"));
      expect(checkBtn).toBeDefined();
      checkBtn!.click();
      await view.settle(80);

      expect(sendMessageMock).toHaveBeenCalledWith("checkExtensionUpdate", { force: true });
      const errorAlert = view.$(".ant-alert-error");
      expect(errorAlert, "检测失败时应展示 error 级提示").not.toBeNull();
      expect(errorAlert!.textContent).toContain("HTTP 503 Service Unavailable");
    } finally {
      view.unmount();
    }
  });
});

describe("更新引导弹窗（UpdateGuideModal）", () => {
  it("打开扩展管理页被拦截时复制到剪贴板并给出引导提示", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "openBrowserExtensionsPage") {
        return { opened: false, url: "chrome://extensions" };
      }
      return undefined;
    });

    const pinia = prepareOptionsPinia();
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnackbar").mockImplementation(() => undefined);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", name: "Home", component: { render: () => null } }],
    });

    const view = mountOptionsView(UpdateGuideModal, {
      pinia,
      plugins: [router],
      props: {
        open: true,
        state: AVAILABLE_STATE,
        ignoredVersion: "",
      },
    });
    try {
      await view.settle(80);
      const openExtBtn = Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal button")).find((btn) =>
        btn.textContent?.includes("打开扩展管理页"),
      );
      expect(openExtBtn).toBeDefined();
      openExtBtn!.click();
      await view.settle(60);

      expect(writeText).toHaveBeenCalledWith("chrome://extensions");
      expect(snackbar).toHaveBeenCalledWith(expect.stringContaining("chrome://extensions"), { color: "info" });
    } finally {
      view.unmount();
    }
  });
});

describe("顶栏更新提醒入口（Topbar）", () => {
  it("存在未忽略的新版本时展示提醒按钮，点击弹出引导弹窗，忽略后按钮自动隐藏", async () => {
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getUpdateCheckState" || type === "checkExtensionUpdate") {
        return AVAILABLE_STATE;
      }
      if (type === "patchExtStoragePath") {
        return undefined;
      }
      return undefined;
    });

    const pinia = prepareOptionsPinia();
    const runtimeStore = useRuntimeStore(pinia);
    vi.spyOn(runtimeStore, "showSnackbar").mockImplementation(() => undefined);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/", name: "Home", component: { render: () => null } },
        { path: "/search-entity", name: "SearchEntity", component: { render: () => null } },
        { path: "/set-base/update", name: "SetBaseUpdate", component: { render: () => null } },
      ],
    });
    await router.push("/");

    const view = mountOptionsView(Topbar, { pinia, plugins: [router] });
    try {
      await view.settle(80);
      const pill = view.$<HTMLButtonElement>(".ptd-topbar-update-btn");
      expect(pill, "检测到新版本时顶栏应渲染更新提醒按钮").not.toBeNull();
      expect(pill!.textContent).toContain("v0.0.28");

      pill!.click();
      await view.settle(80);

      const modal = document.querySelector<HTMLElement>(".ant-modal");
      expect(modal, "点击顶栏更新按钮应打开更新引导弹窗").not.toBeNull();
      expect(modal!.textContent).toContain("extension-chrome.zip");

      const ignoreBtn = Array.from(modal!.querySelectorAll<HTMLButtonElement>("button")).find((btn) =>
        btn.textContent?.includes("忽略此版本"),
      );
      expect(ignoreBtn).toBeDefined();
      ignoreBtn!.click();
      await view.settle(80);

      expect(view.$(".ptd-topbar-update-btn"), "忽略当前版本后顶栏提醒按钮应隐藏").toBeNull();
    } finally {
      view.unmount();
    }
  });
});
