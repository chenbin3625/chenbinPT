import { h, ref } from "vue";
import { Input, type Modal } from "ant-design-vue";
import type { ITorrent } from "@ptd/site";
import type { TDownloaderKey } from "@/shared/types/storages/metadata.ts";
import type { CAddTorrentOptions } from "@ptd/downloader";
import { formatDate } from "@/options/utils.ts";
import { i18n } from "@/options/plugins/i18n.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { sendMessage } from "@/messages.ts";

type ModalApi = ReturnType<typeof Modal.useModal>[0];

/** 动态替换 `<...>` 时向用户索要输入；返回 null 表示用户取消输入（取消即认为取消本次推送） */
export type TDynamicReplacePrompter = (key: string) => Promise<string | null>;

/**
 * 构造「输入替换内容」的对话框。
 *
 * V-11：本组件既在选项页渲染，也会被内容脚本挂载在 **shadow root** 内（content-script/app/App.vue）。
 * antd 的**静态** `Modal.confirm` 会 `vueRender` 到一个游离的 document fragment（见
 * `ant-design-vue/es/modal/confirm.js`）：既不进 shadow root、也拿不到 `ConfigProvider` 的主题/语言/
 * `getPopupContainer`，弹窗会完全失去样式；而且它落在**宿主页面的 document.body** 上，页面脚本可以读取
 * 用户输入的保存路径/标签、可以移动或隐藏该弹窗、甚至直接触发它的 OK 按钮替换成自己的值
 * （该值随后会被用作下载器的 `savepath`/标签）。项目已为此在 `content-script/app/modal.ts` 用
 * `Modal.useModal()` 封装了 shadow 感知的 API，这里改为**由调用组件把自己的 useModal 实例注入进来**
 * （见 Index.vue）：弹窗的 contextHolder 渲染在组件自身所在的容器里，两种宿主下都正确。
 */
export function createDynamicReplacePrompter(modal: ModalApi): TDynamicReplacePrompter {
  return (key: string) =>
    new Promise<string | null>((resolve) => {
      const value = ref("");
      modal.confirm({
        title: i18n.t("SentToDownloaderDialog.dynamicReplaceTitle", [key]),
        content: () =>
          h(Input, {
            value: value.value,
            "onUpdate:value": (v: string) => {
              value.value = v;
            },
          }),
        onOk: () => resolve(value.value),
        onCancel: () => resolve(null),
      });
    });
}

export async function sendTorrentToDownloader(
  torrentItems: ITorrent[],
  downloaderId: TDownloaderKey,
  addTorrentOptions: CAddTorrentOptions,
  promptReplace: TDynamicReplacePrompter,
): Promise<void> {
  const runtimeStore = useRuntimeStore();
  const metadataStore = useMetadataStore();

  // 预处理自定义输入
  for (const key of ["savePath", "label"] as (keyof typeof addTorrentOptions)[]) {
    if ((addTorrentOptions[key] as string).includes("<...>")) {
      // 此处允许空字符 ""， 但不允许用户取消（即取消动态替换操作则认为取消推送任务）
      const userInput = await promptReplace(key);
      if (userInput !== null) {
        // @ts-ignore
        addTorrentOptions[key] = (addTorrentOptions[key] as string).replace("<...>", userInput.trim());
      } else {
        // 用户取消输入，则停止该任务；调用方（Index.vue）会 catch 并给出可区分的提示（V-3）
        return Promise.reject(i18n.t("SentToDownloaderDialog.dynamicReplaceCancelled", [key]));
      }
    }
  }

  // 预构造动态替换映射表
  const nowDate = new Date();
  const baseReplaceMap: Record<string, string> = {
    "date:YYYY": formatDate(nowDate, "yyyy"),
    "date:MM": formatDate(nowDate, "MM"),
    "date:DD": formatDate(nowDate, "dd"),
  };

  // 搜索相关动态替换
  if (runtimeStore.search.searchKey !== "") {
    baseReplaceMap["search:keyword"] = runtimeStore.search.searchKey;
  }

  if (runtimeStore.search.searchPlanKey !== "") {
    baseReplaceMap["search:plan"] = metadataStore.getSearchSolutionName(runtimeStore.search.searchPlanKey);
  }

  const promises = [];

  for (const torrent of torrentItems) {
    const realAddTorrentOptions: Partial<CAddTorrentOptions> = { ...addTorrentOptions };

    const replaceMap: Record<string, string> = {
      "torrent.title": torrent.title ?? "",
      "torrent.subTitle": torrent.subTitle ?? "",
      "torrent.category": (torrent.category as string) ?? "",
      ...baseReplaceMap,
    };

    if (torrent.site) {
      replaceMap["torrent.site"] = torrent.site;
      replaceMap["torrent.siteName"] = await metadataStore.getSiteName(torrent.site);
    }

    for (const key of ["savePath", "label"] as (keyof typeof realAddTorrentOptions)[]) {
      if (realAddTorrentOptions[key]) {
        if (realAddTorrentOptions[key] === "") {
          delete realAddTorrentOptions[key];
        } else {
          for (const [replaceKey, value] of Object.entries(replaceMap)) {
            // @ts-ignore
            realAddTorrentOptions[key] = (realAddTorrentOptions[key]! as string).replace(`$${replaceKey}$`, value);
          }
        }
      }
    }

    promises.push(
      sendMessage("downloadTorrent", {
        torrent,
        downloaderId: downloaderId,
        addTorrentOptions: realAddTorrentOptions as CAddTorrentOptions,
      }).catch((x) => {
        runtimeStore.showSnakebar(
          i18n.t("SentToDownloaderDialog.sendFailed", {
            title: torrent.title,
            error: String(x),
          }),
          { color: "error" },
        );
        // V-1：catch 必须返回 failed 标记。此前这里解析为 `undefined`，而下面的 failedCount 是按
        // `downloadStatus === "failed"` 统计的 → 恒为 0，于是全部失败时仍会弹出
        // 「成功发送 N 个任务到下载器」并配绿色 success。
        return { downloadStatus: "failed" as const };
      }),
    );
  }

  const status = await Promise.all(promises);
  if (status.length > 0) {
    const pendingCount = status.filter((x) => x?.downloadStatus === "pending").length;
    const failedCount = status.filter((x) => x?.downloadStatus === "failed").length;
    const successCount = status.length - failedCount;
    const color = failedCount > 0 ? "warning" : "success";

    runtimeStore.showSnakebar(
      successCount > 0
        ? i18n.t("SentToDownloaderDialog.sendSummary", {
            success: successCount,
            pending:
              pendingCount > 0 ? i18n.t("SentToDownloaderDialog.sendSummaryPending", { count: pendingCount }) : "",
            failed: failedCount > 0 ? i18n.t("SentToDownloaderDialog.sendSummaryFailed", { count: failedCount }) : "",
          })
        : i18n.t("SentToDownloaderDialog.noTasks"),
      { color },
    );
  } else {
    runtimeStore.showSnakebar(i18n.t("SentToDownloaderDialog.noTasks"), { color: "warning" });
  }
}
