/**
 * 内容脚本「引导 → UI」的交接约定（引导：src/entries/content-script/index.ts；UI：src/entries/content-script/app/entry.ts）。
 *
 * WXT 把每个内容脚本打成独立的 IIFE，两边各自持有本模块的一份拷贝，因此交接数据不能放在模块变量里，
 * 而是挂在 isolated world 的 `globalThis` 上：同一扩展在同一 frame 里注入的内容脚本共享这个 world，
 * 页面自己的脚本（main world）看不到它。
 */

/** WXT 产物路径：src/entrypoints/cs-app.content.ts → content-scripts/cs-app.js */
export const CONTENT_SCRIPT_APP_FILE = "content-scripts/cs-app.js";

const PROPS_KEY = "__ptdContentScriptAppProps__";
const MOUNTED_KEY = "__ptdContentScriptAppMounted__";

type TGlobalWithHandoff = typeof globalThis & {
  [PROPS_KEY]?: Record<string, any>;
  [MOUNTED_KEY]?: boolean;
};

/** 引导侧：在请求后台注入 UI 之前写入挂载参数 */
export function setContentScriptAppProps(props: Record<string, any>): void {
  (globalThis as TGlobalWithHandoff)[PROPS_KEY] = props;
}

/** UI 侧：取出并清除挂载参数（只取一次，避免重复注入时拿到旧值） */
export function takeContentScriptAppProps(): Record<string, any> | undefined {
  const holder = globalThis as TGlobalWithHandoff;
  const props = holder[PROPS_KEY];
  delete holder[PROPS_KEY];
  return props;
}

/** UI 侧：同一 frame 只挂载一次（重复注入时直接返回 false） */
export function claimContentScriptAppMount(): boolean {
  const holder = globalThis as TGlobalWithHandoff;
  if (holder[MOUNTED_KEY]) {
    return false;
  }
  holder[MOUNTED_KEY] = true;
  return true;
}
