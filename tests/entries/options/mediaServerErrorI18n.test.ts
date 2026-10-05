/**
 * 设置页错误文案的语言包回归（缺陷清单 M-11 / M-10）。
 *
 * 背景：`MediaServerEntity/utils.ts` 曾把硬编码中文换成 `mediaServer.error.*` 三个 key，
 * 但两个语言包里根本没有 `mediaServer` 命名空间 —— vue-i18n 找不到 key 时**原样返回 key**，
 * 于是用户看到的是 `mediaServer.error.updateFailed: ...`。这类「key 名字写错/漏加语言包」
 * 无法被类型检查发现，只能用「必须解析出真实文案」的断言挡住。
 */
import { describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";

import en from "~/locales/en.json";
import zh_CN from "~/locales/zh_CN.json";

const LOCALES: Array<[string, Record<string, any>]> = [
  ["zh_CN", zh_CN],
  ["en", en],
];

/** 设置页展示给用户的 key（新增文案时同步加到这里） */
const REQUIRED_KEYS = [
  "MediaServerEntity.error.checkAuth",
  "MediaServerEntity.error.unknown",
  "MediaServerEntity.error.updateFailed",
  "common.insecureAddressWarning",
];

for (const [locale, messages] of LOCALES) {
  describe(`${locale} 语言包`, () => {
    // 只挂当前语言、并把 fallback 指向自己：任何缺失 key 都会回退成 key 本身，断言即可发现
    const i18n = createI18n({
      legacy: false,
      locale,
      fallbackLocale: locale,
      messages: { [locale]: messages },
      missingWarn: false,
      fallbackWarn: false,
    });

    it.each(REQUIRED_KEYS)("%s 解析出真实文案（不是 key 本身）", (key) => {
      const text = i18n.global.t(key);
      expect(text).not.toBe(key);
      expect(text.length).toBeGreaterThan(0);
    });

    it("updateFailed 能插值服务器名 / 地址 / 失败原因", () => {
      const text = i18n.global.t("MediaServerEntity.error.updateFailed", {
        name: "Emby",
        address: "http://emby.local:8096",
        reason: "timeout",
      });
      expect(text).toContain("Emby");
      expect(text).toContain("http://emby.local:8096");
      expect(text).toContain("timeout");
    });
  });
}
