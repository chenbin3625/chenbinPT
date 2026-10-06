/**
 * Alert（警示条）语义守卫。
 *
 * Q-3 改造（原用例是本次审查中最典型的反面教材）：
 *
 * 旧版本维护一张**写死的「文件 → `<a-alert>` 出现次数」计数表**，用来间接证明"alert 只用于
 * 需要注意的内容"。它的失效模式在本次修复中被真实触发：另一个代理为修复 S-1（备份恢复安全警示）
 * 在 `Settings/SetBackup/RestoreDialog.vue` 里**新增了 1 个 `<a-alert>`** —— 改动完全正确，
 * 但计数表过期，测试变红。这说明它度量的是"源码里数了几个字符串"，不是"警示语义对不对"。
 *
 * 新版本分两层：
 * 1. **渲染级（行为）**：真实挂载组件，断言"触发条件成立 → 出现什么级别的 alert"。
 *    包括 S-1 那条新增警示（被植入 backupServers 的备份必须弹 warning）与它的阴性对照
 *    （普通备份不得弹警示，否则就是"狼来了"）。
 * 2. **策略级（静态规则）**：跨文件的风格策略 —— 每个 `<a-alert>` 必须**显式声明 type**、
 *    取值必须是 antd 支持的四档、warning/error 必须带 `show-icon` 或 `banner`。
 *    这一层必须是源码级：要验证"整个 options 目录里没有一条依赖 antd 默认 info 的 alert"，
 *    只能扫全目录；把 12 个视图全部挂载起来代价与收益完全不成比例（且它们大多需要真实
 *    chrome API / 后台消息才能进入目标分支）。它与 eslint 规则同类，**不再对条数敏感**，
 *    因此新增 alert 不会误报，但"忘了写 type"或"warning 不带图标"会立刻失败。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

// NativeBridgeWindow 在模块求值期读 `chrome.runtime.id`
(globalThis as any).chrome ??= { runtime: { id: "test-extension-id" } };

/** `getRemoteBackupData` 的返回值由各用例控制 */
const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const optionsRoot = resolve(repoRoot, "src/entries/options");

/** 含他人植入的备份服务器配置：恢复后自动备份会把本机凭据上传到攻击者端点 */
const BACKUP_WITH_IMPLANTED_SERVERS = {
  manifest: { version: "chenbinPT (v1.0.0.0)", files: { metadata: 1 } },
  metadata: {
    backupServers: {
      evil1: {
        id: "evil1",
        type: "webdav",
        name: "attacker-dav",
        config: { address: "https://attacker.example/dav" },
      },
    },
  },
};

/** 未选择恢复任何敏感字段的空备份 */
const BENIGN_BACKUP = {
  manifest: { version: "chenbinPT (v1.0.0.0)", files: {} },
};

/** 文档里出现的 alert 级别（antd 的 Modal / Popover 会 teleport 到 body） */
const alertTypesInDocument = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".ant-alert")).map((element) =>
    ["success", "info", "warning", "error"].find((type) => element.classList.contains(`ant-alert-${type}`)),
  );

describe("S-1：恢复他人备份时的警示级别", () => {
  /** 挂一个可控的 RestoreDialog 宿主：模型值必须由 false → true 变化才会触发远端加载 */
  const mountRestoreDialog = async (remoteBackup: unknown) => {
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue(remoteBackup);

    const { default: RestoreDialog } = await import("@/options/views/Settings/SetBackup/RestoreDialog.vue");

    const open = ref(false);
    const Host = defineComponent({
      name: "RestoreDialogHost",
      setup: () => () =>
        h(RestoreDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (value: boolean) => (open.value = value),
          restoreMetadata: { type: "remote", server: "s1", path: "/backup.zip" },
        }),
    });

    const view = mountOptionsView(Host, { pinia: prepareOptionsPinia(), router: true });
    open.value = true;
    await nextTick();
    await view.settle(120);
    return view;
  };

  it("备份里含植入的备份服务器配置时，渲染 warning 级警示并列出该服务器", async () => {
    const view = await mountRestoreDialog(BACKUP_WITH_IMPLANTED_SERVERS);

    expect(sendMessageMock).toHaveBeenCalledWith(
      "getRemoteBackupData",
      expect.objectContaining({ backupServerId: "s1", path: "/backup.zip" }),
    );

    expect(alertTypesInDocument(), "含植入服务器配置的备份必须给出警示").toContain("warning");
    // 不能只是"有个警示"：必须让用户看见是哪个服务器（否则无从判断）
    const warning = document.querySelector<HTMLElement>(".ant-alert-warning")!;
    expect(warning.textContent).toContain("attacker-dav");

    view.unmount();
  });

  it("阴性对照：无敏感字段的备份不弹警示", async () => {
    const view = await mountRestoreDialog(BENIGN_BACKUP);

    expect(alertTypesInDocument()).toEqual([]);

    view.unmount();
  });
});

describe("其他页面的 alert 级别与其触发条件", () => {
  it("备份设置：密钥不随备份走属于中性提示 → info（不是 warning / error）", async () => {
    const { default: BackupWindow } = await import("@/options/views/Settings/SetBase/BackupWindow.vue");
    const view = mountOptionsView(BackupWindow, { pinia: prepareOptionsPinia() });
    await view.settle();

    const alerts = view.$$(".ant-alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.classList.contains("ant-alert-info")).toBe(true);

    view.unmount();
  });

  it("界面设置：内容脚本风险提示只在启用内容脚本时出现，且是 warning", async () => {
    const { default: UiWindow } = await import("@/options/views/Settings/SetBase/UiWindow.vue");
    const { useConfigStore } = await import("@/options/stores/config.ts");

    const view = mountOptionsView(UiWindow, { pinia: prepareOptionsPinia() });
    await view.settle();

    const configStore = useConfigStore();

    configStore.contentScript.enabled = false;
    await view.settle();
    expect(view.$$(".ant-alert"), "未启用内容脚本时不应出现该风险提示").toHaveLength(0);

    configStore.contentScript.enabled = true;
    await view.settle();
    const alerts = view.$$(".ant-alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.classList.contains("ant-alert-warning")).toBe(true);

    view.unmount();
  });

  it("插件重置：不可恢复的破坏性操作提示是 warning，且带图标", async () => {
    const { default: ResetWindow } = await import("@/options/views/Settings/SetBase/ResetWindow.vue");
    const view = mountOptionsView(ResetWindow, { pinia: prepareOptionsPinia() });
    await view.settle();

    const alerts = view.$$(".ant-alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.classList.contains("ant-alert-warning")).toBe(true);
    expect(alerts[0]!.querySelector(".ant-alert-icon"), "warning 应带图标以更醒目").not.toBeNull();

    view.unmount();
  });

  it("插件重置：「清空用户配置」确认后 siteIndex 也写成空表（M-6）", async () => {
    const callsBefore = sendMessageMock.mock.calls.length;
    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const metadataStore = useMetadataStore(pinia);
    metadataStore.siteHostMap = { "a.example": "siteA" } as any;
    metadataStore.siteNameMap = { siteA: "Site A" } as any;
    (metadataStore as any).$save = vi.fn(async () => {});

    const { default: ResetWindow } = await import("@/options/views/Settings/SetBase/ResetWindow.vue");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const view = mountOptionsView(ResetWindow, { pinia });
    try {
      await view.settle();
      const title = i18nInstance.global.t("SetBase.reset.clearUserConfig");
      const row = view.$$(".ant-list-item").find((item) => item.textContent?.includes(title));
      row!.querySelector<HTMLButtonElement>("button")!.click();
      await view.settle();
      document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-dangerous")!.click();
      await view.settle(80);

      const siteIndexWrites = sendMessageMock.mock.calls
        .slice(callsBefore)
        .filter(([type, payload]) => type === "setExtStorage" && payload?.key === "siteIndex");
      expect(siteIndexWrites.at(-1)?.[1].value).toEqual({ siteHostMap: {}, siteNameMap: {} });
    } finally {
      view.unmount();
    }
  });

  it("原生桥接：隐私说明是 warning 级提示", async () => {
    const { default: NativeBridgeWindow } = await import("@/options/views/Settings/SetBase/NativeBridgeWindow.vue");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");

    const view = mountOptionsView(NativeBridgeWindow, { pinia: prepareOptionsPinia() });
    await view.settle();

    const privacyKey = "SetNativeBridge.info.privacy";
    const privacyText = i18nInstance.global.t(privacyKey);
    expect(privacyText, `${privacyKey} 应有文案`).not.toBe(privacyKey);

    const privacyAlert = view.$$(".ant-alert").find((alert) => (alert.textContent ?? "").includes(privacyText));
    expect(privacyAlert, "隐私说明必须以 alert 形式呈现").toBeDefined();
    expect(privacyAlert!.classList.contains("ant-alert-warning")).toBe(true);

    view.unmount();
  });
});

describe("alert 策略（静态规则，与条数无关）", () => {
  const ALERT_TYPES = ["success", "info", "warning", "error"];

  function vueFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return vueFiles(path);
      return entry.name.endsWith(".vue") ? [path] : [];
    });
  }

  /**
   * 取出 `<a-alert ...>` 的**开始标签**文本。
   * 不能简单地找第一个 `>`：`v-if="... length > 0"` 里就有 `>`（RestoreDialog 正是这种写法），
   * 因此这里按引号状态扫描，直到遇到不在引号内的 `>`。
   */
  function alertOpenTags(source: string): string[] {
    const tags: string[] = [];
    const marker = "<a-alert";

    for (let index = source.indexOf(marker); index !== -1; index = source.indexOf(marker, index + 1)) {
      let quote: string | null = null;
      let end = -1;
      for (let cursor = index + marker.length; cursor < source.length; cursor++) {
        const char = source[cursor]!;
        if (quote) {
          if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === ">") {
          end = cursor;
          break;
        }
      }
      tags.push(source.slice(index, end === -1 ? source.length : end + 1));
    }

    return tags;
  }

  const alerts = vueFiles(optionsRoot).flatMap((path) =>
    alertOpenTags(readFileSync(path, "utf8")).map((tag) => ({ file: relative(repoRoot, path), tag })),
  );

  it("扫描到的 alert 数量非零（防止扫描规则失效导致测试形同虚设）", () => {
    expect(alerts.length).toBeGreaterThan(10);
  });

  it("每个 a-alert 都显式声明 type，且取值是 antd 支持的四档之一", () => {
    const offenders = alerts
      .filter(({ tag }) => {
        const matched = tag.match(/\btype="([^"]*)"/);
        return !matched || !ALERT_TYPES.includes(matched[1]!);
      })
      .map(({ file, tag }) => `${file}: ${tag.slice(0, 80)}`);

    // 不显式声明 type 就等于让 antd 默认值(info)决定警示级别 —— 语义被隐式决定
    expect(offenders).toEqual([]);
  });

  it("warning / error 级 alert 必须带图标或使用 banner 形态", () => {
    const offenders = alerts
      .filter(({ tag }) => /\btype="(?:warning|error)"/.test(tag))
      .filter(({ tag }) => !/\bshow-icon\b/.test(tag) && !/\bbanner\b/.test(tag))
      .map(({ file, tag }) => `${file}: ${tag.slice(0, 80)}`);

    expect(offenders).toEqual([]);
  });
});
