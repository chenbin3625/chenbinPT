/**
 * Settings/SetSite/RebuildMapDialog.vue：重建站点映射对话框的开关默认值、OK 按钮禁用、
 * 重建顺序（host → name → $save）、失败提示不关闭，以及重新打开时开关复位。
 *
 * a-modal 渲染到 document.body，断言从 body 查询；使用宿主组件控制 v-model 的开合，
 * 复现父页面「常驻挂载、按需打开」的真实用法。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";

import { i18nInstance } from "@/options/plugins/i18n.ts";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

const t = i18nInstance.global.t;

beforeEach(() => {
  document.body.innerHTML = "";
});

async function mountDialog() {
  const pinia = prepareOptionsPinia();
  const saveSpy = vi.fn().mockResolvedValue(undefined);
  // 真实插件由 webExtPersistence 提供；单测里不落盘，只验证对话框的调用接线
  pinia.use(({ store }) => {
    (store as any).$save = saveSpy;
  });

  const { useMetadataStore } = await import("@/options/stores/metadata.ts");
  const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
  const metadataStore = useMetadataStore(pinia);
  const hostMapSpy = vi.spyOn(metadataStore, "buildSiteHostMap").mockResolvedValue(undefined);
  const nameMapSpy = vi.spyOn(metadataStore, "buildSiteNameMap").mockResolvedValue(undefined);
  const snackbarSpy = vi.spyOn(useRuntimeStore(pinia), "showSnackbar").mockImplementation(() => undefined);

  const open = ref(false);
  const onUpdate = vi.fn((value: boolean) => {
    open.value = value;
  });

  const { default: RebuildMapDialog } = await import("@/options/views/Settings/SetSite/RebuildMapDialog.vue");
  const view = mountOptionsView(
    defineComponent({
      setup: () => () =>
        h(RebuildMapDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": onUpdate,
        }),
    }),
    { pinia },
  );

  const switches = () => Array.from(document.body.querySelectorAll<HTMLElement>(".ant-modal .ant-switch"));
  const isOn = (index: number) => switches()[index]?.classList.contains("ant-switch-checked") ?? false;
  const toggle = async (index: number) => {
    const target = switches()[index];
    expect(target, `应有第 ${index + 1} 个开关`).toBeTruthy();
    target!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await view.settle();
  };
  const okButton = () => document.body.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary");
  const cancelButton = () => document.body.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-default");

  const openDialog = async () => {
    open.value = true;
    await nextTick();
    await view.settle(80);
  };

  await openDialog();

  return {
    view,
    open,
    onUpdate,
    metadataStore,
    saveSpy,
    hostMapSpy,
    nameMapSpy,
    snackbarSpy,
    switches,
    isOn,
    toggle,
    okButton,
    cancelButton,
    openDialog,
  };
}

describe("RebuildMapDialog 默认状态", () => {
  it("默认只勾选「重建站点域名关系缓存」，名称映射开关关闭，OK 可用", async () => {
    const { view, switches, isOn, okButton } = await mountDialog();
    try {
      expect(switches()).toHaveLength(2);
      expect(isOn(0), "host 映射默认勾选").toBe(true);
      expect(isOn(1), "name 映射默认不勾选").toBe(false);
      expect(okButton()!.disabled).toBe(false);
      expect(document.body.textContent).toContain(t("SetSite.ReBuildMapDialog.title"));
    } finally {
      view.unmount();
    }
  });

  it("关闭全部开关时 OK 按钮禁用，点击也不会触发重建", async () => {
    const { view, toggle, isOn, okButton, hostMapSpy, nameMapSpy, saveSpy } = await mountDialog();
    try {
      await toggle(0); // 关掉默认勾选的 host 映射
      expect(isOn(0)).toBe(false);
      expect(isOn(1)).toBe(false);
      expect(okButton()!.disabled).toBe(true);

      okButton()!.click();
      await view.settle();
      expect(hostMapSpy).not.toHaveBeenCalled();
      expect(nameMapSpy).not.toHaveBeenCalled();
      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });
});

describe("RebuildMapDialog 重建流程", () => {
  it("只勾选 host 映射时依次调用 buildSiteHostMap → $save 并关闭", async () => {
    const { view, okButton, hostMapSpy, nameMapSpy, saveSpy, onUpdate, open } = await mountDialog();
    try {
      okButton()!.click();
      await view.settle();

      expect(hostMapSpy).toHaveBeenCalledTimes(1);
      expect(nameMapSpy).not.toHaveBeenCalled();
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(hostMapSpy.mock.invocationCallOrder[0]).toBeLessThan(saveSpy.mock.invocationCallOrder[0]);
      expect(onUpdate).toHaveBeenLastCalledWith(false);
      expect(open.value).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("打开两个开关后点击 OK：buildSiteHostMap → buildSiteNameMap → $save，随后关闭", async () => {
    const { view, toggle, isOn, okButton, hostMapSpy, nameMapSpy, saveSpy, onUpdate } = await mountDialog();
    try {
      await toggle(1); // 再打开 name 映射
      expect(isOn(0)).toBe(true);
      expect(isOn(1)).toBe(true);

      okButton()!.click();
      await view.settle();

      expect(hostMapSpy).toHaveBeenCalledTimes(1);
      expect(nameMapSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledWith();

      const [hostOrder] = hostMapSpy.mock.invocationCallOrder;
      const [nameOrder] = nameMapSpy.mock.invocationCallOrder;
      const [saveOrder] = saveSpy.mock.invocationCallOrder;
      expect(hostOrder!).toBeLessThan(nameOrder!);
      expect(nameOrder!).toBeLessThan(saveOrder!);
      expect(onUpdate).toHaveBeenLastCalledWith(false);
    } finally {
      view.unmount();
    }
  });

  it("重建抛错时提示保存失败，对话框保持打开", async () => {
    const { view, toggle, okButton, hostMapSpy, saveSpy, snackbarSpy, open, onUpdate } = await mountDialog();
    try {
      hostMapSpy.mockRejectedValueOnce(new Error("boom"));
      await toggle(1);

      okButton()!.click();
      await view.settle();

      expect(snackbarSpy).toHaveBeenCalledWith(t("common.saveFailed"), { color: "error" });
      expect(saveSpy).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalledWith(false);
      expect(open.value).toBe(true);
      expect(document.body.querySelector(".ant-modal")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("重新打开时开关复位为默认值", async () => {
    const { view, toggle, isOn, cancelButton, openDialog } = await mountDialog();
    try {
      await toggle(1); // 两个开关都打开
      expect(isOn(0)).toBe(true);
      expect(isOn(1)).toBe(true);

      cancelButton()!.click();
      await view.settle(80);
      expect(isOn(1)).toBe(true); // 关闭后 DOM 仍保留上一次的值

      await openDialog();

      expect(isOn(0), "host 映射复位为勾选").toBe(true);
      expect(isOn(1), "name 映射复位为不勾选").toBe(false);
    } finally {
      view.unmount();
    }
  });
});
