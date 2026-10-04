<script lang="ts" setup>
import { computed, onUnmounted, ref, watch } from "vue";
import PQueue from "p-queue";
import { useI18n } from "vue-i18n";
import { FireOutlined, ReloadOutlined, StarFilled } from "@ant-design/icons-vue";
import type { ISocialRecommendationItem, TSocialRecommendationCategory } from "@ptd/social";

import { sendMessage } from "@/messages.ts";
import { resolveColor } from "@/shared/colors.ts";

const { disabled } = defineProps<{
  disabled?: boolean;
}>();

const emit = defineEmits<{
  search: [title: string];
}>();

const { t } = useI18n();

const isRecommendationMenuOpen = ref(false);
const isLoadingRecommendations = ref(false);
const recommendationError = ref("");
const recommendationItems = ref<ISocialRecommendationItem[]>([]);
let recommendationRequestId = 0;

const recommendationCategories: TSocialRecommendationCategory[] = ["movie", "tv", "variety", "anime"];
const recommendationCategoryLimit = 10;
const visibleRecommendationCategoryLimit = 5;
const recommendationItemEnrichmentConcurrency = 10;

const groupedRecommendationItems = computed(() =>
  recommendationCategories.map((category) => ({
    category,
    items: recommendationItems.value.filter((item) => item.category === category).slice(0, recommendationCategoryLimit),
  })),
);

async function loadRecommendations(flush = false) {
  if (isLoadingRecommendations.value) {
    return;
  }

  if (!flush && recommendationItems.value.length > 0 && !recommendationError.value) {
    const requestId = ++recommendationRequestId;
    if (hasIncompleteRecommendations()) {
      void enrichRecommendations(requestId);
    }
    return;
  }

  isLoadingRecommendations.value = true;
  recommendationError.value = "";
  const requestId = ++recommendationRequestId;

  try {
    const result = await sendMessage("getSocialRecommendations", { flush, enrichment: "none" });
    if (requestId !== recommendationRequestId) {
      return;
    }

    if (!result.hasFailedSources || recommendationItems.value.length === 0) {
      // 列表被整体替换：丢弃上一轮的待写入结果并重建 key → 下标索引
      pendingEnrichedItems.clear();
      recommendationItems.value = result.items;
      rebuildRecommendationItemIndex();
    }
    if (result.hasFailedSources && recommendationItems.value.length === 0) {
      recommendationError.value = t("layout.header.hotRecommendations.loadFailed");
    }
    void enrichRecommendations(requestId);
  } catch (error) {
    console.error("Failed to load social recommendations", error);
    if (recommendationItems.value.length === 0) {
      recommendationError.value = t("layout.header.hotRecommendations.loadFailed");
    }
  } finally {
    if (requestId === recommendationRequestId) {
      isLoadingRecommendations.value = false;
    }
  }
}

function hasIncompleteRecommendations() {
  return recommendationItems.value.some(
    (item) =>
      !item.summary || !item.releaseYear || !item.region || !item.genres?.length || !item.poster?.startsWith("data:"),
  );
}

function getRecommendationItemKey(item: ISocialRecommendationItem) {
  return `${item.category}:${item.site}:${item.id}`;
}

// P2-6：富化结果按 `category:site:id` 缓存去重后批量写入。
// 原来每收到一个富化结果就 `map()` 整个数组（数十次整数组复制 + 数十次面板重渲染），
// 现在改为「key → 数组下标」索引 + 100ms 合并写入，一次 flush 只做一遍就地赋值。
const recommendationItemIndex = new Map<string, number>();
const pendingEnrichedItems = new Map<string, ISocialRecommendationItem>();
let flushEnrichedTimer: ReturnType<typeof setTimeout> | undefined;

function rebuildRecommendationItemIndex() {
  recommendationItemIndex.clear();
  recommendationItems.value.forEach((item, index) => {
    recommendationItemIndex.set(getRecommendationItemKey(item), index);
  });
}

function flushEnrichedRecommendationItems() {
  if (flushEnrichedTimer !== undefined) {
    clearTimeout(flushEnrichedTimer);
    flushEnrichedTimer = undefined;
  }
  if (pendingEnrichedItems.size === 0) return;

  for (const [key, item] of pendingEnrichedItems) {
    const index = recommendationItemIndex.get(key);
    if (index !== undefined) {
      recommendationItems.value[index] = item;
    }
  }
  pendingEnrichedItems.clear();
}

function scheduleEnrichedRecommendationItemsFlush() {
  if (flushEnrichedTimer !== undefined) return;
  flushEnrichedTimer = setTimeout(() => {
    flushEnrichedTimer = undefined;
    flushEnrichedRecommendationItems();
  }, 100);
}

function updateRecommendationItem(enrichedItem: ISocialRecommendationItem) {
  // 同一 key 的多次富化结果只保留最后一次
  pendingEnrichedItems.set(getRecommendationItemKey(enrichedItem), enrichedItem);
  scheduleEnrichedRecommendationItemsFlush();
}

onUnmounted(() => {
  if (flushEnrichedTimer !== undefined) {
    clearTimeout(flushEnrichedTimer);
    flushEnrichedTimer = undefined;
  }
  pendingEnrichedItems.clear();
});

function getVisibleRecommendationItems() {
  const categoryCounts = new Map<ISocialRecommendationItem["category"], number>();
  const visibleItems: ISocialRecommendationItem[] = [];

  for (const item of recommendationItems.value) {
    const categoryCount = categoryCounts.get(item.category) ?? 0;
    categoryCounts.set(item.category, categoryCount + 1);

    if (categoryCount < visibleRecommendationCategoryLimit) {
      visibleItems.push(item);
    }
  }

  return visibleItems;
}

async function enrichRecommendationItems(
  requestId: number,
  items: ISocialRecommendationItem[],
  enrichment: "visible" | "all",
) {
  if (!isRecommendationMenuOpen.value) {
    return;
  }

  const enrichmentQueue = new PQueue({ concurrency: recommendationItemEnrichmentConcurrency });
  await Promise.all(
    items.map((item) =>
      enrichmentQueue.add(async () => {
        try {
          const result = await sendMessage("getSocialRecommendationItem", { item, enrichment });
          if (requestId !== recommendationRequestId || !isRecommendationMenuOpen.value) {
            return;
          }
          updateRecommendationItem(result.item);
        } catch (error) {
          console.error("Failed to enrich social recommendation item", item, error);
        }
      }),
    ),
  );
}

async function enrichRecommendations(requestId: number) {
  await enrichRecommendationItems(requestId, getVisibleRecommendationItems(), "visible");
  if (requestId !== recommendationRequestId || !isRecommendationMenuOpen.value) {
    return;
  }
  await enrichRecommendationItems(requestId, [...recommendationItems.value], "all");
}

function searchRecommendation(item: ISocialRecommendationItem) {
  isRecommendationMenuOpen.value = false;
  emit("search", item.title);
}

function getRecommendationPosterSrc(item: ISocialRecommendationItem) {
  if (!item.poster || /doubanio\.com/.test(item.poster)) {
    return "/icons/movie_placeholder.png";
  }

  return item.poster;
}

watch(isRecommendationMenuOpen, (isOpen) => {
  if (isOpen) {
    loadRecommendations();
  } else {
    // 关闭时把已到达的富化结果落盘，避免残留的定时器在下次打开时写入旧下标
    flushEnrichedRecommendationItems();
  }
});
</script>

<template>
  <a-popover v-model:open="isRecommendationMenuOpen" placement="bottomRight" trigger="click">
    <a-button
      :disabled="disabled"
      :title="t('layout.header.hotRecommendations.title')"
      size="small"
      type="text"
      @click.stop
    >
      <template #icon><FireOutlined /></template>
    </a-button>

    <template #title>
      <div class="hot-recommendation-header">
        <FireOutlined />
        <span>{{ t("layout.header.hotRecommendations.title") }}</span>
        <div class="hot-recommendation-spacer" />
        <a-button
          :loading="isLoadingRecommendations"
          :title="t('layout.header.hotRecommendations.refresh')"
          size="small"
          type="text"
          @click="() => loadRecommendations(true)"
        >
          <template #icon><ReloadOutlined /></template>
        </a-button>
      </div>
    </template>

    <template #content>
      <div class="hot-recommendation-panel">
        <div v-if="isLoadingRecommendations && recommendationItems.length === 0" class="hot-recommendation-state">
          <a-spin size="small" />
          {{ t("layout.header.hotRecommendations.loading") }}
        </div>

        <a-typography-text
          v-else-if="recommendationError && recommendationItems.length === 0"
          class="hot-recommendation-state"
          type="danger"
        >
          {{ recommendationError }}
        </a-typography-text>

        <a-empty
          v-else-if="recommendationItems.length === 0"
          :description="t('layout.header.hotRecommendations.empty')"
        />

        <a-row v-else :gutter="[12, 12]">
          <a-col v-for="group in groupedRecommendationItems" :key="group.category" :lg="6" :sm="12" :xs="24">
            <a-typography-text strong>
              {{ t(`layout.header.hotRecommendations.category.${group.category}`) }}
            </a-typography-text>

            <div v-if="group.items.length === 0" class="hot-recommendation-list hot-recommendation-empty-list">
              {{ t("layout.header.hotRecommendations.empty") }}
            </div>
            <a-list v-else :data-source="group.items" bordered class="hot-recommendation-list" size="small">
              <template #renderItem="{ item }">
                <a-list-item class="hot-recommendation-item" @click="() => searchRecommendation(item)">
                  <a-image
                    :preview="false"
                    :src="getRecommendationPosterSrc(item)"
                    class="hot-recommendation-poster"
                    fallback="/icons/movie_placeholder.png"
                    referrerpolicy="no-referrer"
                  />

                  <div class="hot-recommendation-body">
                    <div class="hot-recommendation-title-row">
                      <span class="hot-recommendation-title">{{ item.title }}</span>
                      <span class="hot-recommendation-rating">
                        <StarFilled :style="{ color: resolveColor('amber-darken-2'), fontSize: '12px' }" />
                        {{
                          item.ratingScore
                            ? item.ratingScore.toFixed(1)
                            : t("layout.header.hotRecommendations.noRating")
                        }}
                      </span>
                    </div>

                    <div class="hot-recommendation-meta">
                      <a-tag v-if="item.releaseYear">{{ item.releaseYear }}</a-tag>
                      <a-tag v-if="item.region">{{ item.region }}</a-tag>
                      <a-tag v-for="genre in item.genres?.slice(0, 3)" :key="genre">{{ genre }}</a-tag>
                    </div>

                    <a-typography-paragraph
                      :ellipsis="{ rows: 2 }"
                      :content="item.summary || t('layout.header.hotRecommendations.noSummary')"
                      class="hot-recommendation-summary"
                      type="secondary"
                    />
                  </div>
                </a-list-item>
              </template>
            </a-list>
          </a-col>
        </a-row>
      </div>
    </template>
  </a-popover>
</template>
