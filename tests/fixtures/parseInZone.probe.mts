// 由 tests/packages/site/utils/datetimeHostTimezone.test.ts 以不同 TZ 环境变量启动的子进程探针。
import { parseValidTimeStringInZone } from "../../src/packages/site/utils/datetime.ts";

const cases: Array<[string, string[], string]> = JSON.parse(process.argv[2]);
const out = cases.map(([query, formats, offset]) => {
  const value = parseValidTimeStringInZone(query, formats, offset as any);
  return typeof value === "number" ? new Date(value).toISOString() : value;
});
process.stdout.write(JSON.stringify(out));
