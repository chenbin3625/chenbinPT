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
import { defineComponent, h, nextTick, provide, ref } from "vue";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

// 实体模块会连带引入 @ptd/site/utils/adapter.ts → messages.ts（读取 vite 构建期常量 __BROWSER__），
// 这里只需要各实体的 serverMetaData 数据，因此把该运行时依赖替换掉。
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

// SetSite/Editor 通过 metadataStore.getSiteMetadata → @ptd/site 的 getDefinedSiteMetadata 取站点定义；
// 单测里没有构建期的 definitions 映射，这里只替换这一个函数，其余导出保持真实实现。
const siteDefinition = vi.hoisted(() => ({ current: {} as any }));
vi.mock("@ptd/site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ptd/site")>()),
  getDefinedSiteMetadata: async () => structuredClone(siteDefinition.current),
}));

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

  it("未声明的字段保持历史行为（明文）", () => {
    // endpoint / bucket / client_id / accessKeyId 这类标识字段不应被掩码
    expect(secretKeysOf(s3)).not.toContain("accessKeyId");
    expect(secretKeysOf(googleDrive)).not.toContain("client_id");
    // 掩码是否真的生效由下面的真实挂载用例守卫（TESTS-1：原先这里只断言源码字面量）
  });
});

describe("B-31(a)(c)：凭据输入框真实渲染为掩码，可切换明文（H-13：行为断言）", () => {
  /**
   * 原先这里只断言源码里「出现了某些标识符 / 'password' : 'text' 字样」——把掩码判定改成 `return false`
   * （凭据明文显示）测试照样全绿。现在挂载真实 Editor，断言渲染出来的 input type。
   */
  async function settle(times = 6) {
    for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function inputByLabel(host: HTMLElement, label: string): HTMLInputElement {
    const item = Array.from(host.querySelectorAll(".ant-form-item")).find(
      (node) => node.querySelector("label")?.textContent?.trim() === label,
    );
    const input = item?.querySelector<HTMLInputElement>("input");
    expect(input, `应渲染出「${label}」输入框`).toBeTruthy();
    return input!;
  }

  function clickRevealToggle(input: HTMLInputElement) {
    const suffix = input.closest(".ant-input-affix-wrapper")?.querySelector(".ant-input-suffix");
    expect(suffix, "凭据输入框应带显示切换按钮").toBeTruthy();
    // 带 allow-clear 的输入框（如 Bangumi API Key）后缀里第一个 .anticon 是清除图标（不可见），
    // 这里必须把它排除，否则会点在没有任何行为的节点上（TESTS-1）
    const toggle = Array.from(suffix!.querySelectorAll<HTMLElement>(".anticon")).find(
      (node) => !node.closest(".ant-input-clear-icon"),
    );
    expect(toggle, "凭据输入框应带显示切换按钮").toBeTruthy();
    toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  it("SetSite/Editor：passkey 默认 password，点眼睛变 text；普通字段恒为 text", async () => {
    siteDefinition.current = {
      id: "s",
      name: "Site",
      urls: ["https://s.example/"],
      userInputSettingMeta: [
        { name: "passkey", label: "Passkey", required: false },
        { name: "uid", label: "UID", required: false },
      ],
    };
    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    // getSiteUserConfig 是 getter：state.sites 有值时直接返回，不走 sendMessage
    useMetadataStore(pinia).sites.s = { inputSetting: { passkey: "SECRET", uid: "1" } } as any;

    const { default: Editor } = await import("@/options/views/Settings/SetSite/Editor.vue");
    const config = ref<any>({});
    const Root = defineComponent({
      setup() {
        provide("storedSiteUserConfig", config);
        return () => h(Editor, { modelValue: "s" });
      },
    });
    const view = mountOptionsView(Root, { pinia });
    try {
      await settle();
      const passkey = inputByLabel(view.host, "Passkey");
      expect(passkey.type).toBe("password");
      expect(inputByLabel(view.host, "UID").type).toBe("text");

      clickRevealToggle(passkey);
      await nextTick();
      expect(inputByLabel(view.host, "Passkey").type).toBe("text");
    } finally {
      view.unmount();
    }
  });

  it("SetMediaServer/Editor：apikey 默认 password，点眼睛变 text；userId 恒为 text", async () => {
    const { default: Editor } = await import("@/options/views/Settings/SetMediaServer/Editor.vue");
    const config = ref<any>({
      id: "m",
      type: "emby",
      name: "Emby",
      address: "http://127.0.0.1:8096",
      auth: { apikey: "SECRET", userId: "u" },
      enabled: true,
    });
    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(Editor, { modelValue: config.value, "onUpdate:modelValue": (v: any) => (config.value = v) }),
      }),
    );
    try {
      await settle(10);
      const apikey = inputByLabel(view.host, "apikey");
      expect(apikey.type).toBe("password");
      expect(inputByLabel(view.host, "userId").type).toBe("text");

      clickRevealToggle(apikey);
      await nextTick();
      expect(inputByLabel(view.host, "apikey").type).toBe("text");
    } finally {
      view.unmount();
    }
  });

  it("SetBackup/Editor：secret 字段默认 password，点眼睛变 text；未声明 secret 的字段恒为 text", async () => {
    // TESTS-1：原先这里与下面的 Bangumi 用例只断言源码里出现了某些标识符/字面量，
    // 把 isConfigFieldMasked 改成 `return false;`（完全不掩码）测试照样全绿。
    const { default: Editor } = await import("@/options/views/Settings/SetBackup/Editor.vue");
    const config = ref<any>({
      id: "b1",
      type: "WebDAV",
      name: "my webdav",
      enabled: true,
      backupFields: [],
      backupInterval: 0,
      config: { address: "http://127.0.0.1/dav", loginName: "u", loginPwd: "SECRET", digest: false },
    });
    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(Editor, { modelValue: config.value, "onUpdate:modelValue": (v: any) => (config.value = v) }),
      }),
    );
    try {
      // clientMeta 走 computedAsync(getBackupServerMetaData)，需要多等几轮宏任务
      await settle(10);
      const pwd = inputByLabel(view.host, "密码");
      expect(pwd.type).toBe("password");
      expect(inputByLabel(view.host, "地址").type).toBe("text");
      expect(inputByLabel(view.host, "用户名").type).toBe("text");

      clickRevealToggle(pwd);
      await nextTick();
      expect(inputByLabel(view.host, "密码").type).toBe("text");
    } finally {
      view.unmount();
    }
  });

  it("SetBase/SocialInformationWindow：Bangumi API Key 默认 password，点眼睛变 text；AniDB Client ID 恒为 text", async () => {
    // TESTS-1：原用例只断言源码里出现 showBangumiApiKey / 'password' : 'text' 字符串，
    // 把极性反转成默认明文（showBangumiApiKey ? 'password' : 'text'）测试仍然全绿。
    const { default: SocialInformationWindow } =
      await import("@/options/views/Settings/SetBase/SocialInformationWindow.vue");
    const view = mountOptionsView(SocialInformationWindow);
    try {
      await settle();

      // 用输入框前缀头像定位到目标行，避免依赖具体 i18n 文案
      function inputInRowWithAvatar(icon: string): HTMLInputElement {
        const avatar = view.host.querySelector(`img[src*="${icon}"]`);
        const input = avatar?.closest(".ptd-settings-row")?.querySelector<HTMLInputElement>("input");
        expect(input, `应渲染出 ${icon} 所在行的输入框`).toBeTruthy();
        return input!;
      }

      const bangumi = inputInRowWithAvatar("bangumi");
      expect(bangumi.type).toBe("password");
      expect(inputInRowWithAvatar("anidb").type).toBe("text");

      clickRevealToggle(bangumi);
      await nextTick();
      expect(inputInRowWithAvatar("bangumi").type).toBe("text");
    } finally {
      view.unmount();
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
