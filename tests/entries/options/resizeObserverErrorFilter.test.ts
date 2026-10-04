import { describe, expect, it, vi } from "vitest";

import {
  installResizeObserverLoopErrorFilter,
  isResizeObserverLoopError,
} from "@/options/resizeObserverErrorFilter.ts";

describe("ResizeObserver loop error filter", () => {
  it("recognizes browser-level ResizeObserver delivery noise", () => {
    expect(isResizeObserverLoopError("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    expect(isResizeObserverLoopError("ResizeObserver loop limit exceeded")).toBe(true);
  });

  it("does not treat unrelated errors as ResizeObserver loop noise", () => {
    expect(isResizeObserverLoopError("ResizeObserver constructor failed")).toBe(false);
    expect(isResizeObserverLoopError("TypeError: Cannot read properties of undefined")).toBe(false);
    expect(isResizeObserverLoopError(undefined)).toBe(false);
  });

  it("prevents only ResizeObserver loop error events", () => {
    const addEventListener = vi.fn();
    installResizeObserverLoopErrorFilter({ addEventListener } as unknown as Window);
    const handler = addEventListener.mock.calls[0]![1] as EventListener;

    const resizeObserverEvent = {
      message: "ResizeObserver loop completed with undelivered notifications.",
      preventDefault: vi.fn(),
    };
    handler(resizeObserverEvent as unknown as ErrorEvent);
    expect(resizeObserverEvent.preventDefault).toHaveBeenCalledTimes(1);

    const realErrorEvent = { message: "TypeError: boom", preventDefault: vi.fn() };
    handler(realErrorEvent as unknown as ErrorEvent);
    expect(realErrorEvent.preventDefault).not.toHaveBeenCalled();
  });
});
