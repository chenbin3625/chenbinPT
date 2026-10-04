/**
 * SetBackup 的「新增备份服务器」对话框不再有外部链接入口。
 *
 * Q-3 改造：原断言读 `AddDialog.vue` 源码文本，检查不含
 * `src/packages/backupServer`、`config-backup-server`、`SetDownloader.add.newType`、`layout.header.wiki`。
 * 这些是"源码里没有某些字符串"，用户可见性完全没有被验证。
 * 现在真实挂载对话框并断言**渲染结果里没有任何外链 / 新增类型入口**。
 */
import { describe, expect, it, vi } from "vitest";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

describe("SetBackup AddDialog links", () => {
  it("对话框里没有开发者文档 / 帮助 / 新增类型之类的链接入口", async () => {
    const pinia = prepareOptionsPinia();
    const { default: AddDialog } = await import("@/options/views/Settings/SetBackup/AddDialog.vue");

    const view = mountOptionsView(AddDialog, { props: { modelValue: true }, pinia });
    await view.settle(120);

    // 对话框确实渲染出来了（否则"没有链接"会因为什么都没渲染而假通过）
    expect(document.querySelector(".ant-modal"), "对话框应已打开并渲染").not.toBeNull();

    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".ant-modal a[href]")).map((a) => a.href);
    expect(links, "新增备份服务器对话框不应有任何外链").toEqual([]);

    // 也不再提供「新增类型 / 去文档看看」这类入口文案
    const modalText = document.querySelector<HTMLElement>(".ant-modal")!.textContent ?? "";
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    for (const key of ["SetDownloader.add.newType", "layout.header.wiki"]) {
      const text = i18nInstance.global.t(key);
      if (text === key) continue; // 该 key 已随旧入口一起删除
      expect(modalText, `不应再出现「${text}」入口`).not.toContain(text);
    }

    view.unmount();
  });
});
