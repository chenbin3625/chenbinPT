<script setup lang="ts">
import {
  ArrowsAltOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  HddOutlined,
  HeartFilled,
  HeartOutlined,
  MinusCircleOutlined,
  SelectOutlined,
  TagsOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons-vue";
import { computed, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { IMediaServerItem } from "@ptd/mediaServer";
import { formatSize } from "@/options/utils.ts";

import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

const { t } = useI18n();

const showDialog = defineModel<boolean>();
const { item } = defineProps<{
  item: IMediaServerItem;
}>();

function streamsTextFactory(type: "Video" | "Audio" | "Subtitle") {
  return computed(() =>
    (item.streams ?? [])
      .filter((s) => s.type === type)
      .map((x) => x.title)
      .join(" / "),
  );
}

const showSteams: Array<{ name: "Audio" | "Subtitle"; icon: Component }> = [
  { name: "Audio", icon: HddOutlined },
  { name: "Subtitle", icon: FileTextOutlined },
];

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
        <a-image :src="item.poster" :title="item.name" :preview="false"></a-image>
      </a-col>
      <a-col :span="24" :sm="16">
        <a-typography-link
          :href="item.url"
          :title="item.name"
          rel="noopener noreferrer nofollow"
          target="_blank"
          style="display: inline-block; width: 100%; font-size: 24px"
        >
          {{ item.name }}
        </a-typography-link>
        <p style="font-size: 12px">{{ item.description ?? "" }}</p>
        <div v-if="item.tags && item.tags.length > 0" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.type")
          }}</a-typography-text>
          <a-space wrap>
            <a-tag
              v-for="tag in item.tags ?? []"
              :key="tag.name"
              :href="tag.url ?? (false as unknown as undefined)"
              :target="tag.url ? '_blank' : undefined"
              style="margin-right: 4px"
              rel="noopener noreferrer nofollow"
              color="#ff9800"
              ><TagsOutlined style="margin-right: 4px" />
              {{ tag.name }}
            </a-tag>
          </a-space>
        </div>
        <div v-if="item.duration" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.duration")
          }}</a-typography-text>
          <a-tag style="margin-right: 4px" color="#4caf50"
            ><ClockCircleOutlined style="margin-right: 4px" />
            {{ secondsToISO8601(item.duration ?? 0) }}
          </a-tag>
        </div>
        <div v-if="item.size" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.size")
          }}</a-typography-text>
          <a-tag style="margin-right: 4px" color="#673ab7"
            ><HddOutlined style="margin-right: 4px" />
            {{ formatSize(item.size ?? 0) }}
          </a-tag>
        </div>
        <div v-if="item.streams && item.streams.length > 0" class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.mediaInfo")
          }}</a-typography-text>
          <a-space wrap>
            <a-tag v-if="item.format" color="#2196f3"
              ><ArrowsAltOutlined style="margin-right: 4px" />
              {{ item.format?.toUpperCase() }}
            </a-tag>

            <a-tag v-if="item.streams.filter((s) => s.type === 'Video')!.length > 0" color="#2196f3"
              ><VideoCameraOutlined style="margin-right: 4px" />
              {{ item.streams.filter((s) => s.type === "Video")[0].title }}
            </a-tag>

            <template v-for="showStream in showSteams" :key="showStream.name">
              <a-popover v-if="item.streams.filter((s) => s.type === showStream.name)!.length > 0" trigger="hover">
                <template #content>
                  <a-card style="padding-left: 8px">
                    <a-space direction="vertical">
                      <a-tag
                        v-for="stream in item.streams.filter((s) => s.type === showStream.name)"
                        :key="stream.title"
                        ><component :is="showStream.icon" style="margin-right: 4px" />
                        {{ stream.title }}
                      </a-tag>
                    </a-space>
                  </a-card>
                </template>
                <a-tag color="#2196f3"
                  ><component :is="showStream.icon" style="margin-right: 4px" />
                  {{ item.streams.filter((s) => s.type === showStream.name)!.length }}
                </a-tag>
              </a-popover>
            </template>
          </a-space>
        </div>
        <!-- 部分媒体服务器（如 Plex 的搜索结果）不返回 streams，此处给出空状态占位而不是让整块信息消失 -->
        <div v-else class="info-label">
          <a-typography-text style="padding-right: 12px">{{
            t("MediaServerEntity.ItemInformationDialog.mediaInfo")
          }}</a-typography-text>
          <NoDataPlaceholder compact />
        </div>
        <a-divider style="margin: 8px 0" />

        <a-flex align="center" style="width: 100%">
          <component
            :is="item.user?.IsPlayed ? CheckOutlined : MinusCircleOutlined"
            class="ptd-icon-lg"
            style="color: var(--ptd-success)"
          />
          <component
            :is="item.user?.IsFavorite ? HeartFilled : HeartOutlined"
            class="ptd-icon-lg"
            style="color: var(--ptd-danger)"
          />
          <div style="flex: 1 1 auto"></div>
          <a-button :href="item.url" rel="noopener noreferrer nofollow" target="_blank">
            <template #icon><SelectOutlined /></template>
            {{ t("common.visit") }}
          </a-button>
        </a-flex>
      </a-col>
    </a-row>
  </a-modal>
</template>
