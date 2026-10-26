<script setup lang="ts">
import {
  ArrowsAltOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  ExportOutlined,
  FileTextOutlined,
  HddOutlined,
  HeartFilled,
  HeartOutlined,
  PlayCircleOutlined,
  SelectOutlined,
  SoundOutlined,
  StarFilled,
  TagsOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons-vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import type { IMediaServerItem } from "@ptd/mediaServer";
import { formatDate, formatSize } from "@/options/utils.ts";
import { sendMessage } from "@/messages.ts";

import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import PlayedStateIcon from "./PlayedStateIcon.vue";
import { audioText, getSiteSearchKeyword, socialIcon, videoDetailText } from "./itemDisplay.ts";

const { t } = useI18n();
const router = useRouter();

const showDialog = defineModel<boolean>();
const { item } = defineProps<{
  item: IMediaServerItem;
}>();

/**
 * 调研 B12：列表接口只请求轻量字段，演职人员等重字段在弹窗打开时**按需二次拉取**。
 * 拉不到（服务器不支持 / 请求失败）时静默降级，只展示列表已有的信息。
 */
const detail = ref<IMediaServerItem | null>(null);
const isLoadingDetail = ref<boolean>(false);
/** 关闭后快速打开另一条时，丢弃上一条迟到的详情响应 */
let detailToken = 0;

async function loadDetail() {
  const token = ++detailToken;
  detail.value = null;
  if (!item?.id) {
    isLoadingDetail.value = false;
    return;
  }

  isLoadingDetail.value = true;
  try {
    const result = await sendMessage("getMediaServerItemDetail", { mediaServerId: item.server, itemId: item.id });
    if (token === detailToken) detail.value = result;
  } catch {
    if (token === detailToken) detail.value = null;
  } finally {
    if (token === detailToken) isLoadingDetail.value = false;
  }
}

watch(
  [showDialog, () => item],
  ([opened]) => {
    if (opened) {
      void loadDetail();
    } else {
      detailToken++;
      detail.value = null;
      isLoadingDetail.value = false;
    }
  },
  { immediate: true },
);

/**
 * 详情拉取成功就用详情覆盖，否则退回列表里那条。
 * 详情接口不再搬一份海报（data URL 很大），沿用列表条目的海报。
 */
const richItem = computed<IMediaServerItem>(() =>
  detail.value ? { ...detail.value, poster: detail.value.poster || item.poster } : item,
);

/** 调研 B7：用外部标识（imdb / tmdb）一键跳到站点搜索页 */
function searchOnSite(field: "imdb" | "tmdb") {
  const search = getSiteSearchKeyword(richItem.value, field);
  if (!search) return;

  showDialog.value = false;
  // 加 nonce：同一关键词再次搜索时 query 完全相同会被 vue-router 判成重复导航（见 Topbar.vue 的 D2-Medium-02）
  void router.push({ name: "SearchEntity", query: { search, flush: 1, t: Date.now() } });
}

const videoText = computed(() => videoDetailText(richItem.value));

const hasMediaInfo = computed(
  () =>
    !!richItem.value.format ||
    !!videoText.value ||
    !!richItem.value.mediaInfo?.audio?.length ||
    !!richItem.value.mediaInfo?.subtitle?.length,
);

/** 观看深度（调研 A6）：次数 · 进度 · 最近观看 */
const watchText = computed(() => {
  const parts: string[] = [];
  if (richItem.value.user?.playCount) {
    parts.push(t("MediaServerEntity.ItemInformationDialog.playCountText", { count: richItem.value.user.playCount }));
  }
  if (typeof richItem.value.user?.playedPercentage === "number") {
    parts.push(`${richItem.value.user.playedPercentage}%`);
  }
  if (richItem.value.user?.lastPlayedDate) {
    parts.push(formatDate(new Date(richItem.value.user.lastPlayedDate).getTime()));
  }
  return parts.join(" · ");
});

/** 进度图标与收藏图标的悬停说明 */
const playedTitle = computed(() => watchText.value || t("MediaServerEntity.ItemInformationDialog.notWatched"));
const favoriteTitle = computed(() =>
  richItem.value.user?.IsFavorite
    ? t("MediaServerEntity.ItemInformationDialog.favorite")
    : t("MediaServerEntity.ItemInformationDialog.notFavorite"),
);

/** 剧集信息（调研 B10）：剧集名 · S01 · E05 · 共 N 集 */
const seriesInfoText = computed(() =>
  [
    richItem.value.seriesName,
    typeof richItem.value.parentIndexNumber === "number"
      ? `S${String(richItem.value.parentIndexNumber).padStart(2, "0")}`
      : undefined,
    typeof richItem.value.indexNumber === "number"
      ? `E${String(richItem.value.indexNumber).padStart(2, "0")}`
      : undefined,
    richItem.value.recursiveItemCount || richItem.value.childCount
      ? t("MediaServerEntity.ItemInformationDialog.episodeCount", {
          count: richItem.value.recursiveItemCount ?? richItem.value.childCount,
        })
      : undefined,
  ]
    .filter(Boolean)
    .join(" · "),
);

function secondsToISO8601(seconds: number) {
  seconds = Math.abs(seconds);

  let hours = Math.floor(seconds / 3600);
  seconds %= 3600;

  let minutes = Math.floor(seconds / 60);
  seconds = Math.floor(seconds % 60); // 取整秒数

  let duration = "P";

  // 仅在有天数时添加
  if (hours >= 24) {
    let days = Math.floor(hours / 24);
    duration += `${days}D`;
    hours %= 24;
  }

  // 如果有小时、分钟或秒，添加T分隔符
  if (hours > 0 || minutes > 0 || seconds > 0) {
    duration += "T";

    if (hours > 0) duration += `${hours}H`;
    if (minutes > 0) duration += `${minutes}M`;
    if (seconds > 0) duration += `${seconds}S`;
  }

  return duration;
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :footer="null"
    :title="t('MediaServerEntity.ItemInformationDialog.title')"
    :width="800"
  >
    <a-row align="middle" :gutter="8">
      <a-col :span="16" :offset="4" :sm="{ span: 8, offset: 0 }">
        <a-image :src="richItem.poster" :title="richItem.name" :preview="false"></a-image>

        <!-- 站点搜索（拿外部标识去站点搜索页）与外部链接（打开服务器给出的页面）都是「动作」，放在海报下方更容易识别 -->
        <div style="margin-top: 12px; text-align: center">
          <template v-if="richItem.providerIds?.imdb || richItem.providerIds?.tmdb">
            <div class="info-label" style="margin-bottom: 4px">
              {{ t("MediaServerEntity.ItemInformationDialog.searchOnSite") }}
            </div>
            <a-flex vertical :gap="4">
              <template v-for="field in ['imdb', 'tmdb'] as const" :key="field">
                <a-button v-if="richItem.providerIds?.[field]" block @click="searchOnSite(field)">
                  <a-avatar
                    :size="16"
                    :src="`/icons/social/${field}.png`"
                    shape="square"
                    style="margin-right: 6px; vertical-align: -3px"
                  />
                  {{ richItem.providerIds[field] }}
                </a-button>
              </template>
            </a-flex>
          </template>
          <template v-if="richItem.externalUrls?.length">
            <div class="info-label" style="margin: 8px 0 4px">
              {{ t("MediaServerEntity.ItemInformationDialog.externalUrls") }}
            </div>
            <a-flex vertical :gap="4">
              <a-button
                v-for="externalUrl in richItem.externalUrls"
                :key="externalUrl.url"
                :href="externalUrl.url"
                block
                rel="noopener noreferrer nofollow"
                target="_blank"
              >
                <a-avatar
                  v-if="socialIcon(externalUrl.name)"
                  :size="16"
                  :src="socialIcon(externalUrl.name)"
                  shape="square"
                  style="margin-right: 6px; vertical-align: -3px"
                />
                {{ externalUrl.name }}
                <ExportOutlined />
              </a-button>
            </a-flex>
          </template>
        </div>
      </a-col>
      <a-col :span="24" :sm="16">
        <a-typography-link
          :href="richItem.url"
          :title="richItem.name"
          rel="noopener noreferrer nofollow"
          target="_blank"
          style="display: inline-block; width: 100%; font-size: 24px"
        >
          {{ richItem.name }}
        </a-typography-link>
        <p style="font-size: 12px">{{ richItem.description ?? "" }}</p>
        <div v-if="richItem.tags && richItem.tags.length > 0" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.type")
          }}</a-typography-text>
          <a-space wrap>
            <!-- M-24：antd 4.2.6 的 a-tag 没有 href 属性（渲染成 <span href>，点不动），链接必须包一层 <a>；
                 无链接（Plex / fnOS 传空串）时只渲染标签，不留无效的 href="" -->
            <template v-for="tag in richItem.tags ?? []" :key="tag.name">
              <a v-if="tag.url" :href="tag.url" rel="noopener noreferrer nofollow" target="_blank">
                <a-tag color="#ff9800" style="margin-right: 4px; cursor: pointer"
                  ><TagsOutlined style="margin-right: 4px" />{{ tag.name }}</a-tag
                >
              </a>
              <a-tag v-else color="#ff9800" style="margin-right: 4px"
                ><TagsOutlined style="margin-right: 4px" />{{ tag.name }}</a-tag
              >
            </template>
          </a-space>
        </div>
        <div v-if="richItem.duration" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.duration")
          }}</a-typography-text>
          <a-tag style="margin-right: 4px" color="#4caf50"
            ><ClockCircleOutlined style="margin-right: 4px" />
            {{ secondsToISO8601(richItem.duration ?? 0) }}
          </a-tag>
        </div>
        <div v-if="richItem.size" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.size")
          }}</a-typography-text>
          <a-tag style="margin-right: 4px" color="#673ab7"
            ><HddOutlined style="margin-right: 4px" />
            {{ formatSize(richItem.size ?? 0) }}
          </a-tag>
        </div>
        <!-- 评分（调研 A1） -->
        <div v-if="typeof richItem.rating === 'number'" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.rating")
          }}</a-typography-text>
          <a-tag color="#ffc107"><StarFilled style="margin-right: 4px" />{{ richItem.rating.toFixed(1) }}</a-tag>
        </div>
        <template v-if="hasMediaInfo">
          <!-- 画质（调研 A2） -->
          <div v-if="richItem.format || videoText" class="info-label">
            <a-typography-text style="padding-right: 12px">{{
              t("MediaServerEntity.ItemInformationDialog.video")
            }}</a-typography-text>
            <a-space wrap :size="4">
              <a-tag v-if="richItem.format" color="#2196f3"
                ><ArrowsAltOutlined style="margin-right: 4px" />{{ richItem.format.toUpperCase() }}</a-tag
              >
              <a-tag v-if="videoText" color="#2196f3"
                ><VideoCameraOutlined style="margin-right: 4px" />{{ videoText }}</a-tag
              >
            </a-space>
          </div>
          <!-- 音轨（调研 A2） -->
          <div v-if="richItem.mediaInfo?.audio?.length" class="info-label">
            <a-typography-text style="padding-right: 12px; white-space: nowrap">
              {{ t("MediaServerEntity.ItemInformationDialog.audio") }} ({{ richItem.mediaInfo.audio.length }})
            </a-typography-text>
            <a-space wrap :size="4">
              <a-tag v-for="(audio, idx) in richItem.mediaInfo.audio" :key="idx" color="#009688"
                ><SoundOutlined style="margin-right: 4px" />{{ audioText(audio) }}</a-tag
              >
            </a-space>
          </div>
          <!-- 字幕（调研 A2） -->
          <div v-if="richItem.mediaInfo?.subtitle?.length" class="info-label">
            <a-typography-text style="padding-right: 12px; white-space: nowrap">
              {{ t("MediaServerEntity.ItemInformationDialog.subtitle") }} ({{ richItem.mediaInfo.subtitle.length }})
            </a-typography-text>
            <a-space wrap :size="4">
              <a-tag v-for="(subtitle, idx) in richItem.mediaInfo.subtitle" :key="idx" color="#3f51b5"
                ><FileTextOutlined style="margin-right: 4px" />{{
                  [
                    subtitle.language,
                    subtitle.codec,
                    subtitle.isExternal ? t("MediaServerEntity.external") : t("MediaServerEntity.embedded"),
                  ]
                    .filter(Boolean)
                    .join(" · ")
                }}</a-tag
              >
            </a-space>
          </div>
        </template>
        <!-- 部分媒体服务器（如 Plex 的搜索结果）不返回流信息，此处给出空状态占位而不是让整块信息消失 -->
        <div v-else class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.mediaInfo")
          }}</a-typography-text>
          <NoDataPlaceholder compact />
        </div>
        <!-- 观看深度（调研 A6）：次数 · 进度 · 最近观看 -->
        <div v-if="watchText" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.watched")
          }}</a-typography-text>
          <a-tag color="#4caf50"><PlayCircleOutlined style="margin-right: 4px" />{{ watchText }}</a-tag>
        </div>
        <!-- 文件路径（调研 A3）：路径很长且不含空格，按字符换行，避免撑破容器 -->
        <a-flex v-if="richItem.path" class="info-label">
          <a-typography-text style="padding-right: 12px; flex: 0 0 auto; white-space: nowrap">{{
            t("MediaServerEntity.ItemInformationDialog.path")
          }}</a-typography-text>
          <a-typography-text
            type="secondary"
            style="flex: 1 1 auto; min-width: 0; word-break: break-all; overflow-wrap: anywhere"
          >
            {{ richItem.path }}
          </a-typography-text>
        </a-flex>
        <!-- 入库时间（调研 A4） -->
        <div v-if="richItem.dateCreated" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.dateCreated")
          }}</a-typography-text>
          <a-tag color="#607d8b"
            ><CalendarOutlined style="margin-right: 4px" />{{
              formatDate(new Date(richItem.dateCreated).getTime())
            }}</a-tag
          >
        </div>
        <!-- 年份 / 首播 / 分级 / 影评人评分（调研 B8） -->
        <div v-if="richItem.productionYear" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.year")
          }}</a-typography-text>
          <a-tag color="#607d8b">{{ richItem.productionYear }}</a-tag>
        </div>
        <div v-if="richItem.premiereDate" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.premiereDate")
          }}</a-typography-text>
          <a-tag color="#607d8b">{{ richItem.premiereDate.slice(0, 10) }}</a-tag>
        </div>
        <div v-if="richItem.officialRating || richItem.criticRating" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.officialRating")
          }}</a-typography-text>
          <a-tag v-if="richItem.officialRating" color="#ff9800">{{ richItem.officialRating }}</a-tag>
          <a-tag v-if="richItem.criticRating" color="#ffc107">
            {{ t("MediaServerEntity.ItemInformationDialog.criticRating") }} {{ richItem.criticRating.toFixed(1) }}
          </a-tag>
        </div>
        <!-- 剧集信息（调研 B10） -->
        <div v-if="seriesInfoText" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.series")
          }}</a-typography-text>
          <a-typography-text type="secondary">{{ seriesInfoText }}</a-typography-text>
        </div>
        <!-- 同片多版本 / 制片公司 / 自定义标签 / 宣传语（调研 B9 / B8 / B12） -->
        <div v-if="(richItem.mediaSourceCount ?? 0) > 1" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.mediaSourceCount")
          }}</a-typography-text>
          <a-tag color="purple">{{ t("MediaServerEntity.versions", { count: richItem.mediaSourceCount }) }}</a-tag>
        </div>
        <div v-if="richItem.studios?.length" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.studios")
          }}</a-typography-text>
          <a-typography-text type="secondary">{{ richItem.studios.join(" / ") }}</a-typography-text>
        </div>
        <div v-if="richItem.labels?.length" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.labels")
          }}</a-typography-text>
          <a-space wrap :size="4">
            <a-tag v-for="label in richItem.labels" :key="label" color="cyan">{{ label }}</a-tag>
          </a-space>
        </div>
        <div v-if="richItem.taglines?.length" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.taglines")
          }}</a-typography-text>
          <a-typography-text italic type="secondary">{{ richItem.taglines.join(" / ") }}</a-typography-text>
        </div>
        <!-- 演职人员（调研 B12，二次拉取才有） -->
        <div v-if="isLoadingDetail" class="info-label">
          <a-spin size="small" />
          <a-typography-text type="secondary" style="margin-left: 8px">
            {{ t("MediaServerEntity.ItemInformationDialog.loadingDetail") }}
          </a-typography-text>
        </div>
        <div v-else-if="richItem.people?.length" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.people")
          }}</a-typography-text>
          <a-space wrap :size="4">
            <a-popover
              v-for="person in richItem.people"
              :key="person.name + (person.role ?? '')"
              placement="top"
              trigger="hover"
            >
              <template #content>
                <a-flex align="center" vertical>
                  <a-image
                    v-if="person.imageUrl"
                    :height="213"
                    :preview="false"
                    :src="person.imageUrl"
                    :width="160"
                    style="object-fit: cover; border-radius: 4px"
                  />
                  <a-typography-text>{{ person.name }}</a-typography-text>
                  <a-typography-text v-if="person.role" type="secondary" style="font-size: 12px">
                    {{ person.role }}
                  </a-typography-text>
                </a-flex>
              </template>
              <!-- a-tag 没有 href（见上方 M-24），有演员页时包一层 <a> -->
              <a v-if="person.url" :href="person.url" rel="noopener noreferrer nofollow" target="_blank">
                <a-tag style="cursor: pointer"
                  >{{ person.name }}<template v-if="person.role"> · {{ person.role }}</template></a-tag
                >
              </a>
              <a-tag v-else
                >{{ person.name }}<template v-if="person.role"> · {{ person.role }}</template></a-tag
              >
            </a-popover>
          </a-space>
        </div>
        <a-divider style="margin: 8px 0" />

        <a-flex align="center" style="width: 100%">
          <a-tooltip :title="playedTitle">
            <span style="display: inline-flex">
              <PlayedStateIcon
                :is-played="richItem.user?.IsPlayed"
                :percent="richItem.user?.playedPercentage"
                :size="36"
              />
            </span>
          </a-tooltip>
          <a-tooltip :title="favoriteTitle">
            <component
              :is="richItem.user?.IsFavorite ? HeartFilled : HeartOutlined"
              class="ptd-icon-lg"
              style="color: var(--ptd-danger); margin-left: 8px"
            />
          </a-tooltip>
          <div style="flex: 1 1 auto"></div>
          <a-button :href="richItem.url" rel="noopener noreferrer nofollow" target="_blank">
            <template #icon><SelectOutlined /></template>
            {{ t("common.visit") }}
          </a-button>
        </a-flex>
      </a-col>
    </a-row>
  </a-modal>
</template>
