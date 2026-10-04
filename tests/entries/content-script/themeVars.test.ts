/**
 * content-script overlay 的 `--ptd-*` 主题变量同步（见 src/entries/content-script/app/themeVars.ts）。
 *
 * 为什么需要：overlay 跑在 shadow root 里，`chenbinpt.css` 的样式依赖 `--ptd-*`；
 * 变量必须与 init.ts 里 `appliedThemeConfig` 的判定一致——`contentScript.applyTheme`
 * 关闭时 overlay 用的是 antd 默认（浅色）algorithm，因此变量也必须是显式浅色一套，
 * **不能**依赖 style.css 里 `var(--ptd-x, <浅色回退>)` 的回退值（回退值属于 style.css
 * 的实现细节，可能被清理；一旦被删，清空变量的写法会直接掉色）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";

import { buildThemeVars, useAntdConfig } from "@/options/plugins/antd.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { syncThemeVarsToHost } from "@/content-script/app/themeVars.ts";

const LIGHT_VARS = buildThemeVars(false);
const DARK_VARS = buildThemeVars(true);
const VAR_NAMES = Object.keys(LIGHT_VARS);

/** 用真实 config store + 真实 useAntdConfig().themeVars 挂一个真实的 shadow host 元素 */
function mountThemeHost() {
  setActivePinia(createPinia());

  const configStore = useConfigStore();
  const { themeVars } = useAntdConfig();
  const host = document.createElement("div");

  const stop = syncThemeVarsToHost(
    host,
    () => themeVars.value,
    () => configStore.contentScript.applyTheme,
  );

  return {
    configStore,
    stop,
    read: (name: string) => host.style.getPropertyValue(name),
  };
}

describe("content-script overlay 的 --ptd-* 同步", () => {
  beforeEach(() => {
    // 每个用例独立 pinia，避免 store 状态串味
    setActivePinia(createPinia());
  });

  it("深浅两套键名完全一致，且核心语义 token 齐全", () => {
    // 不硬编码变量总数：buildThemeVars 会随 antd token 的补充而增长（如新增的排版与 *-text 语义色），
    // 断言总数只会让每次补充都变成一次无意义的改测试；这里锁定真正的不变量。
    expect(VAR_NAMES.length).toBeGreaterThan(0);
    expect(Object.keys(DARK_VARS)).toEqual(VAR_NAMES);
    for (const name of [
      "--ptd-bg",
      "--ptd-surface",
      "--ptd-text",
      "--ptd-border",
      "--ptd-primary",
      "--ptd-success",
      "--ptd-danger",
      "--ptd-warning",
    ]) {
      expect(VAR_NAMES, name).toContain(name);
    }
  });

  it("applyTheme 打开 + 深色：写入深色一套（14 个都有值，且与浅色不同）", async () => {
    const { configStore, read, stop } = mountThemeHost();
    configStore.theme = "dark";
    configStore.contentScript.applyTheme = true;
    await nextTick();

    for (const name of VAR_NAMES) expect(read(name)).toBe(DARK_VARS[name]);
    expect(read("--ptd-bg")).not.toBe(LIGHT_VARS["--ptd-bg"]);
    stop();
  });

  it("applyTheme 打开 + 浅色：写入浅色一套", async () => {
    const { configStore, read, stop } = mountThemeHost();
    configStore.theme = "light";
    configStore.contentScript.applyTheme = true;
    await nextTick();

    for (const name of VAR_NAMES) expect(read(name)).toBe(LIGHT_VARS[name]);
    stop();
  });

  it("applyTheme 关闭：无论 uiTheme 是什么都写入显式浅色一套（不依赖 CSS 回退）", async () => {
    const { configStore, read, stop } = mountThemeHost();

    for (const theme of ["light", "dark"] as const) {
      configStore.theme = theme;
      configStore.contentScript.applyTheme = false;
      await nextTick();

      for (const name of VAR_NAMES) {
        expect(read(name), `${name} (theme=${theme}, applyTheme=false)`).toBe(LIGHT_VARS[name]);
      }
    }

    stop();
  });

  it("applyTheme 切换时响应式更新", async () => {
    const { configStore, read, stop } = mountThemeHost();
    configStore.theme = "dark";
    configStore.contentScript.applyTheme = true;
    await nextTick();
    expect(read("--ptd-bg")).toBe(DARK_VARS["--ptd-bg"]);

    configStore.contentScript.applyTheme = false;
    await nextTick();
    expect(read("--ptd-bg")).toBe(LIGHT_VARS["--ptd-bg"]);

    configStore.contentScript.applyTheme = true;
    await nextTick();
    expect(read("--ptd-bg")).toBe(DARK_VARS["--ptd-bg"]);

    // uiTheme 变化时（applyTheme 打开）也要跟着切
    configStore.theme = "light";
    await nextTick();
    expect(read("--ptd-bg")).toBe(LIGHT_VARS["--ptd-bg"]);

    stop();
  });
});
