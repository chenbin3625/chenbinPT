# 迁移实现说明：表格操作列位置与固定（上游 #1598）

- 上游提交：`58be52e883` — `feat(options): 表格操作列支持配置位置与固定，设置页新增「数据表格」分区 (#1598)`
- fork 分支：`sync/table-action`（base `6990c085`）
- 分析依据：`docs/upstream-sync-2026-10-30/C-ui-antd.md` 的「58be52e883 …(#1598)」一节
- 语义：新增两个全局配置 `tableActionColumnPosition: "start" | "end"`（默认 `end`）与
  `tableActionColumnFixed: boolean`（默认 `false`），设置页「数据表格」分区可配；14 张表的操作列按配置
  移到行首/行尾，开启固定时 `fixed: "left" | "right"`。

## 1. 提交列表

| commit                      | 内容                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `9208708f`                  | `feat(config): 新增表格操作列位置与固定配置及 antd 列 helper`（config 层 + `configDraft` 白名单 + `antdTable.ts` helper） |
| `5eaca436`                  | `feat(ui): 14 张表格接入操作列位置与固定`（页面接线 + scroll/fixed/选择列/展开列适配）                                    |
| `7d87fd35`                  | `feat(settings): 设置页新增「数据表格」分区与操作列配置项`（`SetBase/UiWindow.vue` + i18n 各 6 键）                       |
| `docs+style+test`（本提交） | 固定列隔行底色 CSS、`check-antd-migration.mjs` 预算 32、`tests/entries/options/tableActionColumn.test.ts`、本文件         |

## 2. 配置层

- `src/entries/shared/types/storages/config.ts`：`IConfigPiniaStorageSchema` 增加两个键（注释说明语义）。
- `src/entries/options/stores/config.ts`：`state` 默认值 `tableActionColumnPosition: "end"`、`tableActionColumnFixed: false`。
- `src/entries/options/views/Settings/SetBase/configDraft.ts`（**fork 特有必做项**）：
  `SET_BASE_CONFIG_DRAFT_KEYS` 白名单补两个键。草稿只 clone 白名单键，不加的话 SetBase 控件既读不到
  （`config.value.tableActionColumn*` 是 `undefined`）也存不回；上游没有草稿机制，照抄必踩。
- 不需要数据 migration：缺省键由 Pinia 默认 state 提供，`config.afterRestore` 的形状校验无嵌套结构。

## 3. helper（`src/entries/options/views/Overview/utils/antdTable.ts`）

不照搬上游 `directives/useTableActionColumn.ts`。fork 的列表页把「可见列过滤 + 列渲染」收敛在
`toAntdColumns`，设置页是手写 antd columns，所以 helper 作用在 **antd column 层**，A/B 两族通用：

- `applyTableActionColumn<T>(columns: T[]): T[]`：找 `key === "action"` 的列，浅拷贝后按配置移到行首/行尾；
  `fixed` 打开时 `start → "left"`、`end → "right"`；无操作列原样返回。读取 `useConfigStore()`，
  **必须在 computed 中调用**才有响应性。
- `useTableActionColumnLayout()`：`{ scroll, rowSelectionFixed, expandFixed }` 三个响应式值，
  封装 antd 的硬前提（见下）。

调用顺序统一为「先可见列过滤 / 先 `toAntdColumns`，最后 `applyTableActionColumn`」。

## 4. 14 页接入清单与差异处理

| 页面                                           | 列来源                                | 额外处理                                                                  |
| ---------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `Overview/DownloadHistory/Index.vue`           | `toAntdColumns`                       | 已有 `scroll.x`；row-selection `fixed`                                    |
| `Overview/KeepUploadTask/Index.vue`            | `toAntdColumns` + 自定义 count sorter | 已有 `scroll.x`；row-selection `fixed`；`expand-fixed="left"`（有展开行） |
| `Overview/MyClient/Index.vue`                  | `toAntdColumns` + `visibleKeys`       | 已有 `scroll.x`；row-selection `fixed`                                    |
| `Overview/MyData/Index.vue`                    | `toAntdColumns` + `visibleKeys`       | 已有 `scroll.x`；row-selection `fixed`；`props.disabled` 列常显不变       |
| `Overview/MyData/HistoryDataViewDialog.vue`    | `toAntdColumns`                       | 已有 `scroll.x`；row-selection `fixed`                                    |
| `Overview/SearchEntity/Index.vue`              | `toAntdColumns` + `visibleKeys`       | 已有 `scroll.x`；row-selection `fixed`                                    |
| `Overview/SearchResultSnapshot/Index.vue`      | `toAntdColumns`                       | **无 `scroll` → fixed 开启时动态补**；row-selection `fixed`               |
| `Overview/MyCollection/Index.vue`（fork 独有） | `toAntdColumns`                       | 已有 `scroll.x`；row-selection `fixed`                                    |
| `Settings/SetBackup/Index.vue`                 | 手写 antd columns                     | **无 `scroll` → 动态补**；row-selection `fixed`                           |
| `Settings/SetBackup/HistoryDialog.vue`         | 手写 antd columns                     | **静态数组 → computed**；**无 `scroll` → 动态补**；row-selection `fixed`  |
| `Settings/SetDownloader/Index.vue`             | 手写 antd columns                     | **无 `scroll` → 动态补**；row-selection `fixed`                           |
| `Settings/SetMediaServer/Index.vue`            | 手写 antd columns                     | **无 `scroll` → 动态补**；rowSelection（computed）加 `fixed`              |
| `Settings/SetSearchSolution/Index.vue`         | 手写 antd columns                     | **无 `scroll` → 动态补**；rowSelection（computed）加 `fixed`              |
| `Settings/SetSite/Index.vue`                   | 手写 antd columns                     | **无 `scroll` → 动态补**；rowSelection（computed）加 `fixed`              |

### antd 与 Vuetify 的语义差异（不能照抄上游）

1. **`fixed` 只有设置了 `scroll.x` 才生效**（`vc-table/Table.js` 的 `horizonScroll`）。
   7 张原本无 `:scroll` 的表按报告建议**只在 fixed 开启时**动态传 `{ x: "max-content" }`，
   默认态布局不变（这些表的列宽是按无横向滚动调过的）。
2. **展开列/选择列插在行首**（不是上游 Vuetify 的表尾）：
   - 上游「操作列固定到 end 时把展开列也 push 成 fixed:end」在 antd **不需要**；
   - 反向：`position === "start" && fixed` 时，行首的展开列/选择列必须一起固定，否则横向滚动时
     操作列会盖住它们（antd 固定列必须是从边缘开始连续的一段）。做法：row-selection 传
     `fixed: "left"`，KeepUploadTask 再给 a-table 传 `expand-fixed="left"`。
3. **`SetSearchSolution` 的「默认搜索方案」**：fork 里是 `tableRows` 的一行数据 + `#bodyCell` 按
   `column.key` 分支，不存在上游 `body.prepend` 手写 `<td>` 需要按列位置增删单元格的问题，
   因此没有移植上游那处特判。

## 5. 固定列隔行底色（CSS 方案二）与覆写预算

- 症状与上游一致：antd 给固定单元格写死 surface 背景（`es/table/style/fixed.js` 的 `tableBg`），
  不跟随 `.table-stripe` 画在 `<tr>` 上的隔行底色 → 固定列出现不随行变色的「白柱」。
- 采用报告**方案二**：在 `src/entries/options/style.css` 的斑马纹规则后新增
  `.table-stripe tbody > tr > td.ant-table-cell-fix-left/-right { background-color: inherit; }`
  —— 保留 antd 的 hover 语义（该规则权重低于行 hover/选中规则，且只作用于 tbody 的 td，
  表头 th 保持 antd 表头底色），`inherit` 自动适配暗黑模式。
- 代价是新增 2 个 `.ant-*` 内部类，`scripts/check-antd-migration.mjs` 的 `antRuleLimit`
  **从 30 上调到 32**，并按该文件要求更新预算沿革注释（说明这两个类没有公开 API/token 可用）。
- 未选 `customCell` 内联方案：它拿得到行号但会压掉 antd 的 hover 底色，且要逐页给操作列加
  `customCell`，视觉风险更高。

## 6. 设置页 UI 与 i18n

- `SetBase/UiWindow.vue`：新增「数据表格」`section`（标题用已有的
  `ptd-settings-row ptd-settings-row--title` 类，不新增 CSS 类，避免撞 `classes-defined` 校验），
  原有 `saveTableBehavior` / `enableTableMultiSort` 搬入该分区，追加：
  - 操作列位置：`a-select`（`tableActionColumnPositionOptions`，行首 / 行尾（默认））；
  - 固定操作列：`a-switch` + `QuestionCircleOutlined` tooltip（照现有 `tableMultiSortNote` 写法）。
- 控件绑定 SetBase 草稿（`useSetBaseConfigDraft()`），点「保存」才写回 store。
- i18n `zh_CN.json` / `en.json` 的 `SetBase.ui` 各 +6 键（键名照上游）：`dataTable`、
  `tableActionColumnPosition`、`tableActionColumnPositionStart`、`tableActionColumnPositionEnd`、
  `tableActionColumnFixed`、`tableActionColumnFixedNote`；中英文文案用上游。

## 7. 测试

新增 `tests/entries/options/tableActionColumn.test.ts`（12 用例，全部通过），覆盖报告验证点：

1. helper 默认：操作列在最后、`fixed === undefined`；
2. `position: "start"` 时移到行首，改回 `end` 复原；
3. `fixed + start → "left"`、`fixed + end → "right"`；
4. computed 中调用时配置变更驱动列重排（响应式）；
5. 无操作列的表格原样返回；
6. **真实页面接线**：
   - `MyData`（挂载真实页面）：只显示 `name` 列时 `props.disabled` 的操作列仍在且默认在行尾；
     `start + fixed` 时操作列紧跟选择列、表头选择列与操作列都带 `ant-table-cell-fix-left`；
   - `KeepUploadTask`：默认无固定列；`start + fixed` 时展开列、选择列、操作列三者都固定到左侧；
   - `SetBackup/HistoryDialog`：默认无横向滚动容器；开启 fixed 后出现 `ant-table-scroll-horizontal` +
     `ant-table-has-fix-right`，且运行中改 `position` 后表头顺序实时更新（验证静态数组已改为 computed）；
   - `SetBase` 草稿：改动「操作列位置」/「固定操作列」后 store 不变，点保存后两个叶子都写回
     （验证 `SET_BASE_CONFIG_DRAFT_KEYS` 白名单）。

## 8. 验证结果（本机执行）

| 命令                                                   | 结果                                                      |
| ------------------------------------------------------ | --------------------------------------------------------- |
| `./node_modules/.bin/vue-tsc --noEmit`                 | ✅ exit 0                                                 |
| `node scripts/check-antd-migration.mjs`                | ✅ 13/13 通过，`.ant-*` 覆写 32 条（`antRuleLimit = 32`） |
| `./node_modules/.bin/vitest run tests/entries/options` | ✅ 93 个文件 / 688 个用例全部通过（含新增 12 用例）       |
| `eslint`（全部改动文件）                               | ✅ exit 0                                                 |
| `prettier --check`（全部改动文件）                     | ✅ 通过                                                   |

## 9. 未覆盖 / 待实机确认项

- **目视验收（未在浏览器实机执行）**：
  - 7 张原无 `:scroll` 的表在开启「固定操作列」后会出现横向滚动容器 / 滚动条，列宽表现需目视确认
    （默认态不变是设计目标，已用「只在 fixed 时传 scroll」保证）；
  - 固定列隔行底色在暗黑模式下的观感、行 hover 高亮是否仍正常（CSS 权重上已保留 hover 规则）；
  - `position=start && fixed` 时选择列/展开列的固定边界阴影（antd `::after` 阴影）是否需要额外调整。
- 上游的 `KeepUploadTask` 展开列特判、`SetSearchSolution` 默认行 `<td>` 特判按 antd 语义**不适用**，
  已在上文说明，不做移植。
- `MyClient/TorrentDetailDialog.vue` 的弹窗小表按报告不纳入（16 处操作列中的 2 处弹窗表未接入）。
- 未跑 `npm run test`（全量）；按任务要求只跑 `tests/entries/options`，其余目录未涉及。
