import { message as staticMessage } from "ant-design-vue";

/**
 * options 页的静态 `message` 出口重定向。
 *
 * `runtimeStore.showSnackbar`、持久化失败提示与全局错误兜底都直接调用 `import { message }`。
 * antd 的静态 `message` 会新建一个游离的 app 渲染通知条，拿不到组件树里 ConfigProvider 的
 * 主题（深色模式下仍是浅色通知条）。这里把 `message.open` 重定向到 options/App.vue 中
 * `message.useMessage()` 生成的实例 —— 它的 holder 渲染在 ConfigProvider 之下，主题/语言一致。
 */
type MessageApi = ReturnType<typeof staticMessage.useMessage>[0];

let optionsMessageApi: MessageApi | undefined;

/** 由 options/App.vue 在 onMounted 中调用（holder 挂载后 open() 才不会被丢弃）。 */
export function registerMessageApi(api: MessageApi) {
  optionsMessageApi = api;
}

const rawStaticMessageOpen = staticMessage.open.bind(staticMessage);

// 与 content-script/app/modal.ts 保持一致：antd 的 message.info/success/... 都经由 open 派发。
// 未注册时（例如单元测试里单独导入本模块）回退到原始静态实现，行为不变。
staticMessage.open = ((args: Parameters<typeof staticMessage.open>[0]) =>
  optionsMessageApi ? optionsMessageApi.open(args as never) : rawStaticMessageOpen(args)) as typeof staticMessage.open;
