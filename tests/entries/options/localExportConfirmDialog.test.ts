/**
 * L-11：本地导出确认后弹窗要关闭；导出进行中再点「导出」不重复触发。
 * H-2：本地导出允许明文（库侧 fail-closed 只拦远端），但必须透出失败原因、并对
 * 「无密钥 + 敏感字段」给出明文警示。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

const { default: Dialog } = await import("@/options/views/Settings/SetBackup/LocalExportConfirmDialog.vue");
const { i18nInstance } = await import("@/options/plugins/i18n.ts");

afterEach(() => {
  sendMessageMock.mockReset();
  document.body.innerHTML = "";
});

function mountDialog(pinia: ReturnType<typeof prepareOptionsPinia>) {
  const open = ref(true);
  const view = mountOptionsView(
    defineComponent({
      setup: () => () =>
        h(Dialog as any, { modelValue: open.value, "onUpdate:modelValue": (v: boolean) => (open.value = v) }),
    }),
    { pinia },
  );
  return { view, open };
}

describe("SetBackup 本地导出确认弹窗（L-11）", () => {
  it("点「导出」后发一次导出请求并关闭弹窗；进行中重复点击不重复导出", async () => {
    let release!: () => void;
    sendMessageMock.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const open = ref(true);
    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(Dialog as any, { modelValue: open.value, "onUpdate:modelValue": (v: boolean) => (open.value = v) }),
      }),
    );
    try {
      await view.settle();
      const ok = () => document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!;
      ok().click();
      ok().click();
      await view.settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(open.value).toBe(true);

      release();
      await view.settle();
      expect(open.value).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("H-2：导出失败时透出库侧原因（不再只有笼统的「备份失败」）", async () => {
    const pinia = prepareOptionsPinia();
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnakebar").mockImplementation(() => undefined);
    sendMessageMock.mockRejectedValue(new Error("download rejected by browser"));

    const { view } = mountDialog(pinia);
    try {
      await view.settle();
      document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!.click();
      await view.settle(60);

      expect(snackbar).toHaveBeenCalledWith(expect.stringContaining("download rejected by browser"), {
        color: "error",
      });
    } finally {
      view.unmount();
    }
  });

  it("H-2：未设置密钥且勾选敏感字段时，确认框里显示「明文导出」警示", async () => {
    const pinia = prepareOptionsPinia();
    const { useConfigStore } = await import("@/options/stores/config.ts");
    const configStore = useConfigStore(pinia);
    configStore.backup.encryptionKey = "";

    const { view } = mountDialog(pinia);
    try {
      await view.settle();
      // 默认勾选全部备份字段（含 cookies/metadata/downloadHistory）
      expect(document.body.textContent).toContain(
        i18nInstance.global.t("SetBackup.LocalExportConfirmDialog.plaintextWarning"),
      );
    } finally {
      view.unmount();
    }
  });
});
