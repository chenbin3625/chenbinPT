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
 *
 * L8：本文件里对 `.vue` 源码文本的断言已全部删除（它们掩盖了 H-1），关键接线一律改为行为断言。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

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
      backupFields: ["config"],
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

  // TESTS-4：原先这里对三个 EditDialog 做「源码含 cloneDeep(」的文本断言。
  // 深拷贝隔离本身已由上面的三条真实挂载用例证明（输入嵌套字段后 store 原值不变、
  // 「确定」后才写回），源码文本断言属于 L8 指出的「等价重构变红、行为坏掉照样绿」，
  // 已删除。
});

describe("F2-N2：下载器「路径与标签」对话框的草稿隔离", () => {
  let pinia: ReturnType<typeof prepareOptionsPinia>;

  beforeEach(() => {
    document.body.innerHTML = "";
    pinia = prepareOptionsPinia();
    pinia.use(({ store }) => {
      (store as any).$save = async () => {};
    });
  });

  async function mountPathAndTagDialog(clientId = "d1") {
    const open = ref(false);
    const { default: PathAndTagSuggestDialog } =
      await import("@/options/views/Settings/SetDownloader/PathAndTagSuggestDialog.vue");
    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(PathAndTagSuggestDialog as any, {
            clientId,
            modelValue: open.value,
            "onUpdate:modelValue": (value: boolean) => (open.value = value),
          }),
      }),
      { pinia },
    );
    return { view, open };
  }

  const folderTextarea = () => document.body.querySelector<HTMLTextAreaElement>(".ant-modal textarea")!;

  /** 默认展开的是「说明」面板，切到「下载路径」面板才会渲染路径输入框 */
  async function openPathPanel() {
    const headers = document.body.querySelectorAll<HTMLElement>(".ant-modal .ant-collapse-header");
    headers[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  function typeInto(textarea: HTMLTextAreaElement, value: string) {
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function clickFooterButton(index: 0 | 1) {
    const footer = document.body.querySelectorAll<HTMLButtonElement>(".ant-modal-footer button");
    footer[index]!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  it("取消不回写 store；重新打开时不再用过期的浅快照覆盖地址/密码", async () => {
    const store = useMetadataStore(pinia);
    store.downloaders["d1"] = {
      id: "d1",
      type: "qBittorrent",
      name: "qb",
      address: "http://qb.local",
      username: "u",
      password: "stored-pwd",
      enabled: true,
      feature: { DefaultAutoStart: false },
      advanceAddTorrentOptions: {},
      suggestFolders: ["/old"],
      suggestTags: [],
    } as any;

    const { view, open } = await mountPathAndTagDialog();
    try {
      open.value = true;
      await new Promise((resolve) => setTimeout(resolve, 120));
      await openPathPanel();
      expect(folderTextarea(), "应渲染出路径输入框").not.toBeNull();

      // 输入后取消：绝不能逐键写回 store（旧实现拿到 store 同一对象，取消无效）
      typeInto(folderTextarea(), "/half-typed");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.downloaders["d1"].suggestFolders).toEqual(["/old"]);

      await clickFooterButton(0); // 取消
      await new Promise((resolve) => setTimeout(resolve, 60));

      // 在别处修改同一台下载器（模拟先打开「编辑」改了密码 / 地址）
      store.downloaders["d1"].password = "new-pwd";
      store.downloaders["d1"].address = "http://qb2.local";

      // 重新打开：旧实现 clientId 没变 → 复用第一次的旧快照，保存时会覆盖掉上面的修改
      open.value = true;
      await new Promise((resolve) => setTimeout(resolve, 120));
      await openPathPanel();
      typeInto(folderTextarea(), "/new-folder");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await clickFooterButton(1); // 确定

      expect(store.downloaders["d1"].suggestFolders, "保存应写入本次输入的目录").toEqual(["/new-folder"]);
      expect(store.downloaders["d1"].password, "不得用旧快照覆盖期间修改的密码").toBe("new-pwd");
      expect(store.downloaders["d1"].address).toBe("http://qb2.local");
    } finally {
      view.unmount();
    }
  });

  // 原先这里还有一条「源码含 cloneDeep / simplePatch」的文本断言（L8）。上述真实挂载用例已
  // 证明「本次输入写入 suggestFolders、期间他人修改的 password/address 不被旧快照覆盖」，
  // 等价重构不应让测试变红，故删除源码文本断言。
});

describe("F2-Medium-03/12/15：编辑弹窗的「确定」由持续校验驱动", () => {
  let pinia: ReturnType<typeof prepareOptionsPinia>;

  beforeEach(() => {
    document.body.innerHTML = "";
    pinia = prepareOptionsPinia();
    pinia.use(({ store }) => {
      (store as any).$save = async () => {};
    });
  });

  it("下载器名称/地址为空时「确定」禁用，补齐后启用", async () => {
    const store = useMetadataStore(pinia);
    store.downloaders["d2"] = {
      id: "d2",
      type: "qBittorrent",
      name: "",
      address: "",
      enabled: true,
      feature: {},
      advanceAddTorrentOptions: {},
    } as any;

    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const { default: EditDialog } = await import("@/options/views/Settings/SetDownloader/EditDialog.vue");
    const open = ref(false);
    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(EditDialog as any, {
            clientId: "d2",
            modelValue: open.value,
            "onUpdate:modelValue": (value: boolean) => (open.value = value),
          }),
      }),
      { pinia },
    );

    const ok = () => document.body.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!;

    try {
      open.value = true;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(ok().disabled, "名称为空时必须禁用保存").toBe(true);

      const nameInput = await (async () => {
        for (let i = 0; i < 100; i++) {
          const item = Array.from(document.body.querySelectorAll(".ant-form-item")).find(
            (node) =>
              node.querySelector("label")?.textContent?.trim() === i18nInstance.global.t("SetDownloader.common.name"),
          );
          const input = item?.querySelector<HTMLInputElement>("input");
          if (input) return input;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("没有渲染出名称输入框");
      })();

      nameInput.value = "qb2";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      // 地址仍是空的
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(ok().disabled, "地址为空时仍应禁用").toBe(true);

      const addressItem = Array.from(document.body.querySelectorAll(".ant-form-item")).find(
        (node) =>
          node.querySelector("label")?.textContent?.trim() === i18nInstance.global.t("SetDownloader.common.address"),
      );
      const addressInput = addressItem!.querySelector<HTMLInputElement>("input")!;
      addressInput.value = "http://qb2.local";
      addressInput.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(ok().disabled, "补齐必填字段后应启用").toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("三个 EditDialog 的「确定」接线由真实挂载的行为用例覆盖（见下方 H-1 用例组）", () => {
    // TESTS-4 / L8：这里原先用「源码含 ok-button-props / @update:config-valid」的文本断言兜底，
    // 正是这种写法让 H-1（第二次打开「确定」永久禁用）在 600 个测试全绿时漏过。
    // 接线是否真的生效现在只由下面的 H-1 用例组（打开 → 取消 → 再打开 + 非法配置）的
    // 真实挂载断言证明，不再读取 `.vue` 源码文本。
    expect(EDIT_DIALOG_CASES).toHaveLength(3);
  });
});

/**
 * H-1 回归（复检 High）：三个编辑弹窗第二次打开时「确定」永久禁用。
 *
 * 根因：`dialogEnter()` 先命令式 `isFormValid.value = false`，再替换 clientConfig；而 Editor 的
 * `watch(formValid, emit('update:configValid'), { immediate: true })` **只在 computed 值变化时** emit。
 * 第二次打开时新配置与旧配置「同样合法」（formValid true → true）→ 不再 emit → 父组件永远停在 false。
 *
 * 修复前的这些用例只验证「首次打开 + 源码正则接线」，无法发现该回归；这里用真实挂载覆盖：
 * 打开 → 取消 → 再打开（Editor 实例复用，正是回归场景）后「确定」必须仍可用；
 * 再次打开时配置非法则必须禁用。
 */
const EDIT_DIALOG_CASES: Array<{
  name: string;
  clientId: string;
  load: () => Promise<{ default: any }>;
  seed: (store: any) => void;
  invalidate: (store: any) => void;
}> = [
  {
    name: "下载器",
    clientId: "d1",
    load: () => import("@/options/views/Settings/SetDownloader/EditDialog.vue"),
    seed: (store) => {
      store.downloaders["d1"] = {
        id: "d1",
        type: "qBittorrent",
        name: "qb",
        address: "http://qb.local",
        enabled: true,
        feature: { DefaultAutoStart: true },
        advanceAddTorrentOptions: {},
      };
    },
    invalidate: (store) => {
      store.downloaders["d1"].name = "";
    },
  },
  {
    name: "媒体服务器",
    clientId: "m1",
    load: () => import("@/options/views/Settings/SetMediaServer/EditDialog.vue"),
    seed: (store) => {
      store.mediaServers["m1"] = {
        id: "m1",
        type: "emby",
        name: "emby",
        address: "http://emby.local",
        enabled: true,
        auth: { apikey: "stored-key" },
      };
    },
    invalidate: (store) => {
      store.mediaServers["m1"].name = "";
    },
  },
  {
    name: "备份服务器",
    clientId: "b1",
    load: () => import("@/options/views/Settings/SetBackup/EditDialog.vue"),
    seed: (store) => {
      store.backupServers["b1"] = {
        id: "b1",
        type: "WebDAV",
        name: "webdav",
        enabled: true,
        backupFields: ["config"],
        config: { address: "http://127.0.0.1/dav", loginName: "u", loginPwd: "stored-pwd", digest: false },
      };
    },
    invalidate: (store) => {
      store.backupServers["b1"].name = "";
    },
  },
];

describe("H-1：编辑弹窗第二次打开后「确定」不得被永久禁用", () => {
  let pinia: ReturnType<typeof prepareOptionsPinia>;

  beforeEach(() => {
    document.body.innerHTML = "";
    pinia = prepareOptionsPinia();
    pinia.use(({ store }) => {
      (store as any).$save = async () => {};
    });
  });

  const okButton = () => document.body.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary");

  async function waitFor(predicate: () => boolean, message: string, timeout = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(message);
  }

  async function mountCase(testCase: (typeof EDIT_DIALOG_CASES)[number]) {
    const { default: EditDialog } = await testCase.load();
    const open = ref(false);
    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(EditDialog, {
            clientId: testCase.clientId,
            modelValue: open.value,
            "onUpdate:modelValue": (value: boolean) => (open.value = value),
          }),
      }),
      { pinia },
    );
    return { view, open };
  }

  for (const testCase of EDIT_DIALOG_CASES) {
    it(`${testCase.name}：合法配置下「打开 → 取消 → 再打开」后「确定」仍可用`, async () => {
      const store = useMetadataStore(pinia);
      testCase.seed(store);
      const { view, open } = await mountCase(testCase);
      try {
        open.value = true;
        // 首次打开：配置合法，「确定」必须可用（先证明这个场景本身是有效的）
        await waitFor(() => okButton()?.disabled === false, "首次打开且配置合法时「确定」应可用");
        expect(okButton()!.disabled).toBe(false);

        // 取消（关闭弹窗，Editor 实例不销毁 —— antd Modal 默认不 destroyOnClose，正是回归场景）
        open.value = false;
        await new Promise((resolve) => setTimeout(resolve, 80));

        // 再次打开同一份合法配置：Editor 的 formValid 仍为 true，不会重新 emit
        open.value = true;
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(
          okButton()!.disabled,
          "第二次打开且配置合法时「确定」不得被禁用（H-1：命令式置 false 会让它永久禁用）",
        ).toBe(false);
      } finally {
        view.unmount();
      }
    });

    it(`${testCase.name}：再次打开时配置非法 → 「确定」禁用`, async () => {
      const store = useMetadataStore(pinia);
      testCase.seed(store);
      const { view, open } = await mountCase(testCase);
      try {
        open.value = true;
        await waitFor(() => okButton()?.disabled === false, "首次打开且配置合法时「确定」应可用");

        open.value = false;
        await new Promise((resolve) => setTimeout(resolve, 80));

        // 在别处把配置改到非法（例如名称清空），再次打开时应重新校验并禁用
        testCase.invalidate(store);
        open.value = true;
        await waitFor(() => okButton()?.disabled === true, "配置非法时「确定」必须禁用");
        expect(okButton()!.disabled).toBe(true);
      } finally {
        view.unmount();
      }
    });
  }
});

describe("F2-Low-09：站点过滤的批量选择不丢失被隐藏的站点", () => {
  let pinia: ReturnType<typeof prepareOptionsPinia>;

  beforeEach(() => {
    document.body.innerHTML = "";
    pinia = prepareOptionsPinia();
    pinia.use(({ store }) => {
      (store as any).$save = async () => {};
    });
  });

  it("「全不选 / 全选」只作用于可见站点，被隐藏站点的排除项保留", async () => {
    const store = useMetadataStore(pinia);
    const { useConfigStore } = await import("@/options/stores/config.ts");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const configStore = useConfigStore(pinia);
    configStore.contentScript.allowExceptionSites = true;

    store.sites = {
      s1: { url: "https://s1.example/", allowContentScript: true, allowSearch: true },
      s2: { url: "https://s2.example/", allowContentScript: false, allowSearch: true },
    } as any;
    store.downloaders["d1"] = {
      id: "d1",
      type: "qBittorrent",
      name: "qb",
      address: "http://qb.local",
      enabled: true,
      excludedSites: ["s1", "s2"],
    } as any;

    const { default: SiteFilterDialog } = await import("@/options/views/Settings/SetDownloader/SiteFilterDialog.vue");
    const open = ref(false);
    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(SiteFilterDialog as any, {
            clientId: "d1",
            modelValue: open.value,
            "onUpdate:modelValue": (value: boolean) => (open.value = value),
          }),
      }),
      { pinia },
    );

    try {
      open.value = true;
      await new Promise((resolve) => setTimeout(resolve, 150));

      // 只有 s1 可见（s2 的 allowContentScript=false 且启用了例外站点）
      const noneButton = Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal button")).find(
        (button) => (button.textContent ?? "").trim() === i18nInstance.global.t("common.checkbox.none"),
      );
      expect(noneButton, "应渲染「全不选」按钮").toBeDefined();
      noneButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 60));

      document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!.click();
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(store.downloaders["d1"].excludedSites, "被隐藏站点的排除项不得被批量操作丢弃").toEqual(["s2"]);
    } finally {
      view.unmount();
    }
  });
});
