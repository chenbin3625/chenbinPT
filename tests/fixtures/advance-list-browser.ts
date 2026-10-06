import { createPinia } from "pinia";
import { ConfigProvider, FloatButton, Select } from "ant-design-vue";
import type { Component } from "vue";
import { StyleProvider } from "ant-design-vue/es/_util/cssinjs";
import { Teleport, createApp, defineComponent, h, provide, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import appCss from "@/content-script/app/app.css?inline";
import { stopRetargetedSelectPointerDown } from "@/content-script/app/shadowPopupEvents.ts";
import resetCss from "ant-design-vue/dist/reset.css?inline";
import optionsCss from "@/options/style.css?inline";
import AdvanceListModuleDialog from "@/content-script/app/components/AdvanceListModuleDialog.vue";
import { antdInstance } from "@/options/plugins/antd.ts";
import { i18nInstance } from "@/options/plugins/i18n.ts";

const host = document.createElement("div");
const shadow = host.attachShadow({ mode: "closed" });
const style = document.createElement("style");
style.textContent = `${resetCss}\n${appCss.replaceAll(":root", ":host")}\n${optionsCss}`;
const mount = document.createElement("div");
mount.id = "ptd-content-script-app";
const popup = document.createElement("div");
popup.className = "ptd-content-script-popup-host";
popup.addEventListener("mousedown", stopRetargetedSelectPointerDown);
popup.addEventListener("touchstart", stopRetargetedSelectPointerDown);
shadow.append(style, mount, popup);
document.body.append(host);

const shown = ref(false);
// 与「推送到…」弹窗里的下载器选择同型的普通 Select（M：shadowPopupEvents 只放行分页器时它打不开）
const downloader = ref<string>();
const menuOpen = ref(true);
const items = Array.from({ length: 100 }, (_, index) => ({
  id: `torrent-${index + 1}`,
  title: `Torrent ${index + 1}`,
  site: "test",
  link: `https://example.com/${index + 1}`,
}));

const Root = defineComponent({
  setup() {
    provide("remoteDownloadDialogData", { show: false, torrents: [], isDefaultSend: false });
    return () =>
      h(
        StyleProvider,
        { container: shadow },
        {
          default: () =>
            h(
              ConfigProvider,
              { getPopupContainer: () => popup },
              {
                default: () => [
                  // 真实扩展里 Select 只出现在弹窗内，而弹窗渲染在 popup host 下 —— 这里放到同一位置
                  h(Teleport, { to: popup }, [
                    h(Select as Component, {
                      class: "fixture-downloader-select",
                      style: "position: fixed; left: 20px; top: 20px; width: 200px; z-index: 2000",
                      value: downloader.value,
                      "onUpdate:value": (value: string) => (downloader.value = value),
                      options: [{ value: "qbittorrent" }, { value: "transmission" }],
                    }),
                  ]),
                  h(
                    "div",
                    { class: "ptd-content-script-draggable", onClick: (event: MouseEvent) => event.stopPropagation() },
                    [
                      h(
                        FloatButton.Group,
                        {
                          open: menuOpen.value,
                          "onUpdate:open": (value: boolean) => (menuOpen.value = value),
                          trigger: "click",
                          shape: "square",
                        },
                        {
                          default: () =>
                            h(AdvanceListModuleDialog, {
                              modelValue: shown.value,
                              "onUpdate:modelValue": (value: boolean | undefined) => (shown.value = value ?? false),
                              torrentItems: items,
                            }),
                        },
                      ),
                    ],
                  ),
                ],
              },
            ),
        },
      );
  },
});
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/", component: { render: () => null } }],
});
createApp(Root).use(createPinia()).use(i18nInstance).use(router).use(antdInstance).mount(mount);
Object.assign(window, {
  openAdvanceListFixture: () => (shown.value = true),
  advanceListShadow: shadow,
  getFixtureDownloader: () => downloader.value,
});
