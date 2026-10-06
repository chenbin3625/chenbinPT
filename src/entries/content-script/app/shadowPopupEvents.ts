/**
 * antd Select 类组件（Select / AutoComplete / 分页条的每页条数选择器）在 window 上监听 mousedown
 * 判断「外部点击」（vc-select/hooks/useSelectTriggerControl.js）。它只在 `target.shadowRoot` 可读时
 * 才回溯 `composedPath()`；我们的 shadow root 是 closed，window 上看到的 target 只是宿主节点，
 * 于是任何一次在选择器或其弹出菜单内的按下都会被判为外部点击，下拉框刚打开就被关掉。
 *
 * 这里在事件冒出 shadow root 之前拦下来自选择器本体与弹出菜单的 mousedown/touchstart。
 * 选择器自身的展开/选中逻辑挂在元素上，不受影响；真正的外部点击（shadow 之外）照常冒泡到 window。
 */
const SELECT_POINTER_SCOPE = ".ant-select, .ant-select-dropdown";

export function stopRetargetedSelectPointerDown(event: Event): void {
  const target = event.target;
  if (target instanceof Element && target.closest(SELECT_POINTER_SCOPE)) {
    event.stopPropagation();
  }
}
