/**
 * 附录 A 站点定义修复的行为回归（选择器 / 过滤器层面，不发网络请求）。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");

describe("losslessclub seedingSize（D-22）", () => {
  it("累加做种列表所有数据行的体积（原先只取到首行的原始文本）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/losslessclub.ts");
    const { parseSizeString } = await import("@ptd/site/utils/filesize.ts");
    const step = siteMetadata.userInfo!.process!.find((p: any) => p.selectors?.seedingSize)!;
    const query = step.selectors!.seedingSize as any;

    const doc = makeDoc(
      "<table><tr><th>a</th><th>b</th><th>size</th></tr>" +
        "<tr><td>x</td><td>y</td><td>1 GB</td></tr><tr><td>x</td><td>y</td><td>512 MB</td></tr></table>",
    );
    expect(query.elementProcess(doc)).toBe(parseSizeString("1 GB") + parseSizeString("512 MB"));
  });
});

describe("ncore lastAccessAt（D-20）", () => {
  it("「3 hónapja」（3 个月前）解析为时间戳，而不是原样返回匈牙利文本", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/ncore.ts");
    const step = siteMetadata.userInfo!.process!.find((p: any) => p.selectors?.lastAccessAt)!;
    const filter = (step.selectors!.lastAccessAt as any).filters[0];
    const value = filter("3 hónapja");
    expect(typeof value).toBe("number");
    expect(Date.now() - value).toBeGreaterThan(80 * 24 * 3600 * 1000);
  });
});
