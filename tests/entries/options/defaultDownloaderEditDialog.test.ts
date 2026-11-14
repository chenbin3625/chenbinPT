/**
 * SetDownloader/DefaultDownloaderEditDialog.vue：默认下载器弹窗。
 *
 * 行为断言（真实挂载 + 真实 metadata store）：
 * - 每次打开先重置，再从 `metadataStore.defaultDownloader` 预填 id / folder / tags，
 *   并按该下载器加载 suggestFolders / suggestTags 作为自动补全选项；
 * - 切换下载器会清空 folder / tags 并换用新下载器的建议列表；
 * - 「确定」写入 `metadataStore.defaultDownloader`、调用 `$save` 并关闭；
 *   `$save` 失败时提示「保存失败」且不关闭。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { i18nInstance } from "@/options/plugins/i18n.ts";

const t = i18nInstance.global.t;
const sleep = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

function seedDownloaders(store: ReturnType<typeof useMetadataStore>) {
  store.downloaders = {
    d1: {
      id: "d1",
      type: "qBittorrent",
      name: "QB-one",
      address: "http://qb1.local",
      enabled: true,
      suggestFolders: ["/downloads/movies", "/downloads/tv"],
      suggestTags: ["movie", "tv"],
    },
    d2: {
      id: "d2",
      type: "Transmission",
      name: "TR-two",
      address: "http://tr2.local",
      enabled: true,
      suggestFolders: ["/data/one"],
      suggestTags: ["linux"],
    },
    d3: {
      id: "d3",
      type: "qBittorrent",
      name: "QB-disabled",
      address: "http://qb3.local",
      enabled: false,
    },
  } as any;
}

async function mountDialog() {
  const pinia = prepareOptionsPinia();
  const metadataStore = useMetadataStore(pinia);
  seedDownloaders(metadataStore);
  metadataStore.defaultDownloader = {};
  metadataStore.$save = vi.fn(async () => undefined);

  const runtimeStore = useRuntimeStore(pinia);
  const snackbarSpy = vi.spyOn(runtimeStore, "showSnackbar");

  const { default: Dialog } = await import("@/options/views/Settings/SetDownloader/DefaultDownloaderEditDialog.vue");
  const open = ref(false);
  const view = mountOptionsView(
    defineComponent({
      setup: () => () =>
        h(Dialog as any, { modelValue: open.value, "onUpdate:modelValue": (v: boolean) => (open.value = v) }),
    }),
    { pinia },
  );

  async function reopen() {
    open.value = true;
    await sleep(120);
  }

  return { view, open, metadataStore, snackbarSpy, reopen };
}

const modal = () => document.querySelector<HTMLElement>(".ant-modal");
/** a-modal 内三个下拉：第 0 个是下载器，第 1/2 个分别是 folder / tags 自动补全 */
const selectors = () => Array.from(document.querySelectorAll<HTMLElement>(".ant-modal .ant-select"));
const downloaderSelect = () => selectors()[0];
const folderInput = () =>
  document.querySelectorAll<HTMLInputElement>(".ant-modal input.ant-select-selection-search-input")[1];
const tagsInput = () =>
  document.querySelectorAll<HTMLInputElement>(".ant-modal input.ant-select-selection-search-input")[2];

async function openSelectDropdown(selector: HTMLElement) {
  const target = selector.querySelector<HTMLElement>(".ant-select-selector") ?? selector;
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await sleep(120);
}

function dropdownOptions(): string[] {
  // 下拉浮层 teleport 到 body 且关闭后仍留在 DOM（ant-select-dropdown-hidden），
  // 只取当前可见的那一个（多个同时可见时取最后打开的那个）。
  const dropdowns = Array.from(document.querySelectorAll<HTMLElement>(".ant-select-dropdown")).filter(
    (node) => !node.classList.contains("ant-select-dropdown-hidden"),
  );
  const dropdown = dropdowns[dropdowns.length - 1];
  return Array.from(dropdown?.querySelectorAll<HTMLElement>(".ant-select-item-option") ?? []).map(
    (node) => node.textContent?.trim() ?? "",
  );
}

async function chooseDownloader(name: string) {
  await openSelectDropdown(downloaderSelect()!);
  const option = Array.from(
    document.querySelectorAll<HTMLElement>(".ant-select-dropdown .ant-select-item-option"),
  ).find((node) => (node.textContent ?? "").includes(name));
  expect(option, `下载器下拉里应有「${name}」`).toBeDefined();
  option!.click();
  await sleep(120);
}

async function openAutoComplete(input: HTMLInputElement) {
  input.focus();
  const selector = input.closest(".ant-select")!.querySelector<HTMLElement>(".ant-select-selector") ?? input;
  selector.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await sleep(150);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("DefaultDownloaderEditDialog：打开时的初始化", () => {
  it("无默认下载器：打开时 id / folder / tags 均为空", async () => {
    const { view, reopen } = await mountDialog();
    try {
      await reopen();

      expect(modal(), "弹窗应渲染").not.toBeNull();
      expect(downloaderSelect()!.textContent ?? "").not.toContain("QB-one");
      expect(folderInput()!.value).toBe("");
      expect(tagsInput()!.value).toBe("");
    } finally {
      view.unmount();
    }
  });

  it("已有默认下载器：预填 id / folder / tags，并加载该下载器的建议列表", async () => {
    const { view, metadataStore, reopen } = await mountDialog();
    metadataStore.defaultDownloader = { id: "d1", folder: "/downloads/movies", tags: "movie" };
    try {
      await reopen();

      expect(downloaderSelect()!.textContent).toContain("QB-one");
      expect(folderInput()!.value).toBe("/downloads/movies");
      expect(tagsInput()!.value).toBe("movie");

      // 打开两个自动补全的下拉，选项就是该下载器的 suggestFolders / suggestTags
      await openAutoComplete(folderInput()!);
      expect(dropdownOptions()).toEqual(["/downloads/movies", "/downloads/tv"]);

      await openAutoComplete(tagsInput()!);
      expect(dropdownOptions()).toEqual(["movie", "tv"]);
    } finally {
      view.unmount();
    }
  });

  it("重新打开会丢弃上次未保存的编辑（重置为 store 里的默认值）", async () => {
    const { view, open, metadataStore, reopen } = await mountDialog();
    metadataStore.defaultDownloader = { id: "d1", folder: "/downloads/movies", tags: "movie" };
    try {
      await reopen();
      expect(folderInput()!.value).toBe("/downloads/movies");

      // 未保存的输入
      folderInput()!.value = "/half-typed";
      folderInput()!.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(40);
      expect(folderInput()!.value).toBe("/half-typed");

      open.value = false;
      await sleep(80);
      await reopen();

      expect(folderInput()!.value, "重新打开应回到 store 的默认值").toBe("/downloads/movies");
    } finally {
      view.unmount();
    }
  });
});

describe("DefaultDownloaderEditDialog：切换下载器", () => {
  it("切换后清空 folder / tags，并换用新下载器的建议列表", async () => {
    const { view, metadataStore, reopen } = await mountDialog();
    metadataStore.defaultDownloader = { id: "d1", folder: "/downloads/movies", tags: "movie" };
    try {
      await reopen();
      expect(folderInput()!.value).toBe("/downloads/movies");

      await chooseDownloader("TR-two");

      expect(folderInput()!.value, "切换下载器必须清空路径").toBe("");
      expect(tagsInput()!.value, "切换下载器必须清空标签").toBe("");

      await openAutoComplete(folderInput()!);
      expect(dropdownOptions()).toEqual(["/data/one"]);

      await openAutoComplete(tagsInput()!);
      expect(dropdownOptions()).toEqual(["linux"]);
    } finally {
      view.unmount();
    }
  });

  it("同一 id 的初始化（预填）不清空 folder / tags", async () => {
    const { view, metadataStore, reopen } = await mountDialog();
    metadataStore.defaultDownloader = { id: "d2", folder: "/data/one", tags: "linux" };
    try {
      await reopen();

      expect(downloaderSelect()!.textContent).toContain("TR-two");
      expect(folderInput()!.value).toBe("/data/one");
      expect(tagsInput()!.value).toBe("linux");
    } finally {
      view.unmount();
    }
  });

  it("只列出已启用的下载器", async () => {
    const { view, reopen } = await mountDialog();
    try {
      await reopen();
      await openSelectDropdown(downloaderSelect()!);

      const options = dropdownOptions();
      expect(options.some((text) => text.includes("QB-one"))).toBe(true);
      expect(options.some((text) => text.includes("TR-two"))).toBe(true);
      expect(options.some((text) => text.includes("QB-disabled"))).toBe(false);
    } finally {
      view.unmount();
    }
  });
});

describe("DefaultDownloaderEditDialog：保存", () => {
  it("点击确定写入 metadataStore.defaultDownloader、调用 $save 并关闭", async () => {
    const { view, open, metadataStore, reopen } = await mountDialog();
    metadataStore.defaultDownloader = { id: "d1", folder: "/downloads/movies", tags: "movie" };
    try {
      await reopen();

      const ok = document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary");
      expect(ok, "应有确定按钮").not.toBeNull();
      ok!.click();
      await sleep(120);

      expect(metadataStore.$save).toHaveBeenCalledTimes(1);
      expect(metadataStore.defaultDownloader).toMatchObject({
        id: "d1",
        folder: "/downloads/movies",
        tags: "movie",
      });
      expect(open.value, "保存成功后应关闭弹窗").toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("$save 抛错：提示保存失败且不关闭弹窗", async () => {
    const { view, open, metadataStore, snackbarSpy, reopen } = await mountDialog();
    metadataStore.defaultDownloader = { id: "d1", folder: "/downloads/movies", tags: "movie" };
    metadataStore.$save = vi.fn(async () => {
      throw new Error("storage quota exceeded");
    });
    try {
      await reopen();

      document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!.click();
      await sleep(120);

      expect(snackbarSpy).toHaveBeenCalledWith(t("common.saveFailed"), { color: "error" });
      expect(open.value, "保存失败时不得关闭弹窗（避免用户以为已保存）").toBe(true);
    } finally {
      view.unmount();
    }
  });
});
