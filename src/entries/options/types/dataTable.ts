export type DataTableHeader = {
  title?: string;
  key?: string;
  value?: string;
  align?: "start" | "center" | "end" | "left" | "right";
  sortable?: boolean;
  width?: number | string;
  minWidth?: number | string;
  maxWidth?: number | string;
  /** 默认文本单元格是否限制最大宽度并单行省略（默认 true；设 false 时该列按内容自由展开） */
  ellipsis?: boolean;
  props?: Record<string, unknown>;
  children?: DataTableHeader[];
  [key: string]: unknown;
};

export type DataTableSortItem = {
  key: string;
  order?: "asc" | "desc" | "ascend" | "descend" | boolean;
};
