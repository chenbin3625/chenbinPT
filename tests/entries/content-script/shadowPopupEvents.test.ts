/**
 * closed shadow root 内的 antd Select 外部点击误判（见 shadowPopupEvents.ts）。
 *
 * 用真实的 antd Select / AutoComplete 挂到 closed shadow 里，模拟 antd 在 window 上的 mousedown 监听：
 * 拦截范围必须覆盖所有 Select 类组件（推送弹窗里的下载器选择、保存路径/标签自动补全），
 * 而不是只覆盖分页条的每页条数选择器；shadow 外的点击仍必须冒泡到 window（真正的外部点击）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import { AutoComplete, ConfigProvider, Pagination, Select } from "ant-design-vue";

import { stopRetargetedSelectPointerDown } from "@/content-script/app/shadowPopupEvents.ts";

let app: App | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

async function mountInClosedShadow() {
  host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "closed" });
  const popup = document.createElement("div");
  popup.addEventListener("mousedown", stopRetargetedSelectPointerDown);
  popup.addEventListener("touchstart", stopRetargetedSelectPointerDown);
  const mount = document.createElement("div");
  const plain = document.createElement("button");
  plain.className = "plain-button";
  popup.append(mount, plain);
  shadow.append(popup);
  document.body.append(host);

  app = createApp({
    render: () =>
      h(
        ConfigProvider,
        { getPopupContainer: () => popup },
        {
          default: () => [
            h(Select, { class: "downloader-select", options: [{ value: "qb" }], open: true }),
            h(AutoComplete, { class: "save-path", options: [{ value: "/data" }] }),
            h(Pagination, { total: 500, showSizeChanger: true }),
          ],
        },
      ),
  });
  app.mount(mount);
  await nextTick();
  await nextTick();
  return { shadow, popup, plain };
}

/** 记录冒泡到 window 的 mousedown（即 antd useSelectTriggerControl 能看到的那些） */
function recordWindowMouseDown() {
  const seen: EventTarget[] = [];
  const listener = (event: Event) => seen.push(event.target!);
  window.addEventListener("mousedown", listener);
  return { seen, stop: () => window.removeEventListener("mousedown", listener) };
}

const press = (element: Element) =>
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));

describe("closed shadow 内 Select 类组件的 mousedown 不冒出 shadow", () => {
  it("下载器 Select、保存路径 AutoComplete、分页条选择器及其弹出菜单都被拦截", async () => {
    const { popup } = await mountInClosedShadow();
    const recorder = recordWindowMouseDown();

    const targets = [
      popup.querySelector(".downloader-select .ant-select-selector"),
      popup.querySelector(".save-path .ant-select-selector"),
      popup.querySelector(".ant-pagination-options-size-changer .ant-select-selector"),
      popup.querySelector(".ant-select-dropdown"),
    ];
    for (const target of targets) {
      expect(target).not.toBeNull();
      press(target!);
    }

    recorder.stop();
    expect(recorder.seen).toEqual([]);
  });

  it("弹层里非 Select 的元素照常冒泡（其它组件的外部点击判定不受影响）", async () => {
    const { plain } = await mountInClosedShadow();
    const recorder = recordWindowMouseDown();

    press(plain);

    recorder.stop();
    expect(recorder.seen).toHaveLength(1);
  });
});
