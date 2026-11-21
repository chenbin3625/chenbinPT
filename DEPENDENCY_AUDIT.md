# 依赖审计（2026-11-18 UTC）

覆盖 npm 直接和传递依赖、现有补丁机制、类型检查、单元测试及 Chrome/Firefox 构建。审计期间工作区持续有并行的源码和测试修改，因此另冻结了包含当时工作区修改的临时检出，并用独立 `node_modules` 验证锁文件。

## 已应用

| 依赖 | 原版本 | 新版本 |
| --- | --- | --- |
| axios | 1.20.0 | 1.21.1 |
| Vue / vue-i18n / vue-router | 3.5.44 / 11.4.16 / 5.4.0 | 3.5.45 / 11.4.22 / 5.5.1 |
| Vite / Vitest / WXT | 8.3.2 / 5.0.3 / 0.21.4 | 8.3.8 / 5.1.0 / 0.21.5 |
| happy-dom | 20.14.5 | 21.0.4 |
| Playwright | 1.63.0 | 1.65.1 |
| ESLint / typescript-eslint / eslint-plugin-vue | 10.12.0 / 8.71.0 / 10.11.1 | 10.15.0 / 8.73.0 / 10.12.1 |
| Prettier / Sass | 3.9.10 / 1.105.1 | 3.10.1 / 1.108.2 |

其余兼容范围更新包括 messaging、es-toolkit、filesize、Konva、p-queue 9、Commitlint、plugin-vue、globals、lint-staged。`package-lock.json` 同步更新；兼容的传递修补包括 follow-redirects 1.16.3、fast-xml-parser 5.12.1 和 fast-uri 3.1.9。

happy-dom 21.0.4 修补 [代码执行公告](https://github.com/advisories/GHSA-834v-8h66-3h79) 和 [SSRF 公告](https://github.com/advisories/GHSA-c8p4-j97h-3vg8)。其 Node 最低版本满足项目约束；项目实际使用的 Window/DOM API 保留，主要样式测试使用内联 CSS，不依赖新版默认关闭的外部 CSS/iframe 加载，因此采用此安全主版本升级。

## 实际验证

- 冻结检出的 `HUSKY=0 npm ci` 通过，三份 picomatch 补丁均成功应用；没有改动原工作区的安装目录。
- `npm run check`、`check:node`、`lint`、`check:antd` 通过；`test:legacy` 的 30 项断言通过。
- `npm run build:dist` 和 `npm run build:dist-firefox` 均通过。
- 最终冻结检出的完整套件运行 308 文件、3146 项测试：3106 通过、2 项测试超时、38 项因两个初始化钩子超时而跳过；另捕获一次 ant-design-vue 动画清理时的 `window is not defined` 异常。完整命令退出码为 1。
- 在同一冻结检出、相同依赖及默认超时设置下，重跑上述四个失败文件和动画异常关联文件：5 文件、102/102 通过，退出码为 0，没有重现未处理异常。未修改源码或测试配置来取得此结果。
- 这些结果覆盖了原先未执行和失败的用例，但尚未取得一次完整套件单次全绿的结果，仍保留超时及异步清理稳定性限制。
- 现有 `check-picomatch.cjs` 对三份安装的有限样例检查通过，但不能据此认定漏洞完整修复，原因见下文。

## 撤回或暂缓

- `@types/chrome 0.3.7`：cookies 返回类型增加 undefined，导致现有消息返回契约及取 cookie 的代码无法通过检查；保留 0.3.5。
- `vue-tsc 3.3.14`：将现有列表索引推断为 `string | number`，与业务函数的 number 参数不匹配；对照 3.3.12 通过，最终固定为 3.3.12。
- `p-queue 10`：改用 EventTarget，现有代码使用 `.on()`；取消队列语义也有测试依赖。
- `url-join 6`：查询/片段前的尾斜杠归一行为改变，与现有 URL 测试契约不符。
- `TypeScript 7`：包入口和编译器 API 发生变化，项目测试直接导入编译器 API，需单独迁移。
- 未强制覆盖 webdav 所声明的 minimatch 9 为新主版本，也未采用 `npm audit fix --force` 建议的 WXT/Vitest/router 降级。

## 剩余风险

版本扫描从基线 33 条降至 27 条受影响包记录（25 high、2 moderate），根因剩余 picomatch 的 [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) 与 minimatch 的 [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)。picomatch 查询时最新仍为受影响的 4.0.7，minimatch 的当前父依赖约束也没有兼容修补版。

已保留并行加入的本地补丁和安装钩子。补丁只缓解部分已知输入：已打补丁的解析器对 `+(a+)b` 加 40 个 `a` 和 `!`，以及 `+([[]*)b` 加 40 个 `[` 和 `!`，均超过 1000ms 隔离子进程限制。现有安全脚本未覆盖这些绕过；补丁也收紧了部分 glob 匹配语义。该公告仍应保留跟踪，不能声称已完整修复。

受影响依赖图同时涉及开发和生产声明，本次未对浏览器扩展最终产物做完整漏洞可达性证明；也未运行需要浏览器扩展装载或外部站点的全部 E2E/设备测试。
