import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveAs } from "@/options/utils/saveAs.ts";

describe("saveAs（替代 file-saver）", () => {
  let clicked: { href: string; download: string; connected: boolean }[];

  beforeEach(() => {
    vi.useFakeTimers();
    clicked = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, connected: this.isConnected });
    });
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("Blob：生成 object URL，点击时 <a> 已在文档中，延迟释放 URL", () => {
    saveAs(new Blob(["{}"], { type: "application/json" }), "export.json");

    expect(clicked).toEqual([{ href: "blob:mock-url", download: "export.json", connected: true }]);
    expect(document.querySelectorAll("a[download]").length, "点击后应移除临时 <a>").toBe(0);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(40_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("字符串：按 URL 直接下载，不创建/释放 object URL", () => {
    saveAs("data:image/png;base64,AAAA", "timeline.png");

    expect(clicked).toEqual([{ href: "data:image/png;base64,AAAA", download: "timeline.png", connected: true }]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40_000);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});
