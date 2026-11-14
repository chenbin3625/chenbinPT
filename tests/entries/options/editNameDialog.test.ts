/**
 * SearchResultSnapshot/EditNameDialog.vue：打开时从 store 预填快照名、空名称禁用保存、
 * 保存时以 trim 后的名称调用 store 并关闭、关闭后清空输入。
 *
 * a-modal 的浮层通过 Teleport 渲染到 document.body，因此断言从 document.body 查询；
 * 组件是常驻的（父级用 v-model 控制显隐），这里用一层宿主组件模拟真实的「打开 / 关闭」。
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await sleep(10);
  }
  expect(predicate(), "等待条件超时").toBe(true);
}

/**
 * 挂载对话框并打开。
 * `snapshotName` 为 undefined 表示 store 里没有该快照（模拟已在别处被删除）。
 */
async function mountDialog(editId: string, snapshotName?: string) {
  const pinia = prepareOptionsPinia();
  const { useMetadataStore } = await import("@/options/stores/metadata.ts");
  const metadataStore = useMetadataStore(pinia);
  if (snapshotName !== undefined) {
    metadataStore.snapshots[editId] = { id: editId, name: snapshotName, createdAt: 1, recordCount: 2 } as any;
  }
  const editSpy = vi.spyOn(metadataStore, "editSearchSnapshotDataName").mockResolvedValue(undefined);

  const open = ref(false);
  const onUpdate = vi.fn((value: boolean) => {
    open.value = value;
  });

  const { default: EditNameDialog } = await import("@/options/views/Overview/SearchResultSnapshot/EditNameDialog.vue");
  const view = mountOptionsView(
    defineComponent({
      setup: () => () =>
        h(EditNameDialog as any, {
          editId,
          modelValue: open.value,
          "onUpdate:modelValue": onUpdate,
        }),
    }),
    { pinia },
  );

  const input = () => document.body.querySelector<HTMLInputElement>(".ant-modal-body input.ant-input");
  const saveButton = () => document.body.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary");

  open.value = true;
  await nextTick();
  await view.settle(80);

  return { view, open, onUpdate, editSpy, metadataStore, input, saveButton };
}

describe("EditNameDialog 打开与预填", () => {
  it("用 metadataStore.snapshots[editId].name 预填输入框，并带 title / maxlength", async () => {
    const { view, input } = await mountDialog("snap-1", "旧快照名");
    try {
      expect(input(), "应渲染名称输入框").not.toBeNull();
      expect(input()!.value).toBe("旧快照名");
      expect(input()!.getAttribute("maxlength")).toBe("200");
      expect(document.body.textContent).toContain(t("SearchResultSnapshot.EditNameDialog.title"));
      expect(document.body.textContent).toContain(t("SearchResultSnapshot.EditNameDialog.snapshotName"));
    } finally {
      view.unmount();
    }
  });

  it("快照不存在时（已在别处删除）预填为空，保存按钮禁用", async () => {
    const { view, input, saveButton } = await mountDialog("gone");
    try {
      expect(input()).not.toBeNull();
      expect(input()!.value).toBe("");
      expect(saveButton()!.disabled).toBe(true);
    } finally {
      view.unmount();
    }
  });
});

describe("EditNameDialog 保存", () => {
  it("名称空或仅空白时禁用保存，输入有效名称后恢复", async () => {
    const { view, input, saveButton } = await mountDialog("snap-2");
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

      await setValue("  有效名称  ");
      expect(saveButton()!.disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("点击保存时以 trim 后的名称调用 store，并关闭对话框", async () => {
    const { view, input, saveButton, editSpy, onUpdate } = await mountDialog("snap-3", "原名");
    try {
      input()!.value = "  新的快照名  ";
      input()!.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle();

      saveButton()!.click();
      await view.settle();

      expect(editSpy).toHaveBeenCalledTimes(1);
      expect(editSpy).toHaveBeenCalledWith("snap-3", "新的快照名");
      expect(onUpdate).toHaveBeenLastCalledWith(false);
    } finally {
      view.unmount();
    }
  });

  it("关闭后清空输入（再次打开不会残留上一次输入的草稿）", async () => {
    const { view, input } = await mountDialog("snap-4", "原名");
    try {
      expect(input()!.value).toBe("原名");

      input()!.value = "未保存的草稿";
      input()!.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle();

      // 点右上角关闭
      document.body.querySelector<HTMLButtonElement>(".ant-modal-close")!.click();
      await view.settle(80);

      // afterClose 在离场过渡结束后触发，清空输入
      await waitFor(() => input()?.value === "");
      expect(input()!.value).toBe("");
    } finally {
      view.unmount();
    }
  });
});
