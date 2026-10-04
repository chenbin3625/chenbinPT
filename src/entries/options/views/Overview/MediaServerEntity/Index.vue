<script setup lang="ts">
import {
  ArrowsAltOutlined,
  CheckOutlined,
  CloudServerOutlined,
  HeartFilled,
  HeartOutlined,
  InfoCircleOutlined,
  MinusCircleOutlined,
  SelectOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons-vue";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { useIntersectionObserver } from "@vueuse/core";
import { isEmpty } from "es-toolkit/compat";
import { getMediaServerIcon, type IMediaServerItem } from "@ptd/mediaServer";

import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { formatSize } from "@/options/utils.ts";

import PageSkeleton from "@/options/components/PageSkeleton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import ItemInformationDialog from "./ItemInformationDialog.vue";

import { doSearch, searchMediaServerIds } from "./utils.ts";

const { t } = useI18n();
const route = useRoute();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

const search = ref<string>((route.query.search as string) || "");

// V-21：全选复选框的真实状态（`checked` / `indeterminate` 都必须由选择情况推导）
const enabledMediaServerIds = computed(() => metadataStore.getEnabledMediaServers.map((mediaServer) => mediaServer.id));
const isAllMediaServerChecked = computed(
  () =>
    enabledMediaServerIds.value.length > 0 &&
    enabledMediaServerIds.value.every((id) => searchMediaServerIds.value.includes(id)),
);
const isMediaServerSelectionIndeterminate = computed(
  () =>
    !isAllMediaServerChecked.value && enabledMediaServerIds.value.some((id) => searchMediaServerIds.value.includes(id)),
);

const showItem = ref<IMediaServerItem | null>(null);
const showItemInformationDialog = ref<boolean>(false);

// P2-5：瀑布流原来把 searchResult 全量 v-for 渲染（DOM 无上限，反复「加载更多」会一直累加卡片）。
// 这里保留「只渲染前 N 条 + 触底自动追加」的窗口化策略：DOM 数量由用户滚动进度决定，
// 而不是由累计搜索结果总数决定；服务端的「加载更多」按钮行为保持不变。
const mediaServerVisiblePageSize = 40;
const visibleResultCount = ref(mediaServerVisiblePageSize);
const gridSentinel = ref<HTMLElement | null>(null);

const visibleSearchResults = computed(() =>
  runtimeStore.mediaServerSearch.searchResult.slice(0, visibleResultCount.value),
);

const hasHiddenResults = computed(() => visibleResultCount.value < runtimeStore.mediaServerSearch.searchResult.length);

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

const hasMore = computed<boolean>(() =>
  isEmpty(runtimeStore.mediaServerSearch.searchStatus)
    ? true
    : Object.values(runtimeStore.mediaServerSearch.searchStatus).some((x) => x?.canLoadMore ?? true),
);

function showItemInformation(item: IMediaServerItem) {
  showItem.value = item;
  showItemInformationDialog.value = true;
}

function onScroll(event: Event) {
  const target = event.currentTarget;
  const isElementScroll = target instanceof HTMLElement;
  const atBottom = isElementScroll
    ? target.scrollTop + target.clientHeight >= target.scrollHeight - 50
    : window.innerHeight + window.scrollY >= document.body.offsetHeight - 50;

  if (
    configStore.mediaServerEntity.autoSearchMoreWhenScroll &&
    atBottom &&
    !runtimeStore.mediaServerSearch.isSearching &&
    hasMore.value
  ) {
    doSearch({ searchKey: search.value, loadMore: true });
  }
}

onMounted(async () => {
  if (configStore.mediaServerEntity.autoSearchWhenMount && runtimeStore.mediaServerSearch.searchResult.length === 0) {
    // noinspection ES6MissingAwait
    doSearch({ searchKey: search.value });
  }
});
</script>

<template>
  <a-card v-scroll="onScroll">
    <a-typography-text strong>
      <a-flex class="page-toolbar" align="center" :gap="8">
        <div style="flex: 1 1 auto"></div>
        <a-input
          v-model:value="search"
          :placeholder="t('MediaServerEntity.searchPlaceholder')"
          allow-clear
          @keyup.enter="() => doSearch({ searchKey: search })"
        >
          <template #prefix>
            <a-popover placement="bottom" trigger="click">
              <CloudServerOutlined />
              <template #content>
                <a-list size="small" style="padding: 0">
                  <a-list-item>
                    <!-- V-21：`:indeterminate="true"` 硬编码会让这个复选框无论选择情况如何都画半选横杠，
                         用户无法判断「是否全选」。改为计算值（对照 SetSearchSolution/SiteCategoryPanel.vue 的写法）。 -->
                    <a-checkbox
                      :checked="isAllMediaServerChecked"
                      :indeterminate="isMediaServerSelectionIndeterminate"
                      @click.stop
                      @update:checked="
                        (v: unknown) => {
                          searchMediaServerIds = v ? [...enabledMediaServerIds] : [];
                        }
                      "
                      >{{ t("common.checkbox.all") }}</a-checkbox
                    >
                  </a-list-item>
                  <a-divider style="margin: 4px 0" />
                  <a-list-item v-for="item in metadataStore.getMediaServers" :key="item.id">
                    <!-- 单个复选框没有「部分选中」语义：禁用项已由 utils.ts 的 watcher 从选择中剪掉，
                         原先的 `:indeterminate="item.enabled === false"` 会让禁用项显示为半选，容易误读。 -->
                    <a-checkbox
                      :checked="searchMediaServerIds.includes(item.id)"
                      :disabled="item.enabled === false"
                      @click.stop
                      @update:checked="
                        (checked: boolean) => {
                          searchMediaServerIds = checked
                            ? Array.from(new Set([...searchMediaServerIds, item.id]))
                            : searchMediaServerIds.filter((x) => x !== item.id);
                        }
                      "
                    >
                      {{ item.name }}
                      <a-avatar
                        :alt="item.type"
                        :src="getMediaServerIcon(item.type)"
                        :size="20"
                        style="margin-left: 8px"
                      ></a-avatar>
                    </a-checkbox>
                  </a-list-item>
                </a-list>
              </template>
            </a-popover>
          </template>
        </a-input>
      </a-flex>
    </a-typography-text>

    <!--  瀑布流形式展示媒体服务器搜索结果（只渲染前 visibleResultCount 条，触底自动追加） -->
    <div v-if="runtimeStore.mediaServerSearch.searchResult.length > 0" class="masonry-grid">
      <div v-for="item in visibleSearchResults" :key="item.url" class="masonry-item">
        <a-card>
          <div style="position: relative; margin-bottom: 4px">
            <a-popover placement="leftTop" trigger="hover" overlay-class-name="masonry-img-overlay">
              <template #content>
                <a-button block @click="() => showItemInformation(item)">
                  {{ t("MediaServerEntity.detail") }}
                  <InfoCircleOutlined />
                </a-button>
                <a-button :href="item.url" block rel="noopener noreferrer nofollow" target="_blank">
                  {{ t("common.visit") }}
                  <SelectOutlined />
                </a-button>
              </template>
              <div>
                <div class="masonry-right-label">
                  <!-- 用户状态（观看、喜欢） -->
                  <a-tag v-if="item.user" color="#e0e0e0">
                    <component
                      :is="item.user?.IsPlayed ? CheckOutlined : MinusCircleOutlined"
                      style="color: var(--ptd-success)"
                    />
                    <component
                      :is="item.user?.IsFavorite ? HeartFilled : HeartOutlined"
                      style="color: var(--ptd-danger)"
                    />
                  </a-tag>
                </div>
                <div class="masonry-left-label">
                  <!-- 封装格式 -->
                  <a-tag v-if="item.format" color="#03a9f4"
                    ><ArrowsAltOutlined style="margin-right: 4px" />
                    {{ item.format?.toUpperCase() }}
                    <template v-if="item.streams && item.streams.filter((s) => s.type === 'Video')!.length > 0">
                      / {{ item.streams.filter((s) => s.type === "Video")[0].title }}
                    </template>
                  </a-tag>
                  <br />
                  <!-- 大小 -->
                  <a-tag v-if="item.size"
                    ><VideoCameraOutlined style="margin-right: 4px" />
                    {{ formatSize(item.size ?? 0) }}
                  </a-tag>
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

    <!-- 其余情况（还没搜过 / 搜索完成但无结果）都要有明确占位，不能留空白 -->
    <NoDataPlaceholder v-else :description="t('MediaServerEntity.noItems')" />

    <!-- 仍有未渲染结果时的触底哨兵：进入视口后追加下一页（DOM 上限由滚动进度决定） -->
    <div v-if="hasHiddenResults" ref="gridSentinel" style="height: 1px; width: 100%"></div>

    <!-- TODO 点击加载更多 -->
    <div v-if="!isEmpty(runtimeStore.mediaServerSearch.searchStatus)">
      <a-row :gutter="8">
        <a-col flex="1 1 0" style="display: flex; justify-content: center">
          <a-button
            :disabled="!hasMore"
            :loading="runtimeStore.mediaServerSearch.isSearching"
            @click="() => doSearch({ searchKey: search, loadMore: true })"
          >
            {{ t("MediaServerEntity.loadMore") }}
          </a-button>
        </a-col>
      </a-row>
    </div>
  </a-card>

  <ItemInformationDialog v-model="showItemInformationDialog" :item="showItem as IMediaServerItem" />
</template>
