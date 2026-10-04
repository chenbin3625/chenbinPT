import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { Modal } from "ant-design-vue";

/**
 * 回归用例：ant-design-vue 4 把 `afterClose` 声明为 **prop**（modalProps 里 `afterClose: Function`，
 * 组件没有 `emits: ['afterClose']`），vc-dialog 只在「可见性 true -> false 且离场过渡结束」时执行
 * `props.afterClose`。
 *
 * 因此模板里必须写 `:after-close="fn"`（编译成 `afterClose` prop）；
 * 写成 `@after-close="fn"` 会编译成 `onAfterClose` 落到 attrs，永远不会被调用。
 *
 * 这里不引 @vue/test-utils（不是本仓库依赖），直接用 vue 的 createApp + h 渲染 a-modal。
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeout = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

/** 渲染一个把 a-modal 挂在 open ref 上的宿主组件，返回控制句柄。 */
async function mountModal(props: Record<string, unknown>, initialOpen = true) {
  const open = ref(initialOpen);
  const host = document.createElement("div");
  document.body.appendChild(host);

  const app = createApp(
    defineComponent({
      name: "ModalTestHost",
      setup() {
        return () => h(Modal, { open: open.value, ...props }, () => "payload");
      },
    }),
  );
  app.mount(host);
  // 等首帧 + 入场过渡，确保 mask/content 已挂载
  await sleep(80);

  return {
    open,
    async close() {
      open.value = false;
      await nextTick();
    },
    async cleanup() {
      await sleep(20);
      app.unmount();
      host.remove();
    },
  };
}

describe("a-modal afterClose 事件 / prop 语义", () => {
  it("正确写法 :after-close（afterClose prop）在关闭后被调用一次", async () => {
    const onAfterClose = vi.fn();
    const modal = await mountModal({ afterClose: onAfterClose, footer: null });

    expect(onAfterClose).not.toHaveBeenCalled();
    await modal.close();

    const fired = await waitFor(() => onAfterClose.mock.calls.length > 0);
    expect(fired, "afterClose prop 未在离场过渡结束后被调用").toBe(true);
    expect(onAfterClose).toHaveBeenCalledTimes(1);

    await modal.cleanup();
  });

  it("反证：错误写法 @after-close（onAfterClose attr）不会被调用", async () => {
    const onAfterClose = vi.fn();
    // 模板 @after-close="fn" 编译产物就是这个 onAfterClose 属性（落在 attrs 里）
    const modal = await mountModal({ onAfterClose, footer: null });

    await modal.close();
    await sleep(400); // 比上一条用例的等待窗口更长，确认它不是「还没触发」而是「永不触发」

    expect(onAfterClose).not.toHaveBeenCalled();

    await modal.cleanup();
  });

  it("先传 onAfterClose 再传 afterClose 时，只有 afterClose 生效（同一实例对照）", async () => {
    const wrong = vi.fn();
    const right = vi.fn();
    const modal = await mountModal({ onAfterClose: wrong, afterClose: right, footer: null });

    await modal.close();
    const fired = await waitFor(() => right.mock.calls.length > 0);
    expect(fired).toBe(true);
    expect(wrong).not.toHaveBeenCalled();

    await modal.cleanup();
  });

  it("反复开关时 afterClose 每次关闭各触发一次（无重复执行）", async () => {
    const onAfterClose = vi.fn();
    const modal = await mountModal({ afterClose: onAfterClose, footer: null });

    await modal.close();
    expect(await waitFor(() => onAfterClose.mock.calls.length === 1)).toBe(true);

    modal.open.value = true;
    await nextTick();
    await sleep(120);

    await modal.close();
    expect(await waitFor(() => onAfterClose.mock.calls.length === 2)).toBe(true);
    // 再多等一段时间，确认没有超量触发（例如 leave + destroy 双触发）
    await sleep(300);
    expect(onAfterClose).toHaveBeenCalledTimes(2);

    await modal.cleanup();
  });

  it("对话框在打开状态下被卸载（v-if 场景）不会触发 afterClose", async () => {
    const onAfterClose = vi.fn();
    const modal = await mountModal({ afterClose: onAfterClose, footer: null });

    // 不关闭，直接卸载（对应 ActionTd.vue 里 `v-if="showDownloadClientDialog"` 的用法）
    await modal.cleanup();
    await sleep(300);

    expect(onAfterClose).not.toHaveBeenCalled();
  });

  it("以关闭状态挂载（常驻在父组件里的对话框）时不会误触发 afterClose", async () => {
    const onAfterClose = vi.fn();
    const modal = await mountModal({ afterClose: onAfterClose, footer: null }, false);

    // 常驻挂载但从未打开：不应触发（否则常驻对话框会在打开选项页时就先把状态写掉）
    await sleep(500);
    expect(onAfterClose).not.toHaveBeenCalled();

    // 真正打开再关闭时才触发
    modal.open.value = true;
    await nextTick();
    await sleep(120);
    await modal.close();
    expect(await waitFor(() => onAfterClose.mock.calls.length === 1)).toBe(true);

    await modal.cleanup();
  });

  /**
   * 现状记录（不是回归断言，而是给 Lead 的核对依据）：
   * ActionTd.vue 里 `<SentToDownloaderDialog v-if="showDownloadClientDialog" v-model="showDownloadClientDialog">`
   * 把 v-if 和 v-model 绑到了同一个 ref —— 关闭时父组件先卸载整个子组件（连同 a-modal），
   * 离场过渡被打断，afterClose 不会触发。该用法在 Vuetify 版（HEAD）里没有 v-if，是本次重构新增的 P1-17 按需挂载。
   */
  it("父组件把 v-if 与 v-model 绑同一 ref 时，关闭会先卸载组件，afterClose 不触发（ActionTd 现状）", async () => {
    const onAfterClose = vi.fn();
    let closeModal: (() => void) | undefined;

    const ChildDialog = defineComponent({
      name: "ChildDialog",
      props: { open: { type: Boolean, default: false } },
      emits: ["update:open"],
      setup(props, { emit }) {
        closeModal = () => emit("update:open", false);
        return () => h(Modal, { open: props.open, afterClose: onAfterClose, footer: null }, () => "payload");
      },
    });

    const Parent = defineComponent({
      name: "ParentHost",
      setup() {
        const open = ref(true);
        return () =>
          open.value ? h(ChildDialog, { open: open.value, "onUpdate:open": (v: boolean) => (open.value = v) }) : null;
      },
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(Parent);
    app.mount(host);
    await sleep(80);

    closeModal!();
    await nextTick();
    await sleep(500);

    expect(onAfterClose).not.toHaveBeenCalled();

    app.unmount();
    host.remove();
  });
});
