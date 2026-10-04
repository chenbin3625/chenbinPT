const resizeObserverLoopMessages = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
]);

export function isResizeObserverLoopError(message: unknown): boolean {
  return typeof message === "string" && resizeObserverLoopMessages.has(message);
}

export function installResizeObserverLoopErrorFilter(target: Pick<Window, "addEventListener"> = window): void {
  target.addEventListener("error", (event) => {
    if (isResizeObserverLoopError((event as ErrorEvent).message)) {
      event.preventDefault();
    }
  });
}
