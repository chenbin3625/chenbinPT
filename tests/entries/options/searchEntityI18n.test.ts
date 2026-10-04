/**
 * SearchEntity 搜索提示文案的翻译完整性。
 *
 * Q-3 改造：原用例自己 import 两份 JSON、手写 `getByPath` 逐段取值来判断 key 是否存在 ——
 * 那是"另一套 i18n 实现"，校验的是 JSON 结构而不是**运行时真正用的那套解析**（含 locale 代码、
 * fallback、消息编译）。现在改为直接问 `i18nInstance`（`src/entries/options/plugins/i18n.ts` 里
 * 真正装到应用上的实例）：`te()` 判断存在、`t()` 判断非空，与线上渲染走同一条路径。
 *
 * 保留源码级的只有**key 的发现方式**：这些 key 以模板内联字符串的形式散在
 * `views/Overview/SearchEntity/Index.vue`（576 行、依赖后台搜索消息）里，没有可导入的模块边界；
 * 要行为化需要先挂载该视图（属于需要源码配合/大规模打桩的改动）。文件末尾有一条自证断言，
 * 防止扫描规则失效导致用例形同虚设。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { i18nInstance } from "@/options/plugins/i18n.ts";

const LOCALES = ["zh_CN", "en"] as const;

const searchEntityPage = readFileSync(
  resolve(import.meta.dirname, "../../../src/entries/options/views/Overview/SearchEntity/Index.vue"),
  "utf8",
);

function collectSearchEntityAlertKeys(): string[] {
  const keys = new Set<string>();
  for (const match of searchEntityPage.matchAll(/t\(["'](SearchEntity\.index\.alert\.[^"']+)["']/g)) {
    keys.add(match[1]!);
  }
  return [...keys].sort();
}

describe("SearchEntity 搜索提示文案", () => {
  const alertKeys = collectSearchEntityAlertKeys();

  it("模板里确实存在 alert 文案 key（防止扫描规则失效导致用例形同虚设）", () => {
    expect(alertKeys.length).toBeGreaterThan(0);
  });

  it("模板中的 alert 翻译 key 都能被真实 i18n 实例解析出非空文案（中英各一份）", () => {
    const missing: string[] = [];

    for (const key of alertKeys) {
      for (const locale of LOCALES) {
        // te() 走的是 vue-i18n 真正的消息解析（含 locale 归一化），不是手写的 JSON 路径遍历
        const exists = i18nInstance.global.te(key, locale);
        const message = exists ? i18nInstance.global.t(key, {}, { locale }) : "";
        if (!exists || typeof message !== "string" || message.length === 0 || message === key) {
          missing.push(`${locale}:${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
