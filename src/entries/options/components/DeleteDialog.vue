<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { useRuntimeStore } from "@/options/stores/runtime.ts";

type TDeleteId = any;

const showDialog = defineModel<boolean>();
const {
  toDeleteIds,
  confirmDelete: confirmDeleteFn,
  failureHints,
} = defineProps<{
  toDeleteIds: TDeleteId[];
  // DOWNLOADER-3：下载器实体删除失败时按契约返回 false（Synology 未勾选「同时删除数据」、
  // Aria2 勾选删除数据），而不是抛异常；调用方必须能把这个结果带到这里来。
  confirmDelete: (toDeleteId: TDeleteId) => Promise<boolean | void> | void;
  // DOWNLOADER-3：实体按契约只回 boolean，`throw` 里那句「为什么删不掉」因此丢失。下载器类型 /
  // 能力的判断只有调用方知道，所以由调用方按 id 提供一句可操作提示，这里只负责把它附进失败提示；
  // 不传时行为与从前完全一致（仍然只提示失败的 id）。
  failureHints?: Record<string, string>;
}>();
const emits = defineEmits<{
  (e: "allDelete"): void;
}>();

const { t } = useI18n();

const isDeleting = ref(false);

async function confirmDelete() {
  isDeleting.value = true;

  let failedIds: TDeleteId[] = [];
  let succeededCount = 0;
  try {
    // OPTIONSSHELL-1：Promise.allSettled 的 reason 不能被丢弃 —— 删除失败（例如 removeSite 重建
    // siteHostMap/siteNameMap 时站点定义加载失败）时旧实现照常关弹窗且零提示，用户以为删除成功，
    // 而派生索引仍是旧内容。这里收集 rejected 项并在关闭前明确告知。
    // DOWNLOADER-3：fulfilled 但 value === false 同样是失败（实体按契约用返回值表达「删不掉」），
    // 旧写法只看 rejection，Synology 默认路径（removeData=false）会被当成删除成功。
    const results = await Promise.allSettled(toDeleteIds.map((toDeleteId) => confirmDeleteFn(toDeleteId)));
    failedIds = toDeleteIds.filter((_, index) => {
      const result = results[index];
      return result?.status === "rejected" || (result?.status === "fulfilled" && result.value === false);
    });
    succeededCount = toDeleteIds.length - failedIds.length;
  } finally {
    isDeleting.value = false;
  }

  if (failedIds.length > 0) {
    // DOWNLOADER-3：把调用方按下载器类型给的原因提示附在失败 id 后面（同一条提示只出现一次），
    // 否则 Synology 用户看到的只有一串删不掉的 id，不知道要去勾「同时删除数据」。
    const hints = [
      ...new Set(failedIds.map((toDeleteId) => failureHints?.[String(toDeleteId)]).filter((hint) => !!hint)),
    ];
    // 首参用字符串拼接而不是模板字符串：tests/entries/options/tooltipI18n.test.ts 的硬编码文案守卫
    // 明确禁止源码里出现 `showSnakebar(\``（这里当初正因模板字符串而让该门禁变红）。
    useRuntimeStore().showSnakebar(
      t("KeepUploadTask.deleteError") + ": " + failedIds.join(", ") + (hints.length ? `（${hints.join("；")}）` : ""),
      { color: "error" },
    );
  }

  // DOWNLOADER-3：全部失败时不能「无条件关窗」——一个都没删掉却关窗刷新，用户仍会以为操作生效了；
  // 保持弹窗打开，用户可以取消勾选（如 Synology 的「同时删除数据」）后重试。
  if (failedIds.length > 0 && succeededCount === 0) {
    return;
  }

  showDialog.value = false;
  emits("allDelete");
}

async function dialogEnter() {
  isDeleting.value = false;
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :confirm-loading="isDeleting"
    :keyboard="!isDeleting"
    :mask-closable="!isDeleting"
    :ok-text="t('common.dialog.ok')"
    ok-type="danger"
    :title="t('common.dialog.title.confirmAction')"
    :width="300"
    @ok="confirmDelete"
  >
    {{ t("common.dialog.deleteText", [toDeleteIds!.length]) }}
    <slot name="append-text" />
  </a-modal>
</template>
