import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import vue from "@vitejs/plugin-vue";
import { createServer } from "vite";
import { chromium } from "playwright";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const server = await createServer({
  configFile: false,
  root,
  plugins: [vue()],
  resolve: {
    alias: {
      "@": resolve(root, "src/entries"),
      "@ptd": resolve(root, "src/packages"),
      "~": resolve(root, "src"),
    },
  },
  server: { host: "127.0.0.1", port: 0 },
});
let browser;

try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ channel: "chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/tests/fixtures/advance-list-browser.html`);
  await page.evaluate(() => window.openAdvanceListFixture());
  await page.waitForFunction(() => window.advanceListShadow.querySelector(".ant-modal"));
  await page.waitForTimeout(500);
  const box = await page.evaluate(() => {
    const modal = window.advanceListShadow.querySelector(".ant-modal");
    const { width, height, x, y } = modal.getBoundingClientRect();
    return { width, height, x, y };
  });
  const target = await page.evaluate(() => {
    const button = window.advanceListShadow.querySelector(".ant-pagination-next button");
    const { x, y, width, height } = button.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(
    () => window.advanceListShadow.querySelector(".ant-pagination-item-active")?.textContent?.trim() === "2",
  );
  assert.ok(
    await page.evaluate(() =>
      window.advanceListShadow.querySelector(".ant-table-tbody")?.textContent?.includes("Torrent 26"),
    ),
  );
  const sizeChanger = await page.evaluate(() => {
    const select = window.advanceListShadow.querySelector(".ant-pagination-options-size-changer");
    const { x, y, width, height } = select.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
  await page.mouse.click(sizeChanger.x, sizeChanger.y);
  await page.waitForTimeout(350);
  assert.ok(
    await page.evaluate(() => {
      const dropdown = window.advanceListShadow.querySelector(".ant-select-dropdown");
      return dropdown && getComputedStyle(dropdown).display !== "none";
    }),
    "page-size selector opened but was immediately closed by the shadow-host mousedown",
  );
  const option = await page.evaluate(() => {
    const item = [...window.advanceListShadow.querySelectorAll(".ant-select-item-option")].find((node) =>
      node.textContent.includes("50"),
    );
    const { x, y, width, height } = item.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
  await page.mouse.click(option.x, option.y);
  await page.waitForFunction(() =>
    window.advanceListShadow
      .querySelector(".ant-pagination-options-size-changer .ant-select-selection-item")
      ?.textContent?.includes("50"),
  );
  assert.equal(
    await page.evaluate(() => window.advanceListShadow.querySelectorAll(".ant-table-tbody > tr[data-row-key]").length),
    50,
  );
  await page.mouse.click(sizeChanger.x, sizeChanger.y);
  await page.waitForFunction(() => {
    const dropdown = window.advanceListShadow.querySelector(".ant-select-dropdown");
    return dropdown && getComputedStyle(dropdown).display !== "none";
  });
  await page.mouse.click(1400, 20);
  await page.waitForFunction(() => {
    const dropdown = window.advanceListShadow.querySelector(".ant-select-dropdown");
    return dropdown && getComputedStyle(dropdown).display === "none";
  });
  // 「推送到…」弹窗里的下载器选择是普通 Select：closed shadow 下它的下拉同样不能被 window 的 mousedown 误关
  await page.mouse.click(1400, 20);
  const downloaderSelect = await page.evaluate(() => {
    const select = window.advanceListShadow.querySelector(".fixture-downloader-select");
    const { x, y, width, height } = select.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
  await page.mouse.click(downloaderSelect.x, downloaderSelect.y);
  await page.waitForTimeout(350);
  const downloaderOption = await page.evaluate(() => {
    const item = [...window.advanceListShadow.querySelectorAll(".ant-select-item-option")].find((node) =>
      node.textContent.includes("transmission"),
    );
    if (!item || !item.offsetParent) return null;
    const { x, y, width, height } = item.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
  assert.ok(downloaderOption, "plain Select dropdown opened but was immediately closed by the shadow-host mousedown");
  await page.mouse.click(downloaderOption.x, downloaderOption.y);
  await page.waitForFunction(() => window.getFixtureDownloader() === "transmission");

  assert.deepEqual(errors, []);
  assert.ok(box.width >= 1100 && box.width <= 1408, `100-item dialog too narrow: ${JSON.stringify(box)}`);
  console.log("100-item closed-shadow dialog pagination click passed", box);
} finally {
  await browser?.close();
  await server.close();
}
