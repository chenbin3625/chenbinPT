import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as any).__BROWSER__ = "chrome";
});

import { prepareOptionsPinia } from "../../helpers/optionsView.ts";

describe("搜索日志", () => {
  it("只输出状态和数量，不携带带凭据的下载链接", async () => {
    prepareOptionsPinia();
    const { summarizeSearchResultForLog } = await import("@/options/views/Overview/SearchEntity/utils/search.ts");
    const summary = summarizeSearchResultForLog(
      [{ link: "https://site.example/download?id=1&passkey=secret" }],
      0,
      "ok",
    );

    expect(summary).toEqual({ status: 0, statusMsg: "ok", count: 1 });
    expect(JSON.stringify(summary)).not.toContain("passkey");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
});
