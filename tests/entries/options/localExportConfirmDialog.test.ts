/**
 * L-11：本地导出确认后弹窗要关闭；导出进行中再点「导出」不重复触发。
 */
import { describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";

import { mountOptionsView } from "../../helpers/optionsView.ts";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

const { default: Dialog } = await import("@/options/views/Settings/SetBackup/LocalExportConfirmDialog.vue");

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
});
