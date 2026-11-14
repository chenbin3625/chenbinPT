/**
 * SearchEntity/SaveSnapshotDialog.vue：快照名称输入的禁用/启用、保存与关闭行为。
 *
 * 真实挂载并复用真实 runtime / metadata store；只把 `saveSearchSnapshotData` 换成 spy，
 * 从而断言组件传给 store 的名称（trim 后）与 v-model 关闭事件。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { i18nInstance } from "@/options/plugins/i18n.ts";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const t = i18nInstance.global.t;

beforeEach(() => {
  document.body.innerHTML = "";
});

async function mountDialog() {
  const pinia = prepareOptionsPinia();
  const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
  const { useMetadataStore } = await import("@/options/stores/metadata.ts");

  const runtimeStore = useRuntimeStore(pinia);
  runtimeStore.search.searchPlanKey = "default";
  runtimeStore.search.searchKey = "my-keyword";
  runtimeStore.search.startAt = new Date(2024, 0, 2, 3, 4, 5).getTime();

  const metadataStore = useMetadataStore(pinia);
  const saveSpy = vi.spyOn(metadataStore, "saveSearchSnapshotData").mockResolvedValue(undefined);

  const onUpdate = vi.fn();
  const { default: SaveSnapshotDialog } = await import("@/options/views/Overview/SearchEntity/SaveSnapshotDialog.vue");
  const view = mountOptionsView(SaveSnapshotDialog, {
    pinia,
    props: { modelValue: true, "onUpdate:modelValue": onUpdate },
  });
  await view.settle(80);

  const input = () => document.querySelector<HTMLInputElement>(".ant-modal-body input.ant-input");
  const saveButton = () => document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary");

  return { view, saveSpy, onUpdate, input, saveButton, metadataStore };
}

describe("SaveSnapshotDialog", () => {
  it("打开时用当前搜索信息生成默认名称，确认按钮可用", async () => {
    const { view, input, saveButton } = await mountDialog();
    try {
      expect(input(), "应渲染名称输入框").not.toBeNull();
      expect(input()!.value).toBe("[default] my-keyword (2024-01-02 03:04:05)");
      expect(input()!.getAttribute("maxlength")).toBe("200");
      expect(saveButton()!.disabled).toBe(false);
      expect(document.body.textContent).toContain(t("SearchEntity.SaveSnapshotDialog.snapshotName"));
    } finally {
      view.unmount();
    }
  });

  it("名称为空或仅空白时禁用保存；输入有效名称后恢复", async () => {
    const { view, input, saveButton } = await mountDialog();
    try {
      const setValue = async (value: string) => {
        input()!.value = value;
        input()!.dispatchEvent(new Event("input", { bubbles: true }));
        await view.settle();
      };

      await setValue("");
      expect(saveButton()!.disabled).toBe(true);

      await setValue("   ");
      expect(saveButton()!.disabled).toBe(true);

      await setValue("  my snapshot  ");
      expect(saveButton()!.disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("点击保存时用 trim 后的名称调用 store，并关闭对话框", async () => {
    const { view, input, saveButton, saveSpy, onUpdate } = await mountDialog();
    try {
      input()!.value = "  my snapshot  ";
      input()!.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle();

      saveButton()!.click();
      await view.settle();

      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledWith("my snapshot");
      expect(onUpdate).toHaveBeenLastCalledWith(false);
    } finally {
      view.unmount();
    }
  });

  it("点击关闭（取消）只关闭对话框，不保存快照", async () => {
    const { view, saveSpy, onUpdate } = await mountDialog();
    try {
      const close = document.querySelector<HTMLButtonElement>(".ant-modal-close");
      expect(close, "应有关闭入口").not.toBeNull();
      close!.click();
      await view.settle(120);

      expect(saveSpy).not.toHaveBeenCalled();
      expect(onUpdate).toHaveBeenLastCalledWith(false);
    } finally {
      view.unmount();
    }
  });
});
