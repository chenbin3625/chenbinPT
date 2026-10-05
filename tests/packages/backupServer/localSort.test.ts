import { describe, expect, it } from "vitest";

import { localSort } from "@ptd/backupServer/utils.ts";
import { EListOrderBy, EListOrderMode, type IBackupFileInfo } from "@ptd/backupServer";

function file(filename: string, time: number, size: number | "N/A" = 0): IBackupFileInfo {
  return { filename, path: filename, time, size };
}

describe("localSort", () => {
  it("按时间排序时使用数值比较，而不是字符串比较", () => {
    const files = [file("older.zip", 20), file("newer.zip", 100)];

    expect(localSort(files, {}).map((item) => item.filename)).toEqual(["newer.zip", "older.zip"]);
  });

  it("按大小排序时使用数值比较，并把 N/A 排到数值后面", () => {
    const files = [file("small.zip", 20, 20), file("unknown.zip", 30, "N/A"), file("large.zip", 10, 100)];

    expect(
      localSort(files, { orderBy: EListOrderBy.size, orderMode: EListOrderMode.desc }).map((item) => item.filename),
    ).toEqual(["large.zip", "small.zip", "unknown.zip"]);
  });
});
