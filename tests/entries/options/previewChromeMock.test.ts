import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * 本用例已经是**行为测试**（Q-3 复核后确认无需改造）：
 * 它把 `__preview.html` 里的 chrome mock 脚本用 `new Function` 真正执行起来，
 * 然后断言 `runtime.sendMessage` 按 Chrome 的 callback 协议把错误交给回调 —— 验的是运行结果。
 *
 * 唯一保留"源码级"动作的是**取脚本的方式**：这段 mock 只存在于预览页 HTML 的 `<script>` 里，
 * 没有可导入的模块边界（改成 import 需要改 `src/**`）。因此这里显式保留 HTML 提取，
 * 并保留"提取失败就抛错"的自证，避免哪天提取规则失效让用例变成空跑。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function loadPreviewChromeMock() {
  const html = readFileSync(resolve(repoRoot, "src/entries/options/__preview.html"), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  if (!script) {
    throw new Error("preview chrome mock script not found");
  }

  const previewWindow: Record<string, any> = {};
  new Function("window", script)(previewWindow);
  return previewWindow.chrome;
}

describe("options preview chrome mock", () => {
  it("runtime.sendMessage 必须按 Chrome callback 协议返回错误，不能让消息永久 pending", async () => {
    const chrome = loadPreviewChromeMock();
    const callback = vi.fn();

    const returned = chrome.runtime.sendMessage(
      { id: 1, type: "getSiteSearchResult", data: {}, timestamp: Date.now() },
      callback,
    );
    returned?.catch?.(() => {});

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toMatchObject({
      err: {
        name: "PreviewBackgroundUnavailableError",
      },
    });
  });
});
