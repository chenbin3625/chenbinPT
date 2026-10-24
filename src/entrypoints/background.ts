/**
 * WXT background 入口。
 *
 * 实际逻辑仍在 `src/entries/background/`：各模块在**模块顶层同步**注册 chrome.* 监听器
 * （MV3 service worker 要求在首个事件循环内注册完毕），这里只用副作用 import 把它们带进 bundle。
 *
 * `#ptd/background-main` 由 wxt.config.ts 按目标解析：
 * - chrome：src/entries/background/main.ts（service worker，DOM 相关能力交给 offscreen 文档）；
 * - firefox：src/entries/background/ff_main.ts（常驻 background 页面，直接注册 offscreen 的处理函数）。
 */
import "#ptd/background-main";

import { defineBackground } from "wxt/utils/define-background";

export default defineBackground(() => {
  // 监听器已在上面的模块顶层注册，这里无需再做事
});
