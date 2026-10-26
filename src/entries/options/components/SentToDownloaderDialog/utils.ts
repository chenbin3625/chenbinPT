import { h, ref } from "vue";
import { Input, type Modal } from "ant-design-vue";
import type { ITorrent } from "@ptd/site";
import type { IDownloadTorrentResult } from "@/shared/types.ts";
import type { TDownloaderKey } from "@/shared/types/storages/metadata.ts";
import type { CAddTorrentOptions } from "@ptd/downloader";
import { datePathTemplateVars, expandPathTemplate } from "@ptd/downloader/utils/pathTemplate.ts";
import { sanitizeDynamicReplaceValue } from "@/options/utils.ts";
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

/**
 * Info8（B2 移交）：动态替换值的路径安全化实现已抽到 `@/options/utils.ts`，供
 * 「发送到下载器」与「辅种任务发送」两处共用（OUI-4：KeepUploadTask 原先是第二份未清洗的实现）。
 * 这里保留 re-export，避免历史 import 路径失效。
 */
export { sanitizeDynamicReplaceValue } from "@/options/utils.ts";

export async function sendTorrentToDownloader(
  torrentItems: ITorrent[],
  downloaderId: TDownloaderKey,
  addTorrentOptions: CAddTorrentOptions,
  promptReplace: TDynamicReplacePrompter,
  options: { allowSiteLessLink?: boolean } = {},
): Promise<void> {
  const runtimeStore = useRuntimeStore();
  const metadataStore = useMetadataStore();

  // F1-08：`<...>` 的替换结果写进**局部副本**，不再直接改写调用方（对话框 ref）里的对象 ——
  // 旧实现会就地改 `addTorrentOptions`，用户取消输入后已经替换掉的那部分仍留在对话框状态里。
  // 同时补 `typeof === "string"` 守卫：`lastDownloader.options` 合并进来时字段可能是 undefined。
  const preparedAddTorrentOptions: CAddTorrentOptions = { ...addTorrentOptions };

  // 预处理自定义输入
  for (const key of ["savePath", "label"] as (keyof typeof preparedAddTorrentOptions)[]) {
    const rawValue = preparedAddTorrentOptions[key] as unknown;
    if (typeof rawValue !== "string" || !rawValue.includes("<...>")) continue;

    // 此处允许空字符 ""， 但不允许用户取消（即取消动态替换操作则认为取消推送任务）
    const userInput = await promptReplace(key);
    if (userInput === null) {
      // 用户取消输入，则停止该任务；调用方（Index.vue）会 catch 并给出可区分的提示（V-3）
      return Promise.reject(i18n.t("SentToDownloaderDialog.dynamicReplaceCancelled", [key]));
    }
    // @ts-expect-error 原因：key 来自字符串字面量数组，CAddTorrentOptions 各字段类型不同，无法按索引赋 string
    preparedAddTorrentOptions[key] = rawValue.replace("<...>", userInput.trim());
  }

  // 预构造动态替换映射表
  const nowDate = new Date();
  const baseReplaceMap: Record<string, string> = {
    ...datePathTemplateVars(nowDate),
  };

  // 搜索相关动态替换（Info8：替换值会进保存路径 / 标签，先做路径安全化）
  if (runtimeStore.search.searchKey !== "") {
    baseReplaceMap["search:keyword"] = sanitizeDynamicReplaceValue(runtimeStore.search.searchKey);
  }

  if (runtimeStore.search.searchPlanKey !== "") {
    baseReplaceMap["search:plan"] = sanitizeDynamicReplaceValue(
      metadataStore.getSearchSolutionName(runtimeStore.search.searchPlanKey),
    );
  }

  const promises = [];

  for (const torrent of torrentItems) {
    const realAddTorrentOptions: Partial<CAddTorrentOptions> = { ...preparedAddTorrentOptions };

    // Info8：标题 / 副标题 / 分类来自站点页面，同样按「替换值」清理后再拼进 savePath/label
    const replaceMap: Record<string, string> = {
      "torrent.title": sanitizeDynamicReplaceValue(torrent.title),
      "torrent.subTitle": sanitizeDynamicReplaceValue(torrent.subTitle),
      "torrent.category": sanitizeDynamicReplaceValue(torrent.category),
      ...baseReplaceMap,
    };

    if (torrent.site) {
      replaceMap["torrent.site"] = sanitizeDynamicReplaceValue(torrent.site);
      replaceMap["torrent.siteName"] = sanitizeDynamicReplaceValue(await metadataStore.getSiteName(torrent.site));
    }

    // F1-08：空串/缺失的 savePath、label 直接从下发给下载器的配置里删掉（语义 = 使用下载器默认值）。
    // 旧实现外层 `if (值)` 已排除空串，内层 `if (值 === "")` 是永远不成立的死分支，于是 `savePath: ""`
    // 会被原样传给下载器（各实体对空串的解释不一致）。
    for (const key of ["savePath", "label"] as (keyof typeof realAddTorrentOptions)[]) {
      const rawValue = realAddTorrentOptions[key];
      if (typeof rawValue !== "string" || rawValue === "") {
        delete realAddTorrentOptions[key];
        continue;
      }
      // 一次扫描展开（替换结果不再二次扫描：标题里即使含 `$torrent.site$` 也不会被当成变量）
      // @ts-expect-error 原因：同上，按动态字段名对字符串字段做占位符替换
      realAddTorrentOptions[key] = expandPathTemplate(rawValue, replaceMap) ?? rawValue;
    }

    promises.push(
      sendMessage("downloadTorrent", {
        torrent,
        downloaderId: downloaderId,
        allowSiteLessLink: options.allowSiteLessLink === true,
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
    // DOWNLOADER-8：`warningMessage` 表示「推送成功但下载器设置未生效」（如 uTorrent 直发 http 链接
    // 拿不到 infoHash，暂停 / 标签 / 上传限速被跳过）。这类结果既不是 failed 也不是 pending，若只按
    // 上面两类统计，搜索页的推送汇总就会把它当普通成功，用户看不到「设置没生效」。
    const warningCount = status.filter((x) => {
      const result = x as IDownloadTorrentResult | undefined;
      return (
        result?.downloadStatus !== "failed" && result?.downloadStatus !== "pending" && Boolean(result?.warningMessage)
      );
    }).length;
    const successCount = status.length - failedCount;
    const color = failedCount > 0 || warningCount > 0 ? "warning" : "success";
    const warningSummary =
      warningCount > 0 ? i18n.t("SentToDownloaderDialog.sendSummaryWarning", { count: warningCount }) : "";

    runtimeStore.showSnakebar(
      successCount > 0
        ? i18n.t("SentToDownloaderDialog.sendSummary", {
            success: successCount,
            pending:
              pendingCount > 0 ? i18n.t("SentToDownloaderDialog.sendSummaryPending", { count: pendingCount }) : "",
            failed: failedCount > 0 ? i18n.t("SentToDownloaderDialog.sendSummaryFailed", { count: failedCount }) : "",
          }) + warningSummary
        : i18n.t("SentToDownloaderDialog.noTasks"),
      { color },
    );
  } else {
    runtimeStore.showSnakebar(i18n.t("SentToDownloaderDialog.noTasks"), { color: "warning" });
  }
}
