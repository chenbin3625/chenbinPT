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
  it("exportBackupData 抛错后按钮退出 loading，并提示失败", async () => {
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "exportBackupData") throw new Error("401 Unauthorized");
      return undefined;
    });

    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const metadataStore = useMetadataStore(pinia);
    (metadataStore as any).$ready = true;
    metadataStore.backupServers = {
      dav: {
        id: "dav",
        name: "my dav",
        type: "WebDAV",
        enabled: true,
        backupFields: ["config"],
        config: {},
      },
    } as any;
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnakebar");

    const { default: SetBackup } = await import("@/options/views/Settings/SetBackup/Index.vue");
    const view = mountOptionsView(SetBackup, { pinia, router: true });
    try {
      await view.settle();
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
});
