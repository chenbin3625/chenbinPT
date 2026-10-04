/**
 * 辅种任务页不再提供「如何使用」外链。
 *
 * Q-3 改造：原断言读 `KeepUploadTask/Index.vue` 源码文本，检查不含
 * `PT-Plugin-Plus/wiki/keep-upload-task` 与 `common.howToUse`。
 * 那是"源码里没有某个字符串"，而不是"用户看不到这个入口"——例如把链接挪进子组件、
 * 用变量拼 URL、或在别处渲染，断言都会失真。
 * 现在真实挂载该视图，断言**渲染结果里不存在指向旧 wiki 的链接**。
 */
import { describe, expect, it, vi } from "vitest";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

describe("KeepUploadTask 页面链接", () => {
  it("渲染结果里没有指向旧 PTPP wiki 的「如何使用」外链", async () => {
    const pinia = prepareOptionsPinia();
    sendMessageMock.mockResolvedValue([]);

    const { default: KeepUploadTask } = await import("@/options/views/Overview/KeepUploadTask/Index.vue");
    const view = mountOptionsView(KeepUploadTask, { pinia });
    await view.settle(60);

    // 页面渲染成功（避免"整页没渲染出来"导致下面的断言假通过）
    expect(view.text().trim().length).toBeGreaterThan(0);

    // 行为断言：页面里不存在指向旧仓库 wiki 的链接
    const links = Array.from(view.host.querySelectorAll<HTMLAnchorElement>("a[href]")).map((a) => a.href);
    expect(
      links.filter((href) => /PT-Plugin-Plus\/wiki/.test(href)),
      "不应再有旧 wiki 链接",
    ).toEqual([]);
    expect(links.filter((href) => /keep-upload-task/i.test(href))).toEqual([]);

    // 也不出现「如何使用」这类文案入口
    expect(view.text()).not.toMatch(/如何使用|How to use/i);

    view.unmount();
  });
});
