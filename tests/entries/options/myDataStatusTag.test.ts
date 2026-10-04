import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const myDataPage = readFileSync(resolve(repoRoot, "src/entries/options/views/Overview/MyData/Index.vue"), "utf8");

function updateAtCellTemplate(): string {
  const match = myDataPage.match(
    /<template v-else-if="column\.key === 'updateAt'">([\s\S]*?)\n\s*<\/template>\n\s*\n\s*<!-- 操作 -->/,
  );
  expect(match, "MyData updateAt cell template should exist").not.toBeNull();
  return match![1]!;
}

describe("MyData 更新状态展示", () => {
  it("错误状态直接使用 ResultParseStatus，避免需要登录标签嵌套层叠", () => {
    const template = updateAtCellTemplate();

    expect(template).toMatch(/<ResultParseStatus\s+:status="record\.status"\s*\/>/);
    expect(template).not.toMatch(/<a-tag(?:\s[^>]*)?>\s*<ResultParseStatus\b[\s\S]*?<\/a-tag>/);
  });
});
