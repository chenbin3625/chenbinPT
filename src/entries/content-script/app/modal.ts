import { h, ref } from "vue";
import { Input, Modal } from "ant-design-vue";

/**
 * shadow root 内的 Modal 服务。
 *
 * overlay 应用挂在 shadow DOM 里，antd 的**静态** `Modal.xxx` 会 `vueRender` 到一个游离的
 * document fragment（见 `ant-design-vue/es/modal/confirm.js`），既不进 shadow root、也拿不到
 * `ConfigProvider` 的主题/语言/`getPopupContainer`，弹窗会完全失去样式。
 *
 * 因此这里改用 `Modal.useModal()`：由 `App.vue` 在 `ConfigProvider` 之下调用它，并把返回的
 * `contextHolder` 渲染进自己的模板，弹窗就落在 shadow root 内（`getContainer` 走 ConfigProvider
 * 的 `getPopupContainer` → `popupHostElement`）。
 */

type ModalApi = ReturnType<typeof Modal.useModal>[0];
type ModalHandle = ReturnType<ModalApi["confirm"]>;

let showModalDialog: ModalApi["confirm"] | undefined;

/** 由 App.vue 在 setup 里调用；重复挂载（content-script remount）时会用新实例覆盖旧实例。 */
export function registerModalApi(api: ModalApi) {
  showModalDialog = api.confirm;
}

function requireModalDialog(): ModalApi["confirm"] {
  if (!showModalDialog) {
    throw new Error("[PTD] Modal API 未注册：请在 App.vue 的 setup 中调用 registerModalApi()");
  }
  return showModalDialog;
}

/** 等价于浏览器原生确认框：点确定 → true；点取消 / ESC → false。 */
export function confirmModal(message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    requireModalDialog()({
      content: message,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

/** 等价于浏览器原生输入框：点确定 / 回车 → 输入值；点取消 / ESC → null。 */
export function promptModal(title: string, defaultValue = ""): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const value = ref(defaultValue);
    const inputRef = ref<{ focus?: () => void } | null>(null);
    const setInputRef = (el: unknown) => {
      inputRef.value = el as { focus?: () => void } | null;
    };
    let handle: ModalHandle | undefined;

    const finish = (result: string) => {
      resolve(result);
      handle?.destroy(); // destroy 不带 triggerCancel，不会再触发 onCancel
    };

    handle = requireModalDialog()({
      title,
      // 关掉 antd 默认「聚焦确定按钮」，把焦点留给输入框
      autoFocusButton: null,
      content: () =>
        h(Input, {
          ref: setInputRef,
          autofocus: true,
          allowClear: true,
          value: value.value,
          "onUpdate:value": (v: string) => (value.value = v),
          onPressEnter: () => finish(value.value),
        }),
      onOk: () => resolve(value.value),
      onCancel: () => resolve(null),
    });

    // antd 的 Dialog 打开后会把焦点收进弹窗容器，这里在下一轮宏任务里抢回输入框，
    // 与浏览器的输入对话框「打开即聚焦」保持一致（拿不到焦点时也只是退化，无副作用）。
    window.setTimeout(() => inputRef.value?.focus?.(), 0);
  });
}
