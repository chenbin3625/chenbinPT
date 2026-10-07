import { h, ref } from "vue";
import { Input, Modal, message as staticMessage } from "ant-design-vue";

/**
 * shadow root 内的 overlay 服务（Modal / message）。
 *
 * overlay 应用挂在 shadow DOM 里，antd 的**静态** `Modal.xxx` 会 `vueRender` 到一个游离的
 * document fragment（见 `ant-design-vue/es/modal/confirm.js`），既不进 shadow root、也拿不到
 * `ConfigProvider` 的主题/语言/`getPopupContainer`，弹窗会完全失去样式。
 *
 * 因此这里改用 `Modal.useModal()`：由 `App.vue` 在 `ConfigProvider` 之下调用它，并把返回的
 * `contextHolder` 渲染进自己的模板，弹窗就落在 shadow root 内（`getContainer` 走 ConfigProvider
 * 的 `getPopupContainer` → `popupHostElement`）。
 *
 * `message` 与 Modal 同根因，注册逻辑见文件下方的 CONTENTSCRIPT-1 段落（本模块顺带承担这一处
 * 注册，避免新增文件或新的循环 import）。
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

/**
 * CONTENTSCRIPT-1：静态 `message` 的通知条在 closed shadow root 内是无样式块。
 *
 * 与静态 Modal 同一个根因：`message.open()` 走 `Notification.newInstance()`，在 shadow root
 * **之外**新建一份 app 来渲染并生成 `.ant-message` 的 cssinjs 规则；`message.config({ getContainer })`
 * 只改 DOM 挂载点，不改 cssinjs 的注入目标 ⇒ 规则留在宿主 `document.head`，节点却挂在 closed
 * shadow root 里，于是「复制成功/失败」「未解析到种子」等提示既没有定位也没有背景。
 * 而内容脚本唯一的用户反馈通道 `runtimeStore.showSnakebar` 用的正是这个静态 API。
 *
 * 因此把静态 API 的出口重定向到 `message.useMessage()` 的实例：它的 holder 由 `App.vue` 渲染在
 * `ConfigProvider` 之下，样式经 `StyleProvider(container=shadowRoot)` 注入 shadow root。
 */
type MessageApi = ReturnType<typeof staticMessage.useMessage>[0];

let shadowMessageApi: MessageApi | undefined;

/** 由 App.vue 在 onMounted 里调用：holder 挂载后 `useMessage().open()` 才不会被丢弃。 */
export function registerMessageApi(api: MessageApi) {
  shadowMessageApi = api;
}

// antd 的 message.info/success/error/... 都经由 `api.open` 派发（见 attachTypeApi），所以只重定向 open。
// 未注册时（holder 尚未挂载、或测试里单独导入本模块）回退为原来的静态实现，行为与修复前一致。
const rawStaticMessageOpen = staticMessage.open.bind(staticMessage);
staticMessage.open = ((args: Parameters<typeof staticMessage.open>[0]) =>
  shadowMessageApi ? shadowMessageApi.open(args as never) : rawStaticMessageOpen(args)) as typeof staticMessage.open;
