import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref, type Component } from "vue";
import { mountOptionsView } from "../../helpers/optionsView.ts";

const state = vi.hoisted(() => ({ send: vi.fn(), showSnakebar: vi.fn() }));
vi.mock("@/options/stores/runtime.ts", () => ({ useRuntimeStore: () => state }));
vi.mock("@/options/stores/config.ts", () => ({
  useConfigStore: () => ({ download: { saveLastDownloader: false, useQuickSendToClient: false } }),
}));
vi.mock("@/options/stores/metadata.ts", () => ({
  useMetadataStore: () => ({
    getEnabledDownloaders: [{ id: "d1", name: "Test", type: "test", address: "http://test" }],
    lastDownloader: {},
  }),
}));
vi.mock("@ptd/downloader", () => ({
  getDownloaderIcon: () => "",
  getDownloaderMetaData: async () => ({}),
}));
vi.mock("@/options/components/SentToDownloaderDialog/utils.ts", () => ({
  sendTorrentToDownloader: state.send,
  createDynamicReplacePrompter: () => vi.fn(),
}));

import DeleteDialog from "@/options/components/DeleteDialog.vue";
import ConnectCheckButton from "@/options/components/ConnectCheckButton.vue";
import RecheckDialog from "@/options/views/Overview/MyClient/RecheckConfirmDialog.vue";
import SendDialog from "@/options/components/SentToDownloaderDialog/Index.vue";

let view: ReturnType<typeof mountOptionsView>;
function mountDialog(component: Component, props: Record<string, unknown>) {
  const open = ref(true);
  view = mountOptionsView(
    defineComponent({
      setup: () => () =>
        h(component, {
          ...props,
          modelValue: open.value,
          "onUpdate:modelValue": (value: boolean) => (open.value = value),
        }),
    }),
  );
  return open;
}

const okButton = () =>
  document.querySelector<HTMLButtonElement>(
    ".ant-modal-footer .ant-btn-loading, .ant-modal-footer .ant-btn-dangerous, .ant-modal-footer .ant-btn-primary",
  )!;
const cancelButton = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal-footer button")).find(
    (button) => button.textContent?.replaceAll(" ", "") === "取消",
  )!;

afterEach(() => {
  view?.unmount();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("异步操作期间的交互保护", () => {
  it.each(["delete", "recheck"])("%s 请求中禁止重复确认和关闭", async (kind) => {
    let finish!: () => void;
    const operation = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const open =
      kind === "delete"
        ? mountDialog(DeleteDialog, { toDeleteIds: ["a"], confirmDelete: operation })
        : mountDialog(RecheckDialog, { torrentCount: 1, confirmFn: operation });
    await view.settle();
    okButton().click();
    okButton().click();
    await view.settle();
    try {
      expect(operation).toHaveBeenCalledTimes(1);
      expect(okButton().classList.contains("ant-btn-loading")).toBe(true);
      expect(cancelButton().disabled).toBe(true);
      expect(document.querySelector(".ant-modal-close")).toBeNull();
      cancelButton().click();
      await view.settle();
      expect(open.value).toBe(true);
    } finally {
      finish();
      await view.settle();
    }
    expect(open.value).toBe(false);
  });

  it("连接测试连续点击只发出一次请求", async () => {
    let finish!: (connected: boolean) => void;
    const checkFn = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    view = mountOptionsView(ConnectCheckButton, { props: { checkFn } });
    view.$<HTMLButtonElement>("button")!.click();
    view.$<HTMLButtonElement>("button")!.click();
    await view.settle();
    try {
      expect(checkFn).toHaveBeenCalledTimes(1);
    } finally {
      finish(true);
      await view.settle();
    }
    expect(view.$(".anticon-check-circle")).not.toBeNull();
  });

  it("下载推送只提交一次，发送期间保留弹窗，完成后通知一次", async () => {
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
    let finish!: () => void;
    state.send.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const done = vi.fn();
    const open = mountDialog(SendDialog, { torrentItems: [{ title: "test" }], onDone: done });
    await view.settle();
    okButton().click();
    okButton().click();
    await view.settle();
    try {
      expect(state.send).toHaveBeenCalledTimes(1);
      expect(document.querySelector(".ant-modal-close")).toBeNull();
      expect(cancelButton().disabled).toBe(true);
      expect(open.value).toBe(true);
    } finally {
      finish();
      await view.settle();
    }
    expect(open.value).toBe(false);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
