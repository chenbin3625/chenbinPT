import { fileURLToPath } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

/**
 * 与 vite.config.ts 的 `resolve.alias` 保持一致：
 * `~` → src、`@` → src/entries、`@ptd` → src/packages。
 *
 * 这里用绝对路径而非相对路径，语义与 vite.config.ts 中的 `path.resolve(__dirname, ...)` 相同，
 * 保证同一份 import 说明符在构建、单测、类型检查三种环境下落到同一个文件。
 */
const alias = {
  "~": fileURLToPath(new URL("./src", import.meta.url)),
  "@": fileURLToPath(new URL("./src/entries", import.meta.url)),
  "@ptd": fileURLToPath(new URL("./src/packages", import.meta.url)),
};

export default defineConfig({
  // 让测试能直接 import `src/**/*.vue`（模板级断言改为真实渲染断言的前提）。
  // 之前 tests/ 只用 `createApp + h` 渲染 antd 组件，无法验证我们自己的 SFC 模板；
  // 有了这个插件，`<a-xxx>` 的 class / prop / 结构类断言可以改成「挂载后查 DOM」的行为断言。
  plugins: [vue()],
  resolve: { alias },
  test: {
    // 站点解析大量依赖 DOM（DOMParser / Element.matches / innerHTML），
    // happy-dom 比 jsdom 快且足够覆盖这些 API。
    environment: "happy-dom",
    // 只收 tests/ 下的 vitest 用例；tests/unit.test.mts 是 tsx 直跑的旧用例集（npm run test:legacy），
    // 它带 process.exit 且没有 test() 块，不能被 vitest 收集。
    include: ["tests/**/*.test.ts"],
    // 测试会模拟扩展全局 API（chrome.storage、消息监听器等）；文件间共享这些宿主桩时，
    // Vitest 默认并行执行会互相覆盖模块状态，导致整套测试随机超时。显式串行化文件，
    // 保证 `npm test` 与单文件运行一致。
    fileParallelism: false,
    // 显式 import { describe, it, expect } from "vitest"，不注入全局，避免污染 src 的类型
    globals: false,
    experimental: {
      diagnostics: {
        environment: false,
        import: false,
        isolate: false,
        transform: false,
      },
    },
  },
});
