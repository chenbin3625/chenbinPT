/**
 * CONTENTSCRIPT-1：内容脚本的通知条（antd 静态 message）必须在 shadow root 内渲染**并**带上样式。
 *
 * 修复前：静态 `message.open()` 走 `Notification.newInstance()` 在 shadow root 之外新建一份渲染，
 * 节点经 `message.config({ getContainer })` 挂进 popup host，但 `.ant-message` 的 cssinjs 规则注入到
 * 宿主 document.head ⇒ shadow root 内的通知条没有定位/背景（内容脚本唯一的用户反馈通道失效）。
 *
 * 这里按 init.ts 的真实层次搭 closed shadow root + StyleProvider(container=shadowRoot) +
 * ConfigProvider(getPopupContainer→popupHost)，然后**调用静态 API**（runtimeStore.showSnakebar
 * 最终就是这一次调用），断言节点落在 popup host，且 antd 生成的组件样式注入 shadow root 而**不**落到
 * 宿主 document.head（只断言「shadow 里含 .ant-message」会被 app.css 自身选择器掩盖，见用例内注释）。
 *
 * 构建版本配对说明：vitest 的 node 解析按 package.json `main` 取 ant-design-vue 的 `lib/` 构建，
 * 而 `ant-design-vue/es/_util/cssinjs` 是另一份 cssinjs 实例（StyleContextKey 是两个 Symbol），
 * 混用会让 StyleProvider 的 container 对 lib 组件不可见。生产构建走 `module` → 全部是 `es/`（单一实例），
 * 因此这里把 message 与 StyleProvider 都固定在 `lib/` 上，复现生产里的「同一份 cssinjs」图。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { createApp, defineComponent, h, nextTick, onMounted } from "vue";
import { ConfigProvider, message as staticMessage } from "ant-design-vue";
import { StyleProvider } from "ant-design-vue/lib/_util/cssinjs";

import { registerMessageApi } from "@/content-script/app/modal.ts";

const appCss = readFileSync(resolve(import.meta.dirname, "../../../src/entries/content-script/app/app.css"), "utf8");

describe("shadow root 内的通知条（CONTENTSCRIPT-1）", () => {
  it("静态 message 被重定向到 useMessage 实例：节点进 popup host，样式注入 shadow root", async () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "closed" });
    // 复刻 init.ts：先注入 app.css（base style），再挂 popup host
    const baseStyle = document.createElement("style");
    baseStyle.textContent = appCss.replaceAll(":root", ":host");
    shadow.append(baseStyle);
    const popup = document.createElement("div");
    popup.className = "ptd-content-script-popup-host";
    shadow.append(popup);
    document.body.append(host);

    const Root = defineComponent({
      setup() {
        const [messageApi, messageContextHolder] = staticMessage.useMessage();
        onMounted(() => registerMessageApi(messageApi));
        return () =>
          h(
            StyleProvider,
            { container: shadow as unknown as HTMLElement },
            {
              default: () =>
                h(
                  ConfigProvider,
                  { getPopupContainer: () => popup },
                  { default: () => h("div", [h(messageContextHolder)]) },
                ),
            },
          );
      },
    });

    const app = createApp(Root);
    const mountPoint = document.createElement("div");
    document.body.append(mountPoint);
    try {
      app.mount(mountPoint);
      await nextTick();
      await nextTick();

      // runtimeStore.showSnakebar 的实现就是这一次静态调用
      staticMessage.open({ type: "success", content: "ptd-shadow-message-probe", duration: 0 });
      await nextTick();
      await nextTick();

      // 1) 节点在 popup host 内
      expect(popup.querySelector(".ant-message")).not.toBeNull();
      expect(popup.textContent).toContain("ptd-shadow-message-probe");

      // 2) 判据必须排除测试自己注入的 baseStyle(app.css)：app.css 自身就含 `.ant-message`
      //    选择器（见 app.css 的 pointer-events 覆盖），如果拿「shadow 样式里含 .ant-message」
      //    当判据，无论 cssinjs 有没有把规则注入 shadow 都恒为真（自证断言）。
      //    这里改为只看 **cssinjs 组件样式**：antd 生成的通知条定位规则必须出现 shadow root 里，
      //    且绝不能落到宿主 document.head（修复前静态 message.open 会新建实例、注入 head）。
      const cssinjsCss = (root: ParentNode) =>
        Array.from(root.querySelectorAll("style"))
          .filter((el) => el !== baseStyle)
          .map((el) => el.textContent ?? "")
          .join("\n");
      const MESSAGE_COMPONENT_RULE = /\.ant-message[\s\S]*?position:\s*fixed/;

      expect(cssinjsCss(shadow), "antd 通知条的组件样式应由 StyleProvider 注入 shadow root").toMatch(
        MESSAGE_COMPONENT_RULE,
      );
      expect(
        cssinjsCss(document.head),
        "修复被还原时静态 message 实例会把同一份组件规则注入宿主 document.head",
      ).not.toMatch(MESSAGE_COMPONENT_RULE);

      // 3) app.css 自身的内容守卫（读磁盘）：pointer-events 覆盖规则存在且排在 `> *` 之后，
      //    保证消息 holder 不吞掉页面顶部点击。这条与上面的渲染位置判据相互独立。
      const baseCss = baseStyle.textContent ?? "";
      expect(baseCss).toMatch(/\.ptd-content-script-popup-host\s*>\s*\.ant-message\s*\{[^}]*pointer-events:\s*none/);
      expect(baseCss.indexOf(".ptd-content-script-popup-host > .ant-message")).toBeGreaterThan(
        baseCss.indexOf(".ptd-content-script-popup-host > *"),
      );
    } finally {
      app.unmount();
      host.remove();
      mountPoint.remove();
    }
  });
});
