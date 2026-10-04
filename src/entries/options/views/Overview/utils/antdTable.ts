import { h, type VNode } from "vue";
import { Tooltip } from "ant-design-vue";

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

/** 等价于兼容层的 isRequiredHeader：props.disabled 的列不参与显隐过滤 */
function isRequiredHeader(header: DataTableHeader): boolean {
  return Boolean((header.props as Record<string, unknown> | undefined)?.disabled);
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
