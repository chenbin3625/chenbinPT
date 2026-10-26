<script setup lang="ts">
import {
  ArrowsAltOutlined,
  ExportOutlined,
  HeartFilled,
  HeartOutlined,
  InfoCircleOutlined,
  SearchOutlined,
  SelectOutlined,
  StarFilled,
  VideoCameraOutlined,
} from "@ant-design/icons-vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { useIntersectionObserver, useThrottleFn } from "@vueuse/core";
import { isEmpty } from "es-toolkit/compat";
import { getMediaServerIcon, type IMediaServerItem } from "@ptd/mediaServer";

import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { formatSize } from "@/options/utils.ts";

import PageSkeleton from "@/options/components/PageSkeleton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import ItemInformationDialog from "./ItemInformationDialog.vue";
import PlayedStateIcon from "./PlayedStateIcon.vue";
import ServerFilterChips from "./ServerFilterChips.vue";

import { doSearch, resetSearchingStateIfIdle, searchMediaServerIds } from "./utils.ts";
import { seriesText, videoRangeBadge, videoSummary } from "./itemDisplay.ts";

const { t } = useI18n();
const route = useRoute();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

const search = ref<string>((route.query.search as string) || "");

const enabledMediaServerIds = computed(() => metadataStore.getEnabledMediaServers.map((mediaServer) => mediaServer.id));

/** 工具条上的服务器筛选 chip：只列已启用的服务器（禁用项已由 utils.ts 的 watcher 从选择中剪掉） */
const filterMediaServers = computed(() =>
  metadataStore.getEnabledMediaServers.map(({ id, name, type }) => ({ id, name, type })),
);

/**
 * 上游 #1599：已加载的结果保留在 store 中不丢弃，仅按当前筛选出的服务器决定显示哪些卡片
 * （取消勾选一台服务器后它的卡片即时隐藏，重新勾选即时恢复，不必重新搜索）。
 */
const filteredSearchResult = computed(() =>
  runtimeStore.mediaServerSearch.searchResult.filter((item) => searchMediaServerIds.value.includes(item.server)),
);

const showItem = ref<IMediaServerItem | null>(null);
const showItemInformationDialog = ref<boolean>(false);

// P2-5：瀑布流原来把 searchResult 全量 v-for 渲染（DOM 无上限，反复「加载更多」会一直累加卡片）。
// 这里保留「只渲染前 N 条 + 触底自动追加」的窗口化策略：DOM 数量由用户滚动进度决定，
// 而不是由累计搜索结果总数决定；服务端的「加载更多」按钮行为保持不变。
const mediaServerVisiblePageSize = 40;
const visibleResultCount = ref(mediaServerVisiblePageSize);
const gridSentinel = ref<HTMLElement | null>(null);

const visibleSearchResults = computed(() => filteredSearchResult.value.slice(0, visibleResultCount.value));

const hasHiddenResults = computed(() => visibleResultCount.value < filteredSearchResult.value.length);

useIntersectionObserver(gridSentinel, ([entry]) => {
  if (!entry?.isIntersecting || !hasHiddenResults.value) return;
  visibleResultCount.value += mediaServerVisiblePageSize;
});

// 新的搜索（searchKey 变化，doSearch 会重置结果）时回到第一页
watch(
  () => runtimeStore.mediaServerSearch.searchKey,
  () => {
    visibleResultCount.value = mediaServerVisiblePageSize;
  },
);

/**
 * N16：只统计「当前勾选且启用」的服务器状态。
 *
 * 原实现统计 `searchStatus` 里的全部条目：取消勾选某台服务器后，它的旧状态仍让
 * `hasMore` 为 true →「加载更多」可点，但只会搜当前勾选项，点完没有新增。
 */
const hasMore = computed<boolean>(() => {
  const searchableIds = searchMediaServerIds.value.filter((id) => enabledMediaServerIds.value.includes(id));
  if (searchableIds.length === 0) return false;
  const status = runtimeStore.mediaServerSearch.searchStatus;
  if (isEmpty(status)) return true;
  return searchableIds.some((id) => status[id]?.canLoadMore ?? true);
});

function showItemInformation(item: IMediaServerItem) {
  showItem.value = item;
  showItemInformationDialog.value = true;
}

const isFetchingMore = ref(false);

const onScroll = useThrottleFn((event: Event) => {
  const target = event.currentTarget;
  const isElementScroll = target instanceof HTMLElement;
  const atBottom = isElementScroll
    ? target.scrollTop + target.clientHeight >= target.scrollHeight - 50
    : window.innerHeight + window.scrollY >= document.body.offsetHeight - 50;

  if (
    configStore.mediaServerEntity.autoSearchMoreWhenScroll &&
    atBottom &&
    !runtimeStore.mediaServerSearch.isSearching &&
    !isFetchingMore.value &&
    hasMore.value
  ) {
    isFetchingMore.value = true;
    // N15：「加载更多」必须沿用当前结果对应的搜索词（store 里的 searchKey），
    // 否则用户改了输入框但没回车时，滚动会带着新词重新搜第一页（清空已看的结果、位置丢失）。
    doSearch({ searchKey: runtimeStore.mediaServerSearch.searchKey, loadMore: true, userInitiated: true });
    setTimeout(() => {
      isFetchingMore.value = false;
    }, 100);
  }
}, 200);

let mounted = false;
onMounted(async () => {
  mounted = true;
  await metadataStore.$onReady();
  if (!mounted) return;
  // N1：恢复出来的 isSearching 可能没有对应的在途队列（PQueue 是内存对象），先做一次收尾
  resetSearchingStateIfIdle();
  if (configStore.mediaServerEntity.autoSearchWhenMount && runtimeStore.mediaServerSearch.searchResult.length === 0) {
    // noinspection ES6MissingAwait
    doSearch({ searchKey: search.value });
  }
});
onUnmounted(() => {
  mounted = false;
});
</script>

<template>
  <a-card v-scroll="onScroll">
    <a-typography-text strong>
      <a-flex class="page-toolbar" align="center" :gap="8">
        <!-- 媒体服务器筛选器（上游 #1599：由搜索框前缀里的弹出层改为平铺的 chip，并即时过滤已加载卡片） -->
        <ServerFilterChips v-model="searchMediaServerIds" :items="filterMediaServers" style="flex: 0 1 auto" />
        <div style="flex: 1 1 auto"></div>
        <a-input
          v-model:value="search"
          :placeholder="t('MediaServerEntity.searchPlaceholder')"
          allow-clear
          @keyup.enter="() => doSearch({ searchKey: search, userInitiated: true })"
        >
          <template #prefix>
            <SearchOutlined />
          </template>
        </a-input>
      </a-flex>
    </a-typography-text>

    <!--  瀑布流形式展示媒体服务器搜索结果（只渲染前 visibleResultCount 条，触底自动追加） -->
    <div v-if="filteredSearchResult.length > 0" class="masonry-grid">
      <div v-for="item in visibleSearchResults" :key="item.url" class="masonry-item">
        <a-card>
          <div style="position: relative; margin-bottom: 4px">
            <a-popover placement="leftTop" trigger="hover" overlay-class-name="masonry-img-overlay">
              <template #content>
                <a-button block @click="() => showItemInformation(item)">
                  {{ t("MediaServerEntity.detail") }}
                  <InfoCircleOutlined />
                </a-button>
                <!-- 外部链接（调研 A5：IMDb / TMDb …） -->
                <a-button
                  v-for="externalUrl in item.externalUrls ?? []"
                  :key="externalUrl.url"
                  :href="externalUrl.url"
                  block
                  rel="noopener noreferrer nofollow"
                  target="_blank"
                >
                  {{ externalUrl.name }}
                  <ExportOutlined />
                </a-button>
                <a-button :href="item.url" block rel="noopener noreferrer nofollow" target="_blank">
                  {{ t("common.visit") }}
                  <SelectOutlined />
                </a-button>
              </template>
              <div>
                <div class="masonry-right-label">
                  <!-- 用户状态（观看、喜欢、观看深度，调研 A6） -->
                  <a-tag v-if="item.user" color="#e0e0e0">
                    <PlayedStateIcon :is-played="item.user?.IsPlayed" :percent="item.user?.playedPercentage" />
                    <component
                      :is="item.user?.IsFavorite ? HeartFilled : HeartOutlined"
                      style="color: var(--ptd-danger); margin-left: 4px"
                    />
                  </a-tag>
                </div>
                <div class="masonry-left-label">
                  <!-- 封装格式 + 画质/码率（调研 A2） -->
                  <a-tag v-if="item.format" color="#03a9f4"
                    ><ArrowsAltOutlined style="margin-right: 4px" />
                    {{ item.format?.toUpperCase() }}
                    <template v-if="videoSummary(item)"> / {{ videoSummary(item) }}</template>
                  </a-tag>
                  <br v-if="item.format" />
                  <!-- 大小 -->
                  <a-tag v-if="item.size"
                    ><VideoCameraOutlined style="margin-right: 4px" />
                    {{ formatSize(item.size ?? 0) }}
                  </a-tag>
                  <!-- 评分（调研 A1） -->
                  <a-tag v-if="typeof item.rating === 'number'" color="gold"
                    ><StarFilled style="margin-right: 4px" />{{ item.rating.toFixed(1) }}</a-tag
                  >
                  <!-- 色域（调研 A2） -->
                  <a-tag v-if="videoRangeBadge(item)" color="volcano">{{ videoRangeBadge(item) }}</a-tag>
                  <!-- 年份（调研 B8） -->
                  <a-tag v-if="item.productionYear" color="#607d8b">{{ item.productionYear }}</a-tag>
                  <!-- 同片多版本（调研 B9） -->
                  <a-tag v-if="(item.mediaSourceCount ?? 0) > 1" color="purple">
                    {{ t("MediaServerEntity.versions", { count: item.mediaSourceCount }) }}
                  </a-tag>
                  <!-- 剧集编号（调研 B10） -->
                  <a-tag v-if="seriesText(item)" color="geekblue">{{ seriesText(item) }}</a-tag>
                </div>
                <a-image :src="item.poster" :title="item.name" :preview="false"></a-image>
              </div>
            </a-popover>
          </div>

          <a-typography-text style="white-space: normal; margin: 4px 0; text-align: center" type="secondary">
            <a-typography-link :href="item.url" :title="item.name" strong style="margin: 8px 0" target="_blank">
              {{ item.name }}
            </a-typography-link>

            <a-flex
              v-if="metadataStore.mediaServers[item.server]"
              align="center"
              justify="center"
              style="margin-top: 4px"
            >
              <a-avatar
                :alt="metadataStore.mediaServers[item.server].name"
                :src="getMediaServerIcon(metadataStore.mediaServers[item.server].type)"
                :size="20"
              ></a-avatar>
              &nbsp; {{ metadataStore.mediaServers[item.server].name }}
            </a-flex>
          </a-typography-text>
        </a-card>
      </div>
    </div>
    <!-- 首次搜索中（尚无任何结果）：用卡片骨架占位，避免整块内容区空白 -->
    <PageSkeleton v-else-if="runtimeStore.mediaServerSearch.isSearching" :count="8" :rows="3" variant="masonry" />

    <!-- 其余情况（还没搜过 / 搜索完成但无结果 / 已加载的结果都被服务器筛选隐藏）都要有明确占位，不能留空白 -->
    <NoDataPlaceholder
      v-else
      :description="
        runtimeStore.mediaServerSearch.searchResult.length > 0
          ? t('MediaServerEntity.serverFilter.allHidden')
          : t('MediaServerEntity.noItems')
      "
    />

    <!-- 仍有未渲染结果时的触底哨兵：进入视口后追加下一页（DOM 上限由滚动进度决定） -->
    <div v-if="hasHiddenResults" ref="gridSentinel" style="height: 1px; width: 100%"></div>

    <!-- TODO 点击加载更多 -->
    <div v-if="!isEmpty(runtimeStore.mediaServerSearch.searchStatus)">
      <a-row :gutter="8">
        <a-col flex="1 1 0" style="display: flex; justify-content: center">
          <a-button
            :disabled="!hasMore"
            :loading="runtimeStore.mediaServerSearch.isSearching"
            @click="
              () =>
                doSearch({ searchKey: runtimeStore.mediaServerSearch.searchKey, loadMore: true, userInitiated: true })
            "
          >
            {{ t("MediaServerEntity.loadMore") }}
          </a-button>
        </a-col>
      </a-row>
    </div>
  </a-card>

  <ItemInformationDialog v-model="showItemInformationDialog" :item="showItem as IMediaServerItem" />
</template>
