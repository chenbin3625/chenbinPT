/**
 * 路径 / 标签模板展开（移植自上游 8128ba13：SentToDownloaderDialog / KeepUploadTask / 右键菜单三处合一）。
 */
import { describe, expect, it } from "vitest";

import {
  datePathTemplateVars,
  expandPathTemplate,
  hasPathTemplateVariable,
  PATH_TEMPLATE_VARIABLES,
} from "@ptd/downloader/utils/pathTemplate.ts";

describe("expandPathTemplate", () => {
  const replaceMap = { "torrent.site": "mteam", "torrent.title": "Some.Title", "date:YYYY": "2026" };

  it("同一变量出现多次时全部替换", () => {
    expect(expandPathTemplate("/d/$torrent.site$/$date:YYYY$/$torrent.site$", replaceMap)).toBe("/d/mteam/2026/mteam");
  });

  it("不对替换结果二次扫描：值里含 `$变量$` 也原样保留", () => {
    expect(expandPathTemplate("/d/$torrent.title$", { ...replaceMap, "torrent.title": "x$torrent.site$y" })).toBe(
      "/d/x$torrent.site$y",
    );
  });

  it("replaceMap 里没有的已知变量原样保留；dropUnresolved 时整项返回 null", () => {
    expect(expandPathTemplate("/d/$torrent.siteName$", replaceMap)).toBe("/d/$torrent.siteName$");
    expect(expandPathTemplate("/d/$torrent.siteName$", replaceMap, { dropUnresolved: true })).toBeNull();
    expect(expandPathTemplate("/d/$torrent.site$", replaceMap, { dropUnresolved: true })).toBe("/d/mteam");
  });

  it("路径里的字面量 `$`（如 Windows 隐藏共享）不会吞掉后面的变量，也不算未解析", () => {
    expect(expandPathTemplate("\\\\nas\\share$\\$torrent.site$", replaceMap)).toBe("\\\\nas\\share$\\mteam");
    expect(expandPathTemplate("/d/$custom$/x", replaceMap, { dropUnresolved: true })).toBe("/d/$custom$/x");
  });

  it("replaceMap 只按自有属性取值（不会命中原型链上的 constructor 等）", () => {
    expect(expandPathTemplate("/d/$torrent.site$", Object.create({ "torrent.site": "proto" }))).toBe(
      "/d/$torrent.site$",
    );
  });
});

describe("hasPathTemplateVariable / datePathTemplateVars / PATH_TEMPLATE_VARIABLES", () => {
  it("只识别已知变量，且多次调用结果稳定（全局正则 lastIndex 不残留）", () => {
    expect(hasPathTemplateVariable("/d/$torrent.site$")).toBe(true);
    expect(hasPathTemplateVariable("/d/$torrent.site$")).toBe(true);
    expect(hasPathTemplateVariable("/d/share$/x$")).toBe(false);
  });

  it("日期变量按本地时间补零", () => {
    expect(datePathTemplateVars(new Date(2026, 0, 5))).toEqual({
      "date:YYYY": "2026",
      "date:MM": "01",
      "date:DD": "05",
    });
  });

  it("变量表包含 $torrent.category$（上游补上的漏记项）", () => {
    expect(PATH_TEMPLATE_VARIABLES).toContain("torrent.category");
  });
});
