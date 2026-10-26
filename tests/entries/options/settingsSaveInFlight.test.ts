import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref, type Component } from "vue";
import { mountOptionsView } from "../../helpers/optionsView.ts";

const state = vi.hoisted(() => ({
  addSite: vi.fn(),
  addDownloader: vi.fn(),
  addMediaServer: vi.fn(),
  addBackupServer: vi.fn(),
  showSnakebar: vi.fn(),
}));
vi.mock("@/options/stores/metadata.ts", () => ({
  useMetadataStore: () => ({
    ...state,
    sites: { test: {} },
    downloaders: { test: { id: "test", type: "test" } },
    mediaServers: { test: { id: "test", type: "test" } },
    backupServers: { test: { id: "test", type: "test" } },
    getDownloaders: [],
  }),
}));
vi.mock("@/options/stores/runtime.ts", () => ({ useRuntimeStore: () => state }));
vi.mock("@ptd/downloader", () => ({
  entityList: ["test"],
  getDownloaderDefaultConfig: async () => ({ type: "test" }),
  getDownloaderMetaData: async () => ({ description: "Test downloader" }),
  getDownloaderIcon: () => "",
}));
vi.mock("@ptd/mediaServer", () => ({
  entityList: ["test"],
  getMediaServerDefaultConfig: async () => ({ type: "test" }),
  getMediaServerMetaData: async () => ({ description: "Test media server" }),
  getMediaServerIcon: () => "",
}));
vi.mock("@ptd/backupServer", () => ({
  entityList: ["test"],
  getBackupServerDefaultConfig: async () => ({ type: "test" }),
  getBackupServerMetaData: async () => ({ description: "Test backup server" }),
  getBackupServerIcon: () => "",
}));
vi.mock("@/options/views/Settings/SetSite/utils.ts", () => ({
  getCanAddedSiteMetadata: async () => ({ test: { id: "test", name: "Test Site", type: "private" } }),
}));
vi.mock("@/options/components/SiteFavicon/Index.vue", () => ({ default: { render: () => null } }));

function editorStub() {
  return {
    props: ["modelValue"],
    emits: ["update:config-valid", "update:form-valid"],
    setup(_props: unknown, { emit }: { emit: (event: string, value: boolean) => void }) {
      emit("update:config-valid", true);
      emit("update:form-valid", true);
      return () => null;
    },
  };
}

vi.mock("@/options/views/Settings/SetSite/Editor.vue", () => ({ default: editorStub() }));
vi.mock("@/options/views/Settings/SetDownloader/Editor.vue", () => ({ default: editorStub() }));
vi.mock("@/options/views/Settings/SetMediaServer/Editor.vue", () => ({ default: editorStub() }));
vi.mock("@/options/views/Settings/SetBackup/Editor.vue", () => ({ default: editorStub() }));

import AddSite from "@/options/views/Settings/SetSite/AddDialog.vue";
import EditSite from "@/options/views/Settings/SetSite/EditDialog.vue";
import AddDownloader from "@/options/views/Settings/SetDownloader/AddDialog.vue";
import EditDownloader from "@/options/views/Settings/SetDownloader/EditDialog.vue";
import AddMediaServer from "@/options/views/Settings/SetMediaServer/AddDialog.vue";
import EditMediaServer from "@/options/views/Settings/SetMediaServer/EditDialog.vue";
import AddBackupServer from "@/options/views/Settings/SetBackup/AddDialog.vue";
import EditBackupServer from "@/options/views/Settings/SetBackup/EditDialog.vue";

let view: ReturnType<typeof mountOptionsView>;
const cases = [
  { name: "添加站点", component: AddSite, save: state.addSite, add: true },
  { name: "编辑站点", component: EditSite, save: state.addSite, add: false },
  { name: "添加下载器", component: AddDownloader, save: state.addDownloader, add: true },
  { name: "编辑下载器", component: EditDownloader, save: state.addDownloader, add: false },
  { name: "添加媒体服务", component: AddMediaServer, save: state.addMediaServer, add: true },
  { name: "编辑媒体服务", component: EditMediaServer, save: state.addMediaServer, add: false },
  { name: "添加备份服务", component: AddBackupServer, save: state.addBackupServer, add: true },
  { name: "编辑备份服务", component: EditBackupServer, save: state.addBackupServer, add: false },
];

function footerButton(text: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal-footer button")).find(
    (button) => button.textContent?.replaceAll(" ", "").trim() === text,
  )!;
}

async function openDialog(component: Component, add: boolean) {
  const open = ref(false);
  view = mountOptionsView(
    defineComponent({
      setup: () => () =>
        h(component, {
          clientId: "test",
          siteId: "test",
          modelValue: open.value,
          "onUpdate:modelValue": (value: boolean) => (open.value = value),
        }),
    }),
  );
  open.value = true;
  await view.settle();
  if (add) {
    document
      .querySelector(".ant-modal .ant-select-selector")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await view.settle();
    document.querySelector<HTMLElement>(".ant-select-item-option")!.click();
    await view.settle();
    footerButton("下一步").click();
    await view.settle();
  }
  expect(footerButton("完成").disabled).toBe(false);
  return open;
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  view?.unmount();
  document.body.innerHTML = "";
});

describe.each(cases)("$name 的保存反馈", ({ component, save, add }) => {
  it("请求中只保存一次，显示忙碌状态并阻止关闭，成功后关闭", async () => {
    let finish!: () => void;
    save.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const open = await openDialog(component, add);
    const ok = footerButton("完成");
    ok.click();
    ok.click();
    await view.settle();
    try {
      expect(save).toHaveBeenCalledTimes(1);
      expect(ok.classList.contains("ant-btn-loading")).toBe(true);
      expect(footerButton("取消").disabled).toBe(true);
      expect(document.querySelector(".ant-modal-close")).toBeNull();
      footerButton("取消").click();
      document
        .querySelector(".ant-modal-wrap")!
        .dispatchEvent(new KeyboardEvent("keydown", { keyCode: 27, bubbles: true }));
      await view.settle();
      expect(open.value).toBe(true);
    } finally {
      finish();
      await view.settle();
    }
    expect(open.value).toBe(false);
  });

  it("失败后保留表单、解除忙碌状态，并允许重试", async () => {
    save.mockRejectedValueOnce(new Error("write failed")).mockResolvedValueOnce(undefined);
    const open = await openDialog(component, add);
    footerButton("完成").click();
    await view.settle();
    expect(open.value).toBe(true);
    expect(state.showSnakebar).toHaveBeenCalledWith(expect.any(String), { color: "error" });
    expect(footerButton("取消").disabled).toBe(false);
    footerButton("完成").click();
    await view.settle();
    expect(save).toHaveBeenCalledTimes(2);
    expect(open.value).toBe(false);
  });
});
