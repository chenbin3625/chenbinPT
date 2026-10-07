/**
 * B-28：设置页三个「编辑已有配置」弹窗必须深拷贝 metadata store 的条目。
 *
 * 修复前的写法 `clientConfig.value = { ...metadataStore.x[id] }` 只复制顶层，
 * `auth` / `config` / `feature` / `advanceAddTorrentOptions` 仍与 store 共用同一对象，
 * 而子编辑器直接 v-model 绑到这些嵌套路径 → 每敲一个字符都实时改写 store，
 * 「取消」不回滚，列表页下一次保存还会把半途输入的凭据落盘。
 *
 * TESTS-4：原先这里的三条「行为用例」只拿 cloneDeep 与手写浅展开做对照（测的是库本身，
 * 没有 import 任何一个 EditDialog），弹窗接线只剩一条源码正则。现在改为真实挂载三个 EditDialog：
 * 在弹窗里输入/切换嵌套字段后断言 store 原值未变，再用「确定」按钮证明这次编辑确实进入了
 * 弹窗自己的副本 —— 接线一旦退回浅展开，第一条断言立刻变红。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

const repoRoot = resolve(import.meta.dirname, "../../..");
const EDIT_DIALOGS = [
  "src/entries/options/views/Settings/SetMediaServer/EditDialog.vue",
  "src/entries/options/views/Settings/SetBackup/EditDialog.vue",
  "src/entries/options/views/Settings/SetDownloader/EditDialog.vue",
];

describe("B-28：编辑弹窗与 metadata store 的隔离（TESTS-4：真实挂载）", () => {
  let pinia: ReturnType<typeof prepareOptionsPinia>;

  beforeEach(() => {
    // 清掉上个用例的 teleport 残留（a-modal 渲染到 body）
    document.body.innerHTML = "";
    pinia = prepareOptionsPinia();
    // 编辑弹窗的「确定」会走 store 的 $save（真实插件由 webExtPersistence 提供），
    // 这里补一个空实现，避免把「保存」路径的成败混进隔离断言
    pinia.use(({ store }) => {
      (store as any).$save = async () => {};
    });
  });

  async function openEditDialog(component: any, clientId: string) {
    const open = ref(false);
    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(component, {
            clientId,
            modelValue: open.value,
            "onUpdate:modelValue": (value: boolean) => (open.value = value),
          }),
      }),
      { pinia },
    );
    open.value = true;
    await nextTick();
    return view;
  }

  async function waitForInput(label: string): Promise<HTMLInputElement> {
    for (let i = 0; i < 100; i++) {
      const item = Array.from(document.body.querySelectorAll(".ant-form-item")).find(
        (node) => node.querySelector("label")?.textContent?.trim() === label,
      );
      const input = item?.querySelector<HTMLInputElement>("input");
      if (input) return input;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`弹窗里没有渲染出「${label}」输入框`);
  }

  function typeInto(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function clickOk() {
    const ok = document.body.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary");
    expect(ok, "弹窗应有「确定」按钮").toBeTruthy();
    ok!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it("媒体服务器：弹窗里输入 apikey 不会实时改写 store，确定后才写回", async () => {
    const store = useMetadataStore(pinia);
    store.mediaServers["m1"] = {
      id: "m1",
      type: "emby",
      name: "emby",
      address: "http://emby.local",
      enabled: true,
      auth: { apikey: "stored-key" },
    };

    const { default: EditDialog } = await import("@/options/views/Settings/SetMediaServer/EditDialog.vue");
    const view = await openEditDialog(EditDialog, "m1");
    try {
      const apikey = await waitForInput("apikey");
      expect(apikey.type).toBe("password");

      typeInto(apikey, "half-typed");
      await nextTick();
      // 关键断言：逐键输入不得边输入边写回 store（浅展开接线会在这里变红）
      expect(store.mediaServers["m1"].auth.apikey).toBe("stored-key");

      await clickOk();
      // 证明输入确实进入了弹窗自己的副本（而不是「什么都没发生」导致上面假通过）
      expect(store.mediaServers["m1"].auth.apikey).toBe("half-typed");
    } finally {
      view.unmount();
    }
  });

  it("备份服务器：弹窗里输入 config.loginPwd 不会实时改写 store，确定后才写回", async () => {
    const store = useMetadataStore(pinia);
    store.backupServers["b1"] = {
      id: "b1",
      type: "WebDAV",
      name: "webdav",
      enabled: true,
      backupFields: [],
      config: { address: "http://127.0.0.1/dav", loginName: "u", loginPwd: "stored-pwd", digest: false },
    };

    const { default: EditDialog } = await import("@/options/views/Settings/SetBackup/EditDialog.vue");
    const view = await openEditDialog(EditDialog, "b1");
    try {
      const pwd = await waitForInput("密码");
      expect(pwd.type).toBe("password");

      typeInto(pwd, "half-typed");
      await nextTick();
      expect(store.backupServers["b1"].config.loginPwd).toBe("stored-pwd");

      await clickOk();
      expect(store.backupServers["b1"].config.loginPwd).toBe("half-typed");
    } finally {
      view.unmount();
    }
  });

  it("下载器：弹窗里切换 feature.DefaultAutoStart 不会实时改写 store，确定后才写回", async () => {
    const store = useMetadataStore(pinia);
    store.downloaders["d1"] = {
      id: "d1",
      // 与 entity 文件名 / clientConfig.type 一致（"qBittorrent"，不是小写）
      type: "qBittorrent",
      name: "qb",
      address: "http://qb.local",
      enabled: true,
      // feature 是 TorrentClientFeature 的映射类型，字段必须是真实存在的能力项
      feature: { DefaultAutoStart: false },
      advanceAddTorrentOptions: {},
    };

    const { default: EditDialog } = await import("@/options/views/Settings/SetDownloader/EditDialog.vue");
    const view = await openEditDialog(EditDialog, "d1");
    try {
      // 等 clientMeta（feature 声明）异步就绪后才会渲染出 DefaultAutoStart 开关
      let toggle: HTMLElement | null = null;
      for (let i = 0; i < 100 && !toggle; i++) {
        toggle = document.body.querySelector<HTMLElement>(".ant-modal .ant-switch");
        if (!toggle) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(toggle, "弹窗里应有 feature 开关").toBeTruthy();

      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await nextTick();
      expect(store.downloaders["d1"].feature?.DefaultAutoStart).toBe(false);

      await clickOk();
      expect(store.downloaders["d1"].feature?.DefaultAutoStart).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("三个 EditDialog 仍保留 cloneDeep 接线（源码级附加护栏）", () => {
    for (const path of EDIT_DIALOGS) {
      const source = readFileSync(resolve(repoRoot, path), "utf8");

      expect(source, path).toMatch(/clientConfig\.value = cloneDeep\(/);
      expect(source, path).not.toMatch(/clientConfig\.value = \{/); // 不再有浅展开赋值
      expect(source, path).not.toMatch(/防止直接修改父组件的数据/); // 与实际行为相反的注释
    }
  });
});
