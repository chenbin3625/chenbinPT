<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import type { TUserInfoStorageSchema } from "@/shared/types.ts";
import { sendMessage } from "@/messages.ts";

/**
 * 插件重置 / 清空数据。
 *
 * 原 `views/Devtools/Debugger.vue`（已随迁移删除）中的 7 项重置操作在此恢复，
 * 处理函数仍复用 messages.ts 中现成的消息名（setExtStorage / clearDownloadHistory /
 * clearSiteFaviconCache / clearSocialInformationCache），未新增任何后台消息。
 * 每一步都必须经过二次确认，避免误触导致数据不可恢复。
 */
const { t } = useI18n();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

interface IResetItem {
  key: string;
  title: string;
  subTitle: string;
  action: () => Promise<void>;
}

const clearSiteTarget = ref<string>("all");
const siteItems = computed(() => [
  { label: t("SetBase.reset.clearSiteDataAll"), value: "all" },
  ...Object.keys(metadataStore.lastUserInfo ?? {}).map((siteId) => ({
    label: metadataStore.siteNameMap?.[siteId] ?? siteId,
    value: siteId,
  })),
]);

const resetItems = computed<IResetItem[]>(() => [
  {
    key: "resetSystemSettings",
    title: t("SetBase.reset.resetSystemSettings"),
    subTitle: t("SetBase.reset.resetSystemSettingsDesc"),
    action: async () => {
      configStore.$reset();
      await configStore.$save();
    },
  },
  {
    key: "clearUserConfig",
    title: t("SetBase.reset.clearUserConfig"),
    subTitle: t("SetBase.reset.clearUserConfigDesc"),
    action: async () => {
      metadataStore.$reset();
      await metadataStore.$save();
    },
  },
  {
    key: "clearSiteData",
    title: t("SetBase.reset.clearSiteData"),
    subTitle: t("SetBase.reset.clearSiteDataDesc"),
    action: async () => {
      if (clearSiteTarget.value === "all") {
        // 清空所有站点数据
        metadataStore.lastUserInfo = {};
        await sendMessage("setExtStorage", { key: "userInfo", value: {} });
      } else {
        // 清空指定站点数据
        const siteId = clearSiteTarget.value;
        if (metadataStore.lastUserInfo[siteId]) {
          delete metadataStore.lastUserInfo[siteId];
        }
        const userInfo = ((await sendMessage("getExtStorage", "userInfo")) ?? {}) as TUserInfoStorageSchema;
        if (Object.hasOwn(userInfo, siteId)) {
          delete userInfo[siteId];
          await sendMessage("setExtStorage", { key: "userInfo", value: userInfo });
        }
      }
      await metadataStore.$save();
    },
  },
  {
    key: "clearDownloadHistory",
    title: t("SetBase.reset.clearDownloadHistory"),
    subTitle: t("SetBase.reset.clearDownloadHistoryDesc"),
    action: async () => {
      await sendMessage("clearDownloadHistory", undefined);
    },
  },
  {
    key: "clearFaviconCache",
    title: t("SetBase.reset.clearFaviconCache"),
    subTitle: t("SetBase.reset.clearFaviconCacheDesc"),
    action: async () => {
      await sendMessage("clearSiteFaviconCache", undefined);
    },
  },
  {
    key: "clearMediaCache",
    title: t("SetBase.reset.clearMediaCache"),
    subTitle: t("SetBase.reset.clearMediaCacheDesc"),
    action: async () => {
      await sendMessage("clearSocialInformationCache", undefined);
    },
  },
  {
    key: "clearSearchSnapshot",
    title: t("SetBase.reset.clearSearchSnapshot"),
    subTitle: t("SetBase.reset.clearSearchSnapshotDesc"),
    action: async () => {
      metadataStore.snapshots = {};
      await metadataStore.$save();
      await sendMessage("setExtStorage", { key: "searchResultSnapshot", value: {} });
    },
  },
]);

const pendingItem = ref<IResetItem | null>(null);
const showConfirm = ref<boolean>(false);
const isResetting = ref<boolean>(false);

function askReset(item: IResetItem) {
  pendingItem.value = item;
  showConfirm.value = true;
}

function cancelReset() {
  if (isResetting.value) return; // 执行中不允许取消
  showConfirm.value = false;
  pendingItem.value = null;
}

async function confirmReset() {
  if (!pendingItem.value || isResetting.value) return;
  isResetting.value = true;
  try {
    await pendingItem.value.action();
    runtimeStore.showSnakebar(t("SetBase.reset.resetSuccess"), { color: "success" });
    showConfirm.value = false;
    pendingItem.value = null;
  } finally {
    isResetting.value = false;
  }
}
</script>

<template>
  <div class="ptd-settings-grid">
    <a-alert type="warning" show-icon>
      <template #message>
        <strong style="display: block">{{ t("SetBase.reset.title") }}</strong>
        <div>{{ t("SetBase.reset.warning") }}</div>
      </template>
    </a-alert>

    <a-list>
      <a-list-item v-for="item in resetItems" :key="item.key" class="ptd-list-item">
        <a-list-item-meta>
          <template #title>{{ item.title }}</template>
          <template #description>{{ item.subTitle }}</template>
        </a-list-item-meta>
        <a-flex align="center" :gap="16">
          <template v-if="item.key === 'clearSiteData'">
            <a-typography-text>{{ t("SetBase.reset.clearSiteDataTarget") }}</a-typography-text>
            <a-select v-model:value="clearSiteTarget" :options="siteItems" style="width: 160px" />
          </template>
          <a-button danger @click="askReset(item)">
            {{ t("SetBase.reset.resetButton") }}
          </a-button>
        </a-flex>
      </a-list-item>
    </a-list>
  </div>

  <a-modal
    v-model:open="showConfirm"
    :cancel-button-props="{ disabled: isResetting }"
    :cancel-text="t('common.dialog.cancel')"
    :confirm-loading="isResetting"
    :keyboard="!isResetting"
    :mask-closable="!isResetting"
    :ok-text="t('SetBase.reset.confirmOk')"
    :title="t('SetBase.reset.confirmTitle')"
    :width="420"
    ok-type="danger"
    @cancel="cancelReset"
    @ok="confirmReset"
  >
    {{ t("SetBase.reset.confirmText", [pendingItem?.title ?? ""]) }}
  </a-modal>
</template>
