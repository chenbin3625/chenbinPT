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
  // 不监听文件：本用例只跑一次，而 src/** 常被其他并行任务改动，HMR 客户端会在用例中途
  // 整页 reload（页面回到未打开弹窗的状态）——那是环境噪声，不是产品行为（TESTS-5）。
  server: { host: "127.0.0.1", port: 0, watch: null },
});

/**
 * 计算 closed shadow 里某个下拉选项的**稳定**点击点并真的点下去。
 *
 * 为什么不能取一次 getBoundingClientRect 就点（TESTS-5）：
 * antd Select 的下拉在入场动画与虚拟列表测量期间会短暂处于「零尺寸」或离屏位置，
 * 此时取到的坐标点到的其实是弹窗内容（等于一次外部点击）——下拉会被立刻关掉却不选中，
 * 真实回归（shadowPopupEvents 没有放行 mousedown）与这种取点失败因此无法区分。
 * 这里要求：选项尺寸非零、整体落在视口内、且连续三次采样完全一致（≈150ms 稳定窗口）。
 * 不依赖 `transitionend`（入场动画的 class 在无渲染压力的环境下可能迟迟不摘掉）。
 *
 * 为什么还要等「视觉静止」再采样（TESTS-5 残留的随机失败，实测复现并定位）：
 * 下拉入场用的是 antSlideUpIn（`transform-origin: 0% 0%` + `scaleY(0.8)` + `opacity: 0`），
 * 它在 Vue Transition 的 nextFrame 补上 `-enter-active` 之前一直是 `animation-play-state: paused`。
 * 暂停帧里的选项矩形会连续多次采样完全一致 —— 只看「矩形稳定」会把这个**缩小且不可见**的框
 * 当成稳定点；等真正点击时动画往往已经推进，整个下拉向下伸展（约 20% 高度），同一个坐标就落到了
 * 上一项（= 当前已选中的那一项）上：选值不变、下拉关闭，看起来与「mousedown 被当作外部点击」
 * 一模一样。
 * 所以这里先等到下拉**视觉静止**（opacity 回到 1、缩放回到 1）才允许取点，保证
 * 「采样时的几何 == 点击时的几何」。这不是重试或 sleep，而是等待一个有确定终态的渲染状态。
 *
 * 为什么还要验证「采样点真的落在选项上」（TESTS-5 残留的真正成因，探针实测）：
 * 即使几何静止，矩形也可能已经不接收指针事件了 —— 此时点下去命中的是弹窗遮罩，
 * 下拉被当成「外部点击」关掉、选项不被选中，症状与「mousedown 没有放行」无法区分。
 * 实测抓到的完整时间线：antd Modal（vc-dialog）入场动画结束时执行 `Dialog.js` 的
 * `onVisibleChanged(true)`：`if (!contains(wrapper, document.activeElement)) contentRef.focus()`
 * （聚焦 `.ant-modal` 的 start sentinel）。我们的 shadow root 是 closed，焦点在 shadow 内时
 * 宿主页面看到的 `document.activeElement` 只会是 **shadow 宿主元素**，这个 contains() 于是恒为
 * false —— 弹窗入场动画每次结束都会把焦点从 shadow 内真正聚焦的元素上抢走（rAF 被节流时可能晚到
 * 数秒）。若此刻正好有 Select 下拉打开，它的搜索框收到 blur，antd 把 blur 延迟 100ms 交给容器，
 * 容器随即关闭下拉（探针时间线：blur@2862ms → 下拉 `-slide-up-leave` + `pointer-events: none`
 * @2977ms），而用例在 blur 之前已采样完成、点击时坐标已失效 ⇒ 点击落到遮罩上。
 * 产品侧修复见 `src/entries/content-script/app/shadowPopupEvents.ts` 的
 * `installDialogSentinelFocusGuard`（把这一次被 shadow 边界误判的抢焦点还回去）。
 * 这里的命中判定是同一件事的兜底：点之前必须确认 `shadow.elementFromPoint(point)` 就是该选项，
 * 否则继续等待一个「真能点」的状态，而不是拿失效坐标去点。
 */
async function clickShadowOption(page, needle, failureMessage) {
  let handle;
  try {
    handle = await page.waitForFunction(
      (text) => {
        const shadow = window.advanceListShadow;
        // 只接受「整体在视口内」的候选：antd 在下拉里还会渲染离屏测量节点（同为
        // .ant-select-item-option，y ≈ -9xxx），它们宽高非零但不可点。若用 find() 先命中它们，
        // 视口检查会让本函数永远取不到真实选项（TESTS-5 由探针复现）。
        const option = [...shadow.querySelectorAll(".ant-select-item-option")].find((node) => {
          if (!node.textContent.includes(text)) return false;
          const rect = node.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.top >= 1 &&
            rect.bottom <= 899 &&
            rect.left >= 1 &&
            rect.right <= 1439
          );
        });
        if (!option) return null;

        const dropdown = option.closest(".ant-select-dropdown");
        if (!dropdown || getComputedStyle(dropdown).display === "none") return null;

        // 入场动画未结束（缩放/淡入中）时不下发采样点，见上方 TESTS-5 说明
        const dropdownStyle = getComputedStyle(dropdown);
        if (dropdownStyle.opacity !== "1") return null;
        const transform = dropdownStyle.transform;
        const scaleY = transform === "none" ? 1 : new DOMMatrixReadOnly(transform).d;
        if (Math.abs(scaleY - 1) > 0.001) return null;

        const { x, y, width, height } = option.getBoundingClientRect();
        const point = { x: x + width / 2, y: y + height / 2 };
        if (point.x < 1 || point.y < 1 || point.x > 1439 || point.y > 899) return null;

        // 矩形静止 ≠ 可点：下拉正在关闭或被遮罩盖住时（`pointer-events: none` / 层级被
        // .ant-modal-wrap 压过）矩形会保持最后状态，但采样点已经命不中选项，此时点击等于点遮罩。
        const hit = shadow.elementFromPoint(point.x, point.y);
        if (!hit || !option.contains(hit)) return null;

        const previous = window.__ptdLastOptionPoint;
        window.__ptdLastOptionPoint = point;
        if (!previous || Math.abs(previous.x - point.x) > 0.5 || Math.abs(previous.y - point.y) > 0.5) {
          window.__ptdStableSamples = 1;
          return null;
        }
        window.__ptdStableSamples = (window.__ptdStableSamples ?? 0) + 1;
        return window.__ptdStableSamples >= 3 ? point : null;
      },
      needle,
      // 用 rAF 轮询（而不是 setTimeout(50)）：本用例等的是「渲染状态静止」，而 headless 下
      // 页面没有新帧时 rAF 会被拖到数秒一次，rc-motion 的 prepare→start→active 步进也跟着被拖长
      // （实测 rafGaps 有 1.5~5s 的间隔；该测量来自一次性探针，探针脚本未入库）。
      // 持续注册 rAF 轮询本身会让浏览器一直出帧，让「入场动画结束」这个确定状态尽快到达 ——
      // 不是 sleep，也不是重试；状态永远不满足时依然会超时失败。
      { timeout: 45000, polling: "raf" },
    );
  } catch {
    throw new Error(failureMessage ?? `找不到可点击的下拉选项：${needle}`);
  }

  const { x, y } = await handle.jsonValue();
  await page.mouse.click(x, y);
}

let browser;

try {
  await server.listen();
  const port = server.httpServer.address().port;
  try {
    browser = await chromium.launch({ channel: "chromium", headless: true });
  } catch (error) {
    // 缺 chromium 时给出可操作的提示，而不是一句 playwright 内部的 spawn 错误（TESTS-5）
    throw new Error(
      `[test:browser] 无法启动 chromium：${error instanceof Error ? error.message : String(error)}\n` +
        "  先执行 `npx playwright install chromium`，再重跑 `npm run test:browser`。",
    );
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // headless 下 rAF/帧节奏会被拖到数秒一次（探针实测 rafGaps 1.5~5s），rc-motion 的离场动画结束、
  // 弹窗缩放入场动画结束都依赖帧，因此把「等一个确定状态」的默认预算放大到 45s ——
  // 这不是重试或 sleep：状态永远不满足时依旧超时失败，只是不再因帧被节流而随机红。
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/tests/fixtures/advance-list-browser.html`);
  await page.evaluate(() => window.openAdvanceListFixture());
  // 等弹窗入场动画结束再量尺寸/取点：入场中的 .ant-modal 只有 scale(0.2) 的 rect（1200px → 240px），
  // 此时量到的坐标与下拉对齐位置都会偏，后续的选项点击会落到弹窗遮罩上（TESTS-5 实测的随机失败原因）
  const boxHandle = await page.waitForFunction(
    () => {
      const modal = window.advanceListShadow.querySelector(".ant-modal");
      if (!modal) return null;
      const { width, height, x, y } = modal.getBoundingClientRect();
      if (width < 400) return null;
      const next = { width, height, x, y };
      const previous = window.__ptdLastModalBox;
      window.__ptdLastModalBox = next;
      if (
        !previous ||
        Math.abs(previous.width - next.width) > 0.5 ||
        Math.abs(previous.x - next.x) > 0.5 ||
        Math.abs(previous.y - next.y) > 0.5
      ) {
        window.__ptdStableModalSamples = 1;
        return null;
      }
      window.__ptdStableModalSamples = (window.__ptdStableModalSamples ?? 0) + 1;
      return window.__ptdStableModalSamples >= 3 ? next : null;
    },
    null,
    // 同样受 headless 帧节奏影响（弹窗缩放入场动画由帧驱动），给足「等确定状态」的预算
    { timeout: 45000, polling: "raf" },
  );
  const box = await boxHandle.jsonValue();
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
  await clickShadowOption(page, "50", "每页条数下拉在 shadow 内被误关（mousedown 未被放行）");
  await page.waitForFunction(
    () =>
      window.advanceListShadow
        .querySelector(".ant-pagination-options-size-changer .ant-select-selection-item")
        ?.textContent?.includes("50"),
    null,
    { timeout: 10000 },
  );
  assert.equal(
    await page.evaluate(() => window.advanceListShadow.querySelectorAll(".ant-table-tbody > tr[data-row-key]").length),
    50,
  );
  // 选中后下拉会自行关闭；等它真的关掉再重新点开，避免在离场动画跑到一半时被打断
  // （rc-motion 的「入场未结束/离场未结束」交叠在本环境里出现过状态卡死，见下方外部点击处的说明）
  await page.waitForFunction(
    () => {
      const dropdown = window.advanceListShadow.querySelector(".ant-select-dropdown");
      return dropdown && getComputedStyle(dropdown).display === "none";
    },
    null,
    { timeout: 45000, polling: "raf" },
  );
  await page.mouse.click(sizeChanger.x, sizeChanger.y);
  // 先等下拉**真的展开**（可交互），再点外部把它关掉：只看 `display !== "none"` 不够 ——
  // 入场动画被帧节奏拖住时下拉已经挂在 DOM 里但仍是 `opacity: 0 / pointer-events: none`，
  // 此时点外部等于打断一个还没跑起来的入场动画，rc-motion 的离场可能因此停在半途、
  // 下拉一直不回到 `display: none`（实测这正是 TESTS-5 残留里「等下拉关闭」超时的成因）。
  await page.waitForFunction(
    () => {
      const dropdown = [...window.advanceListShadow.querySelectorAll(".ant-select-dropdown")].find((node) => {
        const style = getComputedStyle(node);
        return style.display !== "none" && style.opacity === "1" && style.pointerEvents !== "none";
      });
      return !!dropdown;
    },
    null,
    { timeout: 45000, polling: "raf" },
  );
  await page.mouse.click(1400, 20);
  await page.waitForFunction(
    () => {
      const dropdown = window.advanceListShadow.querySelector(".ant-select-dropdown");
      return dropdown && getComputedStyle(dropdown).display === "none";
    },
    null,
    { timeout: 45000, polling: "raf" },
  );
  // 「推送到…」弹窗里的下载器选择是普通 Select：closed shadow 下它的下拉同样不能被 window 的 mousedown 误关
  await page.mouse.click(1400, 20);
  const downloaderSelect = await page.evaluate(() => {
    const select = window.advanceListShadow.querySelector(".fixture-downloader-select");
    const { x, y, width, height } = select.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
  await page.mouse.click(downloaderSelect.x, downloaderSelect.y);
  await page.waitForTimeout(350);
  await clickShadowOption(page, "transmission", "普通 Select 的下拉被 shadow-host 的 mousedown 立即关闭");
  await page.waitForFunction(() => window.getFixtureDownloader() === "transmission", null, { timeout: 10000 });

  assert.deepEqual(errors, []);
  assert.ok(box.width >= 1100 && box.width <= 1408, `100-item dialog too narrow: ${JSON.stringify(box)}`);
  console.log("100-item closed-shadow dialog pagination click passed", box);
} finally {
  await browser?.close();
  await server.close();
}
