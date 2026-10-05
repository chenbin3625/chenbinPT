/**
 * `@click` 落在「第一个 emit 参数不是 Event」的组件上时，不能用 Vue 的 `.stop` 修饰符。
 *
 * 起因（线上报错）：`TypeError: e.stopPropagation is not a function`，栈落在 antd Switch 内部的
 * AntdIcon 上。Vue 的 `.stop` 编译为 `withModifiers(fn, ["stop"])`，守卫是 `(e) => e.stopPropagation()`，
 * 消费的是组件 emit 的**第一个**参数；而 antd 的 a-switch 是 `emit('click', newChecked, e)`
 * （node_modules/ant-design-vue/es/switch/index.js:130），守卫拿到布尔值 newChecked 就炸。
 *
 * 这里同时钉住两件事：
 * 1. `stopEventPropagation` 只对该调用里的**最后一个**参数（原始事件）调用 stopPropagation，
 *    绝不碰前面的载荷；
 * 2. 在真实挂载的组件上，`@click="stopEventPropagation"` 收到 `(载荷, event)` 时不再抛错，
 *    并且真的挡住了冒泡（用 `@click.stop` 的旧写法在本用例里会直接失败）。
 */
import { defineComponent, h, ref } from "vue";

import { describe, expect, it, vi } from "vitest";

import { mountOptionsView } from "../../helpers/optionsView.ts";
import { stopEventPropagation } from "@/options/utils.ts";

/** 与 antd Switch 的 click 载荷一致的替身组件 */
const SwitchLike = defineComponent({
  name: "SwitchLike",
  emits: ["click"],
  setup(_, { emit }) {
    return () =>
      h("button", {
        type: "button",
        onClick: (e: Event) => emit("click", true, e),
      });
  },
});

/** 与 antd Checkbox 的 click 载荷一致（第一个参数就是原生事件）的替身组件 */
const CheckboxLike = defineComponent({
  name: "CheckboxLike",
  emits: ["click"],
  setup(_, { emit }) {
    return () =>
      h("button", {
        type: "button",
        onClick: (e: Event) => emit("click", e),
      });
  },
});

describe("stopEventPropagation", () => {
  it("对调用里的最后一个参数（原始事件）停止冒泡，不触碰前面的载荷", () => {
    const stopPropagation = vi.fn();
    const payloadStopPropagation = vi.fn();

    stopEventPropagation({ stopPropagation: payloadStopPropagation }, { stopPropagation });

    expect(payloadStopPropagation).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("对单个事件参数（原生标签 / a-checkbox 等）同样生效", () => {
    const stopPropagation = vi.fn();

    stopEventPropagation({ stopPropagation });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("载荷里没有事件时不抛错（防御未来某个组件不再透传事件）", () => {
    expect(() => stopEventPropagation(true)).not.toThrow();
    expect(() => stopEventPropagation(true, undefined)).not.toThrow();
    expect(() => stopEventPropagation()).not.toThrow();
  });
});

describe("模板里 `@click` 于「载荷非 Event」组件上的真实行为", () => {
  it('`@click="stopEventPropagation"` 收到 (载荷, event)：不抛错且挡住冒泡', async () => {
    const outerClicks: string[] = [];
    const innerErrors: unknown[] = [];

    const Parent = defineComponent({
      components: { SwitchLike },
      setup() {
        const label = ref("开关");
        return () =>
          h(
            "div",
            {
              onClick: () => outerClicks.push("outer"),
            },
            [
              h(SwitchLike, {
                onClick: stopEventPropagation,
              }),
              h("span", label.value),
            ],
          );
      },
    });

    // 直接挂载：用 app.config.errorHandler 捕获「守卫抛错」，这正是线上报错的表现
    const mounted = mountOptionsView(Parent);
    mounted.app.config.errorHandler = (error) => innerErrors.push(error);

    const button = mounted.$<HTMLButtonElement>("button")!;
    button.click();
    await mounted.settle(0);

    expect(innerErrors, "不应再出现 stopPropagation is not a function").toEqual([]);
    expect(outerClicks, "click 不应冒泡到外层").toEqual([]);

    mounted.unmount();
  });

  it("对照：`@click.stop` 的旧写法在同样的载荷下会抛错（说明本用例真的能覆盖该缺陷）", async () => {
    const errors: unknown[] = [];

    const Parent = defineComponent({
      components: { SwitchLike },
      setup() {
        // 复刻 Vue 编译 `.stop` 的结果：withModifiers 的 stop 守卫是 (e) => e.stopPropagation()
        const onClickStop = (e: any) => e.stopPropagation();
        return () => h(SwitchLike, { onClick: onClickStop });
      },
    });

    const mounted = mountOptionsView(Parent);
    mounted.app.config.errorHandler = (error) => errors.push(error);

    mounted.$<HTMLButtonElement>("button")!.click();
    await mounted.settle(0);

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("stopPropagation is not a function");

    mounted.unmount();
  });

  it("原生标签 / a-checkbox 这类「第一个参数就是 Event」的组件仍然可以直接用 @click", async () => {
    const outerClicks: string[] = [];

    const Parent = defineComponent({
      components: { CheckboxLike },
      setup() {
        return () =>
          h("div", { onClick: () => outerClicks.push("outer") }, [h(CheckboxLike, { onClick: stopEventPropagation })]);
      },
    });

    const mounted = mountOptionsView(Parent);
    mounted.$<HTMLButtonElement>("button")!.click();
    await mounted.settle(0);

    expect(outerClicks).toEqual([]);

    mounted.unmount();
  });
});
