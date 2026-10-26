import { describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const { sendMessageMock, parseFileMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  parseFileMock: vi.fn(),
}));
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("@ptd/backupServer/utils.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  zipBlobToBackupData: parseFileMock,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const backup = (field: string) => ({ manifest: { version: "0.0.0.0", files: { [field]: 1 } } });

describe("RestoreDialog 异步解析身份", () => {
  it("远端切换及关闭重开后，旧请求的成功与失败不能覆盖新备份", async () => {
    document.body.innerHTML = "";
    const pinia = prepareOptionsPinia();
    const { default: Dialog } = await import("@/options/views/Settings/SetBackup/RestoreDialog.vue");
    const path = ref("a");
    const open = ref(false);
    const pending = [deferred<any>(), deferred<any>(), deferred<any>(), deferred<any>()];
    sendMessageMock.mockReset();
    sendMessageMock.mockImplementation((_name: string, args: { path: string }) => {
      return pending[["a", "b", "c", "d"].indexOf(args.path)].promise;
    });
    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(Dialog as any, {
            modelValue: open.value,
            "onUpdate:modelValue": (v: boolean) => (open.value = v),
            restoreMetadata: { type: "remote", server: "s", path: path.value },
          }),
      }),
      { pinia, router: true },
    );
    try {
      open.value = true;
      await nextTick();
      await view.settle();
      path.value = "b";
      await nextTick();
      pending[0].resolve(backup("cookies"));
      await view.settle();
      expect(
        document.body.querySelector<HTMLInputElement>(".ant-checkbox-group input[value='cookies']")?.disabled,
      ).toBe(true);

      pending[1].resolve(backup("config"));
      await view.settle();
      expect(document.body.querySelector<HTMLInputElement>(".ant-checkbox-group input[value='config']")?.disabled).toBe(
        false,
      );

      open.value = false;
      await nextTick();
      path.value = "c";
      open.value = true;
      await nextTick();
      await view.settle();
      expect(document.body.querySelector<HTMLInputElement>(".ant-checkbox-group input[value='config']")?.disabled).toBe(
        true,
      );
      path.value = "d";
      await nextTick();
      pending[3].resolve(backup("config"));
      await view.settle();
      pending[2].reject(new Error("old failure"));
      await view.settle();
      expect(document.body.querySelector<HTMLInputElement>(".ant-checkbox-group input[value='config']")?.disabled).toBe(
        false,
      );
    } finally {
      view.unmount();
    }
    // 真实挂载 + 多个挂起 Promise：并行跑 17 个测试文件时 5s 默认超时偏紧（冷启动可达 ~3s）
  }, 15000);

  it("本地文件后选覆盖前选，旧文件的失败不能显示重试状态", async () => {
    document.body.innerHTML = "";
    const pinia = prepareOptionsPinia();
    const { default: Dialog } = await import("@/options/views/Settings/SetBackup/RestoreDialog.vue");
    const open = ref(false);
    const first = deferred<any>();
    const second = deferred<any>();
    parseFileMock.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(Dialog as any, { modelValue: open.value, "onUpdate:modelValue": (v: boolean) => (open.value = v) }),
      }),
      { pinia, router: true },
    );
    try {
      open.value = true;
      await nextTick();
      await view.settle();
      const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
      for (const name of ["first.zip", "second.zip"]) {
        Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], name)] });
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await nextTick();
      }
      expect(parseFileMock).toHaveBeenCalledTimes(2);
      second.resolve(backup("config"));
      first.reject(new Error("old failure"));
      await view.settle();
      expect(document.body.querySelector<HTMLInputElement>(".ant-checkbox-group input[value='config']")?.disabled).toBe(
        false,
      );
      expect(document.body.querySelector(".ant-btn")?.textContent).not.toContain("old failure");
    } finally {
      view.unmount();
    }
  });
});

describe("F2-N4：父组件重渲染不得重置恢复对话框", () => {
  it("内联 restoreMetadata 在父组件每次渲染时都会生成新引用，但不能清空已解析的备份", async () => {
    document.body.innerHTML = "";
    const pinia = prepareOptionsPinia();
    const { default: Dialog } = await import("@/options/views/Settings/SetBackup/RestoreDialog.vue");
    const open = ref(false);
    const unrelatedTick = ref(0);
    parseFileMock.mockReset().mockResolvedValue(backup("config"));

    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h("div", [
            // 复刻 SetBackup/Index.vue 旧写法：内联对象字面量 → 每次父渲染都是新引用
            h(Dialog as any, {
              modelValue: open.value,
              "onUpdate:modelValue": (v: boolean) => (open.value = v),
              restoreMetadata: { type: "file" },
            }),
            h("span", { class: "unrelated" }, String(unrelatedTick.value)),
          ]),
      }),
      { pinia, router: true },
    );

    try {
      open.value = true;
      await nextTick();
      await view.settle();
      const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "backup.zip")] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await view.settle(120);

      const configCheckbox = () =>
        document.body.querySelector<HTMLInputElement>(".ant-checkbox-group input[value='config']")!;
      expect(configCheckbox().disabled, "备份解析完成后该字段应可选").toBe(false);

      // 触发一次与恢复无关的父组件重渲染
      unrelatedTick.value++;
      await nextTick();
      await view.settle(120);

      expect(configCheckbox().disabled, "父组件重渲染后已解析的备份不得被清空（否则会跳回第一步）").toBe(false);
    } finally {
      view.unmount();
    }
  });
});
