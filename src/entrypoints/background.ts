/**
 * WXT background 入口。
 *
 * 实际逻辑仍在 `src/entries/background/`：各模块在**模块顶层同步**注册 chrome.* 监听器
 * （MV3 service worker 要求在首个事件循环内注册完毕），这里只用副作用 import 把它们带进 bundle。
 *
 * `#ptd/background-main` 由 wxt.config.ts 按目标解析：
 * - chrome：src/entries/background/main.ts（service worker，DOM 相关能力交给 offscreen 文档）；
 * - firefox：src/entries/background/ff_main.ts（常驻 background 页面，直接注册 offscreen 的处理函数）。
 *
 * Firefox 的 background 以 ESM（`type: "module"`）输出：WXT 默认把 background 单独打成 IIFE，
 * IIFE 不允许代码分割，offscreen 的整条依赖图（downloader / site / backupServer、zip、WebDAV、axios…）
 * 会被内联进 background.js，并与 options 页的 chunk 重复。改为 module 后，background 与 options
 * 进入同一个多页 ESM 构建，共享 chunk（Firefox 112+ 支持 module 类型的 background scripts，
 * manifest 的 strict_min_version 为 133.0）。
 * Chrome 仍保持 IIFE：service worker 的冷启动不应多出 chunk 的加载往返。
 */
import "#ptd/background-main";

import { defineBackground } from "wxt/utils/define-background";

export default defineBackground({
  type: { firefox: "module" },
  main() {
    // 监听器已在上面的模块顶层注册，这里无需再做事
  },
});
