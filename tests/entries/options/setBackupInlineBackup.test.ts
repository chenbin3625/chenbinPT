/**
 * M-25：行内「立即备份」失败时必须复位 loading 并给出失败提示。
 *
 * exportBackupData 不在消息自动重试白名单里，WebDAV.addFile 401 之类会以 rejection 抛到视图；
 * 旧实现把复位写在 await 之后且不在 try 内，按钮永久 loading（antd loading 还会拦截点击），也没有任何提示。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

afterEach(() => {
  sendMessageMock.mockReset();
});

describe("SetBackup 行内立即备份（M-25）", () => {
  async function mountSetBackupWithFailure(
    backupFields: string[],
    encryptionKey = "",
    failure: unknown = new Error("401 Unauthorized"),
  ) {
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "exportBackupData") throw failure;
      return undefined;
    });

    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const { useConfigStore } = await import("@/options/stores/config.ts");
    const metadataStore = useMetadataStore(pinia);
    (metadataStore as any).$ready = true;
    metadataStore.backupServers = {
      dav: {
        id: "dav",
        name: "my dav",
        type: "WebDAV",
        enabled: true,
        backupFields,
        config: {},
      },
    } as any;
    const configStore = useConfigStore(pinia);
    configStore.backup.encryptionKey = encryptionKey;
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnakebar");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");

    const { default: SetBackup } = await import("@/options/views/Settings/SetBackup/Index.vue");
    const view = mountOptionsView(SetBackup, { pinia, router: true });
    await view.settle();
    return { view, snackbar, t: i18nInstance.global.t };
  }

  it("exportBackupData 抛错后按钮退出 loading，并提示失败", async () => {
    const { view, snackbar } = await mountSetBackupWithFailure(["config"]);
    try {
      const button = view.$<HTMLButtonElement>(".table-action .ant-btn-primary");
      expect(button, "应渲染出行内「立即备份」按钮").not.toBeNull();

      button!.click();
      await view.settle(60);

      expect(view.$(".table-action .ant-btn-primary")!.classList.contains("ant-btn-loading")).toBe(false);
      expect(snackbar).toHaveBeenCalledWith(expect.any(String), { color: "error" });
    } finally {
      view.unmount();
    }
  });

  it("H-2：失败提示透出库侧可读原因，而不是只显示「备份失败」", async () => {
    const { view, snackbar } = await mountSetBackupWithFailure(["config"], "k".repeat(8));
    try {
      view.$<HTMLButtonElement>(".table-action .ant-btn-primary")!.click();
      await view.settle(60);

      expect(snackbar).toHaveBeenCalledWith(expect.stringContaining("401 Unauthorized"), { color: "error" });
    } finally {
      view.unmount();
    }
  });

  it("H-2：无密钥 + 敏感字段的远端备份失败时附可操作指引（生成密钥 / 取消勾选 / 导出到本地）", async () => {
    const { view, snackbar, t } = await mountSetBackupWithFailure(["cookies"], "");
    try {
      view.$<HTMLButtonElement>(".table-action .ant-btn-primary")!.click();
      await view.settle(60);

      const lastMessage = snackbar.mock.calls.at(-1)?.[0] as string;
      expect(lastMessage).toContain("401 Unauthorized");
      expect(lastMessage).toContain(t("SetBackup.snackbar.encryptionKeyRequiredHint"));
      expect(snackbar).toHaveBeenLastCalledWith(expect.any(String), { color: "error" });
    } finally {
      view.unmount();
    }
  });
});
