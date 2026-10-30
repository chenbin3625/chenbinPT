# #1611「站点定义改为构建期轻量索引」移植实现说明

- 上游提交：`8c6022c98c` `perf(site): 站点定义改为构建期轻量索引，固定属性读取不再解析完整定义 (#1611)`
- fork 工作区：`/tmp/w-index`，分支 `sync/site-index`，base `6990c085`
- 分析依据：`docs/upstream-sync-2026-10-30/B-core-logic.md` 的「8c6022c98c …（#1611，重点）」一节

## 1. 结论

已在 fork（npm + wxt 0.21.4 + vite 8.3.2 + ant-design-vue）落地构建期轻量索引：

- 索引由嵌套 Vite SSR 构建 + Node 求值生成，取值为**与 app 完全相同的** `getDefinedSiteMetadata()`，
  再经 `pickSiteMetadataIndexEntry()` 抽取固定属性（不存在第二套实现，值不会漂移）。
- 产出 **409 个站点 / 117,440 B（gzip 25,596 B）** 的索引，经虚拟模块 `virtual:site-metadata-index`
  进入 `options` 与 `cs-app` 产物（`metadata` chunk 236,032 B 内含 409 条 `urls:`）。
- 消费方（metadata store / Topbar / MyData / MyClient / SetSite 四个对话框）命中索引字段时不再
  import 完整站点定义；未收录字段（`category` / `search` / `userInfo` / `levelRequirements` …）
  继续回落完整定义。编辑器（`Editor.vue`）与 MyData 等级信息仍走完整定义（索引明确不收录）。

## 2. Commit 列表（分支 `sync/site-index`）

| #   | commit     | subject                                                                     |
| --- | ---------- | --------------------------------------------------------------------------- |
| 1   | `eb5622b7` | `feat(site): 新增站点定义轻量索引的字段契约与构建期生成插件`                |
| 2   | `cb1f6467` | `perf(options): 固定属性改读构建期站点索引，首次打开不再解析全部站点定义`   |
| 3   | 本提交     | `test(site): 补站点索引字段契约测试并适配受影响的 options 用例`（含本文件） |

三个 commit 的 body 都写明「移植自上游 8c6022c98c（#1611）」与 fork/wxt 适配说明。

## 3. 文件清单

### 3.1 新增（commit 1）

| 文件                                       | 说明                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `src/packages/site/types/metadataIndex.ts` | `ISiteMetadataIndexEntry` / `TSiteMetadataIndex` / `TSiteMetadataIndexEntryWithId`（条目不含 id，key 即 id）              |
| `src/packages/site/utils/metadataIndex.ts` | `INDEXED_METADATA_FIELDS`、`isIndexedMetadataField()`、`pickSiteMetadataIndexEntry()` —— 「索引里有什么」的唯一出处       |
| `src/packages/site/metadataIndex.ts`       | 虚拟模块入口（`import { siteMetadataIndex } from "virtual:site-metadata-index"`），**故意不从 `@ptd/site` barrel 再导出** |
| `vite/plugin/generateSiteIndex.ts`         | 构建插件（生成 + sha256 磁盘缓存 + dev 失效监听），从上游取主体、按 fork 改 4 处（见 §4）                                 |

### 3.2 修改（commit 1）

- `src/packages/site/utils/helper.ts`：`checkSiteMetadataAllow` 从 `site/index.ts` 下沉到这里
  （生成器 Node 侧要用同一口径）。`index.ts` 改为 `import { checkSiteMetadataAllow } from "./utils/helper.ts"`，
  并经 `export * from "./utils"` 继续对外暴露，**公共 API 不变**。
- `src/packages/site/index.ts`、`src/packages/site/types.ts`、`src/packages/site/utils.ts`：删本地
  `checkSiteMetadataAllow` / 追加 barrel 导出。
- `src/vite-env.d.ts`：`declare module "virtual:site-metadata-index"`。
- `wxt.config.ts`：`vite: (env) => ({ plugins: [vue(), projectAliasPlugin(target), vitePluginGenerateSiteIndex()] })`。
- `vitest.config.ts`：同样注册该插件（见 §4.5）。

### 3.3 消费方（commit 2）

| 文件                                                              | 改法                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/entries/options/stores/metadata.ts`                          | `getSiteMergedMetadata` 命中 `isIndexedMetadataField()` 时先查索引，未命中回落完整定义；`getSiteUrl` 取索引 `urls[0]`；`getSiteDefaultSearchSolution` 用索引 `isDead` + 是否有 `searchEntries` 决定是否加载完整定义         |
| `src/entries/options/views/Layout/Topbar.vue`                     | `refreshSingleSearchSiteIds` 变同步，`isDead` 直接查索引（原先 immediate+deep watch 每次都解析全部定义）                                                                                                                    |
| `src/entries/options/views/Overview/MyData/utils/siteMetadata.ts` | `type/name/aka/hasUserInfo/isDead` 取索引；favicon 与「定义不可用」聚合提示（OPTIONSSHELL-2）保留；`IExtendSiteMetadata` 改用 `Pick<TSiteMetadataIndexEntryWithId, "id" \| "type">`                                         |
| `src/entries/options/views/Overview/MyClient/torrentSite.ts`      | `getSiteType` 直接 `siteMetadataIndex[siteId]?.type ?? "public"`                                                                                                                                                            |
| `src/entries/options/views/Settings/SetSite/utils.ts`             | `iterateCanAddedSiteMetadata` / `getCanAddedSiteMetadata` → 同步 `getCanAddedSiteIndexEntries()`；`ISiteTableItem.metadata: ISiteMetadataIndexEntry`；`allAddedSiteInfo` 改同步 `computed`（删除 `isLoadingAddedSiteInfo`） |
| `.../SetSite/AddDialog.vue`                                       | `allUnAddedSites` 改索引数组，同步加载                                                                                                                                                                                      |
| `.../SetSite/OneClickImportDialog.vue`                            | 去掉渐进加载 / `siteListLoadToken` / 进度条 / `PageSkeleton`，`userInputSettingMeta` → `hasUserInputSettingMeta`                                                                                                            |
| `.../SetSite/EditSearchEntryList.vue`                             | `metadata.searchEntry` → `metadata.searchEntries`（类型换 `ISiteMetadataIndexEntry`）                                                                                                                                       |
| `.../SetSite/Index.vue`                                           | `Object.hasOwn(metadata,'search'/'userInfo')` → `hasSearch`/`hasUserInfo`；`metadata.searchEntry` → `searchEntries`；`:loading` 去掉 `isLoadingAddedSiteInfo`                                                               |
| `src/locales/{en,zh_CN}.json`                                     | 删除不再使用的 `SetSite.oneClickImportDialog.loading`                                                                                                                                                                       |

**未改**（仍走完整定义）：`SetSite/Editor.vue`、`MyData/utils/siteMetadataCache.ts`（等级/用户信息）、
`offscreen/utils/site.ts`、站点搜索解析路径、`siteMetadataCache` 的 favicon 逻辑。

### 3.4 测试（commit 3）

- 新增 `tests/packages/site/utils/metadataIndex.test.ts`：把上游 `vite/checkSiteDefinition.ts` 的
  `checkMetadataIndexContract()` 按 fork 惯例改成 vitest 行为断言 —— 抽取函数实际写出的键集合 =
  `INDEXED_METADATA_FIELDS` + 派生键（`hasUserInputSettingMeta/hasSearch/hasUserInfo/searchEntries`）；
  `isIndexedMetadataField()` 与名单一致；只写「有值」字段；`searchEntries` 只保留 `name/enabled`；
  索引与完整定义比对（`searchEntries` 键集全量、固定属性抽样）；索引覆盖 `definitionList`。
- 适配受影响用例（都是本次行为变更的直接结果）：
  - `oneClickImportProgressive.test.ts` → 改名 `oneClickImportIndexList.test.ts`（渐进加载已不存在，
    改为「打开即全量 / 无加载中间态」，保留懒挂载与 public 开关断言），并新增
    `getCanAddedSiteIndexEntries` 的顺序/跳过已添加/补 id 用例；
  - `myDataSiteMetadataResilience.test.ts`：失败来源改为「索引缺失 / favicon 失败」，补索引 mock
    与「type/aka/hasUserInfo 取自索引」用例；
  - `myClientTorrentSite.test.ts`、`metadataSearchSolution.test.ts`：补 `@ptd/site/metadataIndex` mock；
  - `settings-a.review-fixes.test.ts`、`setSiteFaviconSize.test.ts`、`settingsSaveInFlight.test.ts`：
    SetSite/utils 的 mock 换成新 API。

## 4. wxt 适配细节（与上游的 4 处差异）

1. **模块级 memo**：一次 `wxt build` 会依次跑 `background` / `content` / `cs-app` / `offscreen+options`
   多个 Vite 构建，`vite: (env) => ({ plugins: [...] })` 返回的插件在每个子构建里都会被重新实例化，
   上游放在插件工厂闭包里的 promise 挡不住重复生成。改为模块作用域的
   `generatedIndexBySourceHash: Map<sourceHash, Promise<Index>>`（失败时从 memo 里摘除，便于重试）。
   实测：`cs-app` 子构建触发一次生成，后面的 `offscreen/options` 直接复用。
2. **缓存 / 中转目录固定在项目内**：`path.join(config.root, "node_modules/.cache/ptd-depiler/")`。
   生成产物要在 Node 里 `import()` 求值，而站点定义链会用到 `axios` / `date-fns` / `es-toolkit`
   等被 SSR 构建外部化的依赖 —— 只有写进项目内 `node_modules` 才能被 Node 解析到（写 `/tmp` 会
   `ERR_MODULE_NOT_FOUND`）。
3. **hash 源文件集合补 fork 的聚合层**：除 `definitions/`、`schemas/`、
   `utils/{metadataIndex,helper}.ts`、`types/metadataIndex.ts` 外，再纳入
   `src/packages/site/utils.ts`（barrel）与 `src/packages/site/index.ts`
   （`getDefinedSiteMetadata` 的 `cloneDeep` / rot13 还原 / `tags ??= []` / `timezoneOffset` 口径）。
4. **抽取调用点移进生成的入口文件**：上游插件自己 `import { pickSiteMetadataIndexEntry } from "../../src/…"`；
   fork 的 `vite/**` 属于 `tsconfig.node.json` 这个 composite project（`npm run check:node`），
   插件直接 import `src/**` 会把整张 `src/packages/site` 文件图拉进该 project 并触发 39 个
   TS6307（"File ... is not listed within the file list"）。改为生成的 `entry.ts` 里
   `import { pickSiteMetadataIndexEntry }` 并在 bundle 内调用，插件只做 JSON 序列化
   （类型由 `src/vite-env.d.ts` 的虚拟模块声明保证）。

其他适配：

- 嵌套构建复用主构建的 `define` / `resolve.alias`（`configResolved` 里取），并自带
  `FALLBACK_DEFINE` 兜底 `__BROWSER__` / `__RESOURCE_SITE_ICONS__` / `__EXT_VERSION__` 等
  构建期常量（缺了会在 Node 求值期 `ReferenceError`）；`configFile: false` 防止递归加载。
- 最小 DOM 打桩（`window/self/document/location/localStorage/matchMedia`）用完立刻删除，
  不给同进程的 Vite 构建留下 `typeof window !== "undefined"` 的错误分支。
- 索引与产物：`options` 走 `chunks/metadata-*.js`、`cs-app.js`（content-script app 会 import
  `@/options/stores/metadata.ts`）；`content-bootstrap` 不受影响。
- `.dsh/skills/ptd-site-definition/scripts/check-site-definition.mjs` **未改**：它是主仓库的
  untracked 文件，worktree 里没有；「新增固定属性需同步 `INDEXED_METADATA_FIELDS`」这条约束
  已写进 `utils/metadataIndex.ts` 的注释、并由本次新增的 vitest 契约测试强制执行（比注释更强）。

### 4.5 为什么 vitest 也要注册这个插件

`vitest.config.ts` 里注册同一个插件的原因：大量既有单测会 import 真实的
`@/options/stores/metadata.ts`（以及 Topbar / SetSite / MyData 页面），它们现在都 import
`@ptd/site/metadataIndex` → `virtual:site-metadata-index`。不注册插件会直接解析失败。
生成结果与 wxt 构建共用同一份磁盘缓存：`vitest run` 首次多约 1 s，之后命中缓存（实测单文件
用例总耗时 1.09 s）。

## 5. 验证结果（全部本地实跑）

### 5.1 类型检查

```
$ ./node_modules/.bin/vue-tsc --noEmit
$ echo $?
0

$ ./node_modules/.bin/tsc -p tsconfig.node.json --noEmit
$ echo $?
0
```

### 5.2 测试

```
$ ./node_modules/.bin/vitest run tests/packages/site
Test Files  1 failed | 55 passed (56)
Tests       1 failed | 965 passed (966)
```

（若连同本次改过的几支 options 用例一起跑：`Test Files 1 failed | 56 passed (57)` /
`Tests 1 failed | 971 passed (972)`，失败项同样是下面这一条。）

其中唯一失败是 **base commit 就存在** 的：
`tests/packages/site/definitions/defs-round2-review-fixes.test.ts`（momentpt 已在 `9bfb0874`
标记为死站并注释掉 userInfo，而 `ede867a3` 的用例仍断言 invites 选择器）。已验证方式：把
`6990c085` 用 `git archive` 导出到 `/tmp/base-check`（软链 node_modules）后跑同一用例，同样失败。

全量 `vitest run`：

```
Test Files  2 failed | 273 passed (275)
Tests       1 failed | 2715 passed (2716)
```

两个失败都是 base 就有的、与本次改动无关：

1. `tests/packages/site/definitions/defs-round2-review-fixes.test.ts`（同上）；
2. `tests/entries/content-script/mountRemountLimit.test.ts`（0 test）——
   `Error: Denied ID /Volumes/SSD 1/code/PT-depiler/node_modules/ant-design-vue/dist/reset.css?inline`。
   本环境的 `node_modules` 是软链到主仓库、位于 Vite `fs.allow` 根之外，属环境问题；
   在 `/tmp/base-check`（同软链方式）下同样失败。

### 5.3 构建（`npm run build:dist`，清空缓存后首次）

```
WXT 0.21.4
Generated public/_locales/en/messages.json
Generated public/_locales/zh_CN/messages.json
ℹ Building chrome-mv3 for production with Vite 8.3.2
⠏ Preparing...⠋ [1/4] background⠋ [2/4] content⠋ [3/4] cs-appsetupReplaceUnsafeHeader() should be called only once
⠋ [4/4] offscreen, options
✔ Built extension in 2.907 s
  ├─ dist-chrome/options.html                                 3.98 kB
  ├─ dist-chrome/background.js                              165.43 kB
Σ Total size: 10.09 MB
✔ Finished in 3.276 s
```

`setupReplaceUnsafeHeader() should be called only once` 出现在 `cs-app` 子构建阶段，正是嵌套
SSR 构建产物在 Node 里求值时打出的（站点定义链 → `utils/adapter.ts` 的副作用），可作为
「索引确实在 wxt 构建里生成了」的证据。

二次构建（命中缓存，缓存文件 mtime 不变）：

```
✔ Finished in 2.557 s
```

### 5.4 索引产物 / 大小

```
node_modules/.cache/ptd-depiler/site-metadata-index.json   117,498 B（含 sourceHash 外壳）
node_modules/.cache/ptd-depiler/site-metadata-index-build/  entry.ts/entry.mjs + 430 chunks（中转）
索引本体（紧凑 JSON）：117,440 B，gzip 25,596 B，409 个站点
hasSearch 322 / hasUserInfo 246 / isDead 89 / searchEntries 20 / hasUserInputSettingMeta 20
```

构建产物中的索引（`dist-chrome/chunks/metadata-*.js`，236,032 B）：

```
MomentPT: true
urls: occurrences: 409
hasSearch:!0: 322
isDead:!0: 89
```

### 5.5 产物体积（`npm run check:bundle`）

```
✓ total                                         9.62 MB  / 预算 10752.0 KB
✓ content-bootstrap                             15.7 KB  / 预算 32.0 KB
✓ largest-js-chunk (content-scripts/cs-app.js)  3219.2 KB / 预算 3584.0 KB
✓ 构建产物完整且未超预算
```

`cs-app` 因带上索引 +117 KB（预算内），`content-bootstrap` 不受影响。

## 6. 与上游的偏差

| 项                                     | 上游 #1611                                                      | fork 实现                                                       | 理由                                                                                                                                   |
| -------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 抽取函数调用点                         | 插件内 import `src/packages/site/utils/metadataIndex.ts`        | 生成的 `entry.ts` 内调用                                        | fork 的 `check:node`（composite project）会因为插件 import `src/**` 触发 39 个 TS6307                                                  |
| 契约校验                               | `vite/checkSiteDefinition.ts` 的 `checkMetadataIndexContract()` | `tests/packages/site/utils/metadataIndex.test.ts`               | fork 没有 `vite/checkSiteDefinition.ts`，静态检查在未被跟踪的 `.dsh` skill 脚本里；vitest 契约测试更强（还比对了真实定义与缓存新鲜度） |
| 索引里没有的「已添加站点」             | SetSite 表格直接过滤掉该行                                      | 保留一行占位（`{name: siteId, type: "public", urls: []}`）      | 否则用户无法删除「站点定义已从构建产物移除」的旧配置（fork OPTIONSSHELL-2 专门为此加过提示）                                           |
| MyData `hasUserInfo`                   | `!!indexEntry.hasUserInfo`（= `checkSiteMetadataAllow`）        | 同上游（但 fork 原实现是 `Object.hasOwn(metadata,"userInfo")`） | 与 offscreen 初始化 `allowQueryUserInfo` 的口径一致；差异站点：`torrenting`（`userInfo: {}`）                                          |
| `SetSite.oneClickImportDialog.loading` | 删除 + 新增 4 个 siteType* 文案                                 | 只删 `loading`；不新增 siteType*                                | fork 的 antd 版一键导入已用 `a-tag` 颜色区分 private/public，不需要上游为图标 tooltip 新增的文案                                       |
| 类型图标（锁/地球）                    | Index.vue / OneClickImportDialog 增加                           | 未加                                                            | Vuetify 专属改动，且 fork 已有等价的信息展示；与 #1611 的性能目标无关                                                                  |

## 7. 风险与后续

1. **字段契约漂移**：`INDEXED_METADATA_FIELDS` 与抽取函数不一致时，消费方会静默拿到 `undefined`
   且不回落。已由新增契约测试钉死（键集合双向比对 + 真实定义比对）。
2. **`searchEntries` 只保留 `name/enabled`**：若将来 options 侧要读入口自己的 `requestConfig`
   （含函数，进不了索引），必须回落完整定义。当前 `EditSearchEntryList` 只读 name/enabled，安全。
3. **`hasUserInfo` 口径变化**：`torrenting` 这类 `userInfo: {}` 的站点在 MyData 里不再显示为
   「有用户信息」（与 offscreen 的 `allowQueryUserInfo` 默认值一致），属修正而非回归。
4. **索引缓存与浏览器目标**：`__BROWSER__` 在站点包内只影响 `definitions/hdsky.ts` 的
   `baseIdSelector`（search selectors，不进索引）与 `utils/favicon.ts`，因此 chrome / firefox
   两次构建可共用同一份缓存；若将来有定义把 `__BROWSER__` 用于 `urls`/`name` 等索引字段，
   需要把该 define 也纳入 hash（插件里有注释提示）。
5. **`node_modules` 是主仓库软链**：按上游/分析报告要求，缓存与中转目录写在项目内
   `node_modules/.cache/ptd-depiler/`；在本环境里它物理落在主仓库的 `node_modules/.cache/` 下
   （gitignored 构建缓存，不改依赖、可按需删除；文件按源码 sha256 命名，与主仓库自身构建互不污染）。
6. **索引未在运行时校验**：索引里没有的已添加站点会走「定义不可用」路径（SetSite 占位行 /
   MyData 聚合提示 / Topbar 视为非 isDead），与改动前的失败行为一致或更温和。
