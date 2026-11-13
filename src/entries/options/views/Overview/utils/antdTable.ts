import { computed, h, type VNode } from "vue";
import { Tooltip } from "ant-design-vue";

import { useConfigStore } from "@/options/stores/config.ts";
import { useDisplay } from "@/options/composables/useDisplay.ts";
import type { DataTableHeader, DataTableSortItem } from "@/options/types/dataTable.ts";

type AnyRecord = Record<string, any>;

function getValue(item: AnyRecord, key: string): unknown {
  if (item == null) return undefined;
  if (key in item) return item[key];
  return key.split(".").reduce<any>((acc, part) => (acc == null ? acc : acc[part]), item);
}

function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;

  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function makeSorter(key: string, multiSort?: boolean) {
  return {
    compare: (a: AnyRecord, b: AnyRecord) => compareValues(getValue(a, key), getValue(b, key)),
    multiple: multiSort ? 4 : undefined,
  };
}

/**
 * 单元格的兜底最大宽度：列上没有写 `maxWidth` 时用这个值。
 *
 * 「每个字段都有合适的最大宽度」分两层落地：
 * - 各表在 header 上按字段声明 `maxWidth`（例如搜索结果标题列桌面端 24vw、移动端 32vw）；
 * - 没声明的列吃这个兜底值，避免个别超长文本把整列撑开、把别的列挤没。
 */
export const DEFAULT_CELL_MAX_WIDTH = "20rem";

/**
 * 页面内长表格的表头吸顶配置（直接传给 `<a-table :sticky="...">`）。
 *
 * 为什么用 antd 的 `sticky` 而不是在 style.css 里给 th 写 `position: sticky`：
 * 带 `scroll.x` 的表格会由 antd 内联 `overflow-x:auto`，CSS 规定此时 `overflow-y` 也算 auto，
 * `.ant-table-content` 就成了 th 的最近滚动祖先 —— 它垂直方向从不滚动，th 永远不吸顶。
 * 要压过内联样式只能写 `!important`（本仓库的 check:antd 禁止）。`sticky` 让 antd 把表头
 * 渲染成独立的 `.ant-table-sticky-holder`，横向滚动由它与表体同步，垂直吸顶相对 `getContainer`。
 *
 * - `getContainer`：滚动发生在 `#ptd-main`（见 style.css 的布局约定），不是 window；
 *   antd 的 StickyScrollBar 也据此监听滚动、计算横向假滚动条的位置。
 * - `offsetHeader`：holder 的 `top` 相对滚动容器的内容盒，而 `#ptd-main` 有内边距，
 *   回退一个内边距后表头才贴在顶栏下沿（窄屏内边距 8px，与 style.css 断点同步）。
 *
 * 弹层里的表格不要用它：弹层的滚动容器是 `.ant-modal-wrap`，表头贴到视口顶部会盖住弹层标题。
 */
export function useMainTableSticky() {
  const display = useDisplay();
  return computed(() => ({
    // 与 style.css 的 `@media (max-width: 840px)` 同一阈值：840 本身属于窄屏档（mdAndUp 在 840 为 true，不能直接用）
    offsetHeader: display.width.value > 840 ? -12 : -8,
    getContainer: () => document.getElementById("ptd-main") ?? window,
  }));
}

/** 数字按 px 处理，字符串（rem / vw / %）原样使用 */
export function toCssSize(value?: string | number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "number" ? `${value}px` : String(value);
}

/**
 * 「最大宽度 + 超出单行省略 + 悬停展示全文」的单元格文本渲染。
 *
 * 为什么不用 antd 的 `column.ellipsis`：只要有一列开启 ellipsis，vc-table 就会把整张表切成
 * `table-layout: fixed`（见 vc-table/Table.js 的 mergedTableLayout），列宽从此不再由内容决定，
 * 各表现有的 minWidth/maxWidth/width 混用配置会整体改版。这里改为给单元格内容套一个带
 * max-width 的单行省略块：只压住超长内容，列宽策略保持不变。
 *
 * 悬停使用 antd Tooltip：浏览器原生 `title` 对超长 URL / 中文字段不可控，
 * 可能被裁切或直接超出视口。Tooltip 允许限制浮层宽度并自动换行。
 */
export function renderEllipsisCell(text: unknown, maxWidth: string | number = DEFAULT_CELL_MAX_WIDTH): VNode {
  const content = text === null || text === undefined ? "" : String(text);
  const cell = h(
    "span",
    {
      class: "ptd-cell-ellipsis",
      style: { maxWidth: toCssSize(maxWidth) },
    },
    content,
  );

  if (!content) return cell;

  return h(
    Tooltip,
    {
      placement: "topLeft",
      overlayStyle: { maxWidth: "min(60vw, 600px)" },
      overlayInnerStyle: {
        overflowWrap: "anywhere",
        whiteSpace: "pre-wrap",
      },
      title: content,
    },
    { default: () => cell },
  );
}

/**
 * 给手写 `columns` 的表格补上默认文本渲染的最大宽度限制（等价于 `toAntdColumns` 的处理）。
 *
 * 只影响「没有命中 `#bodyCell` 分支」的列：antd 在 bodyCell 插槽匹配到内容时优先渲染插槽，
 * 插槽里的自定义内容需要各自用 `.ptd-cell-ellipsis` 包一层。
 */
export function withEllipsisCell<T extends AnyRecord>(
  column: T,
  maxWidth: string | number = DEFAULT_CELL_MAX_WIDTH,
): T {
  return {
    ...column,
    customRender: ({ text }: { text?: unknown }) => renderEllipsisCell(text, maxWidth),
  };
}

/**
 * Vuetify `DataTableHeader[]` → antd `a-table` 的 `columns`。
 * `align: start/end` 映射为 `left/right`；`sortable !== false` 时启用排序，
 * `multi-sort` 时允许同时多列排序，`sortBy` 回填受控排序状态。
 */
export function toAntdColumns(
  headers: DataTableHeader[],
  options: { sortBy?: DataTableSortItem[]; multiSort?: boolean; visibleKeys?: string[] } = {},
): AnyRecord[] {
  const sortBy = options.sortBy ?? [];
  const visibleKeys = options.visibleKeys;
  const visibleKeySet = visibleKeys ? new Set(visibleKeys.map(String)) : undefined;
  return headers
    .filter((h, i) => {
      const key = String(h.key ?? h.value ?? i);
      return !visibleKeySet || isRequiredHeader(h) || visibleKeySet.has(key);
    })
    .map((h, i) => {
      const key = String(h.key ?? h.value ?? i);
      const sortItem = sortBy.find((s) => s.key === key);
      const order = sortItem?.order;
      const align = h.align === "start" ? "left" : h.align === "end" ? "right" : h.align;
      const column: AnyRecord = {
        title: h.title,
        dataIndex: key,
        key,
        align,
        width: h.width,
        minWidth: h.minWidth,
        sorter: h.sortable === false ? undefined : makeSorter(key, options.multiSort),
        sortOrder:
          order === "asc" || order === "ascend"
            ? "ascend"
            : order === "desc" || order === "descend"
              ? "descend"
              : undefined,
      };
      // 默认按「字段最大宽度 + 单行省略」渲染；命中 #bodyCell 分支的列由插槽接管
      if (h.ellipsis !== false) {
        column.customRender = ({ text }: { text?: unknown }) => renderEllipsisCell(text, h.maxWidth);
      }
      return column;
    });
}

/**
 * 把 `key === "action"` 的操作列移到行首/行尾（移植自上游 58be52e883 / #1598）。
 *
 * 上游在 Vuetify 的 `DataTableHeader[]` 层做同样的事；fork 的列表页把「可见列过滤 + 列渲染」
 * 收敛在 `toAntdColumns`，设置页则是手写 antd columns，所以这里改在**antd column 层**实现，
 * 两族页面都能复用：调用顺序固定为「先过滤 / 先 `toAntdColumns`，最后 `applyTableActionColumn`」。
 *
 * - `tableActionColumnPosition`：操作列位于行首（start）还是行尾（end，默认）；
 * - `tableActionColumnFixed`：表格横向滚动时固定操作列，antd 的固定方向与所在位置一致：
 *   行首 → `fixed: "left"`，行尾 → `fixed: "right"`。
 *
 * 注意两点 antd 语义差异（与上游 Vuetify 实现不同，不要照抄）：
 * 1. `fixed` 只有在表格设置了 `scroll.x` 时才生效，无 `scroll` 的表格由调用方按需补
 *    `{ x: "max-content" }`（见 `useTableActionColumnLayout`）；
 * 2. antd 的展开列/选择列插在**行首**，因此固定到行首时还需把这两列一起固定，否则横向滚动时
 *    操作列会盖住它们（固定列必须是从边缘开始连续的一段）。
 *
 * 函数会读取 configStore，**必须在 computed 中调用**，配置变更后操作列才会重新排序 / 固定。
 */
export function applyTableActionColumn<T extends AnyRecord>(columns: T[]): T[] {
  const index = columns.findIndex((column) => column.key === "action");
  if (index === -1) {
    // 没有操作列的表格保持原样（例如弹窗内的小表）
    return columns;
  }

  const configStore = useConfigStore();
  const position = configStore.tableActionColumnPosition;
  const fixed = configStore.tableActionColumnFixed;

  // 复制一份，避免修改调用方传入的列定义
  const actionColumn: AnyRecord = { ...columns[index] };
  if (fixed) {
    actionColumn.fixed = position === "start" ? "left" : "right";
  }

  const otherColumns = columns.filter((_, i) => i !== index);
  return (position === "start" ? [actionColumn, ...otherColumns] : [...otherColumns, actionColumn]) as T[];
}

/**
 * 操作列位置 / 固定对 antd 表格的**布局**要求（与 {@link applyTableActionColumn} 配套使用）。
 *
 * 同样是响应式 helper，在 setup / computed 中调用即可：
 * - `scroll`：给**没有** `:scroll` 的表格用。只在 fixed 打开时返回 `{ x: "max-content" }`，
 *   避免默认态把表格切成 `table-layout: auto` + 横向滚动容器（7 张设置表的列宽是按无滚动调过的）；
 * - `rowSelectionFixed`：`fixed` + 行首时给 `row-selection` 传 `fixed: "left"`。antd 其实会自动
 *   从相邻列继承 `fixed`，这里显式传是为了不依赖内部实现（选择列必须与操作列一起固定才连续）；
 * - `expandFixed`：`fixed` + 行首且该页有展开行时给 `a-table` 传 `expand-fixed="left"`，
 *   展开列同样要固定在左侧。
 */
export function useTableActionColumnLayout() {
  const configStore = useConfigStore();
  const fixed = computed(() => configStore.tableActionColumnFixed);
  const atStart = computed(() => configStore.tableActionColumnPosition === "start");
  /** 操作列固定在行首：此时行首的展开列 / 选择列必须一起固定在左侧 */
  const leadingFixed = computed(() => fixed.value && atStart.value);

  return {
    /** 给无 `:scroll` 的表格用：只在 fixed 打开时补 `scroll.x` */
    scroll: computed(() => (fixed.value ? { x: "max-content" as const } : undefined)),
    /** 给 `row-selection` 用：`position === "start" && fixed` 时选择列固定到左侧 */
    rowSelectionFixed: computed(() => (leadingFixed.value ? ("left" as const) : undefined)),
    /** 给 `a-table` 用：`position === "start" && fixed` 且有展开行时展开列固定到左侧 */
    expandFixed: computed(() => (leadingFixed.value ? ("left" as const) : undefined)),
  };
}

/** 等价于兼容层的 isRequiredHeader：props.disabled 的列不参与显隐过滤 */
function isRequiredHeader(header: DataTableHeader): boolean {
  return Boolean((header.props as Record<string, unknown> | undefined)?.disabled);
}

/**
 * 种子「标题」单元格的宽度上限（`undefined` = 不限宽）。
 *
 * 标题列是搜索 / 下载历史表的**弹性列**：其余列的最小宽度由表头文案与单元格内容决定
 * （自动表格布局下取 max-content），剩余宽度按比例分给内容需求最大的那列 —— 也就是标题列。
 *
 * 为什么桌面端不再限宽：`table-layout: auto` 会先把标题列撑到远超内容需要，而单元格上的
 * `max-width` 只约束内容、不约束列宽。于是取消部分列展示（剩余宽度变多）后，标题列继续变宽、
 * 可见文字却停在 24vw，右侧留下大片空白（1920px 视口下实测约 800px，2560px 下超过 1300px）。
 * 放开上限后标题列真正吃满剩余宽度，列内不再有空白 —— 这是 #1556 的复发形态。
 *
 * 移动端（`smAndDown`）保留 32vw：窄屏本来就要横向滚动，限宽避免标题把可视宽度全占掉。
 */
export function titleColumnMaxWidth(mobile: boolean): string | undefined {
  return mobile ? "32vw" : undefined;
}

type AntdSorter = { columnKey?: string; field?: string; order?: "ascend" | "descend" | null };

/** antd `@change` 的 sorter → 兼容层原先 emit 的 `sortBy` 结构 */
export function toSortBy(sorter: AntdSorter | AntdSorter[]): DataTableSortItem[] {
  return (Array.isArray(sorter) ? sorter : [sorter])
    .filter((s) => s?.order)
    .map((s) => ({ key: String(s.columnKey ?? s.field), order: s.order === "ascend" ? "asc" : "desc" }));
}

/** 等价于 `PtdDataTable` 的客户端搜索：按全部 headers 的 key 做不区分大小写的包含匹配 */
export function matchesHeaders(item: AnyRecord, search: string, headers: DataTableHeader[]): boolean {
  if (!search) return true;
  const query = search.toLowerCase();
  return headers.some((h) => {
    const key = h.key ?? h.value;
    if (!key) return false;
    return String(getValue(item, String(key)) ?? "")
      .toLowerCase()
      .includes(query);
  });
}

/** `PtdDataTable` 的 items-per-page → antd `pagination`；-1 时默认不分页 */
export function toPagination(
  pageSize: number | string | undefined,
  onChange: (size: number) => void,
  options: { allowUnpaginated?: boolean } = {},
) {
  if (Number(pageSize) === -1 && options.allowUnpaginated !== false) return false;
  const normalizedPageSize = Number(pageSize);
  return {
    pageSize: Number.isFinite(normalizedPageSize) && normalizedPageSize > 0 ? normalizedPageSize : 25,
    pageSizeOptions: ["5", "10", "25", "50", "100"],
    showSizeChanger: true,
    onChange: (_page: number, size: number) => {
      if (Number(size) !== Number(pageSize)) onChange(Number(size));
    },
  };
}
