/**
 * antd Select 类组件（Select / AutoComplete / 分页条的每页条数选择器）在 window 上监听 mousedown
 * 判断「外部点击」（vc-select/hooks/useSelectTriggerControl.js）。它只在 `target.shadowRoot` 可读时
 * 才回溯 `composedPath()`；我们的 shadow root 是 closed，window 上看到的 target 只是宿主节点，
 * 于是任何一次在选择器或其弹出菜单内的按下都会被判为外部点击，下拉框刚打开就被关掉。
 *
 * 这里在事件冒出 shadow root 之前拦下来自选择器本体与弹出菜单的 mousedown/touchstart。
 * 选择器自身的展开/选中逻辑挂在元素上，不受影响；真正的外部点击（shadow 之外）照常冒泡到 window。
 *
 * 同一个 shadow root 上还需要 sentinel 抢焦点守卫（closed shadow 下 vc-dialog 会误判「焦点在弹窗
 * 外」，见 `installDialogSentinelFocusGuard`）；两个守卫共用同一个入口，避免调用方只挂了一个。
 */
const SELECT_POINTER_SCOPE = ".ant-select, .ant-select-dropdown";

/**
 * vc-dialog（antd Modal）的 start/end focus sentinel：`.ant-modal` 下无 class 的 `div[tabindex="0"]`
 * （vc-dialog/Content.js）。
 */
const DIALOG_SENTINEL_SELECTOR = ".ant-modal > div[tabindex='0']";

/** 已挂过 sentinel 守卫的 shadow root（同一个 root 只挂一次）。 */
const dialogSentinelGuardedRoots = new WeakSet<ShadowRoot>();

/**
 * closed shadow 下 antd Modal 入场结束时会把焦点从 shadow 内已聚焦的元素上抢走，
 * 从而关掉此刻已打开的 Select 下拉（TESTS-5 残留：真实浏览器连跑 10 次约 3 次在
 * 「点击每页条数下拉选项」处失败）。完整机理（探针实测的时间线）：
 *
 * vc-dialog/Dialog.js 在入场动画结束（`Content` 的 `onAfterEnter`）时执行
 * `onVisibleChanged(true)` → `if (!contains(wrapper, document.activeElement)) contentRef.focus()`
 * （聚焦上面的 start sentinel），本意是「弹窗打开后把焦点移入弹窗」。但我们的 shadow root 是
 * closed：只要焦点位于 shadow 内，宿主页面看到的 `document.activeElement` 就只会是 **shadow 宿主
 * 元素**，它永远不在 `.ant-modal-wrap` 里 —— 这个 contains() 于是一次不落地判为 false，
 * 每次弹窗入场动画结束都会抢焦点（rAF 被节流时可能晚到数秒，实测 blur 出现在弹窗打开后约 2~5s）。
 * 若此刻有一个 Select 下拉是打开的，它的搜索框收到 blur：vc-select 的 Input 把 blur 延迟 100ms
 * 交出去，容器随后关闭下拉（实测：blur@2862ms → 下拉 `-slide-up-leave` + `pointer-events: none`
 * @2977ms），点击选项因此落到弹窗遮罩上、下拉被当成「外部点击」。
 *
 * 这里只撤销这一次被 shadow 边界误判触发的程序化抢焦点：焦点落到弹窗 sentinel、且上一处焦点在
 * **已展开**的 Select（`.ant-select-open`）内时，立刻把焦点还给该 Select 的搜索框 —— 恢复发生在
 * 那 100ms 的 blur 去抖之内，vc-select 的 `onFocus` 会清掉待执行的 blur 回调，下拉不再被关掉。
 * 用户的真实 Tab 移动不受影响：把焦点从「已展开的 Select」直接移到弹窗 sentinel 只可能是这种
 * 程序化抢焦点（sentinel 位于弹窗内容的两端，不是 Select 的邻居）。
 */
function restoreSelectFocusAfterDialogSentinel(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element) || !target.matches(DIALOG_SENTINEL_SELECTOR)) return;

  // ShadowRoot 的事件表只声明了 slotchange，focusin 只能拿到 Event，需要显式窄化
  const previous = event instanceof FocusEvent ? event.relatedTarget : null;
  if (!(previous instanceof Element)) return;

  const input = previous
    .closest(".ant-select-open")
    ?.querySelector<HTMLElement>("input.ant-select-selection-search-input");
  input?.focus({ preventScroll: true });
}

/**
 * 把 sentinel 抢焦点守卫挂到 shadow root 上（幂等）。content-script 的 init.ts 显式调用；
 * 只挂指针守卫的调用方（如 tests/fixtures 里手工搭 shadow 的替身）会在第一次按下时由
 * `stopRetargetedSelectPointerDown` 惰性补挂，保证两处守卫总是同时生效。
 */
export function installDialogSentinelFocusGuard(shadowRoot: ShadowRoot): void {
  if (dialogSentinelGuardedRoots.has(shadowRoot)) return;
  dialogSentinelGuardedRoots.add(shadowRoot);
  shadowRoot.addEventListener("focusin", restoreSelectFocusAfterDialogSentinel);
}

export function stopRetargetedSelectPointerDown(event: Event): void {
  const target = event.target;
  if (target instanceof Element && target.closest(SELECT_POINTER_SCOPE)) {
    const root = target.getRootNode();
    if (root instanceof ShadowRoot) installDialogSentinelFocusGuard(root);
    event.stopPropagation();
  }
}
