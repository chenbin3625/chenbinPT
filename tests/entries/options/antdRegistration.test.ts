/**
 * antd 全局组件注册守卫（见 docs/performance-audit.md P2-2）。
 *
 * `plugins/antd.ts` 为了减小 options 入口 chunk，从"整库 `app.use(Antd)`"改成了
 * **只注册项目用到的 64 个组件**。这类改动的最大风险是"漏注册某个组件"——
 * 表现是运行时静默渲染失败（Vue 只会警告 unknown custom element），类型检查与构建都不会报错。
 *
 * 本测试用官方 `app.use(Antd)` 得到"标准答案"，然后：
 * 1. 扫描 `src/**\/*.vue` 里所有 `<a-xxx>` 标签，得到实际使用的组件名；
 * 2. 断言每个名字都能在**我们的注册表**里解析到，且与官方注册的组件对象**完全相同**。
 *
 * 因此：新增 `<a-xxx>` 用法而忘记加注册表条目 → 本测试失败；
 * 映射写错（例如把 `ARangePicker` 指到 `DatePicker` 本体）→ 本测试失败。
 */
import { createApp } from "vue";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import Antd from "ant-design-vue";
import { describe, expect, it } from "vitest";

import { antdInstance } from "@/options/plugins/antd.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function collectVueFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      collectVueFiles(full, acc);
    } else if (entry.endsWith(".vue")) {
      acc.push(full);
    }
  }
  return acc;
}

function pascalCase(tag: string): string {
  return tag
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** 扫描所有 .vue 模板里用到的 `<a-xxx>` 标签，转成 antd 的全局组件名（A + PascalCase） */
function collectUsedAntdComponentNames(): string[] {
  const names = new Set<string>();
  for (const file of collectVueFiles(resolve(repoRoot, "src"))) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(/<a-([a-z0-9-]+)/g)) {
      names.add(`A${pascalCase(match[1]!)}`);
    }
  }
  return [...names].sort();
}

describe("antd 全局组件注册（P2-2）", () => {
  const usedNames = collectUsedAntdComponentNames();

  it("扫描到的使用面非空（防止扫描规则失效导致测试形同虚设）", () => {
    expect(usedNames.length).toBeGreaterThan(40);
  });

  it("每个用到的 <a-xxx> 都在我们的注册表里，且与 antd 官方注册的组件一致", () => {
    const canonicalApp = createApp({ render: () => null });
    canonicalApp.use(Antd);

    const registryApp = createApp({ render: () => null });
    registryApp.use(antdInstance as any);

    const missing: string[] = [];
    const mismatched: string[] = [];

    for (const name of usedNames) {
      const canonical = canonicalApp.component(name);
      if (!canonical) {
        // 官方也没有这个名字 → 说明标签名拼写有误（例如 a-xxx 拼错）
        missing.push(`${name}(antd 中不存在)`);
        continue;
      }

      const ours = registryApp.component(name);
      if (!ours) {
        missing.push(`${name}(未注册)`);
      } else if (ours !== canonical) {
        mismatched.push(name);
      }
    }

    expect({ missing, mismatched }).toEqual({ missing: [], mismatched: [] });
  });

  it("官方 install 会挂的全局方法本项目未使用（因此自定义 install 不挂它们是安全的）", () => {
    const sources = collectVueFiles(resolve(repoRoot, "src")).map((file) => readFileSync(file, "utf8"));
    const joined = sources.join("\n");
    for (const globalMethod of ["$message", "$notification", "$confirm", "$info", "$warning"]) {
      expect(joined.includes(globalMethod), `发现 ${globalMethod} 用法，需要在 antdInstance.install 中补上`).toBe(
        false,
      );
    }
  });
});
