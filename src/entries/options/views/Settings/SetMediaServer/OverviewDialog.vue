<script setup lang="ts">
import { ReloadOutlined, WarningOutlined } from "@ant-design/icons-vue";
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { formatBitrate, type IMediaServerOverview, type IMediaServerOverviewEntry } from "@ptd/mediaServer";
import { formatDate, formatSize } from "@/options/utils.ts";
import { sendMessage } from "@/messages.ts";
import type { TMediaServerKey } from "@/shared/types.ts";

const { t } = useI18n();

const showDialog = defineModel<boolean>();
const { mediaServerId, mediaServerName } = defineProps<{
  mediaServerId: TMediaServerKey;
  mediaServerName?: string;
}>();

const overview = ref<IMediaServerOverview | null>(null);
const isLoading = ref<boolean>(false);
const errorMessage = ref<string>("");
/** 整库遍历有被封号的风险，必须先由用户显式确认（每次打开都要确认） */
const confirmed = ref<boolean>(false);
/** 关闭弹窗 / 换一台服务器后，丢弃上一轮迟到的结果 */
let generateToken = 0;

/**
 * 调研 C14 / C20：**默认不获取** —— 打开弹窗先给出风险提示，用户确认后才开始。
 * 整库遍历与聚合都在 offscreen 侧完成（几千条条目不会跨消息边界搬过来）。
 */
async function generate() {
  const token = ++generateToken;
  isLoading.value = true;
  errorMessage.value = "";
  try {
    const result = await sendMessage("getMediaServerOverview", { mediaServerId });
    if (token !== generateToken) return;
    overview.value = result;
    if (!result) {
      errorMessage.value = t("SetMediaServer.Overview.unsupported");
    }
  } catch (e) {
    if (token !== generateToken) return;
    errorMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (token === generateToken) isLoading.value = false;
  }
}

function confirmAndGenerate() {
  confirmed.value = true;
  void generate();
}

watch(showDialog, (opened) => {
  // 每次打开都重新走一遍风险提示：整库遍历是高风险操作，不做「不再提示」
  generateToken++;
  overview.value = null;
  errorMessage.value = "";
  isLoading.value = false;
  if (opened) confirmed.value = false;
});

/** 分布条按总体积归一化（每组至少留 2%，避免小项完全看不见） */
function barPercent(entry: IMediaServerOverviewEntry): number {
  const total = Math.max(1, overview.value?.totalSize ?? 1);
  return Math.max(2, Math.round((entry.size / total) * 100));
}

const keyLabel = (key: string) => (key === "-" ? t("SetMediaServer.Overview.unknownKey") : key);

const distributionKeys = ["byResolution", "byCodec", "byContainer", "byRootPath"] as const;
</script>

<template>
  <a-modal v-model:open="showDialog" :footer="null" :width="900">
    <template #title>
      <a-flex align="center" :gap="8" style="padding-right: 24px">
        <span>{{ t("SetMediaServer.Overview.title") }}</span>
        <a-typography-text v-if="mediaServerName" type="secondary">· {{ mediaServerName }}</a-typography-text>
        <div style="flex: 1 1 auto"></div>
        <a-tooltip v-if="confirmed" :title="t('SetMediaServer.Overview.regenerate')">
          <a-button :disabled="isLoading" size="small" type="text" @click="generate">
            <template #icon><ReloadOutlined /></template>
          </a-button>
        </a-tooltip>
      </a-flex>
    </template>

    <!-- 风险提示：绝大多数公开媒体服务器不允许整库遍历，必须先确认 -->
    <template v-if="!confirmed">
      <a-alert show-icon type="warning">
        <template #message>
          <a-typography-text strong>{{ t("SetMediaServer.Overview.warningTitle") }}</a-typography-text>
        </template>
        <template #description>
          <a-typography-paragraph style="margin: 8px 0 0">
            {{ t("SetMediaServer.Overview.warningLine1") }}
          </a-typography-paragraph>
          <a-typography-paragraph style="margin: 8px 0 0">
            {{ t("SetMediaServer.Overview.warningLine2") }}
          </a-typography-paragraph>
          <a-typography-paragraph type="secondary" style="margin: 8px 0 0">
            {{ t("SetMediaServer.Overview.warningLine3") }}
          </a-typography-paragraph>
        </template>
      </a-alert>

      <a-flex justify="end" :gap="8" style="margin-top: 16px">
        <a-button @click="showDialog = false">{{ t("SetMediaServer.Overview.warningCancel") }}</a-button>
        <a-button danger type="primary" @click="confirmAndGenerate">
          <template #icon><WarningOutlined /></template>
          {{ t("SetMediaServer.Overview.warningConfirm") }}
        </a-button>
      </a-flex>
    </template>

    <a-flex v-else-if="isLoading" align="center" vertical style="padding: 32px 0">
      <a-spin size="large" />
      <a-typography-text style="margin-top: 16px">{{ t("SetMediaServer.Overview.generating") }}</a-typography-text>
      <a-typography-text type="secondary" style="margin-top: 4px; font-size: 12px">
        {{ t("SetMediaServer.Overview.hint") }}
      </a-typography-text>
    </a-flex>

    <a-alert v-else-if="errorMessage" :message="errorMessage" show-icon type="warning" />

    <template v-else-if="overview">
      <a-alert
        v-if="overview.truncated"
        :message="t('SetMediaServer.Overview.truncated', { count: overview.totalItems })"
        show-icon
        style="margin-bottom: 12px"
        type="info"
      />

      <!-- 概览数字（C20） -->
      <a-row :gutter="[8, 8]">
        <a-col
          v-for="stat in [
            { key: 'totalItems', value: String(overview.totalItems) },
            { key: 'totalSize', value: formatSize(overview.totalSize) },
            { key: 'averageBitrate', value: formatBitrate(overview.averageBitrate) ?? '-' },
            {
              key: 'playsPerGb',
              value:
                overview.playsPerGb === undefined
                  ? '-'
                  : t('SetMediaServer.Overview.playsPerGbValue', { value: overview.playsPerGb }),
            },
          ]"
          :key="stat.key"
          :sm="6"
          :span="12"
        >
          <a-card size="small" style="text-align: center">
            <a-typography-title :level="4" style="margin: 0">{{ stat.value }}</a-typography-title>
            <a-typography-text type="secondary" style="font-size: 12px">
              {{ t(`SetMediaServer.Overview.${stat.key}`) }}
            </a-typography-text>
          </a-card>
        </a-col>
      </a-row>

      <!-- 观看情况（C14 / C20） -->
      <a-typography-title :level="5" style="margin: 16px 0 4px">{{
        t("SetMediaServer.Overview.watch")
      }}</a-typography-title>
      <a-space wrap :size="4">
        <a-tag color="success">{{ t("SetMediaServer.Overview.watched") }} {{ overview.watch.watched }}</a-tag>
        <a-tag color="warning">{{ t("SetMediaServer.Overview.partial") }} {{ overview.watch.partial }}</a-tag>
        <a-tag>{{ t("SetMediaServer.Overview.unwatched") }} {{ overview.watch.unwatched }}</a-tag>
        <a-tag color="processing">{{ t("SetMediaServer.Overview.totalPlays") }} {{ overview.watch.totalPlays }}</a-tag>
      </a-space>

      <!-- 分布（C20） -->
      <template v-for="distKey in distributionKeys" :key="distKey">
        <div v-if="overview[distKey].length > 0" style="margin-top: 16px">
          <a-typography-title :level="5" style="margin: 0 0 4px">
            {{ t(`SetMediaServer.Overview.${distKey}`) }}
          </a-typography-title>
          <div v-for="entry in overview[distKey]" :key="entry.key" style="margin-bottom: 4px">
            <a-flex class="info-label" justify="space-between" :gap="8">
              <span style="min-width: 0; overflow-wrap: anywhere">{{ keyLabel(entry.key) }}</span>
              <span style="flex: 0 0 auto">
                {{ t("SetMediaServer.Overview.countUnit", { count: entry.count }) }} · {{ formatSize(entry.size) }}
              </span>
            </a-flex>
            <a-progress :percent="barPercent(entry)" :show-info="false" size="small" style="margin: 0" />
          </div>
        </div>
      </template>

      <!-- 占空间但从未观看（C14） -->
      <template v-if="overview.neverWatched.length > 0">
        <a-typography-title :level="5" style="margin: 16px 0 4px">
          {{ t("SetMediaServer.Overview.neverWatched") }}
        </a-typography-title>
        <a-list :data-source="overview.neverWatched" size="small">
          <template #renderItem="{ item: entry }">
            <a-list-item>
              <span style="min-width: 0; overflow-wrap: anywhere">{{ entry.name }}</span>
              <template #extra>
                <span style="white-space: nowrap">
                  <a-typography-text v-if="entry.productionYear" type="secondary" style="margin-right: 8px">
                    {{ entry.productionYear }}
                  </a-typography-text>
                  {{ formatSize(entry.size) }}
                </span>
              </template>
            </a-list-item>
          </template>
        </a-list>
      </template>

      <!-- 最近 7 天入库（C20） -->
      <template v-if="overview.recentlyAdded.length > 0">
        <a-typography-title :level="5" style="margin: 16px 0 4px">
          {{ t("SetMediaServer.Overview.recentlyAdded") }}
        </a-typography-title>
        <a-list :data-source="overview.recentlyAdded" size="small">
          <template #renderItem="{ item: entry }">
            <a-list-item>
              <span style="min-width: 0; overflow-wrap: anywhere">{{ entry.name }}</span>
              <template #extra>
                <a-typography-text type="secondary" style="white-space: nowrap">
                  {{ entry.dateCreated ? formatDate(new Date(entry.dateCreated).getTime()) : "-" }}
                </a-typography-text>
              </template>
            </a-list-item>
          </template>
        </a-list>
      </template>

      <a-typography-text type="secondary" style="display: block; margin-top: 16px; font-size: 12px">
        {{ t("SetMediaServer.Overview.generatedAt", { time: formatDate(overview.generatedAt) }) }}
      </a-typography-text>
    </template>
  </a-modal>
</template>
