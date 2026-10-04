/**
 * B-28：设置页三个「编辑已有配置」弹窗必须深拷贝 metadata store 的条目。
 *
 * 修复前的写法 `clientConfig.value = { ...metadataStore.x[id] }` 只复制顶层，
 * `auth` / `config` / `feature` / `advanceAddTorrentOptions` 仍与 store 共用同一对象，
 * 而子编辑器直接 v-model 绑到这些嵌套路径 → 每敲一个字符都实时改写 store，
 * 「取消」不回滚，列表页下一次保存还会把半途输入的凭据落盘。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { cloneDeep } from "es-toolkit";

import { useMetadataStore } from "@/options/stores/metadata.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

const repoRoot = resolve(import.meta.dirname, "../../..");
const readSource = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

const EDIT_DIALOGS = [
  "src/entries/options/views/Settings/SetMediaServer/EditDialog.vue",
  "src/entries/options/views/Settings/SetBackup/EditDialog.vue",
  "src/entries/options/views/Settings/SetDownloader/EditDialog.vue",
];

describe("B-28：编辑弹窗与 metadata store 的隔离", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("媒体服务器：cloneDeep 后修改 auth.apikey 不会改写 store（对照修复前的浅展开会改写）", () => {
    const store = useMetadataStore();
    store.mediaServers["m1"] = {
      id: "m1",
      type: "emby",
      name: "emby",
      address: "http://emby.local",
      enabled: true,
      auth: { apikey: "stored-key" },
    };

    const stored = store.mediaServers["m1"];

    // 修复前的写法：浅展开只复制顶层，auth 仍是 store 中的同一个对象
    const shallowSpread: any = { ...stored };
    expect(shallowSpread.auth).toBe(stored.auth);
    shallowSpread.auth.apikey = "half-typed"; // 逐键输入
    expect(stored.auth.apikey).toBe("half-typed"); // store 被改写，「取消」回不去

    // 修复后的写法：cloneDeep
    stored.auth.apikey = "stored-key";
    const clientConfig: any = cloneDeep(stored);
    expect(clientConfig).not.toBe(stored);
    expect(clientConfig.auth).not.toBe(stored.auth);
    clientConfig.auth.apikey = "half-typed-2";
    expect(stored.auth.apikey).toBe("stored-key"); // store 原值未变
  });

  it("备份服务器：cloneDeep 后修改 config.loginPwd 不会改写 store", () => {
    const store = useMetadataStore();
    store.backupServers["b1"] = {
      id: "b1",
      type: "webdav",
      name: "webdav",
      enabled: true,
      backupFields: [],
      config: { loginPwd: "stored-pwd" },
    };

    const stored = store.backupServers["b1"];
    const clientConfig: any = cloneDeep(stored);

    expect(clientConfig.config).not.toBe(stored.config);
    clientConfig.config.loginPwd = "half-typed";
    expect(stored.config.loginPwd).toBe("stored-pwd");
  });

  it("下载器：cloneDeep 后修改 feature / advanceAddTorrentOptions 不会改写 store", () => {
    const store = useMetadataStore();
    store.downloaders["d1"] = {
      id: "d1",
      type: "qbittorrent",
      name: "qb",
      address: "http://qb.local",
      enabled: true,
      // feature 是 TorrentClientFeature 的映射类型，字段必须是真实存在的能力项
      // （原写法用的 noAdd 并不存在）；断言意图不变：cloneDeep 后不与 store 共享嵌套对象
      feature: { DefaultAutoStart: false },
      advanceAddTorrentOptions: { addAtPaused: false },
    };

    const stored = store.downloaders["d1"];
    // 与 SetDownloader/EditDialog.vue 的默认值合并写法保持一致
    const clientConfig: any = cloneDeep({ sortIndex: 100, advanceAddTorrentOptions: {}, ...stored });

    expect(clientConfig.feature).not.toBe(stored.feature);
    expect(clientConfig.advanceAddTorrentOptions).not.toBe(stored.advanceAddTorrentOptions);
    clientConfig.feature.DefaultAutoStart = true;
    clientConfig.advanceAddTorrentOptions.addAtPaused = true;
    expect(stored.feature?.DefaultAutoStart).toBe(false);
    expect(stored.advanceAddTorrentOptions?.addAtPaused).toBe(false);
  });

  it("三个 EditDialog 都改用 cloneDeep，并删除了与实际行为相反的注释", () => {
    for (const path of EDIT_DIALOGS) {
      const source = readSource(path);

      expect(source, path).toMatch(/clientConfig\.value = cloneDeep\(/);
      expect(source, path).not.toMatch(/clientConfig\.value = \{/); // 不再有浅展开赋值
      expect(source, path).not.toMatch(/防止直接修改父组件的数据/); // 与实际行为相反的注释
    }
  });
});
