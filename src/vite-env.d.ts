/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_AVISTAZ_USER_INFO_FETCHING?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// 在 wxt.config.ts（vite.define）中定义的常量，这些常量一般都是编译中产生的
declare const __BROWSER__: "chrome" | "firefox";
declare const __EXT_VERSION__: string;
declare const __GIT_VERSION__: { short: string; long: string; date: number; count: number; branch: string };
declare const __BUILD_TIME__: string;
declare const __RESOURCE_SITE_ICONS__: string[];

// background 入口的按目标别名（wxt.config.ts 的 projectAliasPlugin）：
// chrome → src/entries/background/main.ts，firefox → src/entries/background/ff_main.ts，只做副作用 import
declare module "#ptd/background-main";
