/**
 * 内容脚本 overlay 的三条加固（见代码审查报告；报告已移出仓库树，可在提交 3b066d59 中查阅）：
 *
 * - A-8：SPA 站点（Unit3D/Livewire）列表 → 详情是 `pushState` 导航，内容脚本不会重新执行，
 *   必须订阅 URL 变化并重新求值 pageType，否则「复制链接 / 本地下载 / 推送」会按列表页解析详情页；
 * - A-9：批量动作的 loading 复位必须在 `finally`、复制必须走已有回退实现；
 * - A-10：宿主元素的 z-index 规则必须写在 `:host` 上（shadow 样式表按类名选不中宿主），
 *   主题 token 需要 `important` 优先级。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";

import { syncThemeVarsToHost } from "@/content-script/app/themeVars.ts";

vi.mock("@/content-script/app/pages/SocialSitePage.vue", () => ({ default: { name: "SocialSitePage" } }));
vi.mock("@/content-script/app/pages/SiteListPage.vue", () => ({ default: { name: "SiteListPage" } }));
vi.mock("@/content-script/app/pages/SiteDetailPage.vue", () => ({ default: { name: "SiteDetailPage" } }));

/** updatePageType 会用 getSite 造站点实例；这里给一个带 list/detail urlPattern 的替身 */
const mocks = vi.hoisted(() => ({
  getSite: vi.fn(),
}));
vi.mock("@ptd/site", () => ({ getSite: mocks.getSite }));
vi.mock("@/options/stores/metadata.ts", () => ({
  useMetadataStore: () => ({
    siteHostMap: {},
    getSiteUserConfig: async () => ({}),
  }),
}));

(globalThis as any).__BROWSER__ = "chrome";

const { installPageTypeUrlWatcher, pageType, siteInstance, copyTextToClipboard, setClipboardFallbackContainer } =
  await import("@/content-script/app/utils.ts");

const SITE_ID = "testsite";
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

function readSource(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

const FAKE_SITE = {
  metadata: {
    id: SITE_ID,
    urls: ["https://pt.example.com/"],
    list: [{ urlPattern: ["/torrents"] }],
    detail: { urlPattern: ["/torrent/\\d+"] },
  },
} as any;

/** 让 updatePageType 里两处 await（getSiteUserConfig / getSite）的微任务都跑完 */
async function flushAsync() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.getSite.mockReset();
  mocks.getSite.mockImplementation(async () => FAKE_SITE);
  siteInstance.value = undefined;
  pageType.value = "unknown";
});

describe("A-8 · URL 变化订阅", () => {
  it("pushState 导航到详情页后重新求值 pageType（列表 → 详情）", async () => {
    history.replaceState({}, "", "/torrents");
    const stop = installPageTypeUrlWatcher({ siteId: SITE_ID });

    // 订阅本身不触发求值（幂等：只有 URL 真的变化才求值）
    expect(mocks.getSite).toHaveBeenCalledTimes(0);

    history.pushState({}, "", "/torrent/123");
    await flushAsync();

    expect(mocks.getSite).toHaveBeenCalledTimes(1);
    expect(pageType.value).toBe("detail");
    expect(siteInstance.value).toBe(FAKE_SITE);

    // 再回到列表页
    history.pushState({}, "", "/torrents");
    await flushAsync();
    expect(pageType.value).toBe("list");

    stop();
  });

  it("同一 URL 的重复事件幂等：不重复求值；hashchange/popstate 也能触发", async () => {
    history.replaceState({}, "", "/torrents?page=1");
    const stop = installPageTypeUrlWatcher({ siteId: SITE_ID });

    history.replaceState({}, "", "/torrents?page=1"); // 同址回写
    await flushAsync();
    expect(mocks.getSite).toHaveBeenCalledTimes(0);

    // 浏览器前进/后退：happy-dom 的 dispatchEvent 不能改 URL，用 hashchange 验证事件通路
    location.hash = "#page=2";
    window.dispatchEvent(new Event("hashchange"));
    await flushAsync();
    expect(mocks.getSite).toHaveBeenCalledTimes(1);

    stop();
  });

  it("卸载（取消订阅）后：history 补丁被还原、window 监听器被移除、URL 变化不再求值", async () => {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    history.replaceState({}, "", "/torrents");
    const stop = installPageTypeUrlWatcher({ siteId: SITE_ID });

    // 装上补丁与监听器
    expect(history.pushState).not.toBe(originalPushState);
    expect(history.replaceState).not.toBe(originalReplaceState);
    const addedTypes = addSpy.mock.calls.map(([type]) => type);
    expect(addedTypes).toEqual(["popstate", "hashchange"]);

    stop();

    // 无泄漏：补丁还原成原函数、监听器数量与注册时一致
    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);
    expect(removeSpy.mock.calls.map(([type]) => type)).toEqual(addedTypes);

    history.pushState({}, "", "/torrent/999");
    await flushAsync();
    expect(mocks.getSite).toHaveBeenCalledTimes(0);
    expect(pageType.value).toBe("unknown");

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("重复订阅两次再各自取消：共享同一套补丁与监听器，全部取消后完全还原", async () => {
    const originalPushState = history.pushState;
    history.replaceState({}, "", "/torrents");

    const stop1 = installPageTypeUrlWatcher({ siteId: SITE_ID });
    const stop2 = installPageTypeUrlWatcher({ siteId: SITE_ID });
    const patched = history.pushState;

    history.pushState({}, "", "/torrent/1");
    await flushAsync();
    // 两个订阅都被通知，但 updatePageType 内部的请求序号守卫只让最后一次求值真正跑完
    expect(mocks.getSite).toHaveBeenCalledTimes(1);
    expect(pageType.value).toBe("detail");

    stop1(); // 还有订阅者：补丁必须留着
    expect(history.pushState).toBe(patched);

    stop2();
    expect(history.pushState).toBe(originalPushState);

    mocks.getSite.mockClear();
    history.pushState({}, "", "/torrent/2");
    await flushAsync();
    expect(mocks.getSite).toHaveBeenCalledTimes(0);
  });
});

describe("A-9 · 复制/下载动作", () => {
  it("copyTextToClipboard：clipboard 可用时返回 true；不可用时回退且返回布尔值（不抛异常）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await expect(copyTextToClipboard("https://pt.example.com/a.torrent")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://pt.example.com/a.torrent");

    // 非安全上下文 / 文档失焦：writeText reject → 回退 execCommand；happy-dom 没有 execCommand → false
    writeText.mockRejectedValueOnce(new Error("Document is not focused"));
    await expect(copyTextToClipboard("x")).resolves.toBe(false);

    await expect(copyTextToClipboard("")).resolves.toBe(false);
  });

  it("剪贴板回退节点挂在内容脚本容器内，不落到宿主 document.body", async () => {
    const shadowHost = document.createElement("div");
    const fallbackContainer = document.createElement("div");
    shadowHost.attachShadow({ mode: "closed" }).appendChild(fallbackContainer);
    document.body.appendChild(shadowHost);

    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("clipboard unavailable")) },
      configurable: true,
    });
    let seenInFallbackContainer = false;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => {
        seenInFallbackContainer = fallbackContainer.querySelector("textarea")?.value === "secret-download-link";
        expect(document.body.querySelector("textarea")).toBeNull();
        return true;
      }),
    });
    setClipboardFallbackContainer(fallbackContainer);

    await expect(copyTextToClipboard("secret-download-link")).resolves.toBe(true);
    expect(seenInFallbackContainer).toBe(true);
    expect(fallbackContainer.querySelector("textarea")).toBeNull();

    setClipboardFallbackContainer(undefined);
    shadowHost.remove();
  });

  it("execCommand 抛错时也清理影子树中的敏感文本", async () => {
    const shadowHost = document.createElement("div");
    const fallbackContainer = document.createElement("div");
    shadowHost.attachShadow({ mode: "closed" }).appendChild(fallbackContainer);
    document.body.appendChild(shadowHost);
    setClipboardFallbackContainer(fallbackContainer);
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => {
        throw new Error("copy denied");
      }),
    });

    await expect(copyTextToClipboard("secret-download-link")).resolves.toBe(false);
    expect(fallbackContainer.querySelector("textarea")).toBeNull();

    setClipboardFallbackContainer(undefined);
    shadowHost.remove();
  });

  it("影子容器不可用时不把下载凭据插入宿主页面", async () => {
    setClipboardFallbackContainer(undefined);
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    await expect(copyTextToClipboard("https://pt.example/download?passkey=secret")).resolves.toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("批量动作的 loading 复位在 finally 内、发送被 await（源码结构断言：SFC 无法在 vitest 内挂载）", () => {
    const dialog = readSource("src/entries/content-script/app/components/AdvanceListModuleDialog.vue");
    const listPage = readSource("src/entries/content-script/app/pages/SiteListPage.vue");

    // A-9c：不再直接调用 navigator.clipboard.writeText（绕过同功能已有的回退实现）
    expect(dialog).not.toMatch(/navigator\??\.clipboard/);
    expect(dialog).toContain("copyTextToClipboard");

    for (const [name, source, status] of [
      ["handleLocalDownloadMulti", dialog, "localDownloadMultiStatus"],
      ["handleLinkCopyMulti", dialog, "linkCopyMultiStatus"],
      ["handleLocalDownloadMulti", listPage, "localDownloadMultiStatus"],
      ["handleLinkCopyMulti", listPage, "linkCopyMultiStatus"],
    ] as const) {
      const body = new RegExp(`(?:async )?function ${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? "";
      expect(body, `${name} 应存在`).not.toBe("");
      expect(body, `${name} 应有 try/finally`).toContain("finally");
      expect(body, `${name} 复位语句应在 finally 之后`).toMatch(/finally \{[\s\S]*?\.value = false/);
      // 发送必须被 await（fire-and-forget 会让 loading 在发送完成前复位）
      expect(body, `${name} 应 await 发送结果`).toMatch(/await Promise\.all\(/);
      expect(body).toContain(status);
    }
  });
});

describe("A-10 · 宿主样式规则与主题变量优先级", () => {
  it("app.css 的宿主规则写在 :host 上并带 !important（类名规则在 shadow 样式表里选不中宿主）", () => {
    const css = readSource("src/entries/content-script/app/app.css");

    // ① :host 才可能命中宿主（shadow 内的选择器匹配不到外层文档里的宿主元素）；
    // ② !important 才压得过文档样式（encapsulation context 准则下文档样式优先，局部 important 反超）
    expect(css).toMatch(/:host \{[\s\S]*?position: relative !important;[\s\S]*?z-index: 2147483647 !important;/);
    // 回归守卫：原来那条按类名写的宿主规则从未生效，不能再回来
    expect(css).not.toMatch(/\.ptd-content-script-root \{/);
  });

  it("init.ts 把样式注入 shadow root，因此宿主只能用 :host 命中", () => {
    const init = readSource("src/entries/content-script/app/init.ts");

    expect(init).toContain('attachShadow({ mode: "closed" })');
    expect(init).toMatch(/shadowRoot\.appendChild\(baseStyleElement\)/);
    // 宿主上的类名保留（已知的页面可见指纹面），但它不是样式选择器
    expect(init).toContain('contentRoot.className = "ptd-content-script-root"');
  });

  it("运行时复现注入结构：宿主不在影子树内 → 影子树内的类名选择器匹配不到它", () => {
    const host = document.createElement("div");
    host.className = "ptd-content-script-root";

    const shadowRoot = host.attachShadow({ mode: "closed" });
    const styleElement = document.createElement("style");
    // 与 init.ts 完全一致的注入方式（含 :root → :host 替换）
    styleElement.textContent = readSource("src/entries/content-script/app/app.css").replaceAll(":root", ":host");
    shadowRoot.appendChild(styleElement);
    document.body.appendChild(host);

    // 宿主自己匹配类名，但影子树里根本没有这个元素：类名规则永远命中不了宿主
    expect(host.matches(".ptd-content-script-root")).toBe(true);
    expect(shadowRoot.querySelector(".ptd-content-script-root")).toBeNull();
    expect(shadowRoot.contains(styleElement)).toBe(true);
    // 注入的样式文本里确实只有 :host 一条宿主规则
    expect(styleElement.textContent).toMatch(/:host \{/);

    host.remove();
  });

  it("主题 token 以 important 优先级写到宿主上（页面 !important 覆盖不了）", async () => {
    setActivePinia(createPinia());
    const host = document.createElement("div");
    const stop = syncThemeVarsToHost(
      host,
      () => ({ "--ptd-bg": "#123456" }),
      () => true,
    );
    await nextTick();

    expect(host.style.getPropertyValue("--ptd-bg")).toBe("#123456");
    expect(host.style.getPropertyPriority("--ptd-bg")).toBe("important");

    stop();
  });
});
