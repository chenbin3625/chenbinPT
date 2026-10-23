#!/usr/bin/env node
/**
 * Browser smoke gate for the built Chrome extension.
 *
 * Playwright launches its own Chromium because branded Google Chrome ignores
 * the unpacked-extension command-line switches used by extension test runners.
 * The browser runs headed; on a headless machine wrap this command with xvfb-run
 * (仓库已无 CI workflow，它不会被任何流水线调用 —— INFRA-1)。
 *
 * Coverage:
 * - the options page mounts in a real extension context;
 * - the top-bar search button navigates to the search route;
 * - the Set Site "Add" button opens its modal;
 * - the Set Site "Rebuild Site Cache" button opens a second modal.
 * - a matched site mounts the content script without module load errors;
 * - the fixed-ID JS WAR remains accessible (known extension-fingerprinting risk).
 *
 * The test uses a temporary browser profile and never touches the user's
 * installed extension data or persistent browser profile.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const extensionDir = resolve(root, process.env.EXTENSION_DIR ?? "dist-chrome");
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 45_000);
const serviceWorkerPath = "/src/entries/background/main.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForProjectServiceWorker(context) {
  const existing = context.serviceWorkers().find((worker) => worker.url().endsWith(serviceWorkerPath));
  if (existing) return existing;

  return await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      context.off("serviceworker", onServiceWorker);
      reject(new Error(`Project service worker did not start (${serviceWorkerPath})`));
    }, timeoutMs);

    const onServiceWorker = (worker) => {
      if (!worker.url().endsWith(serviceWorkerPath)) return;
      clearTimeout(timer);
      context.off("serviceworker", onServiceWorker);
      resolvePromise(worker);
    };

    context.on("serviceworker", onServiceWorker);
  });
}

async function runSmoke() {
  if (!existsSync(join(extensionDir, "manifest.json"))) {
    throw new Error(`Missing ${join(extensionDir, "manifest.json")}; run npm run build:dist first.`);
  }

  const profileDir = await mkdtemp(join(tmpdir(), "ptd-extension-e2e-"));
  let context;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: { width: 1440, height: 1000 },
      args: [
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });

    const serviceWorker = await waitForProjectServiceWorker(context);

    const extensionId = new URL(serviceWorker.url()).hostname;
    const optionsUrl = `chrome-extension://${extensionId}/src/entries/options/index.html`;
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(optionsUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.locator("#ptd-topbar").waitFor({ state: "visible", timeout: timeoutMs });

    const extensionContext = await page.evaluate(() => ({
      extensionId: chrome.runtime.id,
      hasStorage: Boolean(chrome.storage?.local),
      hasStorageChangeListener: typeof chrome.storage?.onChanged?.addListener === "function",
      title: document.title,
    }));
    assert(
      extensionContext.extensionId === extensionId &&
        extensionContext.hasStorage &&
        extensionContext.hasStorageChangeListener,
      `Extension host capabilities are incomplete: ${JSON.stringify(extensionContext)}`,
    );

    await page.locator(".ptd-search-key input").fill("e2e-smoke");
    await page.locator('button[title="搜索"], button[title="Search"]').first().click();
    await page.waitForFunction(
      () => /search-entity/.test(location.hash) && /e2e-smoke/.test(location.hash),
      undefined,
      { timeout: timeoutMs },
    );

    await page.goto(`${optionsUrl}#/set-site`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.locator(".ptd-settings-card").waitFor({ state: "visible", timeout: timeoutMs });

    await page.getByRole("button", { name: /增加|Add/ }).click();
    const addSiteModal = page.locator(".ant-modal").filter({ hasText: /添加站点|Add Site/ });
    await addSiteModal.waitFor({ state: "visible", timeout: timeoutMs });

    await addSiteModal.getByRole("button", { name: /取消|Cancel/ }).click();
    await addSiteModal.waitFor({ state: "hidden", timeout: timeoutMs });

    await page.getByRole("button", { name: /重建站点映射|Rebuild Site Cache/ }).click();
    const rebuildModal = page
      .locator(".ant-modal")
      .filter({ hasText: /重建站点映射关系缓存|Rebuild Site Mapping Cache/ });
    await rebuildModal.waitFor({ state: "visible", timeout: timeoutMs });

    assert(
      pageErrors.length === 0,
      `The extension page raised ${pageErrors.length} exception(s):\n${pageErrors.join("\n")}`,
    );

    await context.route("https://movie.douban.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><head><title>Movie list</title></head><body><h1>Movie list</h1></body></html>",
      }),
    );
    const sitePage = await context.newPage();
    const contentScriptErrors = [];
    sitePage.on("pageerror", (error) => contentScriptErrors.push(error.message));
    sitePage.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        contentScriptErrors.push(message.text());
      }
    });
    await sitePage.goto("https://movie.douban.com/top250", { waitUntil: "domcontentloaded", timeout: timeoutMs });
    try {
      await sitePage.locator(".ptd-content-script-root").waitFor({ state: "attached", timeout: timeoutMs });
    } catch (error) {
      throw new Error(`Content script did not mount: ${error.message}\n${contentScriptErrors.join("\n")}`);
    }
    // task-12（P2）：挂载点是引导先插入的，cs-app chunk / 样式资源仍在异步加载。
    // 若立刻断言「零 console error」，会漏掉 200ms 后才出现的 chunk/style 加载失败（漏报）。
    // 这里给资源与微任务一个 settle 窗口，并显式等待入口 chunk 的 resource timing 出现（最多 2s）。
    await sitePage
      .waitForFunction(
        (entrySuffix) => performance.getEntriesByType("resource").some((entry) => entry.name.includes(entrySuffix)),
        "assets/cs-app.js",
        { timeout: 2000 },
      )
      .catch(() => undefined);
    await sitePage.waitForTimeout(800);
    const fixedResourceAccessible = await sitePage.evaluate(async (url) => {
      try {
        return (await fetch(url)).ok;
      } catch {
        return false;
      }
    }, `chrome-extension://${extensionId}/assets/cs-app.js`);
    assert(
      fixedResourceAccessible,
      "The fixed-ID JS WAR is unavailable; static ESM imports will fail to mount the content script.",
    );
    assert(
      contentScriptErrors.length === 0,
      `The content script raised ${contentScriptErrors.length} exception(s):\n${contentScriptErrors.join("\n")}`,
    );
    console.log(`Extension smoke E2E passed (${extensionId})`);
  } finally {
    await context?.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

try {
  await runSmoke();
} catch (error) {
  console.error(`Extension smoke E2E failed: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exitCode = 1;
}
