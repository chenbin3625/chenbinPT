/**
 * L-7：内容脚本覆盖层要应用用户的语言设置。
 * 覆盖层只经过 useAntdConfig（不经过 options/App.vue 的 watch），旧实现里 vue-i18n 的全局 locale 恒为 zh_CN。
 */
import { describe, expect, it } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

(globalThis as any).__BROWSER__ ??= "chrome";

const { useAntdConfig } = await import("@/options/plugins/antd.ts");
const { i18nInstance } = await import("@/options/plugins/i18n.ts");
const { useConfigStore } = await import("@/options/stores/config.ts");

describe("内容脚本覆盖层语言（L-7）", () => {
  it("configStore.lang 切换时 vue-i18n 的全局语言跟随", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const configStore = useConfigStore(pinia);
    configStore.lang = "en";

    const host = document.createElement("div");
    const app = createApp(
      defineComponent({
        setup() {
          useAntdConfig();
          return () => h("span", i18nInstance.global.t("contentScript.openPTD"));
        },
      }),
    )
      .use(pinia)
      .use(i18nInstance);
    app.mount(host);
    try {
      await nextTick();
      expect(i18nInstance.global.locale.value).toBe("en");

      configStore.lang = "zh_CN";
      await nextTick();
      expect(i18nInstance.global.locale.value).toBe("zh_CN");
    } finally {
      app.unmount();
      i18nInstance.global.locale.value = "zh_CN";
    }
  });
});
