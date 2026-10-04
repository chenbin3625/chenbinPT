/**
 * B-31：凭据不得明文显示、不得被 console 打印活对象。
 *
 * - (a) SetMediaServer/Editor.vue：fnOS 的 password、emby/jellyfin/plex 的 apikey
 * - (b) SetBackup/Editor.vue：按 requiredField 的显式 `secret` 声明掩码
 * - (c) SetSite/Editor.vue：站点 inputSetting 的 passkey / apikey / token 等
 * - (d) SetBase/SocialInformationWindow.vue：Bangumi API Key
 * - (e) 三个 AddDialog 不再打印响应式代理（DevTools 会长期持有其活引用）
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

// 实体模块会连带引入 @ptd/site/utils/adapter.ts → messages.ts（读取 vite 构建期常量 __BROWSER__），
// 这里只需要各实体的 serverMetaData 数据，因此把该运行时依赖替换掉。
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

import { serverMetaData as backblazeB2 } from "@ptd/backupServer/entity/BackblazeB2.ts";
import { serverMetaData as cookieCloud } from "@ptd/backupServer/entity/CookieCloud.ts";
import { serverMetaData as dropBox } from "@ptd/backupServer/entity/DropBox.ts";
import { serverMetaData as gist } from "@ptd/backupServer/entity/Gist.ts";
import { serverMetaData as googleDrive } from "@ptd/backupServer/entity/GoogleDrive.ts";
import { serverMetaData as owss } from "@ptd/backupServer/entity/OWSS.ts";
import { serverMetaData as s3 } from "@ptd/backupServer/entity/S3.ts";
import { serverMetaData as webdav } from "@ptd/backupServer/entity/WebDAV.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const readSource = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

const secretKeysOf = (meta: { requiredField: { key: unknown; secret?: boolean }[] }) =>
  meta.requiredField.filter((field) => field.secret === true).map((field) => String(field.key));

describe("B-31(b)：备份服务器的凭据字段由 requiredField 显式声明", () => {
  it("所有凭据字段都被标注 secret，非凭据字段不受影响", () => {
    expect(secretKeysOf(webdav)).toEqual(["loginPwd"]);
    expect(secretKeysOf(s3)).toEqual(["secretAccessKey"]);
    expect(secretKeysOf(cookieCloud)).toEqual(["password"]);
    expect(secretKeysOf(gist)).toEqual(["access_token"]);
    expect(secretKeysOf(dropBox)).toEqual(["access_token"]);
    expect(secretKeysOf(googleDrive)).toEqual(["client_secret", "refresh_token"]);
    expect(secretKeysOf(owss)).toEqual(["authCode"]);
    expect(secretKeysOf(backblazeB2)).toEqual(["applicationKey"]);
  });

  it("未声明的字段保持历史行为（明文），SetBackup/Editor.vue 依据 secret 掩码", () => {
    // endpoint / bucket / client_id / accessKeyId 这类标识字段不应被掩码
    expect(secretKeysOf(s3)).not.toContain("accessKeyId");
    expect(secretKeysOf(googleDrive)).not.toContain("client_id");

    const source = readSource("src/entries/options/views/Settings/SetBackup/Editor.vue");
    expect(source).toMatch(/function isSecretConfigField\(metaField: \{ secret\?: boolean \}\): boolean \{/);
    expect(source).toMatch(/return metaField\.secret === true;/);
    expect(source).toMatch(/:type="isConfigFieldMasked\(metaField\) \? 'password' : 'text'"/);
  });
});

describe("B-31(a)(c)(d)：其余凭据输入框默认掩码 + 显示切换", () => {
  const cases: Array<[string, string[]]> = [
    [
      "src/entries/options/views/Settings/SetMediaServer/Editor.vue",
      ["SECRET_AUTH_FIELD_PATTERN", "isAuthFieldMasked", "revealedAuthFields", "EyeInvisibleOutlined"],
    ],
    [
      "src/entries/options/views/Settings/SetSite/Editor.vue",
      ["SECRET_INPUT_SETTING_PATTERN", "isInputSettingMasked", "revealedInputSettings", "EyeInvisibleOutlined"],
    ],
    [
      "src/entries/options/views/Settings/SetBase/SocialInformationWindow.vue",
      ["showBangumiApiKey", "EyeInvisibleOutlined"],
    ],
  ];

  it.each(cases)("%s 使用掩码 + 眼睛切换", (path, markers) => {
    const source = readSource(path);
    for (const marker of markers) {
      expect(source, `${path} 应包含 ${marker}`).toContain(marker);
    }
    expect(source).toMatch(/'password' : 'text'|'text' : 'password'/);
  });

  it("站点凭据（passkey / apikey / rsskey / token）都在掩码名单内", () => {
    const source = readSource("src/entries/options/views/Settings/SetSite/Editor.vue");
    const pattern = source.match(/const SECRET_INPUT_SETTING_PATTERN = (\/.*\/i);/);
    expect(pattern, "应能取到字段名匹配规则").not.toBeNull();

    const raw = pattern![1]; // 形如 /passkey|.../i
    const lastSlash = raw.lastIndexOf("/");
    const regExp = new RegExp(raw.slice(1, lastSlash), raw.slice(lastSlash + 1));
    for (const name of ["passkey", "apikey", "apiKey", "rsskey", "token", "cookie", "password"]) {
      expect(regExp.test(name), `${name} 应被掩码`).toBe(true);
    }
    // 站点名 / 分组 / URL 之类不能被误判为凭据
    for (const name of ["name", "groups", "url", "timezoneOffset"]) {
      expect(regExp.test(name), `${name} 不应被掩码`).toBe(false);
    }
  });
});

describe("B-31(e)：不再把响应式配置对象打印到控制台", () => {
  const addDialogs = [
    "src/entries/options/views/Settings/SetDownloader/AddDialog.vue",
    "src/entries/options/views/Settings/SetMediaServer/AddDialog.vue",
    "src/entries/options/views/Settings/SetBackup/AddDialog.vue",
  ];

  it.each(addDialogs)('%s 不再出现 console.log("stored...")', (path) => {
    expect(readSource(path)).not.toMatch(/console\.log\(\s*"stored/);
  });
});
