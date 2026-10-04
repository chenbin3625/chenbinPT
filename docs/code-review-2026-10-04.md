# chenbinPT 全量代码审查报告

| 项 | 值 |
| --- | --- |
| 审查对象 | `chenbinPT`（Manifest V3 浏览器扩展，Chrome + Firefox），工作树 |
| 分支 / HEAD | `refactor/antd` / `a6993f1f83a9363ab78d9dbace53bc863c307b88`（工作树 656 个文件相对 HEAD 有改动） |
| 源文件快照指纹 | `src/` + `tests/` 内容哈希 `df4103e1b45808aa` |
| 规模 | 596 个 TS/Vue 源文件，118,320 行（`packages/site/definitions` 341 文件 / 65,122 行；`entries/options` 130 文件 / 22,843 行） |
| 审查日期 | 2026-10-04 |

> ⚠️ **快照说明**：审查期间工作树被**并发修改**（如 `MyClient/Index.vue` 于 14:57:59 被改、`stores/config.ts` 于 14:55:09 被改）。14:54 时测试套件为**红**（`myClientAutoRefresh.test.ts` 5 个断言失败），14:58 后同一测试全绿——即当时有人正在修这些问题。**本报告所有结论均在上表快照上重新核验**；行号可能随后续改动漂移。

---

## 1. 方法

分域并行深审 + **关键结论逐条独立复现**。所有标注「已复现」的结论都由我本人用 `node -e` 或直读源码/依赖源码验证过；未经复现的推断一律不写入。审查过程中主动**排除了 11 处误报**（见 §8），并修正了两处子审查的错误结论。

### 1.1 我自己的四处更正（诚实记录，附方法论教训）

审查与修复期间，我发现自己有四处结论不准确。全部记录在此，因为它们同时也是**可复用的教训**：

| # | 我原先的结论 | 实际情况 | 教训 |
| --- | --- | --- | --- |
| 1 | lint 门禁「通过但被架空」 | `eslint .` 实际 **exit 2**（我用 `npx eslint . \| tail` 取 `$?`，拿到的是 `tail` 的 0） | **凡是要断言退出码的验证，必须不经管道**；管道会把 `$?` 变成最后一个命令的 |
| 2 | 时间线「总分享率」求和是误报（已排除） | 确实是缺陷：守卫 `if (downloaded > 0)` 为假时显示 `-1 + Σ各站分享率` | **「守卫存在」≠「无守卫时行为正确」**；要检查守卫为假的分支 |
| 3 | B-2：正则在第一处空格截断标题，实现与注释矛盾 | 该行是**三处 U+00A0（NBSP）**，且注释与代码其实一致；真实症状是「该切分时不切分」 | **逐字符敏感的内容必须从文件字节提取，不能凭阅读印象重敲**——终端会把 NBSP 渲染成普通空格，肉眼无法区分。详见 B-2 |
| 4 | `eslint-suppressions.json` 里 5 条过期抑制是「提交进 HEAD 的状态」 | 该文件**根本不在 HEAD 中**（未跟踪），因此「CI 红不红」取决于它最终如何被提交 | **审查代码内容之外还要审查版本控制状态**——正是这个盲区让我漏掉了 S-3（123 个被依赖文件未跟踪） |

### 1.2 修复阶段的额外发现（原审查未覆盖）

| ID | 发现 | 为什么原审查会漏 |
| --- | --- | --- |
| **S-3** | **123 个被依赖文件处于未跟踪状态**（整个 `tests/`、`scripts/`、`eslint.config.mjs`、`vitest.config.ts`、`package-lock.json`，以及 29 个 `src/` 源文件含 `selector.ts`），`git commit -a` 会产出一个无法 `npm ci`、无法 lint、无法跑测试、无法构建的提交 | 原审查只看了文件**内容**，没看**版本控制状态**（见上表 #4） |
| 门禁真相 | `check-antd-migration.mjs` 的 `classes-defined` 那条是**脚本自身的误报**（`:class` 表达式里的变量名 `configStore` 被当成类名） | 我信任了脚本的输出而没读它的实现 |

覆盖矩阵：

| 域 | 规模 | 方式 |
| --- | --- | --- |
| `packages/site/schemas` + `types` | 15 文件 / 6,788 行 | 全量精读 |
| `packages/site/utils` | 11 文件 / 2,965 行 | 全量精读 |
| `packages/site/definitions` | 341 文件 / 65,122 行 | 全量 AST 机械扫描 + 26 个文件精读 |
| `entries/background` + `offscreen` | 23 文件 / 4,395 行 | 全量精读 |
| `entries/options`（stores/directives/views/components） | 130 文件 / 22,843 行 | 全量精读 |
| `entries/content-script` + `shared` + `extends` | 30 文件 / 3,461 行 | 全量精读 |
| `packages/downloader` | 12 文件 / 6,520 行 | 全量精读 + 上游客户端源码比对 |
| `packages/backupServer` / `mediaServer` / `social` | 29 文件 / 5,740 行 | 定向精读（凭据与恢复路径） |
| `vite.config.ts` / `scripts` / `tests` / CI / manifest | — | 全量精读 + 实跑 |
| 全局静态分析 | — | 依赖图、循环依赖、孤儿模块、重复代码、i18n 覆盖、AST 定义扫描 |

**覆盖边界**：本次审查对 **`src/` 全域是完整的**——`packages/{site,downloader,backupServer,mediaServer,social}`、`entries/{background,offscreen,content-script,options,shared}`、`extends/`、`vite.config.ts`/`scripts`/`tests`/CI/manifest 均已逐文件读完或做完全量机械扫描（341 个站点定义用 TypeScript AST 扫描覆盖）。唯一未做逐文件精读的是 `packages/mediaServer` 与 `packages/social` 的非凭据路径（已定向精读凭据与恢复链路），以及 `src/locales/*.json`（已做键对齐与空值校验）。`views/Devtools/` 是**空目录**，无内容可审。

两点值得单独说明：
- **`selector.ts`（1201 行，全仓库复用度最高的文件）经两路独立验证**：我本人逐条对照 Sizzle 语义复算位置伪类边界，另一路用**冻结的 Sizzle 2.3.10 做差分 oracle**（556 个真实选择器 × 9 上下文 + 约 7.5k 次模糊测试），除 A-18 那一类外零差异（§7.12）。
- **本报告纠正了我自己的 1 处误判**（B-26 的 ratio 聚合），并修正了两处子审查的错误结论（V-3 的「异步 executor 导致弹窗卡死」不成立；V-11 的 Modal 问题被降级并重新定位为「违反项目自身成文规则」）。

---

## 2. 结论摘要

**工程质量明显高于同类个人项目。** 几乎所有高风险子系统都带有「为什么这样做」的注释与对照基准，且**自省式门禁确实存在并在 CI 中会红**（产物完整性 + 体积预算 + 浏览器 E2E）。站点定义层的机械体检结果尤其干净：341 个定义中 **0 个 id 重复、0 个 hostname 重复、0 处跨站 host 污染、0 处硬编码密钥**。

**但问题也不少：1 条阻断级安全链、1 个 CRITICAL 级死锁、30 条高危、52 条中危、28 条低危，外加 1 个系统性问题**（本分支自带的迁移验收脚本失败且无人调用）。三条最该先看的：

| 优先级 | 问题 | 一句话后果 |
| --- | --- | --- |
| 🔴 阻断 | **S-1** 备份恢复不校验内容 | 恢复他人分享的备份 zip ⇒ 站点 passkey/Cookie/下载器密码被**自动**上传到攻击者端点 |
| 🔴 阻断 | **B-25** `loadAllAddedSiteMetadata` 的 async executor 永不 settle | 一个失效站点 id 就让 MyData/时间线/统计**三个页面永久转圈**（`Promise.allSettled` 防不了「不 settle」） |
| 🔴 阻断 | **S-2** 拖拽载荷与解析链接未校验来源 | 页面可让扩展以自身特权（`*://*/*`）向任意主机发起**绕过 CORS 的带凭据请求** |
| 🟠 高 | **B-4~B-7** 四个下载器 API 契约错误 | 限速/Tracker/文件面板**什么都不做却报成功**——用户几乎不可能自己发现 |
| 🟠 高 | **B-8 / B-26 / B-28 / B-29** | 静默删掉用户搜索方案里的站点 / 总分享率显示成 `-1+Σ` / 「取消」不回滚且逐键把凭据写进库 / 「删除并删数据」可能抹掉**另一个客户端**上的文件 |
| 🟠 高 | **B-21** 中文时长单位缺 `小时`/`个月` | `"5小时"` 会返回**字符串**灌进数值字段，`"1天2小时"` 静默少算 2 小时 |

**关于本次审查自身的可信度**：我在过程中修正了 1 处自己的误判（把 B-26 的 ratio 聚合错判为「已正确处理」，见 §7.13）、剔除了 11 处不成立的怀疑（§8），并对每条高危/中危都做了独立复现。报告里凡标「已复现」的都可按 §10 的命令重跑。

### 门禁实际状态（在快照上实跑，并在修复阶段复核）

> ⚠️ **本节更正过两次**，两次都是我自己取退出码的方式有误，记录在此以免后人重犯：
> 1. 最初我用 `npx eslint . 2>&1 | tail` 取退出码，`$?` 拿到的是 `tail` 的 0，因而误判 lint「通过」。
> 2. 改用**不经管道**的方式重测后得到 exit 2，我把它归因为「抑制文件里有 5 条过期条目」。进一步核查发现**更根本的事实**：`eslint-suppressions.json` **根本不在 HEAD 中**（`git status` 为 `??`，未被跟踪、也未被忽略），它是迁移期间新增的未提交文件。因此「CI 到底红不红」取决于它最终如何被提交：

| `eslint-suppressions.json` 的处理方式 | ESLint 步骤结果 |
| --- | --- |
| **不提交**（当前状态，文件未跟踪） | ❌ **252 个真实 error**（135 `no-console` + 116 `no-floating-promises` + 1 `no-empty`）——基线不存在，全部违规暴露 |
| 提交 257 条版本（迁移期本地状态） | ❌ **exit 2** —— ESLint 10 把「未剪枝的抑制」视为失败 |
| 提交剪枝后的 252 条版本 | ✅ exit 0 —— **唯一能让门禁变绿的组合** |

**本次修复已执行**：对该文件跑 `--prune-suppressions`（257→252，115→112 文件），使 `eslint .` 在本工作树 **exit 0**。但**还需作者把它 `git add` 进版本库**——否则 CI 仍是红的。这是修复清单里必须交付的一步，我没有代替作者执行 `git add`（不擅自改动暂存区）。

| 门禁 | 结果 | 说明 |
| --- | --- | --- |
| `npx vue-tsc --noEmit` | ✅ exit 0 | 无输出 |
| `npm run lint`（`eslint .`） | ✅ exit 0（修复后） | 见上表：剪枝后 exit 0；**恢复点**：修复前为 exit 2 |
| `npx eslint . --suppressions-location <空文件>` | 252 error / 112 文件 | 135 `no-console`、116 `no-floating-promises`、1 `no-empty` —— 被永久豁免的真实存量（Q-1 的实质问题，未在本次修复中消化） |
| `npm test`（`vitest run`） | ✅ exit 0，74 文件 / **430** 通过 | 但约 30% 测试断言的是**源码文本**而非行为（Q-3） |
| `npm run build:dist` / `build:dist-firefox` | ✅ exit 0 | 均成功 |
| `npm run check:bundle`（新增脚本名） | ✅ exit 0 | chrome 6.44 MB / firefox 8.19 MB，均在预算内；**报告计数已修**（firefox 曾把豁免的 offscreen 也算作「就位」，显示 10/10 而实际 9/10） |
| `npm run check:antd`（新增脚本名） | ✅ **exit 0（修复后，12/12 全绿）** | 修复前 exit 1（12 项中 2 项失败），且**未被 `package.json` / CI / husky 引用**。现已接入 `package.json` 与 CI action_build.yml（Q-2） |

**结论**：修复后本工作树的三条静态门禁（typecheck / lint / antd 迁移验收）**全部 exit 0**；`check:antd` 从「失败且无人调用」变为「全绿且 CI 强制」。ESLint 仍需作者提交抑制文件才在 CI 中生效。

---

## 3. 阻断级：安全、数据损失与仓库完整性

### S-1　备份恢复不校验内容 → 可注入备份服务器 → 自动外泄站点密钥、Cookie 与下载器凭据

**位置**：`backupServer/utils.ts:253-315`、`options/views/Settings/SetBackup/RestoreDialog.vue:27,42-71`、`offscreen/utils/backup.ts:229-292`、`background/utils/alarms.ts:376-425`、`backupServer/entity/WebDAV.ts:9-16`

**证据链（每一环已复现）**

1. 解包只做「与 **attacker 自己写的** `manifest.json` 逐文件对比 MD5」——仅保证压缩包内部自洽，对伪造零防御；解出的任意 JSON 直接落库，**无 schema 校验**：
```ts
// packages/backupServer/utils.ts:281-288
const fileContentHash = CryptoJS.MD5(fileContent).toString();
if (fileKey != "manifest" && fileContentHash !== manifestFileHash) throw new Error(`File hash mismatch for ${fileName}.`);
decryptedFiles[fileKey] = decryptData(fileContent, encryptionKey);
```
2. 恢复时 `metadata` **原样写入** `chrome.storage.local`，唯一处理是按 `type + config` 去重，没有白名单、没有确认、没有告警：
```ts
// entries/offscreen/utils/backup.ts:270
await sendMessage("setExtStorage", { key: field, value: fieldData });
```
3. `autoBackup` 定时器随后遍历**所有** `enabled && backupInterval > 0` 的服务器上传，**上传字段取自被恢复进来的** `serverConfig.backupFields`：
```ts
// entries/background/utils/alarms.ts:413-418
const backupFields = (serverConfig.backupFields ?? []) as any[];
const ok = await sendMessage("exportBackupData", { backupServerId: serverId, backupFields });
```

**后果**：用户在「设置 → 备份 → 恢复」中恢复一份**他人分享的备份 zip**（`RestoreDialog` 的默认入口就是本地文件上传），该 zip 即可植入一条指向攻击者 WebDAV/S3/Gist 的记录，并设 `enabled: true`、`backupInterval: 1`、`backupFields: ["cookies","config","userInfo",…]`。此后扩展会**自动、静默地**把站点 passkey、会话 Cookie、下载器账号密码上传到攻击者端点。无需任何交互式钓鱼。

**修复**
1. `backupServers` 默认**不恢复**（或恢复为 `enabled:false` 并剥离 `backupInterval`/`backupFields`）；有差异时列出「类型 + 主机」让用户显式确认。
2. `restoreBackupData` 写库前做逐字段 schema 校验，拒绝未知顶层键。
3. **上传字段不得来自恢复数据**——必须来自用户本次会话的勾选。
4. UI/文档明确提示「不要恢复来源不明的备份文件」。

### S-3　【阻断级 · 仓库完整性】123 个被依赖的文件处于未跟踪状态，`git commit -a` 会产出一个无法构建、无法跑测试、无法过 CI 的提交

> **这是原报告完全遗漏的一条**，而且它**门控其它所有修复**：只要这个提交不完整，任何代码修复都无法在 CI 里被验证。我在修复阶段核查 CI 依赖时才用 `git status --porcelain -uall` 发现它——原审查只看了文件内容，没看版本控制状态，方法上有盲区。

**证据（均已实跑）**

```bash
$ git status --porcelain -uall | grep '^??' | wc -l      # 排除 dist-*/临时目录/本报告
123
$ git ls-files --error-unmatch package-lock.json          # 未跟踪
$ git ls-tree -r --name-only HEAD | grep -c '^package-lock.json$'   # 0
$ git ls-tree -r --name-only HEAD | grep -c '^pnpm-lock.yaml$'      # 1
```

**CI 的第 1 步就会失败**：`action_build.yml:31` 是 `npm ci`，而 `npm ci` 硬依赖 `package-lock.json`。HEAD 里**只有 `pnpm-lock.yaml`**；`package-lock.json` 是迁移产物但**未跟踪**。我已用一个最小目录实测：

```
$ npm ci      # 目录里只有 package.json，无 lockfile
npm error code EUSAGE
npm error The `npm ci` command can only install with an existing package-lock.json or
npm error npm-shrinkwrap.json with lockfileVersion >= 1.
exit=1
```

**未跟踪清单（`-uall` 展开后共 123 个文件）**

| 类别 | 数量 | 关键项 |
| --- | --- | --- |
| `tests/`（**整个目录**） | 82 | 全部测试，含 `tests/packages/site/utils/oracle/selector-oracle-2.3.10.js.txt`（Sizzle 差分 oracle） |
| `src/` 源文件 | 29 | **`src/packages/site/utils/selector.ts`（1201 行，全仓库复用度最高）**、`src/entries/shared/storagePath.ts`、`messagesSerializable.ts`、`colors.ts`、`src/entries/options/plugins/antd.ts`、`stores/metadataStoreBridge.ts`、`background/utils/siteIndex.ts`、`packages/backupServer/zipStream.ts`、`site/utils/error.ts`、`content-script/app/{modal,themeVars}.ts`、`views/Settings/SetBase/ResetWindow.vue` 等 |
| `scripts/`（**整个目录**） | 4 | `check-bundle-budget.mjs`、`check-antd-migration.mjs`、`e2e-extension-smoke.mjs`、`pack-crx.mjs` |
| 根配置 | 6 | **`package-lock.json`**、**`eslint.config.mjs`**、**`eslint-suppressions.json`**、**`vitest.config.ts`**、`.node-version`、`commitlint.config.mjs` |
| 其它 | 2 | `.husky/commit-msg`、`patches/git-rev-sync+3.0.2.patch`（后者是 `postinstall: patch-package` 生效的前提） |

**逐条后果**（若按现状 `git commit -a` 提交）

| CI 步骤 | 结果 |
| --- | --- |
| `npm ci` | ❌ `EUSAGE`，缺 `package-lock.json` |
| `npm run check`（vue-tsc） | ❌ 缺 `selector.ts`/`storagePath.ts`/`antd.ts` 等 29 个源文件 → 大量 TS 报错 |
| `npm run lint` | ❌ 缺 `eslint.config.mjs`（无配置）与 `eslint-suppressions.json` |
| `npm run check:antd` | ❌ 缺 `scripts/check-antd-migration.mjs` |
| `npm test` | ❌ 缺 `vitest.config.ts` 与整个 `tests/`（82 个文件） |
| `npm run build:dist` | ❌ 缺 `selector.ts` 等被 schema 直接 import 的文件 |
| `postinstall: patch-package` | ❌ 缺 `patches/git-rev-sync+3.0.2.patch` → `git.count("HEAD")` 版本号逻辑失效 |

**修复（这是提交前的必做动作，不是代码改动）**

```bash
git add -A          # 或逐项 git add；务必覆盖上面 5 类共 123 个文件
git status          # 确认没有 ?? 残留（除 dist-*/临时目录）
# 验证：在干净克隆里跑一遍 CI 的关键步骤
git clone . /tmp/verify-clone && cd /tmp/verify-clone && npm ci && npm run lint && npm run check:antd && npm test && npm run build:dist
```

**我没有代作者执行 `git add`**：那会改动暂存区，属于作者的版本控制决策；本报告给出清单与验证命令。**同时建议**：把这个「干净克隆验证」加进发布流程或 CI 的一个定时任务——它能一次性抓住这一类「本地能跑、提交后崩」的问题。

---

## 4. 高危

### S-2　拖拽载荷与页面解析出的链接均未做来源校验 → 扩展以自身特权请求任意主机

**位置**：`content-script/app/App.vue:201-206`（载荷解析）、`:104-122`（自建载荷）、`:228`（唯一闸门）；`AbstractBittorrentSite.ts:430-447`（`fixLink`）；`SiteListPage.vue:35,59,76`、`SiteDetailPage.vue:25,43,53`

**证据（已复现的不对称）**

```ts
// App.vue:200-206 —— 自建 MIME 分支：JSON.parse 后完全信任
if (Array.from(dataTransfer.types).includes(CUSTOM_DRAG_MIME)) {   // CUSTOM_DRAG_MIME = "text/json+ptd"
  torrents = JSON.parse(dataTransfer.getData(CUSTOM_DRAG_MIME));   // 无任何形状校验
} else {
  const links = extractLinksManually(dataTransfer);
  for (const link of links) {
    const url = URL.parse(link);
    if (!url || !(url.protocol.startsWith("http") || url.protocol.startsWith("magnet"))) continue;  // ← 另一分支有校验
```

```ts
// AbstractBittorrentSite.ts:433-443 —— 任意绝对 scheme 原样通过
} else if (uri.slice(0, 4) !== "http") {
  const requestUrl = axios.getUri(requestConfig);
  url = new URL(uri, requestUrl).toString();     // javascript: / file: / data: 均存活
}
```

**后果**：任意页面都能在 `dragstart` 里 `setData("text/json+ptd", …)` 伪造 torrent（`link`/`site`/`title`/`id` 全由页面决定）；用户按扩展引导把该链接拖到悬浮球并确认后，扩展会带着 `host_permissions: *://*/*` 对该 URL 发起**绕过 CORS 的带凭据请求**（`offscreen/download.ts:439/531/557/571/606`），或把该 URL 交给 `chrome.downloads` / `window.open` / 用户的下载器。`torrent.site` 由载荷决定，还会绕过「该站点不允许该下载器」的限制。此外，注入到列表/详情页下载列的 `<a href="https://evil.tld/x">` 会让普通点击（复制链接/本地下载/推送到下载器）走到同一组 sink。

**修复**：校验拖拽载荷（只接受 `{link}`，`new URL(link).protocol ∈ {http:,https:,magnet:}`），忽略载荷里的 `site`/`id` 并强制使用 `ptdData.siteId`；解析出的 `torrent.link`/`url` 必须落在该站点已知 host 内才允许下载类操作；显式拒绝 `file:`/`javascript:`/`data:`。

### B-1　站点数据里一行坏时间就会让整站搜索结果全部作废

**位置**：`packages/site/utils/datetime.ts:139`，调用点 `AbstractBittorrentSite.ts:810-812`，逐行 catch `:716-723`

**证据（已复现）**

```
format(new Date("昨天"), "yyyy-MM-dd'T'HH:mm:ss")  →  RangeError: Invalid time value
```

```ts
// datetime.ts:137-140
if (offsetSign) {
  const datetime = format(new Date(time), "yyyy-MM-dd'T'HH:mm:ss");   // 无效日期直接抛
```

原始字符串进入该路径是**设计内的降级行为**（NexusPHP `time.elementProcess` 在解析失败时返回原文 `NexusPHP.ts:504-517`；Gazelle `baseTimeSelector` 同理 `Gazelle.ts:117-127`）。致命之处是逐行 catch **重抛**：

```ts
// AbstractBittorrentSite.ts:716-723
for (const tr of trs) {
  try { torrents.push(await this.parseWholeTorrentFromRow({}, tr, searchConfig!)); }
  catch (e) { console.error(`… parseWholeTorrentFromRow Error:`, e, tr); throw e; }   // ← 整站结果作废
}
```

**后果**：空时间单元格 / `"01.03.2024 10:00"` / `"昨天"` 这类输入会让该站点**全部**结果被丢弃，用户看到 `parseError` 而非其余 N-1 条。

**修复**：`parseTimeWithZone` 改为全函数（`const d = new Date(time); if (!isValid(d)) return 0;`）；逐行失败降级为「记日志 + 跳过该行」（`Gazelle.ts:702-704` 已是这个模式）。

### B-2　NexusPHP 详情页标题过滤器与自己的注释不一致（**本条的症状描述已更正，见下**）

**位置**：`packages/site/schemas/NexusPHP.ts:571-572`

> ⚠️ **我的原始证据是错的，此处更正（本次审查第三处自我更正）**。我原先写的是「正则 `/^(.+?) +.+$/`，在第一处空格就截断」，并用 `"Interstellar 2014 2160p" → "Interstellar"` 作为复现。修复代理指出该行实际是 **U+00A0（NBSP）**而不是 ASCII 空格，我随即做了**字节级核实**：
> ```
> $ git show 82db8f3b:src/packages/site/schemas/NexusPHP.ts | sed -n '571p' | hexdump -C
> 00000010  20 5e 28 2e 2b 3f 29 c2  a0 c2 a0 c2 a0 2e 2b 24  | ^(.+?).......+$|
> #                                               ^^^^^^^^^^^ = 三处 c2 a0，即三个 U+00A0
> $ git show 82db8f3b:... | sed -n '571p' | grep -c ' +\.+$'   # ASCII 版本
> 0
> ```
> 也就是说：**我当时是把正则按自己的理解敲进 `node -e` 里跑的，而不是从文件里取出来的**——跑的是一个文件里并不存在的正则。注释里的「三个空格」同样是三个 NBSP（所以注释与代码其实**是一致的**，我原先说「实现与注释矛盾」也不准确）。
>
> **真实症状**（比我原先描述的更轻，但缺陷仍然成立）：该过滤器要求**三连 NBSP** 才切分，因此
> - `"Name&nbsp;[Free]"`（单个 NBSP 分隔）→ **完全不切分**，返回带 `[Free]` 的整串；
> - ASCII 空格分隔的标题（`"A B C"`）→ 同样不切分。
>
> 即真实表现是「**该切分的时候不切分**」，而不是我原先说的「过度截断」。严重性从「影响所有 NexusPHP 详情页标题显示」下调为「只影响用单个 NBSP 分隔的标题（以及注释意图未覆盖的 ASCII 空格场景）」。
>
> **教训（已写入 §1 方法说明）**：验证正则/字符串这类逐字符敏感的代码时，必须从文件字节里提取，不能凭阅读印象重敲——终端会把 NBSP 渲染成普通空格，肉眼无法区分。

**证据（更正后）**

```ts
// NexusPHP.ts:570-572（修复前）
// ^(.+?)   .+$              ← 这里的「三个空格」是三处 U+00A0
let titleMatch = title.match(/^(.+?)\u00A0\u00A0\u00A0.+$/);
```

该过滤器挂在 `detail.selectors.title`（`:566-578`），对所有 NexusPHP 站点在详情页生效，标题会流向 `SiteDetailPage.vue:37` 的 `runtimeStore.search.searchKey`（快捷搜索关键词）以及下载器/下载历史。

**修复（已落地）**：改为 `/^(.+?)\s{3}.+$/`（`\s` 同时覆盖 NBSP 与 ASCII 空白，与注释意图一致），并补了回归测试。

**顺带修掉（同一类「守卫与正则捕获组数不匹配」）**：`NexusPHP.ts:583-591` 的 `"html > body > title"` 过滤器用 `titleMatch.length >= 3` 判定、取 `titleMatch[2]`，而正则是 `/"(.+)" - Powered by NexusPHP$/`——**只有 1 个捕获组**，于是该分支永假、`<title>` 兜底永远返回带 `- Powered by NexusPHP` 的原始串（实测 `match.length === 2`）。

### B-3　Avistaz 列表页 torrent id 只取一位数字（同文件另一处是正确的）

**位置**：`packages/site/schemas/AvistazNetwork.ts:253`，对照 `:286`

```ts
// listTorrentPageMetadata（种子列表页）:253
const torrentIdMatch = href.match(/\/torrent\/(\d)/);      // ← /torrent/12345/name → "1"
// listHistoryPageMetadata（历史/HR 页）:286
const match = href.match(/\/torrent\/(\d+)/);              // ← 正确写法
```

**后果**：Avistaz 网络 5 个站点（avistaz / animez / cinemaz / exoticaz / privatehd）列表页每一行的 id 都是首位数字，大量重复；`ITorrent.id` 是扩展级身份（`uniqueId = ${site}-${id}`、`download.ts:317` 持久化 `torrentId`），于是不同种子会被合并/串号。失败时返回 `undefined`，而 `getFieldData:595` 会把它变成 `""`（非 nullish），使 `torrent.id ??= …`（`:795`）永远无法修复。

**修复**：`/\/torrent\/(\d+)/`，两处统一返回 `match?.[1] ?? undefined`。

### B-4　qBittorrent 单种下载限速打到不存在的端点

**位置**：`packages/downloader/entity/qBittorrent.ts:714`，对照同函数 `:723`

```ts
if (typeof limits.download !== "undefined") {
  requests.push(this.request("/torrents/setLimit", { … }));        // ← qBittorrent 无此路由
}
if (typeof limits.upload !== "undefined") {
  requests.push(this.request("/torrents/setUploadLimit", { … }));  // ← 同一函数里的正确命名
}
```

qBittorrent WebAPI 只有 `setUploadLimit` / `setDownloadLimit`（已在 master、release-4.6.0、release-4.1.0 三处核对，无 `setLimit`）。**后果**：MyClient → 批量限速设置下载限速时 404，`Promise.all` 拒绝 → UI 报失败；同时设两个方向时上传请求通常已成功，种子处于半配置状态。**修复**：`/torrents/setDownloadLimit`。

### B-5　Transmission 单种限速键名不存在 → 静默无效却报成功

**位置**：`packages/downloader/entity/Transmission.ts:630-646`，对照同文件 `:208-209, 261-262, 478-479`

```ts
// 同一文件自己的类型联合（正确写法）
| "downloadLimit" | "downloadLimited" … | "uploadLimit" | "uploadLimited"
// :478-479 addTorrent 里的正确用法
uploadLimit: options.uploadSpeedLimit * 1024, uploadLimited: true,
// :639-645 torrent-set 里的错误用法
args["upload-limit"] = limits.upload; args["upload-limited"] = limits.upload > 0;
args["download-limit"] = limits.download; args["download-limited"] = limits.download > 0;
```

`torrent-set` 只接受 `uploadLimit`/`uploadLimited`（Transmission 3.00 规范），Transmission 4/5 改名为 `upload_limit`/`upload_limited` 并**只枚举** camelCase 作为兼容别名（`api-compat.cc:246-247`），kebab-case 不在兼容表内。未知键被忽略且仍返回成功。**后果**：用户设置限速后下载器什么都不做，`setTorrentSpeedLimit` 返回 `true`，UI 显示成功。**修复**：改用 camelCase（与本文件 `addTorrent` 一致）。

### B-6　ruTorrent multicall 少剥一层 → 文件/Peers/Tracker 三个面板全是垃圾数据

**位置**：`packages/downloader/entity/ruTorrent.ts:202-207`，使用于 `:509`（文件）、`:570`（peers）、`:620`（trackers）

```ts
// :153-159 标量场景的解析器：下探了「两层」array
const dataNode = parsedXML.querySelectorAll("params > param > value > array > data > value > array > data > value");
// :202-207 multicall 场景只下探到 methodResponse params param value
const valueNode = doc.querySelector("methodResponse params param value");
…
const files = (Array.isArray(parsed) ? (parsed as XmlRpcValue[][]) : []) as XmlRpcValue[][];
return files.map((file, index) => {
  const [path, size, completedChunks, totalChunks, priority] = file as [...];   // ← file 是 wrapper，不是行
```

XML-RPC `system.multicall` 会把每个调用结果再包一层数组；同文件 `parseResponseXML` 下探两层正是这一事实的内部证据，而 `parseXmlRpcResponse` 少了一层。**后果**：`path` 变成整行数组（`String(path)` = 逗号拼接字段），`size`/`completedChunks` 为 `undefined` → `NaN`，且恰好返回一行假数据；peers 与 trackers 同形。**修复**：多剥一层（可复用 `Aria2.ts:193` 的 `unwrapMultiCallResult`）。

### B-7　ruTorrent label 与状态消息索引错位一位（同文件元组声明自证）

**位置**：`packages/downloader/entity/ruTorrent.ts:365`、`:400`

同文件元组注释声明的顺序（逐项计数）：`… get_chunk_size=13, torrent_label=14, peers_actual=15, … is_active=28, torrent_msg=29, torrent_comment=30 …`；其它索引的使用（`[23]` get_hashing、`[28]` is_active、`[24]`、`[5]`、`[6]`）**都与声明一致**，只有两处偏移：

```ts
const torrentMsg = rawTorrent[30];                       // 声明 torrent_msg = 29（30 是 torrent_comment）
label: decodeURIComponent(rawTorrent[15]),               // 声明 torrent_label = 14（15 是 peers_actual）
```

**后果**：`label` 变成 peer 数（`"0"`/`"5"`），下载器设置页的「目录/标签建议」对每个 ruTorrent 种子都给出数字标签；错误检测拿 `d.get_custom2` 去比 `"Tracker: [Tried all trackers.]"`，永远看不到真正的 `d.get_message`。**修复**：`[14]` 与 `[29]`。

### B-8　`getSearchSolution` 在 getter 内改写持久化 state，静默删除用户搜索方案里的站点

**位置**：`entries/options/stores/metadata.ts:248-263`（配合 `:180-201`、`:503-506`）

```ts
let solution = state.solutions[solutionId] as ISearchSolutionMetadata;   // ← state 活引用
for (const solutionItem of solution.solutions) {
  if (solutionItem.id === "default") {
    const searchEntries = await this.getSiteDefaultSearchSolution(solutionItem.siteId);
    if (searchEntries) { solutionItem.searchEntries = searchEntries; solutionItems.push(solutionItem); }
  } else { solutionItems.push(solutionItem); }        // 取不到就整条丢弃
}
solution.solutions = solutionItems;                   // ← 截断后的数组写回 store state
```

`getSiteDefaultSearchSolution` 在 `siteUserConfig.isOffline || siteMetadata.isDead` 时返回 `undefined`（`:186`）。该函数在**每次搜索开始时**被调用；随后防抖的筛选器 watcher 触发 `setLastSearchFilter` → `$save()` 落盘。**后果**：一次临时 `isOffline`（用户切换，或站点定义临时 `isDead`）就**永久**移除该站点在搜索方案中的条目，需手工重加；「复制方案」同样丢站点。**修复**：getter 内不改写 state，返回浅拷贝。

### B-9　消息层对非幂等 RPC 盲目重试一次（且判据过宽）

**位置**：`entries/messages.ts:338-341, 405-416`

```ts
return /message port closed|receiving end does not exist|could not establish connection|no response/i.test(message);
…
offscreenReadyPromise = null;
await ensureOffscreenReady();
return await original.sendMessage(type, data);   // 原样重发
```

双重问题：(1) 重发是 **at-least-once**——若 offscreen 已完成操作但在回包前被回收，`downloadTorrent` 会**再下一次**（`download.ts:383` 每次消息新铸 `downloadId`），产生重复下载 + 重复历史记录；(2) 判据含宽泛的 `no response`，**handler 内部抛出的错误**若文本命中该串，会被误判为连接错误并触发整段重试。**修复**：只对读路径自动重试；写路径引入幂等键（`site + torrent.id + downloaderId`）去重；删掉 `no response` 判据。

### B-10　`metadata`/`config` 存在第二个整对象写入者，"SW 是唯一写者"的前提不成立

**位置**：`entries/background/utils/base.ts:54-59`（注释断言）vs `extends/pinia/webExtPersistence.ts:57-58`

```ts
// base.ts：SW 侧串行化读改写
await enqueueWrite(async () => {
  const current = (await getExtStorageCached(key)) ?? {};
  setValueByPath(current, path, value);   // 就地改缓存对象
  await extStorage.setItem(key, current); // 整份写回
});
// webExtPersistence.ts：选项页 pinia 持久化直接整份写同一个 key，完全绕过 writeChain
await getUsableStorageArea(storage)?.set({ [key]: serialized });   // key = store.$id = "metadata"/"config"
```

**后果**：用户信息刷新（按站点多次 patch `lastUserInfo`）与用户在选项页改配置（整份 `$save()`）交错时，落在「缓存读 → setItem」窗口内的写会覆盖对方——**改动静默回滚**。窗口横跨一次结构化克隆 + `set` IPC，`metadata` 可达 MB 级。**修复**：pinia 持久化改走按路径读改写；或引入版本号 CAS + 冲突重试；至少修正 `base.ts:59` 这句已不成立的断言。

### B-11　下载历史读改写竞态：未 await 的 patch 与最终状态写入互相覆盖

**位置**：`entries/offscreen/utils/download.ts:491` vs `:623`（实现 `:659-670`）

```ts
patchDownloadHistory(downloadId, { addTorrentResult }).catch(…);   // :623 未 await
await setDownloadStatus(downloadId, downloadStatus);              // :491 紧接着
```

两者都是「读 history →（跨上下文消息往返）→ 写回」，窗口很宽。**后果**：历史记录可能永久停在 `downloading`（最终状态丢失）或丢失 `addTorrentResult`。**修复**：对同一 `downloadId` 的 patch 串行化，或把读改写放进一个 IndexedDB 事务。

### B-12　`cancelUserInfoQueue` 让已入队任务永久悬挂 → 刷新轮次永不返回、锁不释放

**位置**：`entries/offscreen/utils/userInfo.ts:64-66, 72`、`background/utils/alarms.ts:284-359`

`p-queue@9.3.3` 的 `clear()`（`node_modules/p-queue/dist/index.js:477-498`）直接 `this.#queue = new this.#queueClass()` **丢弃队列且不 settle 被丢弃任务的 promise**（源码注释只承诺 `empty`/`idle` 事件）。于是 `await flushQueue.add(...)`（`userInfo.ts:72`）永不 settle。

**触发**：点「刷新全部」→ 10 分钟自动刷新任务排在后面 → 用户点取消 → 所有排队任务被丢弃 → SW 侧 `await sendMessage("getSiteUserInfoResult", siteId)` 永不返回 → `try/finally` 到不了 `releaseLock` → `userInfoAutoFlushLock` 一直占着直到 30 分钟 TTL 过期，期间每轮定时任务都只打印 "already running, skip"。**修复**：不要用 `clear()`，自行跟踪在途任务并在取消时以 `AbortError` reject；给 SW 侧 await 加超时兜底。

### B-13　搜索方案不存在/站点已删除时必抛 TypeError（调用方兜底是死代码）

**位置**：`entries/options/stores/metadata.ts:248-250` 与 `:183-186`

```ts
// :248 —— 无 if (!solution)
let solution = state.solutions[solutionId] as ISearchSolutionMetadata;
for (const solutionItem of solution.solutions) {
// :183/:186 —— 同一函数里可选链与裸解引用混用（:191 用了 siteUserConfig?.merge?.searchEntry）
const siteUserConfig = state.sites[siteId];
if (siteUserConfig.isOffline || siteMetadata.isDead) { return; }
```

调用方明确处理了「不存在」（`SearchEntity/utils/search.ts:230-235` 的提示、`SetSearchSolution/Index.vue:277` 的 guard）——**两者都不可达**。而 `removeSite`（`:374-384`）只做 `delete this.sites[siteId]`，**不级联清理** `solutions[*].solutions` 与 `lastUserInfo`。

**复现**：添加站点 X → 建含 X 的方案 → 删除 X → 运行该方案 → TypeError，整次搜索中断。第二路径是水合竞态：右键菜单深链到 `#/search-entity?…&flush=1`，而搜索链路**没有** `await metadataStore.$onReady()`（对照 `MyData/utils/lastUserData.ts:57` 等了）。**修复**：`state.sites[siteId] ?? {}`、补 `if (!solution) return undefined`、`removeSite` 级联清理、搜索链路补 `$onReady()`。

### B-14　高级筛选：转义方案被解析库反向破坏（含空格/逗号/冒号的值永不匹配）

**位置**：`entries/options/directives/useAdvanceFilter.ts:67-99`

**证据（用同一版本 `search-query-parser@1.6.0` 复现）**

```
raw="hello world"  escaped="hello\u0020world"  query="hello\u0020world text:hello\u0020world"
                   parsed="hellou0020world"    unescaped="hellou0020world"   OK=false
raw="My Sites"     → parsed="Myu0020Sites"     OK=false
raw="a,b"          → parsed="au002cb"          OK=false
```

库在 `parse` 时剥离反斜杠（`val.replace(/\\(.?)/g, …)`），于是 `unEscapeQueryValue` 用来匹配的 `\u00XX` token 永远匹配不上。**后果**：可稳定复现——「设置 → 站点」把分组命名为 `My Sites`，点该分组筛选 → 生成 `userConfig.groups:My\u0020Sites` → 重新解析为 `Myu0020Sites` → **表格零行命中，而复选框仍是勾选状态**。**修复**：删掉自研转义，或改用 `"…"` 引号方案。

### B-15　`boolean` 格式化基于真值判断，`isOffline:0` 往返成 `isOffline:1`

**位置**：`entries/options/directives/useAdvanceFilter.ts:59-62`

```ts
boolean: { parse: (value: string) => (value ? "1" : "0"),
           build: (value: boolean) => (value ? "1" : "0") },
// 已复现：parse("0") === "1"    build("0") === "1"   ← 字符串 "0" 是真值
```

该格式用于 `userConfig.isOffline | allowSearch | allowQueryUserInfo`（`SetSite/Index.vue:107-109`）。`buildFilterDictFn` 会把已解析值再经 `parse` 归一化，于是用户输入 `userConfig.isOffline:0` 被改写为 `:1`——**筛选语义反转**。`SetSite/Index.vue:202-205` 里写死 `"1"` 的绕行只是掩盖症状。**修复**：显式判断 `v === true || v === "1" || v === "true"`。

### B-16　正则缓存复用带 `g` 标志的实例 → 筛选结果「隔一行命中一次」

**位置**：`entries/options/directives/useAdvanceFilter.ts:80-81, 101-132`

`regexLiteralPattern` 允许 `gimsuy`（含 `g`/`y`），而 `regexCache` 每个 pattern 只存一个实例并被 `regex.test()` 反复使用。**已复现**：`/1080p/g` 复用于 `["a1080pb","c1080pd","e1080pf","g1080ph"]` → `true, false, true, false`（期望全 true）。**后果**：用户输入正则字面量时约一半匹配行消失，且因缓存是模块级、跨表格共享，表现依赖历史调用顺序。**修复**：缓存前剥掉 `g`/`y`。

### B-17　Cloudflare 重试会丢掉 DNR 注入的请求头（`Referer`/`Origin`/`User-Agent`）

**位置**：`extends/axios/replaceUnsafeHeader.ts:167-180, 222-236` + `extends/axios/retryWhenCloudflareBlock.ts:138-145`，注册顺序见 `packages/site/utils/adapter.ts:25`

**证据（我用真实 axios 实测了拦截器顺序）**

```
响应拦截器执行顺序: req:cfRetry -> req:replaceUnsafeHeader -> res:replaceUnsafeHeader(releaseDnrRule) -> res:cfRetry(REJECT)
=> 确认：releaseDnrRule 先于 CF 重试执行（重试时 DNR 规则已被移除）
```

axios 的 request 拦截器用 `unshift`（逆序）、response 拦截器用 `push`（正序）；`setupReplaceUnsafeHeader` 先注册，故其 response 拦截器先跑并 `releaseDnrRule`。而请求拦截器早已 `config.headers.delete(key)`，重试复用同一 config（`mergeConfig` 从已剥离的 headers 重建），因此重试时 `requestHeaders.length === 0`，不装任何规则。

**后果**：重试请求**不带** `Referer`/`Origin`/`User-Agent`，与首次请求不是同一个请求；受影响站点 `gtnet.ts:249`、`mteam.ts:673`、`huno.ts:552`、`bangumi.ts:140`。**修复**：把原始头集合保留在 config 上（如 `config.unsafeHeaders`），每次尝试重建 DNR 规则；或把 DNR 安装移出请求拦截器，改为在重试耗尽后才释放。

### B-18　`fixAllStoredUserInfo` 绕过写链与缓存失效（数据修复可能被自己回滚）

**位置**：`entries/background/utils/fixer.ts:51-76`

`extStorage.setItem("userInfo", fixedUserInfoData)` **不走 `enqueueWrite`、不同步失效 `storageReadCache`**，而 `onInstalled`（`main.ts:20`）与两个 `immediate: true` 定时任务（`alarms.ts:364-370,435-441`）在同一个 SW 启动里注册，会并发执行。**后果**：修复写与 `patchExtStoragePathLocal("userInfo", …)` 互相覆盖；且 `setItem` 到 `onChanged` 到达的窗口内，其它读路径拿到**修复前**的旧对象。**修复**：改走 `enqueueWrite` + `invalidateStorageReadCache`。

### B-19　`runtimeStore` 在内容脚本里读写**宿主页面**的 `sessionStorage`

**位置**：`entries/options/stores/runtime.ts:27, 47-53, 55-68, 80-84, 141-142`；被 `content-script/app/App.vue:11,21` 与 `app/utils.ts:8,109` 引用

```ts
const RUNTIME_STORE_KEY = "__ptd_runtime_store";   // 注释自承「可能会在 content-script 中注册」
function getSessionStorage(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}
const restoredState = restoreState();              // 模块求值期执行
const parsed = JSON.parse(raw) as Partial<…>; return parsed && typeof parsed === "object" ? parsed : {};
```

内容脚本与宿主页面共享同一 `window.sessionStorage`。**后果**：(1) 页面可读取扩展持久化的内容，包括 `search.searchKey`（来自解析出的种子标题/关键词），而这些值还会流入下载器保存路径/标签替换；(2) 页面可在内容脚本加载前**预置**该 key 注入任意 JSON——`restoreState` 只校验 `typeof === "object"`。**修复**：内容脚本实例改为纯内存（web scheme 下跳过持久化/恢复），并做形状校验。

### B-20　站点定义 / 共享工具的数据错误（会静默削弱等级与筛选判断）

| # | 位置 | 问题 | 后果 |
| --- | --- | --- | --- |
| a | `definitions/beyondhd.ts:51` 与 `:87`；`definitions/ptskit.ts:37` 与 `:48` | `category[]` 中两项声明同一个 `key`（`types` / `cat`） | UI 状态、保存的方案、`v-for :key` 全部以 `category.key` 为键（`SetSearchSolution/utils.ts:47,86`、`SiteCategoryPanel.vue:36,93`），后项**静默覆盖**前项；`types/search.ts:209` 明文规定「单个站点中大类的 key 不能重复」。beyondhd 的 `Type`（UHD/BD）与 `Internal` 互斥；ptskit 的「综合」与「十八禁」两组共用一个数组，勾选一组会清掉另一组——而两者正是该站 `#url` 双入口设计所需要的 |
| b | `definitions/desigaane.ts:41` | `uploaded: "10B"`，旁边留着模板注释 `// 例如 "20GB"` | `sizePattern`（`filesize.ts:1`）要求 `[ZEPTGMK](B\|iB)`，**已复现** `"10B"` 不匹配 → `parseSizeString` 返回 0 → `level.ts:108-114` 的上传量要求**静默失效** |
| c | `definitions/aidoruonline.ts:278` `"P20H"`；`definitions/onlyencodes.ts:203` `"P2D7H33M20S"` | 非法/不完整 ISO-8601 | `convertIsoDurationToDate`（`datetime.ts:146-151`）的正则**未锚定且所有 group 可选**。**已复现**：`"P20H"` 匹配成功但所有 group 为 null → 零时长（应为 `PT20H`）；`"P2D7H33M20S"` 只取到 2 天，时分秒静默丢弃（应为 `P2DT7H33M20S`） |
| d | `definitions/novahd.ts:45/48`（WiKi=4/beAst=4）、`okpt.ts:206/213`（英字=58/说唱=58）、`xdypt.ts:91/103`（WiKi=16/OurTV=16）、`xdypt.ts:92/104`、`tu88.ts:35/36` | 同一分类内 option `value` 重复 | `cross.mode:"append"` 把 value 拼进请求键，选第二项实际按第一项的 id 过滤；`a-checkbox-group` 还会让两个同值项一起点亮。novahd 的 id 序列 1..15 中只有 7 空缺，强烈暗示 `beAst` 应为 7 |
| e | `definitions/orpheus.ts:137`、`redacted.ts:142`（`uniqueGroups`）、`secretcinema.ts:141,149,157`（`percentile`）、`piggo.ts:84`（`downgrade`），全仓库共 21 处 | `levelRequirements` 里引擎**从不求值**的键 | **已确认**（`grep` 全仓库仅出现在定义内，`utils/level.ts:101-231` 只交集固定键表）。`getNextLevelUnMet` 驱动的「等级达成」判断（`UserLevelRequirementsTd.vue:51,111,171`）因此把这些门槛当作已满足，且永不展示 |
| f | `definitions/hdsky.ts:414` | `store(...).catch()` **不带处理函数** | `.catch()` 不吞异常，派生 promise 仍 unhandled rejection（341 个定义中唯一一处） |
| g | `definitions/crabpt.ts`（DTS-HD/FRDS/WiKi/ZmWeb/QHstudIo 各有两条同名项）、`freefarm.ts:124-127`（四个都叫 `待定`） | 同一分类内选项**重名** | 用户无法区分；value→name 用 `.find()` 反查，保存的方案会显示错标签 |
| h | `fsm.ts:272`、`gazellegames.ts:251`、`generationfree.ts:207`、`milkie.ts:138`、`mteam.ts:672`、`yemapt.ts:366`、`hdbits.ts:329/330/353` | `this.userConfig.inputSetting!.token ?? ""` | 非空断言让 `?? ""` 成为**死代码**；`inputSetting` 缺失时直接 TypeError，而非同批定义（`beyondhd.ts:611`、`huno.ts:543`）那样的「提示用户填写 API Key」 |
| i | `definitions/zhuque.ts:320` | `const csrfToken = retrieveStore(…)` **缺 `await`**（`adapter.ts:61` 是 `async`） | Promise 恒为真值 → `storeRuntimeSettings` 把 Promise 持久化（序列化为 `{}`）→ 后续每次会话取到 `{}`（真值）→ 每个请求都发 `x-csrf-token: [object Object]`，真 token 再不重取。变量遮蔽（内层 `const csrfToken`）掩盖了该错误 |
| j | `definitions/tokyopt.ts:5,8,23-127` | `//...SchemaMetadata` 与整个 `category` 块被注释，URL 却已更新到存活域名（`urls: ["uggcf://…"]` 经 ROT13 解码为 `https://www.tokyo-manga.top/`），且**无 `isDead`** | `checkSiteMetadataAllow`（`index.ts:66-71`）要求非空 `search` → `allowSearch = false` → 该站点从所有搜索入口消失，分类面板显示「该站点未定义搜索模块」 |

**修复优先级**：a、b、c、i 优先。其中 **c 是共享工具缺陷**——`convertIsoDurationToDate` 应收紧为锚定正则 + 要求至少一个有效字段，非法输入显式抛错；`parseSizeString` 同理，不匹配时应告警而非静默返回 0。

### B-21　中文时长单位缺 `小时`/`个月` → 做种时长被静默截断，甚至把**字符串**写进数值字段

**位置**：`packages/site/utils/datetime.ts:31-34`（单位表）、`:50-56`（正则构造）→ `parseTimeToLiveToSeconds`(`:63-87`) → `parseTimeToLiveToDate`(`:89-93`) → `filter.ts:165,179,190-193` 的 `parseTTL`/`parseDuration`/`parseFuzzyTime`

```ts
months: ["個月", "月", "month", "mo", "M"],   // ← 缺简体 "个月"
hours:  ["小時", "时", "hour", "hr", "h"],    // ← 缺简体 "小时"
// 正则要求单位紧跟在 (\d+) 之后，故两字简体形式永不匹配：
new RegExp(`(\\d+)\\s*(${unitConvArr.join("|")})`, "g")
```

**证据（我逐字复刻单位表与正则后实测，与报告数值完全一致）**

```
"1天2小时"        -> 86400      （应为 93600，2 小时被丢弃）
"1天2小时30分钟"   -> 88200      （应为 95400）
"5小时"           -> "5小时"     ← 返回原始字符串，不是数字！
"1个月"           -> "1个月"     ← 返回原始字符串
"1个月5天"         -> 432000     （月份被丢弃）
"2h30m"           -> 1800       （应为 9000，"2h" 被 (?=\s|$) 先行断言拒绝）
--- 繁体形式（唯一被测过的写法）全部正确 ---
"1天2小時" -> 93600    "5小時" -> 18000    "1月5天" -> 3024000
```

**为何危险**：`parseTimeToLiveToSeconds` 只要**任一**单位匹配就置 `parsed = true`，于是「部分匹配」返回的是**数值错误的数字**而非原始字符串——静默给出错值，比报错更难发现。而完全无单位可匹配时会把**字符串**原样返回，直接流进 `IUserInfo.seedingTime`/`averageSeedingTime`/`torrent.time` 等数值字段，污染 `level.ts:205-217` 的等级比较与 MyData 展示。

**可达性（内部证据）**：`definitions/speedapp.ts:452` 写了 `filters: [{name:"replace", args:["个",""]}, {name:"parseDuration"}]` —— 这个「把 `个` 去掉」**正是作者在单个站点上打的同一个 `个月` 补丁**，只是没回移到共享单位表；而 `小时` 连这样的站点级补丁都没有。另有 `definitions/starspace.ts:69`（中文站「星空」，`timezoneOffset: "+0800"`）走 `parseTTL`。`tests/packages/site/utils/datetime.test.ts:30,44` 只覆盖 `小時`/`個月`，因此 CI 全绿。

**修复**：补齐 `"小时"`、`"个月"`、`"週"`、`"日"`，并把每个数组**按长度降序**排列以保证最长匹配优先；补「1天2小时30分钟」「1个月5天」断言**数值**的回归测试。

### B-22　`setValueByPath` 允许 `__proto__` 污染 `Object.prototype`（本工作树引入的回归）

**位置**：入口 `packages/site/utils/adapter.ts:41-46`（`store()`）→ sink `entries/shared/storagePath.ts:31-47`；同类问题见 `packages/site/utils/helper.ts:173`

**证据（我逐字复刻该函数后实测）**

```
setValueByPath({}, ['sites','__proto__','runtimeSettings','x'], 1)
   -> Object.prototype.runtimeSettings = {"x":1}
   -> 任意对象都继承到该属性：({}).runtimeSettings === {"x":1}
setValueByPath({}, ['__proto__','polluted'], 'yes')
   -> ({}).polluted === "yes"

对照：es-toolkit 的 set（重构前的写法）
   set({}, 'a.__proto__.leak', 'x')  ->  ({}).leak  === undefined   （安全）
   set({}, '__proto__.leak2', 'x')   ->  ({}).leak2 === undefined   （安全）
```

**成因**：`cursor["__proto__"]` 取到的是 `Object.prototype`，它**本身就是对象**，于是 `:40` 的守卫 `typeof cursor[key] !== "object"` 不成立、不做替换，下一段 key 就写到了全局原型上。（注：`constructor.prototype` 路径**不可用**——`Object.prototype.constructor` 是函数，会命中 `typeof !== "object"` 分支被替换成新对象，我也实测确认了这一点。）

**为何算回归**：`adapter.ts:33` 的注释声称「`field`/`key` 是代码内常量（不是用户输入），因此直接拼接路径是安全的」——但这只是注释，不是代码约束。`siteId` 与导出的 `store(siteId, key: string, …)` / `retrieveStore(store, keyPath: string)` 参数都没有约束，而 `patchExtStoragePath` 是对所有扩展上下文开放的 `onMessage` handler。当前所有调用点传的都是字面量或 `this.metadata.id`（我已核对），**因此目前无法构造端到端远程利用链**——这是一个**本轮工作树新引入的潜在原语**：旧实现用的 `es-toolkit set` 本身免疫。

**修复**：在 `setValueByPath`/`removeValueByPath` 中跳过 `__proto__`/`constructor`/`prototype` 段（或用 `Object.create(null)` 作容器）；`helper.ts:171-174` 同样处理。

### B-23　`parseTimeWithZone` 静默忽略类型合法的偏移写法 → 时间戳按「宿主机时区 vs 站点时区」偏移

**位置**：`packages/site/utils/datetime.ts:134`（正则 `^(?:UTC)?([+-])(\d{1,2})(\d{2})$`），类型声明在 `:3`（`${"UTC"|""}${"-"|"+"}${number}`）

**证据（宿主机为 `America/New_York`，`2024-03-01 10:00:00 +0800` 的真值应为 `1709258400000`）**

```
"+0800"    -> 1709258400000  ✓
"UTC+0800" -> 1709258400000  ✓
"+8"       -> 1709305200000  ✗ 偏 13 小时
"UTC+8"    -> 1709305200000  ✗
"+08:00"   -> 1709305200000  ✗
```

正则失配时 `offsetSign` 为 undefined，`result` 保持原始字符串，`+new Date(result)` 便以**扩展宿主机的本地时区**解释站点墙上时间——静默且随宿主机变化。声明类型允许 `"UTC+8"`/`"+8"`，而 `tests/packages/site/utils/datetime.test.ts:95` 还用「不会静默算错偏移」这一**错误论断**把该行为锁定进测试。当前所有定义与 UI（`SetSite/Editor.vue:112-135`）都用 `±HHMM`，故属手写定义时的陷阱。

**修复**：把偏移规范化/校验后再用——接受 `([+-])(\d{1,2}):?(\d{2})?`（缺分钟按 `00`），或在无法识别时记日志并拒绝；同时修正该测试标题。

### B-24　单字符单位的先行断言破坏紧凑时长写法（`2h30m` → 1800 秒）

**位置**：`packages/site/utils/datetime.ts:55`（`${str}(?=\\s|$)`），消费于 `:56`、`:77-84`

**证据（已复现）**

```
"2h30m"              -> 1800   （应为 9000：'2h' 因 'h' 后面紧跟 '3' 而被先行断言拒绝）
"2h 30m"             -> 9000   ✓
"2 hours 30 minutes" -> 9000   ✓
```

先行断言本意是避免在单词内部误匹配单位，但同时也拒绝了任何紧凑写法；由于**有**单位匹配成功，函数返回的是错误数字而非原始字符串。仓库测试只覆盖空格分隔形式（`datetime.test.ts:43-45`）。

**修复**：把 `h(?=\s|$)` 换成 `h(?![A-Za-z])` 之类「后面不接字母」的边界；补 `"2h30m"`、`"1D2h"` 用例。


### B-25　【CRITICAL】`loadAllAddedSiteMetadata` 在任一站点元数据加载失败时**永不 settle**，死锁 MyData / 时间线 / 统计三个页面

**位置**：`entries/options/views/Overview/MyData/utils/siteMetadata.ts:26-60`；调用方 `MyData/utils/lastUserData.ts:30,60`、`UserDataTimeline/Index.vue:245`、`UserDataStatistic/Index.vue:382`

**证据（已核验）**

```ts
await Promise.allSettled(
  loadSites.map((siteId) => {
    return new Promise<void>(async (resolve) => {        // ← async executor
      if (!allAddedSiteMetadata[siteId]) {
        const siteMetadata = await getCachedSiteMetadata(siteId);   // :32 可 reject
        const siteFaviconUrl = await sendMessage("getSiteFavicon", { site: siteId }); // :33 可 reject
        …
      }
      resolve();
    });
  }),
);
```

**为何是死锁**：`new Promise` 构造函数**忽略 executor 的返回值**。executor 是 async 函数，一旦 `:32`/`:33` 抛错，它返回的那个 rejected promise 无人观察，而 `resolve()` 永远不会被调用——外层 promise **永不 settle**。`Promise.allSettled` 能防的是「reject」，恰恰**防不了「永不 settle」**，所以 `await loadAllAddedSiteMetadata(...)` 会永久挂起。

**触发**：`getCachedSiteMetadata` → `getDefinedSiteMetadata` 对「已不在构建产物里的站点定义」会抛 TypeError——而持久化的 `metadataStore.sites` 里**没有任何逻辑清理失效站点 id**；任一 `getSiteFavicon` 的 rejection 同样触发。

**后果**：`lastUserData.ts:89` 的 finally 永不执行 → MyData 表格永久转圈；`UserDataTimeline/Index.vue:268`、`UserDataStatistic/Index.vue:420` 的 finally 永不执行 → 永久骨架屏；`updatePerSiteData`（`lastUserData.ts:30`）等待同一 loader，导致 `flushSiteLastUserInfo` 的 `.finally`（`:115`）永不重置 `flushPlan[site]` → 每行的刷新按钮永久转圈。

**修复**：去掉 `new Promise(async …)` 包裹，改为 `loadSites.map(async (siteId) => { try { … } catch (e) { console.error(…); } })`，让每个映射出的 promise 都必然 settle。

### B-26　时间线「总分享率」在总下载量为 0 时是 `-1 + Σ各站分享率`（**更正我此前的错误结论**）

**位置**：`entries/options/views/Overview/MyData/UserDataTimeline/utils.ts:147`、`:36-39`（字段表含 `ratio`）、`:203`、`:219-222`

**证据（已核验）**

```ts
totalInfo: { … ratio: -1 },                                  // :147 初值 -1
for (const userInfoField of CTimelineUserInfoField) {        // :38 含 { name: "ratio", … }
  … result.totalInfo[userInfoKey] += value;                  // :203 逐站累加
}
if (result.totalInfo.downloaded > 0) {                       // :220 仅此条件内覆盖！
  result.totalInfo.ratio = result.totalInfo.uploaded / result.totalInfo.downloaded;
}
```

**后果**：当所有展示站点的下载量合计为 0（守卫不成立）时，表头（`:401` → `realFormatRatio`）显示的是 `-1 + Σ(各站 ratio)`：单站 ratio 2.5 → 显示「1.50」；两站 0.5 + 0.2 → 显示**负数**「-0.30」。此时正确的值应是 `∞`。

**我在本次审查中先判错了这条**：我只确认了 `downloaded > 0` 守卫**存在**，就据此把它写进了「已排除的误报」——**没有检查守卫为假的分支**。教训：「守卫存在」不等于「无守卫时行为正确」。已在 §7.13 与 §8 标注更正。

**修复**：让 `ratio` 不参与累加循环，只由总量推导：`downloaded > 0 ? uploaded/downloaded : uploaded > 0 ? Infinity : -Infinity`。

### B-27　历史数据弹窗无过期响应守卫 → 可显示 A 站数据却在 B 站上执行删除

**位置**：`entries/options/views/Overview/MyData/HistoryDataViewDialog.vue:61-71`（加载）、`:73-80`（删除）

```ts
async function loadHistoryData() {
  if (!siteId) return;
  isLoading.value = true;
  try {
    const data = await loadSiteHistoryData(siteId);
    siteHistoryData.value = data;        // ← 无 siteId 是否变化的校验
    tableSelected.value = [];
  } finally { isLoading.value = false; }
}
async function deleteSiteUserInfo(date: string[]) {
  …
  sendMessage("removeSiteUserInfo", { siteId: siteId!, date: date.filter((d) => d != currentDate) })
```

**后果**：弹窗实例是复用的（`MyData/Index.vue:722`）。打开 A（请求在途）→ 关闭 → 打开 B 发起第二个请求，两个响应可能交错，A 的行数据最后落地而标题/siteId 已是 B。此时删除/导出会以 **B 的 siteId + A 的日期**调用 `removeSiteUserInfo`——**销毁 B 站这些日期的记录**（仅「今天」被过滤保护）。

**修复**：`const requested = siteId;` 并在赋值前 `if (requested !== siteId) return;`。

### B-28　三个 EditDialog 的浅拷贝让「取消」失效，并逐键把凭据写进 metadata store

**位置**：`Settings/SetMediaServer/EditDialog.vue:21`、`Settings/SetBackup/EditDialog.vue:21`、`Settings/SetDownloader/EditDialog.vue:21`

```ts
clientConfig.value = { ...metadataStore.mediaServers[clientId] };   // 防止直接修改父组件的数据
```

**证据（已核验）**：展开只复制**顶层**，`auth`/`config`/`feature`/`advanceAddTorrentOptions` 仍与 store 中**同一对象身份**（pinia 深层响应式，`ref()` 保留既有代理）。子编辑器直接 `v-model` 绑到嵌套路径：

- `SetMediaServer/Editor.vue:113,119` → `clientConfig.auth[authField]`
- `SetBackup/Editor.vue:235,240,244` → `clientConfig.config[key]`
- `SetDownloader/Editor.vue:155,169,186` → `clientConfig.feature!.X`、`clientConfig.advanceAddTorrentOptions![opt.key]`

**后果**：在编辑框里每敲一个字符都会改写 `metadataStore.mediaServers[id].auth.apikey` / `backupServers[id].config.loginPwd`；**「取消」不会回滚**；列表页下一次 `simplePatch`（`SetMediaServer/Index.vue:133` 的开关）会 `await this.$save()`（`metadata.ts:356-358`）把半途输入的密钥落盘。对照：`SetSearchSolution/EditDialog.vue:123` 用的是 `cloneDeep`，**同一代码库里已有正确写法**。

**修复**：改用 `cloneDeep`；同时删掉那句与实际行为相反的注释。

### B-29　MyClient 表格只用 `record.id` 作行 key，跨下载器撞键 → 删除/暂停可能打到另一个客户端

**位置**：`Overview/MyClient/Index.vue:486-487`（而正确写法已存在于同文件 `:338`）

```ts
:row-key="(record: any) => record.id"
:row-selection="{ selectedRowKeys: tableSelected.map((item) => item.id), onChange: onSelectionChange }"
// 同文件 :338 已经定义并使用了复合 key（仅 DeleteDialog 用到，见 :675）
function torrentKey(torrent: CTorrent) { return `${torrent.clientId}:${String(torrent.id)}`; }
```

数据源是 `active.flatMap((id) => torrents.value[id] ?? [])`（`:141`），而 qBittorrent 的 id 就是 info hash（`downloader/entity/qBittorrent.ts:595`），同一个种子存在于两个下载器时产生两行同 key。antd 的 key map 只保留最后一个（`es/table/hooks/useLazyKVMap.js:13`），`onSelectionChange` 又按 key 反查（`es/table/hooks/useSelection.js:151`），于是勾选第一行会把**另一个下载器**的 `CTorrent` 放进 `tableSelected`，两个复选框还会联动。所有动作随后都发错 `clientId`——尤其 `DeleteDialog` 传 `removeData`（`:313-321`、`MyClient/DeleteDialog.vue:37`），**「删除并删除数据」可能抹掉用户并未选择的那个客户端上的文件**。

**修复**：表格统一使用已有的 `torrentKey`（`:row-key="torrentKey"`，`selectedRowKeys: tableSelected.map(torrentKey)`）。

### B-30　TorrentDetailDialog 关闭后才到达的响应会重新「武装」`*Loaded`，下次打开显示上一个种子的数据

**位置**：`Overview/MyClient/TorrentDetailDialog.vue:100/104`（files）、`:143/150`（trackers）、`:130/134`（peers）、`:194-204`（`resetDialog`）、`:255`（`:after-close`）、`:213-215`（open watcher）

`resetDialog()` 会把 `trackers/files/peers` 清空并置 `*Loaded = false`，但**没有任何机制取消在途请求**。若响应在 `after-close` 之后到达，迟到的 `.then` 会重新填充数据并把 `trackersLoaded` 置回 `true`；下次为种子 B 打开时，`afterEnter → loadTrackers()` 因这个陈旧的 `true` 直接 early-return，于是 Tracker 页签在 B 名下显示 A 的 tracker。更严重的是 `removeTracker(record)`（`:175-192`）会发出 `{downloaderId: B.clientId, torrent: B, url: A.url}`——**从 B 上移除一个属于 A 的 tracker URL**；文件列表的 `updateFilePriority` 同理使用陈旧的 `record.index`。

**修复**：在 `resetDialog()` 里自增 epoch，赋值前校验 `if (epoch !== loadEpoch || !showDialog.value) return;`；或把「已加载」标记改为按种子身份（`loadedFor.value === torrentKey`）。

### B-31　凭据在明文输入框中显示 / 被 console 打印活对象（多处）

| # | 位置 | 问题 | 后果 |
| --- | --- | --- | --- |
| a | `Settings/SetMediaServer/Editor.vue:112-121` | fnOS 的 `username`/`password`、emby/jellyfin/plex 的 `apikey` 用无 `:type` 的 `<a-input>` | 凭据明文显示且编辑后仍可见，无显示切换——而这些 token 可完全访问用户的媒体库。对照：`SetDownloader/Editor.vue:120-129` 实现了明文/掩码切换，`SetBase/BackupWindow.vue:41-45`、`SetBackup/RestoreDialog.vue:274` 也做了掩码 |
| b | `Settings/SetBackup/Editor.vue:238-241` | `metaField.type === "string"` 一律渲染为无 `:type` 的 `<a-input>`，而该类型覆盖 `WebDAV.loginPwd`、`S3.secretAccessKey`、`CookieCloud.password`、`Gist/DropBox.access_token`、`GoogleDrive.client_secret/refresh_token`、`OWSS.authCode`、`BackblazeB2.applicationKey` | 每个云存储凭据都明文显示；一次截图/屏幕共享即泄露备份桶的写权限 |
| c | `Settings/SetSite/Editor.vue:241` | `siteUserConfig.inputSetting![name]` 为普通 input；字段名来自站点定义（`hdbits.ts:318 passkey`、`rousipro.ts:245 passkey`、`beyondhd.ts:466 apikey`、`sunnypt.ts:54 apiKey`、`mteam.ts:504`/`fsm.ts:204`/`gazellegames.ts:216`/`yemapt.ts:314 token`） | 站点 passkey 是扩展持有的最敏感凭据（可代替用户下载），却比相邻设置页的下载器密码保护更弱 |
| d | `Settings/SetBase/SocialInformationWindow.vue:89-97` | Bangumi API key 明文 | 同区域更早的 `BackupWindow.vue:41-45` 却做了掩码 |
| e | `Settings/SetDownloader/AddDialog.vue:55`、`SetMediaServer/AddDialog.vue:58`、`SetBackup/AddDialog.vue:44` | `console.log("storedXConfig", storedXConfig.value)` 打印的是**响应式代理本身**，而 DevTools 会长期持有其活引用；随后在同一个 `<Editor v-model>` 里输入的密码/apikey/云密钥，在展开那条旧日志时**全部可见**。生产构建未剥离 `console.*`（`vite.config.ts` 无 `esbuild.drop`/`pure_funcs`） | 凭据经由控制台泄露；注意 `SetMediaServer/AddDialog.vue:58` 的日志文本还写成了 `"storedDownloaderConfig"`——复制粘贴痕迹 |

**修复**：为凭据字段统一加掩码 + 显示切换（按字段名或给 `packages/backupServer/type.ts` 增加显式 `secret?: boolean`）；删掉这三条 `console.log`。



## 5. 中危

### 5.1 工程门禁

| ID | 位置 | 问题 | 后果 |
| --- | --- | --- | --- |
| Q-1 | `eslint-suppressions.json`（115 文件 / 257 条）、`eslint.config.mjs` | **实测对比**：`npx eslint .` → 0 error；`npx eslint . --suppressions-location <空文件>` → **252 error / 112 文件**（135 `no-console`、116 `@typescript-eslint/no-floating-promises`、1 `no-empty`）。抑制文件有 5 条/3 文件已失效，每次运行都会打印 `suppressions left that do not occur anymore`，说明**从未执行 `--prune-suppressions`** | `no-floating-promises` 是真实缺陷类别（SW 里未处理的 rejection 会静默丢失操作），116 处被永久豁免，CI 只拦新增 |
| Q-2 | `scripts/check-antd-migration.mjs` | **实跑 exit 1**：`classes-defined`（`content-script/app/App.vue` 命中 `configStore`）与 `antd-override-budget`（`.ant-*` 内部类 27 个 > 目标 24）失败；`grep -rn "check-antd-migration" package.json .github/workflows/ .husky/` → **无匹配** | 分支自定的「迁移完成」判据未达成，且**在 CI 中完全不可见**，正好抵消 `check-bundle-budget.mjs`（已接入 CI 且能红）建立的门禁文化 |
| Q-3 | `tests/` | **74 个测试文件中约 18-22 个（约 30%）断言源码文本**（`readFileSync` + `toMatch(/regex/)` 打在 `.vue`/`.ts` 源文件上），约 90 条断言。本次审查期间 14:54 的 5 个失败**全部**属于此类（源码被改后即红），而行为坏掉时它们照样绿 | 双向失效：重构即红、行为错不报 |
| Q-4 | `vite.config.ts:147-150`、`:68`、`.github/workflows/*.yml` | `web_accessible_resources` 把 `assets/*`+`vendor/*` 以 `matches:["*://*/*"]` 暴露给所有站点（含 751 KB 的 `pinia` chunk）；`skipManifestValidation: true` 关闭手写 manifest 校验；所有 action 都 pin 在可变 tag（`checkout@v7`、`upload-artifact@v7`、`ncipollo/release-action@v1` …）而 workflow 持有商店发布密钥 | 任何站点可 fetch 已知 URL 做**扩展指纹识别**（对 PT 用户群体是隐私问题）；发布链存在供应链风险。建议 WAR 改为构建期生成精确 chunk 清单、action pin 到 SHA |
| Q-5 | `scripts/check-bundle-budget.mjs:136` | `关键产物：${REQUIRED_ARTIFACTS.length - stillMissing.length}/…` —— firefox 目标下 `offscreen.html` 被有意豁免却仍计入「就位」 | 实测 9/10 却打印 `10/10`，门禁输出失真 |

### 5.2 生命周期 / 并发 / 资源

| ID | 位置 | 问题 | 后果 |
| --- | --- | --- | --- |
| L-1 | `offscreen/utils/download.ts:328, 391-421` | 每站点下载间隔 `lastSiteDownloadAt` **只在 offscreen 内存** | offscreen 被回收/重建后，每站点首次下载**完全绕过** `downloadInterval` 防轰炸保护；且时间戳在下载成功前记录，失败也消耗一次间隔 |
| L-2 | `background/utils/contextMenus.ts:596-618, 396-398, 523-534` | 只在 `tabs.onActivated` 重建菜单（**全仓库无 `tabs.onUpdated`/`webNavigation`**，已 grep 确认） | 同一标签内从站点 A 跳到 B 不重建；`lastBuiltContextKey` 命中即 return，点击回调仍持 A 的 `thisTabSiteId`，`$torrent.site$` 被替换成 A → 文件落到错误目录 |
| L-3 | `background/utils/alarms.ts:20, 49-74` | `USER_INFO_LOCK_TTL = 30min` 固定 TTL，而单轮串行刷新每站点 timeout 默认 30s | 60 个无响应站点 ≈ 30+ 分钟 → TTL 到期后另一轮次判定锁已废弃并**并发**启动第二轮，对所有站点重复认证请求 |
| L-4 | `background/utils/alarms.ts:100-117, 461-495` + `offscreen/utils/download.ts:405-416` | `pending`→`downloading` 推进依赖 alarm，但 Chrome 不保证 alarm 跨重启存活（代码注释自承） | 强杀/更新后历史记录永久停在 `pending`，既不重试也不标失败 |
| L-5 | `offscreen/utils/backup.ts:166-170`、`offscreen/utils/download.ts:571-585` | `URL.createObjectURL` 后 `backup.ts` **从不 revoke**；`download.ts` 只在成功路径 revoke | 本地备份（整包 config+metadata+userInfo，数 MB）每次都在 offscreen 内钉住一个 blob；下载失败路径泄漏种子 blob |
| L-6 | `offscreen/utils/download.ts:527-536` | `localDownloadMethod === "web"` 时在 offscreen 里 `window.open`，**不检查返回值**就标记 `completed` | offscreen 无用户激活，弹窗通常被拦截并返回 `null`，用户什么都没拿到却显示「已完成」 |
| L-7 | `offscreen/utils/logger.ts:53-88, 121-123` | 500 条环形缓冲 + 500ms 节流落盘 `sessionStorage`，但 `getLogger`/`clearLogger` **在 `src/` 内零引用**（日志查看器在 `a6993f1f` 被移除），**已 grep 确认无消费者** | 纯成本无收益；更严重的是 `download.ts:530/556/569` 记录完整下载 URL，而 `yemapt.ts:398` 的 URL 形如 `/api/torrent/download1?token=…` → **token 明文长期驻留 `sessionStorage`**（`rousipro.ts:323-324` 的注释已明确警示过这个坑） |
| L-8 | `background/utils/base.ts:92-136` | `getExtStorageCached` 按**引用**返回缓存对象，`setValueByPath` 就地改它；若 `setItem` 失败/SW 被杀，缓存已被污染且 `onChanged` 不会到达 | 后续 SW 读路径返回**从未落盘**的值，UI 展示不存在的状态 |
| L-9 | `extends/pinia/webExtPersistence.ts:225-262` | `applyMinimalPatch` 只删**一层**（代码注释自承），变更子对象走 `$patch` 深合并 | 恢复备份后，备份中不存在但本地存在的**孙级**字段不会被删除，并在下次 `$save()` 时写回——「恢复」实际没把配置变成备份的样子 |
| L-10 | `offscreen/utils/backup.ts:229-292` | 跨 5 个 storage key 逐个 `setExtStorage`，无事务/回滚（下载历史有原子替换且非法时**不清空**本机历史，做得很好） | 中途失败（配额、SW 被杀）留下「一半备份一半现状」的配置，无回滚、无失败清单 |

### 5.3 下载器客户端

| ID | 位置 | 问题 | 后果 |
| --- | --- | --- | --- |
| D-1 | `downloader/entity/Aria2.ts:260-266, 355-377, 302-309` | 不等 `WebSocket.OPEN` 就 `send()`（规范要求 CONNECTING 时抛 `InvalidStateError`）；`_handleWsClose` 不重连 | 新实例的**首个**请求必失败（`ping()` 吞掉异常，第二次测试才成功，从而掩盖问题）；关闭后 `send()` 被静默丢弃，后续请求全部挂到 30s 超时 |
| D-2 | `downloader/entity/Deluge.ts:778-792`（`:181` 声明了 `error` 却未用） | 忽略 JSON-RPC 响应体的 `error` 字段（deluge-web 以 HTTP 200 + `error` 报错） | 会话失效时 `Object.values(null)` → TypeError；`removeTorrent`/`pauseTorrent` 返回 `null` 被当作成功；用户看不到 "Not authenticated" |
| D-3 | `downloader/entity/qBittorrent.ts:384-386, 410-415` | `isLogin` 一旦成功永不复位，实例长期缓存，`request()` 无 401 处理（对照 `Flood.ts:167-177` 有 401 重登） | SID 超时（默认 3600s）后每个请求 401 且**无法自愈**，直到 offscreen 重建或配置变化 |
| D-4 | `downloader/entity/synologyDownloadStation.ts:392-397, 616-622` | `_sessionId` 永久缓存；`getTorrentsBy` 直接 `req.data.task.filter(...)` 不看 `success`（文件内注释的枚举已列出 105/106） | DSM 会话过期 → `Cannot read properties of undefined (reading 'task')`，且整个会话期持续故障 |
| D-5 | `downloader/entity/Transmission.ts:451-453` | `data.arguments["torrent-added"].id` 无保护，未处理 `torrent-duplicate` | 推送已在库中的种子 → TypeError → 历史记录标记**失败**（尽管 Transmission 返回 success），标签/限速后置设置被跳过 |
| D-6 | `downloader/entity/ruTorrent.ts:136-151, 210-225` | XML-RPC 请求体不做 `&`/`<`/`>` 转义，且 `setTorrentLabel` 硬编码返回 `true` | 标签含 `&` 等问题 → XML 解析 fault → 操作静默无效但 UI 报成功 |
| D-7 | `downloader/entity/ruTorrent.ts:292-299` | 空闲空间 URL `/rutorrent/plugins/diskspace/action.php` 与 `baseURL` 重复拼接（其它端点都是 `/plugins/...`） | 404；当前**潜伏**（`getClientFreeSpace()` 无调用方） |
| D-8 | `downloader/entity/synologyDownloadStation.ts:462-472` | 登录用 `params` 且无 `method` → axios 发 **GET**，账号密码进入 URL query | 凭据落入服务端/代理访问日志、Referer、历史（DSM 自身也这样调，且 `http.cgi` 支持 POST，故仅 LOW-MEDIUM） |

### 5.4 Schema 引擎

| ID | 位置 | 问题 | 后果 |
| --- | --- | --- | --- |
| E-1 | `AbstractBittorrentSite.ts:907-914` | `keywordField === "data"` 分支插值了 `keywordField`（字面量 `"data"`）而非 `keywordParams`，生成 `input[name="data"]` | 7 个用 `data.*` 的定义（`mteam`/`zhuque`/`yemapt`/`gtnet`/`beyondhd`/`hdbits`/`audionews`）在列表页**取不到关键词**；URL 回退看不到 POST 值，于是「在插件中搜索」以空关键词打开 |
| E-2 | `Gazelle.ts:741-747`（正确模式见 `NexusPHP.ts:935-941`） | `if (flushUserInfo.id && !flushUserInfo.seedingSize)` 缺 `status === success` 守卫，`getSeedingSize` 未包 try/catch | 基础抓取失败（needLogin/网络/CF）时 `id` 仍从 `pickLast` 保留，于是对**刚失败的站点**再发 1-50 个请求；抛错会逃出契约上「总返回 IUserInfo」的方法，调用方 `offscreen/utils/userInfo.ts:105` 无 try/catch → 只看到泛化失败提示。8 个 Gazelle 子类全部继承 |
| E-3 | `GazelleJSONAPI.ts:417-440` | `if (doc.status === "success") {...} return torrents;` —— `status: "failure"`（账号停用/ratio watch/限流）返回空数组 | 被当作 success + 0 结果，用户看到「无结果」，`error` 字符串被丢弃；`doc.response.results` 在缺 `response` 时还会抛 |
| E-4 | `NexusPHP.ts:1011-1014`（有守卫的同款代码见 `Gazelle.ts:430-436`） | `selectElements(...)[0] as HTMLElement` 后直接 `.innerText`，无保护 | `td:eq(N)` 对少列的行（colspan 表头/表尾）返回 `[]` → TypeError → **整次用户信息刷新失败**。Gazelle 的同一循环明确注释了这个失败模式并加了守卫——典型的「修了一处、没回移另一处」 |
| E-5 | `Luminance.ts:162-172` | `element.innerHTML.split("<br/>")` —— `innerHTML` 序列化 `<br>` 不带斜杠（同库 `NexusPHP.ts:504` 就用的是 `<br>`），split 永不生效 | `find()` 检查整段日志，正则取到任意一条 `\| N credits \|`；符号在捕获组之外，扣款行 `-500.0 credits` 会得到**正的** 500/24 → 错误的时魔值流入升级时间计算 |
| E-6 | `AvistazNetwork.ts:184-193, 555-561, 670-672, 687-689` | `mergeUserInfo` 吞掉所有请求错误 | 网络失败被误判为 `parseError`（且无 `statusMsg`），与「站点真的没有该数据」无法区分；其它实现都走 `classifySiteError` |
| E-7 | `Unit3D.ts:585-594`（请求 `:649-658`） | 可选的 `/earnings` 请求失败会跳到 catch，覆盖已成功解析的 status | `setSiteLastUserInfo` 仅在 success 时写当日历史 → **一个可选页面失败就丢掉整天的记录** |
| E-8 | `Gazelle.ts:472-491` vs `GazelleJSONAPI.ts:369,405` | 合成回退下载 URL 只带 `action=download&id=…`，**不含 `authkey`/`torrent_pass`**（JSON-API 版本刻意带了） | 走详情页 URL 的拖拽/推送场景下，Gazelle 返回登录页/HTML，跟随重定向的下载器会把 HTML 当种子存下 |
| E-9 | `AbstractBittorrentSite.ts:1002-1007` | 缺链接时先拼后缀再返回：``torrent.link = `${torrent.link}${downloadLinkAppendix}` `` | 产出字面量 `"undefined<后缀>"`，下游得到费解的 404（仅在用户配置了后缀且链接缺失时） |
| E-10 | `Gazelle.ts:66-67` | `const cell = row.querySelector(tdSelector); const clone = cell!.cloneNode(true)` —— 下一行的 `torrentLink` 有 null 守卫，`cell` 没有 | 单种子行按行吞掉（静默丢种子）；**group 行**在 `transformGroupTorrents` 的逐行 try/catch 之外，整页搜索 `parseError` |

### 5.5 选项页交互

| ID | 位置 | 问题 | 后果 |
| --- | --- | --- | --- |
| V-1 | `components/SentToDownloaderDialog/utils.ts:103-126` | 每项 `.catch(showSnakebar)` 包裹 → 解析为 `undefined`；`failedCount = status.filter(x => x?.downloadStatus === "failed").length` **恒为 0** | 全部失败时仍弹「成功发送 N 个任务到下载器」+ `color:"success"` |
| V-2 | `components/SentToDownloaderDialog/Index.vue:134-150` | `if (path) savePath = path` / `if (label) label = label` 仅在非空时赋值 | 先点 `/downloads/movies` 再点「默认路径」行，第二个种子仍进该目录并沿用上次标签 |
| V-3 | `components/SentToDownloaderDialog/utils.ts:50` + `Index.vue:127-131` | 用户取消 `<...>` 输入时 `return Promise.reject(...)`，调用方只挂 `.finally()` 无 `.catch` | `finally` 会执行（弹窗会关、`isSending` 会复位），但产生 **unhandled rejection**，且取消与成功在 UI 上无法区分。⚠️ 子审查原始结论称「异步 executor 导致弹窗卡死」——**经核验不成立**，executor 是同步的，已降级 |
| V-4 | `components/TorrentTitleTd.vue:65-72` | `sendMessage("getSocialInformation", …).then(…)` 无 `.catch`，且先写入 `{loading:true}`，重入守卫是 `!socialInformation[site]` | 请求失败后 popover **永久**停在 `Loading....`，悬停无法重试 |
| V-5 | `views/Overview/SearchEntity/utils/filter.ts:18` | `initialSearchValue: metadataStore.lastSearchFilter` 在**模块求值期**读取 | 「记住上次筛选」取决于懒加载 chunk 求值 vs storage 异步恢复的竞态，输了就静默丢失 |
| V-6 | `stores/metadata.ts:351-359` | `simplePatch` 在 `this[schemaKey][id]` 为 `undefined` 时 `set()` 静默 no-op，但**仍执行 `$save()`** | 另一标签已删除的行，编辑被静默丢弃，同时付出一次整状态写入 |
| V-7 | `stores/metadata.ts:361-441` + `components/DeleteDialog.vue:22` | `removeSite`/`addSite` 每次调用都重建整张站点映射（`getSiteName` → `cloneDeep` 每个站点）；批量删除用 `Promise.allSettled` 并发 | 删 50 个站点 ≈ 50 次全量重建（O(N²) 深拷贝）+ 50 次整状态 `$save()` → 秒级主线程卡顿，且最终 `siteHostMap` 取决于写入顺序 |
| V-8 | `extends/pinia/webExtPersistence.ts:443-493` | 每次字段开关都走 `toWriteSnapshot(getState())` 全量序列化 + 整 key 写入（`runtime.ts:1-24` 已因同样原因专门脱离该路径） | 设置页每点一个复选框都重写整个 metadata blob（含所有站点配置与用户信息），窗内每个 `onChanged` 还会再 `JSON.stringify` 一次做回声比对 |
| V-9 | `views/Settings/{SetDownloader,SetMediaServer,SetBackup}/Editor.vue` | 三个 `Editor.vue` 逐字重复同一段约 20 行表单块；`SetMediaServer/Editor.vue:76,82` 复用了 **downloader** 命名空间的 i18n key | 改一处影响两处；新增一个下载器/媒体服务器类型时需改三处 |
| V-10 | `locales/en.json:1331` | `userInfo.alwaysPickLastUserInfo: ""`（空字符串） | `Settings/SetBase/UserInfoWindow.vue:77` 渲染出**空白开关标签**。en/zh_CN 键完全对齐（1019/1019、零偏差），仅此一处空值 |
| V-11 | `options/components/SentToDownloaderDialog/utils.ts:18` | 该组件被 `App.vue` 挂载在 shadow root 内，却调用了 antd 的**静态** `Modal.confirm`；这**正是项目自己在 `content-script/app/modal.ts:1-14` 明文警告并专门封装规避的用法**（该文件注释：「antd 的**静态** `Modal.xxx` 会 `vueRender` 到一个游离的 document fragment，既不进 shadow root、也拿不到 `ConfigProvider` 的主题/语言/`getPopupContainer`，弹窗会完全失去样式」，并因此实现了 `Modal.useModal()` 版 API `registerModalApi`/`promptModal`，见 `:16,:45`） | 从内容脚本触发的「替换 `<...>`（保存路径/标签）」弹窗落在**宿主页面 document.body** 而非 shadow root：丢失主题与容器约束、样式失效，且页面脚本可读取用户输入的保存路径/标签、可移动/隐藏该弹窗、**可直接触发其 OK 按钮**替换成自己的值。该对话框的输入随后被用作下载器的 `savepath`/标签 |

---

### 5.6 选项页视图域（补充）

| ID | 位置 | 问题 | 后果 |
| --- | --- | --- | --- |
| V-12 | `MyData/UserDataStatistic/Index.vue:92-99` vs `:244-251` | 合计用 `.map(x => x[field]).filter(isNumber).reduce(...)`，而逐站序列用 `isNumber(val) ? val : Number(val) \|\| 0`。**已实测** es-toolkit/compat 的 `isNumber(NaN) === true`、`isNumber("123") === false` | 双向不一致：(1) 以**数字字符串**存储的值（`IUserInfo` 允许；`UserDataTimeline` 就为此用 `parseFloat` 并引用了 issue #48）被逐站条形图计入、却被「总上传」折线丢弃；(2) 一个 `NaN` 能通过 filter 并**污染整个日桶的合计** → echarts 断点/空洞。修复：两处共用一个 `toNumber`（parseFloat + `Number.isFinite`） |
| V-13 | `MyData/UserDataStatistic/Index.vue:335`（对照同文件 `:297-298` 的可选链写法） | `formatter: (site) => allAddedSiteMetadata[site].siteName ?? site` —— 裸解引用 | 元数据只为**有历史记录**的站点加载（`:382`），而 `selectedSites` 可含任意 id（路由 query 见 `MyData/Index.vue:232-239`，或持久化的 `configStore.userStatisticControl.selectedSites`）。选中一个无历史的新站点/历史被清空的站点时 legend formatter 抛 TypeError → 图表空白或损坏。修复：加 `?.` |
| V-14 | `Overview/DownloadHistory/utils.ts:10-11, 31-41` | `shallowRef({})` + `computed(() => Object.values(downloadHistory.value))`，而轮询用 `downloadHistory.value[id] = history` **就地改内层对象** | shallowRef 只在 `.value` 重新赋值时触发，就地写既不动 ref 也不使 computed 失效 → 表格一直持有旧记录对象，**「下载中/等待中」永远不会翻成「已完成/错误」**，尽管每秒都在发请求；只有整表刷新（`:57` 的 `downloadHistory.value = {}`）才恢复。修复：`downloadHistory.value = { ...downloadHistory.value, [id]: history }` 或 `triggerRef` |
| V-15 | `SearchEntity/Index.vue:127-152`（写入方 `SearchEntity/utils/search.ts:129-203`） | 快照切换 `getSearchSnapshotData(...).then((data) => { data && (runtimeStore.search = {...}) })` **无请求守卫**，且快照分支**不停止搜索队列** | 快速连续切换快照时旧响应可能后到并覆盖；更麻烦的是仍在排队的 `doSearchEntity` 会继续往被替换掉的 `runtimeStore.search.searchResult/searchPlan` 写入（`search.ts:133,159,187,192`），实时搜索结果污染快照视图。修复：加 token/目标 id 校验；应用快照时清空或暂停队列 |
| V-16 | `SearchEntity/ActionTd.vue:61-78`（对照 `:80-87` 的安全写法） | `copyTorrentDownloadLinkBtnStatus.value = true;` 之后 `await getTorrentDownloadLinks()` 落在 **try 之外** | `sendMessage("getTorrentDownloadLink")` 一旦 reject 就逃过 catch 直到 `:77`，**复制按钮永久转圈** + unhandled rejection |
| V-17 | `Settings/SetSite/Editor.vue:70-86, 189-217` | 自定义 URL 单选框内联 `@click="updateFormValid(false)"` 直接置位 flag，而真正的判据是 computed `siteFormValid`，watcher 只在**值变化**时同步 | 当自定义 URL 本就有效时（例如站点已存自定义 url，`initSiteData:97-99`），`siteFormValid` 保持 `true` → watcher 不再触发 → `isFormValid` 停在 `false`，**表单有效但 OK 按钮永久禁用**，须靠「先输错再改对」恢复。修复：删掉这两处命令式调用，统一由 computed 驱动 |
| V-18 | `Settings/SetSearchSolution/Index.vue:174-190` | 导入只校验「`solutions` 是非空数组」，不校验 `name`、各条 `siteId`、`selectedCategories`、`searchEntries` 形状，也不检查引用的站点是否存在；随后 `addSearchSolution` 立即 `$save()`（`metadata.ts:492-496`） | 手工编辑或外部来源的方案文件可把任意条目持久化，损坏只在之后表现为「空方案/搜索失败」，导入时没有任何校验报错。导出侧同样未复验，往返「无损」只是约定 |
| V-19 | `Overview/MediaServerEntity/utils.ts:16-18`（消费方 `Index.vue:141-151`、`utils.ts:54`） | `searchMediaServerIds` 在**模块加载时**由 `getEnabledMediaServers` 初始化一次；复选框 `:disabled="item.enabled === false"` 且无重新同步；offscreen 侧也不检查 `enabled`（`offscreen/utils/search.ts:89-100` 按 id 取配置就搜） | 媒体墙打开后再去设置里禁用某媒体服务器：搜索**仍会带着已存凭据发给它**，而 UI 上是一个「禁用但仍勾选、且点不动」的复选框，只有整页刷新才清掉 |
| V-20 | `Settings/SetSite/Index.vue:230, 267, 452` | `isFaviconFlushing` 声明后**全文件从未赋值 `true`**，却绑在 `:loading` 上 | 工具栏/行内按钮永不进入 loading、无法禁用；用户对数百个选中站点可反复点击，每次都为每个站点发一条 `getSiteFavicon`，且无论是否部分失败都弹成功提示 |
| V-21 | `Settings/SetSite/Index.vue:291,306`、`SetDownloader/Index.vue:271,289`、`MyData/Index.vue:405`、`MediaServerEntity/Index.vue:122`、`DownloadHistory/AdvanceFilterGenerateDialog.vue:79,107`、`SearchEntity/AdvanceFilterGenerateDialog.vue:114,158`（**共 10 处**） | `:indeterminate="true"` **硬编码** | antd 只要 `indeterminate` 为真就画「半选」横杠，于是这些筛选复选框无论筛选是否生效都显示为半选状态——`checked` 绑定其实是对的，但用户**无法从 UI 判断哪些筛选已启用**。同库的 `SiteCategoryPanel.vue:111-113` 是正确写法（用 computed）。修复：改为计算值或直接去掉该属性 |

---

## 6. 低危 / 架构 / 可维护性

| ID | 位置 | 问题 |
| --- | --- | --- |
| A-1 | `entries/shared/messagesSerializable.ts:13-25` | 注释称 `Date/Map/Set/Blob/Error/ArrayBuffer/类型化数组` 交给「浏览器自身的结构化克隆」，但 `@webext-core/messaging` 直接调 `chrome.runtime.sendMessage`（`node_modules/@webext-core/messaging/dist/index.mjs:12-19`），Chrome 走 **JSON 序列化**（manifest 无 `message_serialization: "structured_clone"`）：`Map`/`Set`/`Blob`/`Error` → `{}`，`Date` → 字符串；而**同上下文本地 handler 快路径**返回真实对象 → 同一消息因分发路径不同而类型不同。当前 payload 全用 `number` 时间戳，**尚未触发**，属潜在陷阱 + 注释与事实不符 |
| A-2 | `entries/shared/messagesSerializable.ts:78-84` | `out[key] = item` 对 `Object.keys(raw)` 全量赋值，字面量 `__proto__` 键会**改写输出对象原型**而非建立自有属性（可从任意 `JSON.parse` 的远端数据/恢复的备份到达）。建议跳过 `__proto__`/`constructor`/`prototype` |
| A-3 | `content-script/index.ts:85`、`background/utils/contextMenus.ts:205,375`、`shared/storagePath.ts:10-46` | `siteHostMap[host]` 未用 `Object.hasOwn`（单标签 host 如 `http://constructor/` 会解析到 `Object.prototype.constructor`）；`parsePath`/`setValueByPath` 沿原型链读写，未拒绝 `__proto__` 等段（当前无调用方传入攻击者可控路径，属纵深防御） |
| A-4 | 循环依赖 | 剥离 `import type` 后（475 条类型边编译期擦除）仍有真实静态环：`content-script/app/utils.ts` ↔ `pages/{SiteListPage,SiteDetailPage,SocialSitePage}.vue`（`utils.ts:12-14` 静态导入页面，`:157-159` 在**模块求值期**构造组件映射表）。当前用法只在 setup/函数内引用，未触发 TDZ。其余被报的环经核验为**动态导入**，不构成问题——`options/plugins/router.ts:137`、`packages/social/recommendations.ts:374`、`social/index.ts:9-14`（`import type`） |
| A-5 | `packages/site/utils/adapter.ts:13-22` | `@ptd/site` 反向依赖 `@/messages.ts`、`@/storage.ts`、`@/shared/types.ts`，故「packages 与平台解耦」并不成立，且会把 entries 层拖进每个 bundle。**这是文件头明确记录的有意适配缝**，属架构债而非缺陷 |
| A-6 | `src/` 注释共 **83 处**引用 5 个 `docs/*.md`，而**这 5 个文件在磁盘与 git 历史中都不存在**；同时 `.gitignore` 特意放行的两个文档却无人引用且同样不存在 | 精确事实：`grep -rhoE "docs/[A-Za-z0-9._/-]+\.md" src` 去重后为 `performance-audit.md`(**79** 处)、`style-layout-audit.md`、`functional-audit/06-shell-entry.md`、`antd-migration-guide.md`、`antd-component-audit.md`——**全部缺失**。`.gitignore:6-12` 用 `docs/*`（注释明确说明是为了能再用 `!` 放行个别文件）并放行了 `!docs/engineering-audit.md`、`!docs/engineering-remediation-status.md`，但这两个文件**既不存在、也没有任何源码引用它们**。后果：存储读缓存/写链/锁/调度器这些最微妙部分的「为什么」对任何 clone 仓库的人都不可恢复，而且注释主动把读者引向永远找不到的文件；`base.ts:59` 依据它写下的不变量已经失效（B-10）。修复：把这 5 个文档补入仓库（并同步修正 `!` 放行清单），或把关键不变量内联进代码注释再删掉悬空引用 |
| A-21 | `.gitignore:10` | `docs/*` 忽略整个文档目录，且放行的两个文件名与实际被引用的文档名完全不匹配 | 见 A-6：文档治理规则与实际引用脱节，新写审计文档会默认不进仓库，而代码又在引用它们 |
| A-7 | `content-script/app/pages/SiteListPage.vue:35` | 每个悬浮球动作都 `document.cloneNode(true)`（`:56,:70,:96,:109,:118`），详情页在 `AbstractBittorrentSite.ts:948` 再克隆一次 | 大列表页每次点击都整树复制（含内联 `<script>`/`<style>`），是点击成本的主要来源 |
| A-8 | `content-script/app/App.vue:70-75, 269` | 无 `history.pushState`/`popstate`/`hashchange` 订阅 | SPA 式站点（Unit3D/Livewire）列表→详情导航后 `pageType`/站点实例仍是旧值，「复制链接/推送/本地下载」会按列表页解析详情页 → 「未解析到种子」或复制上一页链接 |
| A-9 | `content-script/app/components/AdvanceListModuleDialog.vue:120`, `:100-107`；`SiteListPage.vue:54-65` | 绕过已有的 `copyTextToClipboard` 回退；下载循环的 `status.value = false` 不在 `finally` 内（`SiteListPage` 反之——`.finally` 在 fire-and-forget 之前就清了 loading） | 非安全上下文下复制恒失败；异常时按钮卡在 loading 且产生 unhandled rejection |
| A-10 | `content-script/app/app.css:21-24`、`app/themeVars.ts:41-43` | `.ptd-content-script-root{…}` 写在 **shadow 样式表**里，无法匹配 host（shadow 内按类名选不中宿主）；theme 变量以非 `important` 内联写入 | 声明的 host `z-index` 从未生效（真正生效的是树内 `.ptd-content-script-draggable`）；页面的 `!important` CSS 能隐藏整个覆盖层或覆盖主题 token → UI redressing 面 |
| A-11 | `options/views/Overview/MyData/UserDataTimeline/utils.ts:197-199` | `try { value = parseFloat(...) } catch (e) {}` —— `parseFloat` **从不抛异常**，死代码（也是抑制文件中唯一一条 `no-empty`） | — |
| A-12 | `src/styles/vuetify/` | 迁移后遗留的空目录 | — |
| A-13 | `definitions/1337x.ts:259`、`u2.ts:123`、`anirena.ts:52`、`wukongwendao.ts:17`、`definitions/totheglory.ts:62`/`minept.ts:12` 等 | detail 回退选择器 `http://itorrents.org/` 未重写域名（Jackett 已改写为 `https://itorrents.net/`）；`u2.ts` 的 `http://anidb.net/` 前缀过时；`wukongwendao` 的 `urls` 重复条目；`schema: "TBSource"`/`"meanTorrent"` 无实现（静默回退 `AbstractPrivateSite`，全仓库 7 处，其中 5 处 `isDead`） | 回退路径失效；实为死配置 |
| A-14 | `definitions/myanonamouse.ts:546-547, 581-588` | `createRequestThrottle(undefined)` 返回 no-op（未声明 `userInfo.requestDelay`），却仍按 4 并发 ×5 类型批量取页；批在前、检查在后 | 每批 4 个并发 CDN 请求；首页不足 250 行时每类型仍白付 3 个请求 |
| A-15 | `definitions/aidoruonline.ts:393, 406-409` | `flushUserInfo.seedingSize = 0` 后 `+= this.getFieldData(...)`，而 `getFieldData` 未命中时返回**字符串** `""` | `0 + "" = "0"`，之后每次 `+= 数字` 变成字符串拼接 → `"01234"` 静默污染数值 |
| A-16 | `definitions/exttorrents.ts:285-288`、`generationfree.ts:236-238` | `computeHMAC` 实为无密钥的 SHA-256（命名与线协议字段都称 hmac）；`freeleech.replace("%","%")` 是 no-op | 语义误导；疑似丢失的规范化逻辑 |
| A-17 | `definitions/cinemageddon.ts:151-160`、`broadcasthenet.ts:323,329`、`aidoruonline.ts:403-404` | 无保护的 `sizeAnother[0]` 解引用（作者自留 FIXME）；搜索路径残留 `console.log`（171 个定义中唯一的 `console.log`）；唯一一处裸 `new DOMParser()`（其它定义用共享 `createDocument()`） | 少列行导致整次用户信息刷新失败；日志噪音；若站点包在 background 而非 offscreen 执行将单独失效 |
| A-18 | `packages/site/utils/selector.ts:979-987` | `evalPositionalGroup` 对「存活的每个上下文」分别求值剩余部分，而 Sizzle 是对**并集**施加尾随位置过滤。已用真实 Sizzle 2.3.10 差分确认：`"tr:gt(0) td:eq(0)"` → Sizzle `[row1.td0]`，本引擎 `[row1.td0, row2.td0]`；且结果拼接时**不去重**，嵌套存活可能返回同一元素两次 | **当前可达性为零**（对 `src/` 全部字符串/模板字面量做 AST 扫描：26 个含多存活位置伪类的选择器中，**0 个**把该伪类放在非末尾位置）。属对新写/第三方定义的潜在风险——该模块正是文档化的公开 API。修复：对 `filtered` 的并集去重后统一施加尾随位置伪类，或把该差异写入「已知差异」清单 |
| A-19 | `packages/site/utils/favicon.ts:132`、`:147` | `manifest.icons.forEach(...)` 未校验（`:128` 的 `as` 断言掩盖了缺失/非法 `icons`）；`.ico` 只认 `image/x-icon` | 形如 `{"name":"x"}` 的 manifest 会在第 3 步之前抛 TypeError，使第 1 步已收集的 `<link rel=icon>` 与默认 `/favicon.ico` **一起丢失**，站点退回 `NO_IMAGE`；而 IANA 注册类型是 `image/vnd.microsoft.icon`，正确声明的 `.ico` 会被丢弃。影响仅外观，故 LOW |
| A-20 | `packages/site/utils/helper.ts:171-174` | 与 B-22 同类：`ret` 可因远端 JSON 的 `__proto__` 键被污染 | 同上，建议一并加段名守卫 |
| A-21 | `Overview/DownloadHistory/utils.ts:33-35` | 轮询里 `const history = await sendMessage("getDownloadHistoryById", id)` 后直接读 `history.downloadStatus`，而该 handler 返回 IndexedDB 原始 get（`offscreen/utils/download.ts:653-657`），键不存在时是 `undefined` | 删除某行不会取消已排的 1s 定时器（`clearWatchingMap` 只在该页节流重载的开头执行）→ 定时器内 TypeError（未被捕获），轮询链**静默死掉**，且 `undefined` 可能残留在 map 里破坏 `Object.values` 行。修复：`if (!history) { delete watchingMap[id]; delete downloadHistory.value[id]; return; }` |
| A-22 | `SearchEntity/SearchStatusDialog.vue:31-42`（应用于 `:74-75`） | 用 Vuetify 颜色名作 antd Tag 的 `color`：`"yellow-darken-2"` 等。antd-vue 只认预设色，其余会写进 `style.backgroundColor`（`es/tag/index.js:88-120`） | `yellow-darken-2` 是非法 CSS → 声明被丢弃 → 状态标签**无样式**。仓库里已有 `resolveColor()`（`src/entries/shared/colors.ts:39`）正是为这类迁移准备的 |
| A-23 | `MyData/UserLevelShowSpan.vue:232`（对照同文件 `:138/:146/:155` 已改十六进制） | `style="color: green darken-4; font-size: 14px"` —— Vuetify token 留在 style 里 | 非法 CSS → 颜色声明被丢弃，图标呈继承色。同类：`MyData/UserNextLevelUnMet.vue:11` 的默认 `iconClass = "mr-3"`，而 `src/` 内**不存在** `.mr-3` 规则 |
| A-24 | `MyData/HistoryDataViewDialog.vue:229-239` | `<template #footer.prepend>` —— `#footer.prepend` 是 Vuetify `v-data-table` 的插槽名；antd 的 vc-table 只消费 `slots.footer`（`es/vc-table/Table.js:412,563-566`） | 该组按钮**永不渲染**（当前被 `:244-255` 里另一组完全相同的 `#footer` 掩盖，所以看不出来）。修复：删掉或并入 `#footer` |
| A-25 | `MyData/HistoryDataViewDialog.vue:26`（用于 `:77` 与 `:218`） | `const currentDate = formatDate(+new Date(), "yyyy-MM-dd")` 在 setup 时**取一次值**，而它正是「不允许删除当天数据」的判据 | 长时间打开的选项页跨天后仍在保护**昨天**，于是既允许用户删掉今天的记录（批量与单行），`format` 格式本身与存储 key（`offscreen/utils/userInfo.ts:157`）是一致的——只是值过期了。修复：调用时再取当前日期 |
| A-26 | `MyData/ExportUserInfoDialog.vue:147-164` | CSV 转义只在匹配 `/[",\n\r]/` 时加引号，单元格首字符为 `=`/`+`/`-`/`@` 时**原样输出** | 站点可控字段（用户名、等级名、站点名）会进入 CSV；`=HYPERLINK("http://x","click")` 之类在 Excel/Sheets 打开时被求值——**CSV 公式注入**。修复：首字符命中 `= + - @ \t \r` 时前置 `'` |
| A-27 | `Settings/SetDownloader/SiteFilterDialog.vue:78`、`SetSite/OneClickImportDialog.vue:219`、`MyClient/Index.vue:430`、`MediaServerEntity/ItemInformationDialog.vue:101-111` | 迁移残留的**无效属性**：`variant="tonal"`（antd 4.2.6 无 `variant`）、`color="blue-lighten-1"`（`NavButton.vue:19-21` 未映射的 Vuetify 调色板名）、`control-variant="stacked"`（antd 无 `controlVariant`）、`<a-tag :href>`（`tagProps()` 无 `href`，渲染为 `<span>`，点击不跳转且 `tag.url` 为 undefined 时会输出字面量 `href="false"`——Vue 只移除 `null`/`undefined`） | 全部静默失效：低强调按钮样式不生效、数字输入框的上下控件不是堆叠布局、媒体服务器的 tag 链接点不动 |
| A-28 | `src/entries/options/views/Devtools/` | **空目录**（0 文件），仅 `SetBase/ResetWindow.vue:14` 的注释提到 `views/Devtools/Debugger.vue` 已在迁移中移除 | 死目录 + 悬空注释 |

---

## 7. 已核验的良好实践（改动时请勿破坏）

1. **offscreen 生命周期**：`setupOffscreenDocument` 用 `chrome.runtime.getContexts` + 在途 `creating` promise 双重守卫，`finally` 正确复位，预热失败不污染 `creating`。
2. **跨浏览器消息拓扑**：`ff_main.ts` 把 offscreen handler 注册进 background 本身，Firefox 下 60+ 条消息走同上下文本地快路径——**设计正确，无「Firefox 全盘失效」问题**。
3. **本地 handler 快路径不会遮蔽远端 handler**：`options/` 与 `content-script/` 全仓库**没有** `onMessage(` 注册（已 grep 确认）。
4. **内容脚本引导确实轻量**：只发 1-2 条定路径读消息；`attachShadow({mode:"closed"})`；整链唯一兜底 catch 保留可诊断信息；重资源经 `assets/cs-app.js` 按需动态导入，首次失败带 cache-busting 参数重试一次。
5. **选项页无定时器/观察者泄漏**：全目录无 `setInterval`；`MyClient` 的 `setTimeout` 自调度链在 `onUnmounted` → `stopAllTimers()` 正确清理（我最初怀疑此处泄漏，核验后**排除**）；`resizeObserverErrorFilter` 只精确匹配两条已知无害消息。
6. **敏感模块不裸打日志**：`packages/downloader`、`packages/backupServer`、`background/utils/cookies.ts`、`site/utils/adapter.ts` 内**没有** `console.*`，统一走 `logMessage`/`logBackgroundError`。
7. **存储读缓存设计正确**：`onChanged` 全域失效 + 自身写入 resolve 后**同步**失效（正确识别了 `setItem` 早于 `onChanged` 的窗口）；失效键名与 `@webext-core/storage` 实际使用的裸键名一致（已核对库源码，**无前缀错配**）。
8. **站点 URL 的 ROT13 机制正确**：182 个定义用 ROT13 编码站点链接（如 `uggcf://jjj.gbxlb-znatn.gbc/`），`index.ts:53-56` 经 `restoreSecureLink`/`rot13` 正确解码——这是防止分享配置时泄露tracker 成员身份的合理设计。
9. **341 个站点定义的体检结果干净**：0 个 id 重复、0 个 hostname 重复（513 个 host）、0 处跨站 host 污染、0 处硬编码密钥/邮箱/内网 IP、0 个 `userInfo.selectors` 死键、0 个未知 `filters[].name`（897 个字面量校验）、0 个用户输入注入选择器/URL、0 个 ReDoS 候选、0 处 `levelRequirements` id 重复或非单调。
10. **`check-bundle-budget.mjs` 是真门禁**：断言 10 项关键产物存在 + 4 项体积预算，超限退出 1，已接入 CI（含 firefox 目标）。
11. **多处细节体现工程成熟度**：下载历史原子替换且非法时**不清空**本机历史；`writeChain` 不因单次失败中断（`next.catch(() => undefined)`）；`toMerged(fieldData, userInfoStore)` 参数顺序使「保留本机用户信息」语义正确；`fixAllStoredUserInfo` 幂等；Transmission 409 握手、Aria2 JSON-RPC `token:` 与 `id` 匹配、qBittorrent FormData/content-type、Flood 的 401 重登、各客户端限速单位换算（除 B-4~B-7 外）均正确；`getRemoteTorrentFile` 用 `valid-filename` 校验文件名；`redactSensitive` 覆盖 `pass|key|auth`。
12. **选择器引擎（`utils/selector.ts`，1201 行）经两路独立验证，未发现缺陷**。这是全仓库复用度最高的文件（所有站点 schema 都依赖）：
    - **我本人**逐条对照 jQuery/Sizzle 语义复算了位置伪类的全部边界（length=5）：
    ```
    :eq(-1) → [4]     :eq(10) → []      :eq(-10) → []
    :lt(2)  → [0,1]   :lt(-1) → [0,1,2,3]   :lt(10) → 全部   :lt(-10) → []
    :gt(1)  → [2,3,4] :gt(-1) → []      :gt(-2) → [4]        :gt(10) → []
    :even   → [0,2,4] :odd    → [1,3]
    ```
      最危险的失效模式——CSS 原生的 `:nth-child`/`:first-child`/`:nth-of-type`/`:only-child` 被位置扩展伪类吞掉——**已正确处理**：伪类名按 `[\w-]+` 整体提取，`"nth-child"` ≠ `"nth"`，故归类为 `native` 交回浏览器；`::before` 等伪元素亦正确跳过；`:contains`/`:has` 参数内的伪类不会被外层误扫（`findMatching` 括号配平）。`positionalIndices` 不产出越界下标，因此 `filterByIndices` 的 `keep.size === elements.length` 提前返回是安全的。
    - **另一路**用**冻结的 Sizzle 2.3.10 作为差分 oracle**（在 happy-dom 里对同一 DOM 跑两套引擎）：从 `src/packages/site/**` + `social/**` 抽出 **556 个真实选择器 × 9 种上下文**，外加全元素 `matchesSelector` 与约 7.5k 次随机模糊测试，**除 JSDoc 里抄来的字符串与 A-18 那一类外零差异**。这种 oracle 差分是对「自制选择器引擎」最强的验证手段，值得保留为常驻测试。
13. **ant-design-vue 的 prop/event 迁移面经全量核对，未发现遗漏**（这是本分支最大的风险面，故单列）：`v-model:open`（a-modal/popover/drawer）、`v-model:value`/`v-model:checked`、`:options` 用于 select、`a-menu :items` + `@click`、`sorter` 的两种形态（纯比较函数 / `{compare,multiple}`）、`sortOrder`、`rowSelection.getCheckboxProps`、`a-upload :before-upload` 返回 `false`、`a-layout-sider @update:collapsed`、`a-table` 的 change 签名、`destroy-inactive-tab-pane`、`a-input @press-enter`、`:sm="{span,offset}"`、`a-progress :width`——**均与 4.2.6 的实际 API 一致**；`bodyCell` 与 `customRender` 的优先级、部分 `#bodyCell` 链回退到 `customRender` 的行为也已验证；`update:checked` 确实发出布尔值、`@click` 属性落在真实 input 上。整个 scope 内**没有**遗留 `<v-*>` 组件、也没有在 antd 组件上漏写修饰符的 `v-model`（40 余处 `v-model="…"` 全是使用 `defineModel` 的自定义组件）。另：`SetBase/UserInfoWindow.vue:22` 的 `dayjs(value,"HH:mm")` **是合法的**——antd 的 `vc-picker/generate/dayjs.js:10` 在导入时就全局 `dayjs.extend(customParseFormat)`，早于任何视图渲染。
14. **三处高风险的迁移细节经核对是正确的**：(a) `SetBase/DownloadWindow.vue:81` 的 `v-html` **安全**——`t('SetBase.download.quickSendToClientNote')` 未传任何插值参数，中英文案都只有静态文本 + `<br />`；(b) 三个「测试连接」路径（`SetDownloader/Editor.vue:58-64`、`SetMediaServer/Editor.vue:59-65`、`SetBackup/Editor.vue:189-196`）调用的都是 `getX(clientConfig.value!)`，即**表单当前地址**，不存在「地址来自另一个用户输入字段」的凭据外送面；(c) 所有弹窗都用 antd 的 `afterClose`（kebab `:after-close`）+ `watch(showDialog)` 做打开初始化，**没有** `@after-leave` 残留。
15. **状态隔离与破坏性操作做得扎实**：`SetSearchSolution/EditDialog.vue:123`（`cloneDeep`）、`SetSite/Editor.vue:91-94`（`toMerged`）、`SetDownloader/SiteFilterDialog.vue:44`、`PathAndTagSuggestDialog.vue:78-83/105-110`（数组整体替换而非就地改）**确实与 store 隔离**；`SetBase/ResetWindow.vue` 的 7 个破坏性操作全部有确认弹窗 + `isResetting` 守卫，且用到的 storage key（`"userInfo"` 与 `background/utils/fixer.ts:53` 一致、`"searchResultSnapshot"` 与 `offscreen/utils/search.ts:109` 一致）正确，**不会在随后 `$save()` 时把已清数据复活**；「默认下载器不可删除」有显式守卫（`SetDownloader/Index.vue:212-223`）。所有删除路径均经 `DeleteDialog` 确认。
16. **scope 内计时器/监听器清理完整**：`Layout/RecommendationMenu.vue:139-145` 在 `onUnmounted` 清 100ms flush 定时器；`SetBase/NativeBridgeWindow.vue:91-101` 只在按钮触发的 `testConnection` 内轮询（≤5s）；`v-scroll`（`options/main.ts:32-55`）在卸载时移除 window 监听；scope 内无 `ResizeObserver` 创建。`MyClient/TorrentDetailDialog.vue` 与 `ClientStatusDialog.vue` **自身没有** `setTimeout/setInterval`（刷新链在已核验的 `MyClient/utils.ts` 里）。
17. ~~**我的另一处怀疑也被证伪（多站点聚合的时间线统计）**~~ → **此结论是我的误判，已在 B-26 更正**。我原先只确认了 `UserDataTimeline/utils.ts:220` 存在 `if (totalInfo.downloaded > 0)` 守卫就判定「已正确处理」，**但没有检查守卫为假的分支**：`totalInfo.ratio` 初值为 `-1`，而 `CTimelineUserInfoField` 含 `ratio`，循环会把它逐站累加；当总下载量为 0 时守卫不生效，显示出来的「总分享率」实际是 `-1 + Σ(各站分享率)`——单站 ratio 2.5 会显示「1.50」，0.5+0.2 会显示**负数**「-0.30」。正确做法是 `ratio` 不参与累加、只由总量推导。教训记在这里：**只验证「守卫存在」不等于验证「无守卫时行为正确」**。
18. **字节类字段的单位确实一致**（这一条成立）：`uploaded`/`downloaded`/`seedingSize` 全程以字节求和、仅在展示层 `formatSize`；抽样确认各 schema 走 `parseSize` 归一化（`schemas/Luminance.ts:183`、`schemas/Gazelle.ts:454`）。唯一值得跟进的是 `schemas/GazelleJSONAPI.ts:261-263` 的 `response.userstats.seedingSize` 没有显式的尺寸过滤器/单位归一化——未构成已确认缺陷，仅记录。

---

## 8. 审查过程中已排除的误报

| 怀疑 | 核验结论 |
| --- | --- |
| Firefox 构建缺 offscreen，60+ 条消息全部失败 | **不成立**：`ff_main.ts` 把 offscreen handler 注册进 background，走本地快路径 |
| 存储读缓存因 `@webext-core/storage` 键前缀与 `onChanged` 失效键名错配 | **不成立**：库使用裸键名（`storage.set({[key]:value})`），失效逻辑正确 |
| `MyClient` 自动刷新定时器在路由离开后继续轮询 | **不成立**：`onUnmounted` 已清理 |
| `stopAllTimers()` 边遍历 `Map.keys()` 边删除会漏清 | **不成立**：删除当前项在 Map 迭代中是安全的 |
| `SentToDownloaderDialog` 用异步 executor 导致弹窗无法关闭 | **不成立**：executor 是同步的，`.finally()` 在 reject 时也执行；真实问题是 unhandled rejection 与取消无提示（已降级为 V-3） |
| `router.ts` ↔ `SetBase/Index.vue`、`social` 内部存在运行时循环依赖 | **不成立**：均为动态 `import()` 或 `import type` |
| 341 个定义大量重复（144 行块 ×50） | **不成立**：归一化后相似但语义各异（各站点自有分类名），属固有结构 |
| `resizeObserverErrorFilter` 屏蔽真实错误 | **不成立**：仅匹配两条已知无害消息 |
| `t()` 动态拼键导致 7 个 i18n key 缺失 | **不成立**：均为动态组合，构成键齐备；en/zh_CN 键 1019/1019 完全对齐 |
| `beyondhd.ts:668`/`broadcasthenet.ts:394` 无条件 H&R 标签是缺陷 | **不成立**：与全站 H&R 的既有约定一致（`tjupt.ts:139` 用 `selector:"*"`、`hdhome.ts:73` 用 `img.hitandrun`） |
| 时间线「总分享率」求和是误报（我最初的判断） | **我错了，见 B-26**：只确认了守卫存在，没检查守卫为假的分支。当总下载量为 0 时确实显示 `-1 + Σ各站分享率` |
| `UserDataStatistic` 跨页选择会丢/重选中行 | **不成立**：已在 antd `table/hooks/useSelection.js` 确认 `onChange(keys, rows)` 的 rows 取自整个 dataSource 与 keys 的并集 |
| `KeepUploadDialog` 的 `files.every` 会因 `undefined` 崩 | **不成立**：offscreen 侧构造器始终产出数组 |
| antd 复选框 `update:checked` 事件形状、`bodyCell` 与 `customRender` 优先级、`fieldNames`/`v-model:*` 映射 | **均正确**：已验证 `update:checked` 发出布尔值、`@click` 属性落在真实 input 上；部分 `#bodyCell` 链会正确回退到 `customRender` |
| `AvistazNetwork.parseTorrentRowForTags` 未调 `super` | **不成立**：当前无 Avistaz 定义声明 `search.selectors.tags` |
| 定义层的 `timezoneOffset` 被大量删除会出错 | **不成立**：`index.ts:60` 与 `NexusPHP.SchemaMetadata` 会补回 `+0800`，非 NexusPHP 默认 `+0000` |
| `DownloadWindow.vue:81` 的 `v-html` 是 XSS | **不成立**：`t()` 未传插值参数，中英文案均为静态文本 + `<br />`（详见 §7.15a） |
| 「测试连接」按钮可被用来把凭据送到任意主机 | **不成立**：三处都调用 `getX(clientConfig.value!)`，用的是**表单当前地址**而非另一个独立输入字段（§7.15b） |
| `dayjs(value, "HH:mm")` 缺 `customParseFormat` 插件会失效 | **不成立**：antd 的 `vc-picker/generate/dayjs.js:10` 在导入时全局 extend，早于任何视图渲染（§7.14） |
| 弹窗关闭生命周期残留（`@after-leave` / `afterOpenChange`） | **不成立**：全部使用 antd 的 `afterClose` + `watch(showDialog)`（§7.15c） |
| `SetBase/ResetWindow.vue` 清空数据后会被随后的 `$save()` 复活 | **不成立**：storage key 与消费端一致，且 `$reset()` 后显式 `$save()`（§7.16） |
| `Navigation.vue` / `SetSite/Index.vue` 存在 CSS 模块类名未注册 | **不成立**：`classes-defined` 检查里 `configStore` 那条来自 `App.vue`，属脚本判据问题而非未定义类（见 Q-2 修复建议） |
| 多站点 `seedingSize` 单位不一致导致求和错误 | **未证实**：抽样确认各 schema 经 `parseSize` 归一化（`schemas/Luminance.ts:183`、`schemas/Gazelle.ts:454`），仅 `GazelleJSONAPI.ts:261-263` 无显式尺寸过滤器，记为待跟进而非缺陷（§7.18） |
| 高级筛选勾选框「取消勾选却变成排除条件」（同时翻转 `required` 并推入 `exclude`） | **确实存在，但非本分支引入**（在 HEAD 上同样存在），因此不计入迁移缺陷；成因见 `useAdvanceFilter.ts:447-455` 的 `@update:checked` + `@click.stop` 双写，且被硬编码的 `:indeterminate="true"` 掩盖（V-21） |

---

## 9. 建议的修复顺序

**第一批（安全 / 数据损失 —— 建议阻断合并）**

1. **S-1** 备份恢复不信任输入：`backupServers` 默认不恢复 + 差异确认 + schema 校验 + 上传字段不由恢复数据决定。
2. **S-2** 校验拖拽载荷与解析出的链接（协议白名单 + 站点 host 白名单），忽略载荷中的 `site`/`id`。
3. **B-25（CRITICAL）**：`loadAllAddedSiteMetadata` 去掉 `new Promise(async …)` 包裹，改为 `map(async …)` + 逐站 try/catch，保证每个 promise 必然 settle——这是唯一一个会让**整页永久卡死**的缺陷，改动量却只有几行。
4. **B-8 / B-13 / B-26**：`getSearchSolution` 不再改写 state；补 `if (!solution)` 与 `state.sites[siteId] ?? {}`；`removeSite` 级联清理；搜索链路补 `$onReady()`；时间线 `ratio` 不参与累加。同源，一次改完。
5. **B-10 / B-11 / B-18**：确立单一写入者（或引入 CAS）；下载历史读改写串行化；`fixAllStoredUserInfo` 改走写链与缓存失效。
6. **B-12**：取消队列时让在途 promise 有归宿；SW 侧 await 加超时。
7. **B-1**：`parseTimeWithZone` 全函数化 + 逐行失败降级为跳过。
8. **B-21**：补齐中文时长单位（`小时`/`个月`/`週`/`日`）并按长度降序排列，补断言**数值**的回归测试——当前 `"5小时"` 会把字符串灌进数值字段，`"1天2小时"` 会静默少算 2 小时，且 `speedapp.ts` 里已有站点级补丁证明该缺陷真实发生。
9. **B-22**：`setValueByPath`/`removeValueByPath`/`helper.ts:171-174` 加段名守卫（本工作树新引入的原型污染原语，旧实现免疫）。
10. **B-28 / B-29 / B-30**：三个 EditDialog 改 `cloneDeep`（同库已有正确写法）；MyClient 表格改用已有的 `torrentKey` 复合键；TorrentDetailDialog 加 epoch/按种子身份守卫——**这三条分别对应「逐键写入凭据」「删错客户端的文件」「显示/操作上一个种子的数据」，都属于会造成实际损失的交互缺陷**。
11. **B-27 / B-31 / V-11**：历史弹窗加过期响应守卫；凭据字段统一掩码 + 删掉三处 `console.log` 活对象；Modal 改走 shadow 感知 API。

**第二批（用户可见的功能性错误）**

12. **B-4 / B-5 / B-6 / B-7**：四个下载器客户端契约错误（端点名、键名、两层解析、索引错位）——都是「客户端什么都不做却报成功」这类最难被用户发现的问题。
13. **B-2 / B-3 / E-1 / E-3 / E-4 / E-5**：schema 引擎的解析缺陷（标题截断、id 取一位、关键词选择器、失败当空、单元格越界、`<br/>` 永不匹配）。
14. **B-14 / B-15 / B-16**：筛选转义、boolean 语义、`g` 标志正则——同一文件，一次修完并补**行为**测试。
15. **B-17**：CF 重试保留 DNR 注入的头。
16. **B-19 / B-20 / B-23 / B-24**：内容脚本 `sessionStorage` 隔离；定义层数据错误；偏移写法规范化；紧凑时长边界——并收紧 `parseSizeString`/`convertIsoDurationToDate` 的失败语义（共享工具应显式失败而非静默返回 0）。
17. **V-12 / V-14 / V-16 / V-17**：统计合计与逐站序列共用 `toNumber`；下载历史轮询改为替换 `.value`；ActionTd 用 try/finally；SetSite 自定义 URL 改为纯 computed 驱动。
18. **Q-2**：把 `check-antd-migration.mjs` 接入 CI 并修至全绿。
19. **L-1 / L-2 / L-5 / L-6**、**D-1~D-8**、**V-1 / V-2 / V-4 / V-13 / V-15 / V-18~V-21**：下载间隔持久化、菜单随 URL 变化重建、blob 释放、`window.open` 返回值检查、客户端会话自愈、发送结果统计、legend 加 `?.`、快照切换加守卫、导入校验、媒体服务器选择同步、`isFaviconFlushing` 生效、`:indeterminate` 改计算值。

**第三批（工程卫生，可并行）**

20. **Q-1**：`--prune-suppressions` 纳入 CI；116 处 floating promise 分批消化。
21. **L-7**：要么恢复日志查看器，要么把日志管线降级为 debug 空实现；同时**脱敏 URL query**（`yemapt` 的 `?token=` 正在明文落盘）。
22. **Q-3**：把约 20 个「源码文本断言」测试改写为行为测试（优先 `myClientAutoRefresh.test.ts`、`layoutDensity.test.ts`、`searchEntityTablePresentation.test.ts`）。
23. **A-6 / A-21~A-28 / Q-4**：补回或内联 `performance-audit.md` 的不变量；清理迁移残留（无效属性、Vuetify 颜色名/token、`#footer.prepend`、空 `Devtools/`）；`ExportUserInfoDialog` 加 CSV 公式注入前缀；`currentDate` 改为调用时取值；下载历史轮询处理已删除记录；收窄 `web_accessible_resources`；CI action pin 到 SHA。
24. **§7.12 的 Sizzle 差分 harness**：建议保留为常驻测试并接入 CI——它是自制选择器引擎唯一真正有说服力的回归防线。

---

## 10. 复现命令

```bash
# ── 门禁现状 ─────────────────────────────────────────────
npx vue-tsc --noEmit
npx eslint .                                            # 0 error（但见下）
npx eslint . --suppressions-location /tmp/empty.json    # 252 error / 112 files
npx vitest run                                          # 429 passed
npm run build:dist && npm run build:dist-firefox
node scripts/check-bundle-budget.mjs && node scripts/check-bundle-budget.mjs --target=firefox
node scripts/check-antd-migration.mjs                   # exit 1（12 项中 2 项失败）

# ── 关键复现（正文各条「已复现」对应）────────────────────
# 筛选转义往返（B-14）：用 search-query-parser@1.6.0 跑 escape → stringify → parse → unescape
#   "My Sites" → "Myu0020Sites"（OK=false）
# boolean 语义（B-15）：parse("0") === "1"，build("0") === "1"
# 状态化正则（B-16）：/1080p/g 复用于 4 个值 → true,false,true,false
# 标题过滤器（B-2）：⚠️ 我原先这条复现是**无效**的——正则是我自己敲的，不是文件内容。
#   文件里实际是三处 U+00A0（见 §1.1 更正 #3）：
#   git show 82db8f3b:src/packages/site/schemas/NexusPHP.ts | sed -n '571p' | hexdump -C
#     -> 20 5e 28 2e 2b 3f 29 c2 a0 c2 a0 c2 a0 2e 2b 24   （三处 c2 a0）
#   真实症状："Name&nbsp;[Free]"（单个 NBSP）不切分；ASCII 空格标题也不切分
# 时间解析抛错（B-1）：format(new Date("昨天"), "yyyy-MM-dd'T'HH:mm:ss") → RangeError
# 尺寸解析静默归零（B-20b）：sizePattern 对 "10B" 不匹配，parseSizeString 返回 0
# ISO 时长静默归零（B-20c）：正则未锚定且全 group 可选 → "P20H" 全 null，"P2D7H33M20S" 只取 2 天
# axios 响应拦截器顺序（B-17）：实测 releaseDnrRule 先于 CF 重试执行
# ROT13 URL 解码（正面结论）：src/packages/site/index.ts:53-56 + utils/html.ts:138-146
# 中文时长单位缺陷（B-21）：逐字复刻 datetime.ts:28-56 的单位表与正则后跑
#   "1天2小时" -> 86400（应 93600）  "5小时" -> "5小时"（字符串！）  "1个月" -> "1个月"
#   "1天2小時" -> 93600（繁体正确）  speedapp.ts:452 的 replace("个","") 是同缺陷的站点级补丁
# 原型污染（B-22）：逐字复刻 storagePath.ts:31-47 后跑
#   setValueByPath({}, ['sites','__proto__','runtimeSettings','x'], 1)
#     -> Object.prototype.runtimeSettings === {x:1}，({}).runtimeSettings 可读到
#   setValueByPath({}, ['__proto__','polluted'], 'yes') -> ({}).polluted === "yes"
#   对照 es-toolkit set（重构前实现）：set({},'a.__proto__.leak','x') -> ({}).leak === undefined（安全）
#   （注：constructor.prototype 路径不可用——其值非 object，会被 :40 的守卫替换成新对象）
# 紧凑时长（B-24）："2h30m" -> 1800（应 9000，被 (?=\s|$) 先行断言拒绝）；"2h 30m" -> 9000 ✓
# 属性检查顺序（B-7）：ruTorrent 元组注释逐项计数 14=torrent_label / 29=torrent_msg / 30=torrent_comment，
#   而代码用 [15] 与 [30]，其余下标（[23] get_hashing、[28] is_active 等）均与声明一致
# 位置伪类语义（正面结论 §7.12）：复算 positionalIndices(length=5) 全部边界并与 jQuery/Sizzle 对照
```

---

## 11. 修复阶段（本轮）：方式、结果与独立验证

> 本节记录「按本报告逐条修复」的执行结果。修复由 **10 个并行子代理 + 我本人**完成，随后由 **4 个独立对抗性验证代理**尝试推翻。**凡是验证代理推翻过的条目，都在 11.3 里如实列出——包括我自己造成的回归。**

### 11.1 执行方式

| 环节 | 做法 |
| --- | --- |
| 分域 | 按目录切成 10 个工作流（schemas / site utils / downloader / background+offscreen / messages+extends / stores+directives / options 视图 / Settings+MyClient / definitions / tests+CI），**每个文件只有一个写入者**，越界即失败 |
| 约束 | 禁止子代理运行全量门禁（`vue-tsc` / 全量 `vitest` / `vite build`）以免互相干扰；只允许定点 `eslint`、单文件 `vitest`、`node -e`；**禁止新增 `console.*`**（`no-console` 是 error，见 §5.1 Q-1） |
| 自证 | 每个修复必须给出「修复前的触发输入 → 修复后不再触发」的实测，能写测试的必须写测试，并**做变异测试**（把实现改回旧版，确认测试会红） |
| 审查 | 全部修复停手后，4 个验证代理按「重跑原始复现 + 变异测试 + 找修过头的回归」逐条对抗性复核；**只读，不许改仓库文件** |
| 我的收口 | 门禁文件（`eslint-suppressions.json` / `scripts/**` / `package.json` / CI）、跨代理接口、以及所有**无人认领**的条目由我处理 |

**为什么必须做变异测试**：本轮实测反复证明「测试全绿」毫无信息量——见 §11.3 的第 3、6、7 条。

### 11.2 逐条状态（116 条）

图例：✅ 已修复并验证 · 🔧 已修复但取值/语义需维护者确认 · 📋 有意不改（见 11.4）· ⏳ 由测试工作流收尾中

**阻断级**

| ID | 状态 | 说明 |
| --- | --- | --- |
| S-1 备份恢复不校验内容 | ✅ | 三层防御：**解析侧**（我）`packages/backupServer/utils.ts` 新增 `validateBackupPayload` + JSON 边界剥离 `__proto__` + 非枚举告警通道（13 条测试）；**写入侧**（WS4）`backupServers` 默认不恢复且不采信备份的 `backupFields`（收敛为「协议字段 ∩ 安全子集 ∩ 本次恢复字段」）、metadata 最小形状校验、写入失败逆序回滚；**UI 侧**（WS8）显著警示区块 + 默认 false 的开关 + 「将不恢复 N 个」+ 按结构化报告呈现结果。跨代理的报告类型 `IRestoreReport` 由我提到 `shared/types.ts` 并打通消息返回类型（原先只回 `boolean`，导致安全提示**到不了 UI**） |
| S-2 拖拽载荷与解析链接未校验来源 | ✅ | **schema 侧**（WS1）`fixLink` 协议白名单 http/https/magnet，危险 scheme 返回空串；**content-script 侧**（WS11）载荷形状+协议校验、忽略载荷里的 `site`/`id`、站点 host 白名单（定义 `urls`+`legacyUrls`+`siteHostMap`+当前页 host，允许同域族父子域以不误伤 CDN），并实测「`pt.example.com.evil.tld` / `evil-pt.example.com` / 异站」被拒 |
| S-3 123 个文件未跟踪 | 📋 | 无法由代码修复：需作者 `git add`。清单与验证命令见 §3 S-3 |

**高危（§4）**

| ID | 状态 | ID | 状态 | ID | 状态 |
| --- | --- | --- | --- | --- | --- |
| B-1 单行坏时间作废整站结果 | ✅ | B-9 盲目重试非幂等 RPC | ✅ | B-20 definitions 数据/结构 | 🔧/📋 |
| B-2 标题过滤器 | ✅（经 2 次更正） | B-10 双写者互相回滚 | ✅ | B-21 简体时长单位 | ✅ |
| B-3 torrent id 只取一位 | ✅ | B-11 下载历史读改写竞态 | ✅ | B-22 storagePath 原型污染 | ✅ |
| B-4 qBittorrent 限速端点 | ✅ | B-12 取消队列让任务悬挂 | ✅ | B-23 时区偏移静默回落 | ✅ |
| B-5 Transmission 键名 | ✅ | B-13 缺失守卫 | ✅ | B-24 单字符单位先行断言 | ✅ |
| B-6 ruTorrent 多剥一层 | ✅ | B-14 转义往返被破坏 | ✅ | B-25 async executor 永不 settle | ✅ |
| B-7 ruTorrent 下标错位 | ✅（经 1 次更正） | B-15 boolean 语义 | ✅ | B-26 总分享率累加 | ✅ |
| B-8 getter 改写 state | ✅ | B-16 状态化正则 | ✅ | B-27 过期响应写错站点 | ✅ |
| | | B-17 CF 重试丢失 DNR 头 | ✅ | B-28/29/30/31 视图层 | ✅ |
| | | B-18 fixer 未串行化 | ✅ | | |
| | | B-19 sessionStorage 污染宿主 | ✅ | | |

**中危（§5）/ 低危（§6）**

| 组 | 状态 | 说明 |
| --- | --- | --- |
| **Q-1** lint 门禁 | ✅ | 抑制文件剪枝（并发现它是**未跟踪文件**，见 §11.3-1）；期间因修复消除了 22 条历史违规，基线由 257 → **235 条** |
| **Q-2** `check:antd` 失败且无人调用 | ✅ | 脚本的 `classes-defined` 是**脚本自身误报**（已修）；`antdRuleLimit` 24→30（在报告里记录政策变更）；接入 `package.json` 与 CI |
| **Q-3** 三成测试断言源码文本 | ⏳ | 见 §11.3-6：本轮已有**两处实证**证明它的危害；由测试工作流按「断言最多的 6-8 个文件 + 变异测试」收尾 |
| **Q-4** WAR 通配 / Actions 未固定 | 📋/✅ | **WAR 只做风险文档化**（收窄成静态清单一旦遗漏依赖 chunk 会在**生产环境静默加载失败**，比指纹识别更严重；注释里写清了正确做法与为何本轮不做）。**Actions 已全部固定**到 40 位 commit SHA（13 处，`with/env/secrets` 一字未动），并新增 `check:pins` 门禁接入 CI；其中 `cardinalby/*` 的 `v1`/`v2` 实为**分支**（`tags/*` 返回 404），已用 `heads/*` + `commits/<sha>` 二次确认——分支比 tag 更可变，固定它们收益更大 |
| **Q-5** 包体预算计数错 | ✅ | firefox 曾把豁免文件也算作「就位」。**顺带强化了门禁本身**：`REQUIRED_ARTIFACTS` 原先**没有守护后台入口**，而它缺失时扩展能装上但**完全不能用**（比脚本头注释里担心的「空白页」更严重）。现已按目标区分守护（chrome `background/main.js` / firefox `background/ff_main.js`）并补上 `icons/logo/128.png`；两个目标都做了「移走产物 → 必须判红」的反证（chrome 9→11 项、firefox 9→10 项） |
| **L-1…L-10** | ✅ | L-1 采用「预留+失败回滚」而非字面「成功后记录」（否则同批任务会一起通过间隔检查，防轰炸失效）；L-9 顶层键删除**有意不做**（会让 store 默认值变 `undefined`）；L-7 只脱敏不删管线 |
| **D-1…D-8** | ✅/📋 | D-1 的 `dispose()` **有意不调用**：`index.ts` 与 `offscreen/utils/download.ts` 的 cacheKey 不同，dispose 会让 offscreen 正在用的实例失效（实测两个 key 确实不同） |
| **E-1…E-10** | ✅ | 每条都有「从 `git show` 抽旧实现 → 跑同一输入 → 变红」的变异证据 |
| **V-1…V-21** | ✅ | V-9 拆两半：i18n 错用（媒体服务器对话框显示「下载服务器」文案）由我修复；三份 ~20 行表单块的去重📋（需视觉验证） |
| **A-1…A-28** | ✅/📋 | A-11（死代码 `try/catch`）、A-12（空目录 `src/styles/vuetify/`）、A-28（空目录 `views/Devtools/`）由我修复；A-4（循环依赖，潜在、修它需改异步组件）📋；A-5（架构债，属有意的适配缝）📋；A-6/A-21（5 个被 83 处注释引用的文档缺失）📋——内容不可恢复 |

### 11.3 修复期间新发现的问题（含**我自己造成的回归**）

这一节是本轮最有价值的部分：**未经独立验证的修复会引入新缺陷，包括我自己写的**。

| # | 问题 | 来源 | 处置 |
| --- | --- | --- | --- |
| 1 | `eslint-suppressions.json` **根本不在 HEAD 中**（未跟踪）。「CI 红不红」取决于它如何被提交：不提交 → 252 个真实 error；提交未剪枝版 → exit 2；只有提交剪枝版才绿 | 我（门禁收口时） | 已剪枝；**仍需作者 `git add`**（见 S-3） |
| 2 | **19 个类型错误**：修复让 `vue-tsc` 从 exit 0 变 **exit 2**（会让 CI 变红）| WS6 顺带发现（它用 TS compiler API 自查），我复核 | 全部修完，`vue-tsc` 恢复 exit 0。**其中一条类型错误掩盖了真实运行时崩溃**：三个凭据掩码函数在 `<script setup>` 里对 ref 写 `ref.has(...)`（模板会自动解包、script 不会）→ 打开任何带凭据的编辑弹窗都会在渲染期抛 `TypeError` |
| 3 | **`tests/` 全部 103 个文件都是本会话新写的**（`git ls-files tests/` = 0）→「测试全绿」**不是**独立证据 | 验证代理 | 因此本轮把「变异测试」作为验收硬标准；也正因如此发现了下面第 6、7 条 |
| 4 | content-script 的注释里写了 `*://*/*`，其中 `*/` **提前闭合块注释** → `Parsing error: Expression expected`，会让构建与 lint 全红 | 我（lint 探针） | 已修；并要求全文件 grep 同类序列 |
| 5 | 我给出的「不要改 `eslint-suppressions.json`」与「修掉已基线化的违规」**互相矛盾**：删掉一条被豁免的 `console.log` 会让该条目变 stale → ESLint 10 直接 exit 2 | WS7 反馈 | 更正政策为「**棘轮只能往下走**」：该删的照删、由我统一剪枝。基线因此从 252 → 235 |
| 6 | `alertSemantics.test.ts` 维护一张写死的「文件→`<a-alert>` 计数表」，S-1 新增 1 个安全警示就让测试变红——**正确的改动让测试失败，而它没测任何行为**。这正是 Q-3 的教科书级实例 | WS7 发现、我复核确认 | 交由测试工作流改造为行为断言 |
| 7 | 验证代理用**变异测试**发现两处「自证」是空的：B-30 的 `commit` 计数阈值 `>=6` 而实际 8（去掉 1~2 处不会被发现）、且有一条断言可被 `loadFiles` 的 `finally` 满足（删掉 `resetDialog` 的复位它照样通过）；B-28 前 3 例只验证 `es-toolkit` 的 `cloneDeep`、不经过任何组件 | 验证代理 | 已记录，交测试工作流加强 |
| 8 | **我把 ptskit 的 `cross.key` 批量套到了 6 个分类组**（本该只给 `cat_normal`/`cat_special`）→ 媒介/编码/分辨率/制作组会发出 `cat1=1` 而不是 `medium1=1`，四个筛选静默失效并污染 `cat` 命名空间 | 验证代理（复刻本仓生成算法实测） | 已修：四组恢复不带 key 的 append。**教训：批量替换（`replace_all`）在配置数组里极危险** |
| 9 | **我的 B-2「字节级更正」本身就是错的**：我 hexdump 的是**注释行**（`sed -n '571p'`），而正则在被注释行隔开的 572 行且内容是 `\u00A0+`（NBSP **加号量词**，一个或多个）——原实现**本来就正确**。我据此批准的 `\s{3}`「修复」反而引入双向回归（单个 NBSP 不再切分；含 3 个 ASCII 空格的标题被新截断），并且**把错误前提写进了测试** | 验证代理（第二次） | 已回滚正则 + 重写测试为双向反回归断言（改回 `\s{3}` 会让其中 2 条变红） |
| 10 | **我在 B-7 上的「更正」也是错的**：我推断 `[30]`（`d.custom2`）承载 tracker 消息，于是加了 `[29] || [30]` 回退。上游一手源码证明相反：rTorrent `download.cc` 的 `receive_tracker_msg()` 写的就是 `d.get_message`（= `[29]`），ruTorrent 自己用 `values[29]` 判 error；`[30]` 是 **Comment**（ruTorrent 发种时会把种子 comment 写进去）→ 我的回退让**任何带 comment 的已停止种子显示为 error** | 验证代理（第三次） | 已回滚为只读 `[29]`，并把测试改成「`[30]` 不得参与错误态判定」的反回归断言（加回回退会让它变红） |
| 11 | 我的 `(?![A-Za-z])` 边界**命中非 ASCII 字母**：`"1 hónapja"`（匈：1 个月前）被解析成 3600 秒（1 小时）——把「明确失败」变成「静默错值」，正是 B-21 要消灭的缺陷类别。可达路径：`ncore.ts`（匈牙利语站点）只归一化 `éve/hete/napja/perce`，没有 `hónap`/`hét` | 验证代理（第二次） | 已改为 `(?!\p{L})` + `u` 标志，并补反回归断言（改回旧边界会变红） |
| 12 | Aria2 的 `timeout` **不覆盖建连阶段**：半开 TCP 下握手永不完成 → 调用方永久挂起（UI 一直 loading），且定时器先行 reject 的 promise 无人 await → unhandled rejection | 验证代理（第三次） | 已加 `Promise.race` 建连超时 + no-op catch；两条新断言在旧实现下 **3000ms 超时**（证明会挂死） |
| 13 | **beyondhd 的 `key: "internal"` 不是合法 API 参数**：Jackett `BeyondHDAPI.cs` 的 `BHDParams` 全量枚举里没有它（相关的只有 `groups`） | 验证代理（第三次），我独立抓上游源码复核 | 该组**移除**（同节其它组用 `key: ""`+append 把选项 value 当参数名发出，全部合法；唯独它无对应参数）。注：原先的 `key: "types"` 也是错的（覆盖 Type 组） |
| 14 | 视图层 `record.ratio.toFixed(2)` **无守卫**，而 `ITorrent` 根本没声明 `ratio`（由各下载器实体自行附加）→ 字段缺失时抛 `TypeError`，**让整个 antd 表格渲染崩掉** | 我（全量测试的 unhandled error 里定位到 `MyClient/Index.vue:557`） | 新增共享 `formatRatio()`（缺失/非有限数 → `"-"`），修 `Index.vue` 与 `TorrentDetailDialog.vue` 两处 |
| 15 | `tests/` 下反复出现修复代理留下的 `zz-scratch-*.test.ts` 临时探针（会让整套测试变红，且若提交会成为永久噪音） | 我（全量测试 + 验证代理同时发现） | 已删除 3 个；已要求代理把探针写到 `/tmp` |
| 16 | 验证代理发现「有 5 个条目（V-17/18/20/21、A-27）**完全没有测试覆盖**」，另有 2 条断言经变异证明无区分力 | 验证代理 | 已记录；A-19（favicon 修复）同样**仓库零测试**，值得补 |
| 17 | A-11/A-12/A-28/V-9(i18n) **四个条目起初无人认领**——分域时落进了缝隙 | 我 | 已由我补修 |
| 18 | **把「源码断言」改成「行为断言」后，立刻暴露出一个真实的用户可见缺陷**：`MyClient/Index.vue` 的圆形进度把 `formatTorrentProgressLabel(...)` 放在 `<a-progress>` 的**默认插槽**里，而 antd-vue 的 Progress **文字来源是 `format` prop / `#format` 插槽**（`es/progress/progress.js`：`textFormatter = format \|\| slots.format \|\| (v => \`${v}%\`)`）→ 该格式化**从未到达用户**（用户看到 antd 默认的 `12.6%`，而 36px 圆环里也放不下）。**原来那条源码断言恰好守住了这段死代码**——这是 Q-3 危害最生动的一例 | 测试工作流（行为化时发现），我修复 | 改为 `:format="() => formatTorrentProgressLabel(record.progress)"`，用户现在看到 `13%`；测试同步改成断言**作者意图**（`13%` / 越界夹到 `100%`），并在注释里写明反回归理由 |
| 19 | **`scripts/check-bundle-budget.mjs` 的 `REQUIRED_ARTIFACTS` 没有守护后台入口**：chrome 的 `background/main.js`（service worker）与 firefox 的 `ff_main.js` 都不在清单里。它缺失时扩展能装上但**完全不能用**——比脚本头注释里担心的「空白页」更严重 | 我（在核对 Q-5 时发现清单与 manifest 不一致） | 按目标区分守护后台入口 + 补 `icons/logo/128.png`；两个目标都做了「移走产物 → 必须判红」的反证（chrome 9→11 项、firefox 9→10 项） |
| 20 | `scripts/check-action-pins.mjs`（校验所有 `uses` 已固定）由测试工作流新建但**按约束没有接入 CI**；`Q-4(b)` 的 Actions 固定本身有一处认知偏差需要记录：`cardinalby/*` 的 `v1`/`v2` 实为**分支**而非 tag（`git/ref/tags/*` 返回 404），比 tag 更可变，固定它们收益更大 | 我（收口门禁） | 已接入 `package.json`（`check:pins`）与 CI（`action pins` 步骤），并用「临时改回 `@v7` → 判红」反证 |
| 21 | **【真实 UI 缺陷，既有】ruTorrent 的分享率放大 1000 倍**：`ruTorrent.ts` 直接 `ratio: iv(rawTorrent[10])`，而 rTorrent 的 `d.get_ratio` 返回的是**千分比**（`(1000 * upTotal) / bytesDone`），ruTorrent 自己的 UI 也按 `/1000` 显示 → ratio 1.0 在 MyClient 里显示成 `1000.00` 且判定为达标变绿 | 第 5 位验证代理（拉上游源码 + 19 字段位次自洽 + 同仓 uTorrent `/1000` 先例） | 已修（`/1000`），并补 2 条守卫（1500 千分比 → 1.5；0 → 0 且非 NaN）；变异反证：改回未归一 → 变红 |
| 22 | **`formatRatio` 的语义与自身文档、与 MyData 都不一致**：`formatRatio("")` 走 `Number("")` 得到 `0` → 显示 `"0.00"`（把「没有数据」显示成 0）；`Infinity` 显示 `"-"` 而 MyData 的 `realFormatRatio` 显示 `"∞"`（同一概念跨页不同）；且颜色表达式用 `Number.isFinite("2.5")` → 文本显示 `2.50` 却是**危险色** | 第 5 位验证代理（真函数逐值对拍 + 表达式级颜色证明） | 已修：空串/空白串 → `"-"`；`Infinity`/`≥10000` → `"∞"`（与 MyData 对齐）；新增 `isRatioHealthy()` 与文本**共用同一归一化**；文档里那条拿 `ITorrent` 解释 `CTorrent` 的错误理由也已改正 |
| 23 | **两条注释事实错误**：`ruTorrent.ts` 称「`m_message` 正是 `d.get_message`（`command_download.cc:820`）」——820 行其实是 `d.message.set`（819 才是 `d.message`），且 rTorrent 侧**没有** `d.get_message`（那是 ruTorrent 仍在请求的旧名）；`formatRatio` 的理由引用了 `ITorrent`，而调用点的 `CTorrent.ratio` 在 `downloader/types.ts:139` 是**明确声明**的 | 第 5 位验证代理 | 两处均已按上游/实际类型改写。**这正是本轮反复出现的教训：注释不能作为验收依据** |
| 24 | **三个覆盖缺口**（验证代理实测后建议补的守卫）：① Aria2 删掉成功路径的 `clearTimeout(connectTimer)` 后 **12/12 仍全绿**（定时器泄漏无防线）；② ptskit 的 `cross.key`（正是我造成并修好的 B-20a）**仓库内零测试**；③ MyClient 分享率的颜色分支零覆盖，且 fixture 默认把 `raw[30]` 填成判定用的白名单哨兵，会让「把 `[30]` 当消息」的回归在 14/15 用例里静默通过 | 第 5 位验证代理 | 三条守卫全部补齐：Aria2 用 fake timers 断言成功请求后 `getTimerCount() === 0`（变异：删清理 → `expected 1 to be +0`）；新增 `tests/packages/site/definitions/ptskitCategories.test.ts`（用**真实生成器 + 真实定义**断言六组各自发 `cat{N}`/`medium{N}`/`codec{N}`/`standard{N}`/`team{N}`，变异：复现我的错误 → 3 条红）；`isRatioHealthy` 契约测试 + 颜色/文本同源断言；ruTorrent fixture 的 `raw[30]` 默认值改为中性空串 |

### 11.4 未修复 / 有意不改（含理由）

| 条目 | 为什么不做 |
| --- | --- |
| **S-3** `git add` 123 个未跟踪文件 | 属作者的版本控制决策；我给出清单与「干净克隆验证」命令（§3 S-3） |
| **Q-4(a)** 收窄 `web_accessible_resources` | 改成构建期静态清单一旦遗漏依赖 chunk，会在**生产环境静默加载失败**（比指纹识别更严重），且本轮无法做浏览器验证 → 只把风险与正确做法写进代码注释 |
| **A-6 / A-21** 补 5 个被 83 处注释引用的 `docs/*.md` | 内容不可恢复；需维护者补写或把关键不变量内联进代码后删除悬空引用 |
| **A-4** content-script 的静态循环依赖 | 当前**不可达**（组件映射表只在渲染期使用）；修它需要改异步组件，会引入加载态闪烁，风险 > 收益 |
| **A-5** `@ptd/site` 反向依赖 entries 层 | 文件头明确记录的**有意适配缝**，属架构债而非缺陷 |
| **A-7** 大列表页每次点击 `cloneNode(true)` | 属性能优化，需要真实页面的测量与重构验证，不在「修复缺陷」范围 |
| **A-14** `myanonamouse` 的节流值 | 需要一个「合适的延迟数值」，属维护者对站点容忍度的决策（MAM 以严格著称，乱给值可能让用户信息刷新极慢） |
| **B-20e** `levelRequirements` 的死字段（`uniqueGroups`/`percentile`/`downgrade`） | 实现它们等于在 `level.ts` 里写新功能（跨引擎），不是修复 |
| **B-20d/g** `okpt`/`xdypt`/`freeunfarm`/`crabpt` 的重复取值与重名项 | **需要真实站点的分类/制作组 id 或名称**；站点均需登录，猜错会把「重复」变成「错值」，比现状更糟 |
| **V-9** 三份 ~20 行表单块去重 | 需对着 3 个表单做视觉验证（字段顺序/校验/可见性都要一致），本轮无法做浏览器验证 |
| **D-1** 淘汰实例时 `dispose()` | 会打断 offscreen 正在使用的实例（两个 cacheKey 不同，实测确认），后果是「Aria2 下载全部失败」，远重于泄漏一个 WS。正确释放点在 offscreen（它才是所有者） |
| **L-9** 删除「本地有、外部新值整个顶层 key 缺失」的键 | 会让 store 的默认值变成 `undefined`（例如 `siteHostMap` 被 `Object.keys` 直接消费），风险高于收益 |
| **ccfbits / minept** 的 `schema` 声明（同 `totheglory` 类问题） | 两者都是 `isDead: true`，声明**不可达**；改它零收益、只增加 diff 噪音。（`totheglory` 是**在线**站点，故已改） |

**已知残留（有意的取舍，均已写进代码注释）**：B-9 让幂等写类消息失去自动重试（需幂等键才能安全重试）；B-10 仍无版本号/CAS，且每次 `$save()` 多一次全量 `storage.get`（实测 452KB 状态约 1.6×，2.22 vs 1.41 ms/次）；A-1 的响应方向未序列化且 `Error` 转换会丢 `code`/`status` 等自有属性（当前无受害消费方）；L-1 的间隔时间戳存 `storage.session`，浏览器重启后首次下载仍会绕过间隔；B-12 只能保证 promise settle、无法中断已在执行的站点抓取。

### 11.5 独立验证的结论

4 个验证代理（只读、全部用 `/tmp` 副本做变异）的核心结论：

- **20/20 变异测试全部变红**（下载器/消息层），即那些测试**真的**在守缺陷，不是空断言。
- 对修复代理自证的评估：**机械类修复（重命名、去重、ISO 时长、`await`、选择器、注释清理）质量好、没有一条是假的**，每条都能在上游源码或 git HEAD 里找到对应证据；**视图层修复逻辑成立、接线完整**，但证据链多为「自己写源码断言 + 自己写测试」，其中已证实有 2 条断言无区分力、5 个条目零覆盖。
- **最危险的改动恰好来自「没有经过自查流程」的那批**（第 8、13 条是我用批量替换/推测做的定义层改动）——这条结论对修复流程本身有普遍意义。
- 验证代理也**推翻失败**了很多怀疑（例如想让 A-2 通过嵌套/数组绕过、想让 B-9 白名单漏收只读消息、想让 D-2/D-3/D-4 无限递归、想让 B-17 泄漏 DNR 规则、想让 A-18 的 oracle 被篡改——最后一项它用 sha256 与 unpkg 上游逐字节比对证伪）。

### 11.6 门禁最终状态（全部实跑）

| 门禁 | 修复前 | 修复后 |
| --- | --- | --- |
| `npx vue-tsc --noEmit` | ✅ exit 0 | ✅ **exit 0**（中途曾因修复退化到 exit 2 / 19 个错误，已全部修回） |
| `npx eslint .` | ❌ **exit 2**（抑制文件有 5 条 stale） | ✅ **exit 0**（基线 257 → **235** 条，真实消除了 22 条历史违规） |
| `npx vitest run` | ✅ 74 文件 / 430 通过 | ✅ **104 文件 / 758 通过**（无失败、无 unhandled error） |
| `npm run build:dist`（chrome） | ✅ exit 0 | ✅ exit 0 |
| `npm run build:dist-firefox` | ✅ exit 0 | ✅ exit 0 |
| `npm run check:antd` | ❌ exit 1（12 项中 2 项失败）且**无人调用** | ✅ **exit 0（12/12）**，已接入 `package.json` 与 CI |
| `npm run check:bundle` | ✅（但计数打印错误） | ✅ **exit 0**；chrome **11/11**、firefox **10/10**（原 9 项，我补上了后台入口与图标） |
| `npm run check:pins` | （无此门禁） | ✅ **exit 0**（13 处 `uses` 全部固定到 40 位 commit SHA），已接入 `package.json` 与 CI |
| `npm run test:e2e`（Playwright + 真实 Chromium 加载构建产物） | ✅ | ✅ **exit 0**（`Extension smoke E2E passed`） |

**真实浏览器验证的意义**：验证代理明确指出「没有起浏览器做端到端点击」。本轮补跑了 CI 用的 Playwright 冒烟门禁（真实 Chromium + 临时 profile 加载 `dist-chrome`），覆盖「选项页在真实扩展上下文里挂载 / 顶栏搜索按钮导航 / Set Site 的 Add 与 Rebuild 两个弹窗」——这是唯一能证明「本轮大量模板级改动没有把页面改坏」的门禁。

**给维护者的三条提醒**：

1. **提交前必须 `git add -A`**：`eslint-suppressions.json`、`eslint.config.mjs`、`vitest.config.ts`、`package-lock.json`、整个 `tests/` 与 `scripts/`、以及 29 个 `src/` 源文件（含 `selector.ts`）**都还是未跟踪状态**（S-3）。只提交已跟踪文件的改动会得到一个 `npm ci` 就失败的提交。验证方式见 §3 S-3 的「干净克隆」命令。
2. **新增/改写的测试全部由 AI 在本会话内编写**：关键项做了变异测试（20/20 变红 + 7/7 哈希校验还原），但 `tests/**` **不在 `eslint` 的覆盖配置内**（`npx eslint tests/...` 会输出 "File ignored"，**0 error 是假绿**），因此测试代码的门禁实际只有 `vitest` 与 `vue-tsc`。
3. **仍有 5 个条目零测试覆盖**（V-17/V-18/V-20/V-21/A-27）与 1 个修复零测试（A-19 favicon）；`B-30`/`B-28` 各有 1-2 条经变异证明无区分力的断言（详见 §11.3-16）。这些是最值得后续补强的地方。
