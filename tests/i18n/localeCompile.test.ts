/**
 * 语言包全量编译门禁 —— EXTENDSI18N-1 / EXTENDSI18N-2 的根因守卫。
 *
 * 背景：这两条问题都不是「键缺失」，而是键存在、值里含 vue-i18n 的**保留语法**：
 * - EXTENDSI18N-1：`MyData.HistoryDataView.title` 的裸 `@ ` 被判成 linked 语法，首次 `t()` 抛 SyntaxError
 *   （英文界面打开「历史数据」弹窗时渲染失败）；
 * - EXTENDSI18N-2：`SetBase.searchEntity.imdbTip` 的裸 `|` 被判成复数分隔符，提示被截断到 `imdb` 为止。
 *
 * 「键对齐 + 非空」这类静态检查发现不了它们，只有把**每一条**消息真的编译、翻译一遍才会暴露
 * （本轮就是靠全量编译一次命中）。所以这里用仓库自带的 vue-i18n 引擎过一遍：
 * 1) `@intlify/core-base` 的 `compile()` 逐条编译（语法层，零异常）；
 * 2) `createI18n` + `t()` 逐条解析（运行期，零异常且不允许回退成 key 本身）；
 * 3) 两份语言包的键集合一致、无空值、同一键的占位符集合一致；
 * 4) 非复数消息里不允许出现未转义的裸 `|`（EXTENDSI18N-2 的形态；仓库当前没有复数消息）；
 * 5) `@:key` 这类 linked 引用必须命中真实键（`@:k,` 会把逗号一起吞进 key 名，界面直接显示裸 key 名）。
 */
import { describe, expect, it } from "vitest";

import { compile } from "@intlify/core-base";
import { createI18n } from "vue-i18n";

import en from "~/locales/en.json";
import zh_CN from "~/locales/zh_CN.json";

const LOCALES: Array<[string, Record<string, any>]> = [
  ["en", en],
  ["zh_CN", zh_CN],
];

/** 展平成 `a.b.c -> 叶子值`；数组叶子（如 SetSite.index.settingNote）原样保留。 */
function flattenMessages(messages: Record<string, any>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flattenMessages(value as Record<string, any>, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

/** 一个键可能对应多条消息（数组叶子），逐条取出待编译的字符串。 */
function messagePieces(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/** 空值 / 非法类型（既不是字符串也不是字符串数组）的键，i18n 消息编译不了。 */
function invalidValueKeys(flat: Record<string, unknown>): string[] {
  const invalid: string[] = [];
  for (const [key, value] of Object.entries(flat)) {
    if (typeof value === "string") {
      if (value.trim() === "") invalid.push(key);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0 || value.some((item) => typeof item !== "string" || item.trim() === "")) {
        invalid.push(key);
      }
      continue;
    }
    invalid.push(key);
  }
  return invalid;
}

/**
 * 提取 vue-i18n 的命名/列表插值占位符 `{name}` / `{0}`。
 * `{'|'}` 这类字面量转义（用引号包住）不是占位符，不计入。
 */
function placeholders(message: string): string[] {
  const found = new Set<string>();
  for (const match of message.matchAll(/\{([^{}]+)\}/g)) {
    const token = match[1].trim();
    if (token.startsWith("'") || token.startsWith('"')) continue;
    found.add(token);
  }
  return [...found].sort();
}

/**
 * 去掉 `{'|'}` / `{"|"}` 这类字面量转义后，若还残留 `|`，说明它会被 vue-i18n 当成复数分隔符。
 */
function barePipes(message: string): boolean {
  return message.replace(/\{'[^']*'\}|\{"[^"]*"\}/g, "").includes("|");
}

/**
 * 按 @intlify/message-compiler 的词法规则提取 linked 引用：`@:key`（可选 `@.modifier:`），
 * key 读到 `{ @ | ( )`、空白或行尾为止 —— 因此 `@:k,` 里的逗号会被算进 key 名。
 * 参考 node_modules/@intlify/message-compiler/dist/message-compiler.mjs 的 readLinkedRefer()。
 */
function linkedReferences(message: string): string[] {
  const refs: string[] = [];
  for (const match of message.matchAll(/@(?:\.[A-Za-z0-9_-]+)?:([^\s{@|()]+)/g)) {
    refs.push(match[1]);
  }
  return refs;
}

const EN = flattenMessages(en);
const ZH_CN = flattenMessages(zh_CN);

describe("语言包结构一致性", () => {
  it("两份语言包的叶子键完全一致", () => {
    // 先确认展平没把内容吃空（导入方式变化时能立刻发现）
    expect(Object.keys(EN).length).toBeGreaterThan(1000);
    expect(Object.keys(EN).sort()).toEqual(Object.keys(ZH_CN).sort());
  });

  it("没有空值 / 非法值类型", () => {
    expect(invalidValueKeys(EN)).toEqual([]);
    expect(invalidValueKeys(ZH_CN)).toEqual([]);
  });

  it("同一键的插值占位符集合一致", () => {
    const mismatches: string[] = [];
    for (const key of Object.keys(EN)) {
      if (typeof EN[key] !== "string" || typeof ZH_CN[key] !== "string") continue;
      const [enTokens, zhTokens] = [placeholders(EN[key] as string), placeholders(ZH_CN[key] as string)];
      if (enTokens.join(",") !== zhTokens.join(",")) {
        mismatches.push(`${key}: en={${enTokens}} zh_CN={${zhTokens}}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

for (const [locale, messages] of LOCALES) {
  describe(`${locale} 语言包逐条编译`, () => {
    const flat = flattenMessages(messages);
    // 只挂当前语言、fallback 指向自己：一旦键缺失就会回退成 key 本身，断言能发现。
    const runtime = createI18n({
      legacy: false,
      locale,
      fallbackLocale: locale,
      messages: { [locale]: messages },
      missingWarn: false,
      fallbackWarn: false,
      // 语言包里既有的 `<br />` / `<...>` 是有意的展示文案，不是本次要管的问题
      warnHtmlMessage: false,
    });

    it("每一条消息都能被 compile() 编译（零异常）", () => {
      const failures: string[] = [];
      for (const [key, value] of Object.entries(flat)) {
        for (const message of messagePieces(value)) {
          try {
            compile(message, { key, locale, warnHtmlMessage: false });
          } catch (error) {
            failures.push(`${key}: ${(error as Error).message}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });

    it("每一条消息都能被 t() 解析且不回退成 key（零异常）", () => {
      const failures: string[] = [];
      for (const [key, value] of Object.entries(flat)) {
        // 数组叶子是既有数据形态（SetSite.index.settingNote），vue-i18n 不编译数组，跳过
        if (Array.isArray(value)) continue;
        try {
          const text = runtime.global.t(key);
          if (text === key) failures.push(`${key}: 回退成 key 本身`);
        } catch (error) {
          failures.push(`${key}: ${(error as Error).message}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it("本轮 OPTIONSSETTINGS-7/8 消费的键都解析出真实文案", () => {
      // 这些键一旦缺失，vue-i18n 会把 key 名原样渲染到界面上
      // （UserInfoWindow 的 afterTimeSuffix 在补键前就显示 "SetBase.userInfo.afterTimeSuffix"）
      const consumedKeys = [
        "SetSite.editor.inputRequired",
        "SetBase.userInfo.afterTimeSuffix",
        "common.form.required",
        "common.form.invalidUrl",
      ];
      for (const key of consumedKeys) {
        const text = runtime.global.t(key);
        expect(text, `${locale} 缺少 ${key}`).not.toBe(key);
        expect(text.length, `${locale} 的 ${key} 是空文案`).toBeGreaterThan(0);
      }
    });

    it("非复数消息里没有未转义的裸 `|`", () => {
      // EXTENDSI18N-2：裸 `|` 被当复数分隔符，t() 只返回第一段。
      // 仓库当前没有任何复数消息；将来真要用复数形式，请在这里显式加白名单。
      const offenders: string[] = [];
      for (const [key, value] of Object.entries(flat)) {
        for (const message of messagePieces(value)) {
          if (barePipes(message)) offenders.push(key);
        }
      }
      expect(offenders).toEqual([]);
    });

    it("linked 引用（@:key）全部命中真实键", () => {
      // 例：`@:resultParseStatus.unknownError,` 会把逗号吞进 key → 界面直接显示裸 key 名（本轮新发现并修复）
      const missing: string[] = [];
      for (const [key, value] of Object.entries(flat)) {
        for (const message of messagePieces(value)) {
          for (const ref of linkedReferences(message)) {
            if (!Object.hasOwn(flat, ref)) missing.push(`${key} -> @:${ref}`);
          }
        }
      }
      expect(missing).toEqual([]);
    });
  });
}
