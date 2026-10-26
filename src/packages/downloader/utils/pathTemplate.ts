/**
 * 下载器保存路径 / 标签里的 `$变量$` 模板（`$torrent.title$`、`$date:YYYY$` …）。
 *
 * 此前这段逻辑写了三份（`SentToDownloaderDialog/utils.ts`、`KeepUploadTask` 视图、右键菜单的建议目录），
 * 且各有细微差异（有的只替换第一处、有的要丢弃未解析项），这里统一成一份。
 *
 * 只依赖 date-fns：background（service worker）的右键菜单也会 import 本文件，不能拖进 downloader 主入口。
 *
 * 注意：替换值的**路径安全化**（剥掉 `/`、`\`、`..` 等，见 `@/options/utils.ts` 的
 * `sanitizeDynamicReplaceValue`）仍由调用方在构造 replaceMap 时完成 —— 本模块只负责展开。
 */
import { format as formatDate } from "date-fns";

/** 全部受支持的模板变量（不含 `$`）。PathAndTagSuggestDialog 的说明表按它生成，增删变量时两边自动对齐 */
export const PATH_TEMPLATE_VARIABLES = [
  "torrent.title",
  "torrent.subTitle",
  "torrent.category",
  "torrent.site",
  "torrent.siteName",
  "search:keyword",
  "search:plan",
  "date:YYYY",
  "date:MM",
  "date:DD",
] as const;

export type TPathTemplateVariable = (typeof PATH_TEMPLATE_VARIABLES)[number];

/**
 * 只匹配**已知变量名**，而不是上游的通用 `/\$[^$]+\$/`：用户路径里本来就可能有字面量 `$`
 * （例如 Windows 的隐藏共享 `\\nas\share$\$torrent.site$`），通用写法会把 `share$\` 与后面变量的
 * 开头 `$` 配成一对，导致真正的变量反而展开不了。这与 fork 原先「逐个已知 key 做 replaceAll」的匹配范围一致。
 */
const PATH_TEMPLATE_PATTERN = new RegExp(
  `\\$(${PATH_TEMPLATE_VARIABLES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\$`,
  "g",
);

/** `$date:YYYY$` / `$date:MM$` / `$date:DD$` 三个日期变量的取值 */
export function datePathTemplateVars(now: Date = new Date()): Record<string, string> {
  return {
    "date:YYYY": formatDate(now, "yyyy"),
    "date:MM": formatDate(now, "MM"),
    "date:DD": formatDate(now, "dd"),
  };
}

/** 模板里是否还存在（已知的）`$…$` 变量，用于判断是否仍有未解析项 */
export function hasPathTemplateVariable(template: string): boolean {
  PATH_TEMPLATE_PATTERN.lastIndex = 0;
  return PATH_TEMPLATE_PATTERN.test(template);
}

/**
 * 展开 `$变量$` 形式的路径 / 标签模板。
 *
 * - 一次扫描替换全部变量 → 同一个变量出现多次都会被替换；
 * - **不对替换结果二次扫描** → 种子标题里即使含 `$torrent.site$` 也不会被当成变量再展开一次；
 * - `replaceMap` 里没有的变量**原样保留**，调用方可用 {@link hasPathTemplateVariable} 判断；
 * - `options.dropUnresolved` 为 true 时，展开后仍含变量的模板返回 `null` —— 右键菜单里没有 `prompt()`
 *   可用，只能把「依赖当前标签页站点」的目录项直接去掉。
 */
export function expandPathTemplate(
  template: string,
  replaceMap: Record<string, string>,
  options: { dropUnresolved?: boolean } = {},
): string | null {
  let unresolved = false;
  const expanded = template.replace(PATH_TEMPLATE_PATTERN, (matched, key: string) => {
    if (Object.hasOwn(replaceMap, key)) {
      return replaceMap[key]!;
    }
    unresolved = true;
    return matched;
  });

  return options.dropUnresolved && unresolved ? null : expanded;
}
