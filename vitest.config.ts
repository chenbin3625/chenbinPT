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
    // 只收 tests/ 下的 vitest 用例。
    // `tests/unit.test.mts` 是 tsx 直跑的旧用例集（npm run test:legacy）：它带 process.exit、
    // 顶层直接断言、没有 test() 块，**不能被 vitest 收集**（收集会以 "No test suite found" 失败）。
    // 因此 G10 的「让 .mts 进 vitest」只做了安全的那一半：`.mts` 已加入 tsconfig.json 的 include，
    // 受 vue-tsc 类型检查保护；把它改写成 describe/it 并合并进 `npm test` 属测试体系重构，见 fix report 延期项。
    include: ["tests/**/*.test.ts"],
    // 保留文件串行（G9 延期项）：`fileParallelism: false` 让 193 个文件的 `npm test` 约 3 分钟。
    // 报告建议先恢复并行再逐文件修污染，但本轮 19 个修复任务并发、且纪律禁止跑全量测试，
    // 无法验证「并行下全部文件稳定」——在没有全量 soak 的情况下改并行会让门禁随机变红。
    // 因此本轮只做了低风险的一半：恢复 Vitest 的 performance diagnostics（默认开启），
    // 让「环境/隔离/转换很贵」的信号重新可见；恢复并行由 Lead 在集成阶段单独验证。
    fileParallelism: false,
    // 显式 import { describe, it, expect } from "vitest"，不注入全局，避免污染 src 的类型
    globals: false,
  },
});
