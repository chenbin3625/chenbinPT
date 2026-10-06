<script setup lang="ts">
import { reactive, ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { ArrowRightOutlined, SearchOutlined, SelectOutlined } from "@ant-design/icons-vue";

import { socialBuildUrlMap } from "@ptd/social";
import type { ITorrent } from "@ptd/site";
import type { ISocialInformation, TSupportSocialSite } from "@ptd/social/types.ts";

import { useConfigStore } from "@/options/stores/config.ts";
import { resolveColor } from "@/shared/colors.ts";
import { sendMessage } from "@/messages.ts";

const {
  item,
  showSocial = true,
  maxWidth,
} = defineProps<{
  item: Partial<ITorrent>;
  showSocial?: boolean;
  maxWidth?: string | number;
}>();

const { t } = useI18n();
const router = useRouter();
const configStore = useConfigStore();

interface ISocialInformationData extends ISocialInformation {
  loading?: boolean;
  error?: boolean;
}

// T-2：此处原有的 @ts-ignore 已不再需要（vue-tsc 报 Unused），按 background/utils/base.ts 的约定删除
const socialInformation = reactive<Record<TSupportSocialSite | string, ISocialInformationData>>({});

// P1-17：社交菜单内容按需渲染。
// 表格每行对每个支持的社交站点都渲染一个社交菜单，若内容（海报卡片 / 骨架屏 / 按钮组）
// 也参与渲染，则整表每次 patch 都要为「从未被悬停过」的菜单创建上百个 vnode。
// 这里仅在用户首次悬停 / 点击某站点图标后才渲染该菜单的内容，已激活的保持挂载（语义不变）。
const activatedSocialMenus = reactive<Record<string, boolean>>({});

function activateSocialMenu(site: TSupportSocialSite | string) {
  activatedSocialMenus[site] = true;
}

const tagsExpanded = ref(false);

const visibleTags = computed(() => {
  const tags = item.tags;
  if (!tags || !tags.length) return [];
  const hiddenNames = configStore.searchEntifyControl.hiddenTagNames || [];
  return tags.filter((tag) => !hiddenNames.includes(tag.name));
});

const maxTagCount = computed(() => configStore.searchEntifyControl.maxTagCountBeforeGroup || 0);

const displayedTags = computed(() => {
  if (!maxTagCount.value || maxTagCount.value >= visibleTags.value.length || tagsExpanded.value) {
    return visibleTags.value;
  }
  return visibleTags.value.slice(0, maxTagCount.value);
});

const hasMoreTags = computed(
  () => maxTagCount.value > 0 && visibleTags.value.length > maxTagCount.value && !tagsExpanded.value,
);

const hiddenTagCount = computed(() => visibleTags.value.length - maxTagCount.value);

function loadSocialInformation(site: TSupportSocialSite) {
  const current = socialInformation[site];

  // V-4：重入守卫不能只判断「有没有值」。请求失败时若把 `{loading:true}` 留在原处，
  // popover 会永久停在 Loading....，悬停也无法重试（守卫永远为假）。这里允许错误态重试。
  if (item[`ext_${site}`] && (!current || current.error)) {
    socialInformation[site] = { loading: true } as ISocialInformationData;
    sendMessage("getSocialInformation", { site, sid: item[`ext_${site}`] as unknown as string })
      .then((info) => {
        socialInformation[site] = info;
      })
      .catch(() => {
        // 置为错误态（保留键，避免悬停时的并发重复请求），再次悬停 / 点击图标会重新发起请求
        socialInformation[site] = { error: true } as ISocialInformationData;
      });
  }
}

function doAdvanceSearch(site: TSupportSocialSite, sid: string) {
  const toRoute = { name: "SearchEntity", query: { search: `${site}|${sid}`, flush: 1 } };

  if (configStore.searchEntifyControl.socialInformationSearchOnNewTab) {
    window.open(router.resolve(toRoute).href, "_blank");
  } else {
    router.push(toRoute);
  }
}

function canAdvanceSearch(site: TSupportSocialSite) {
  return site !== "tmdb";
}
</script>

<template>
  <div :style="{ maxWidth, minWidth: 0 }">
    <!-- 种子主标题信息 -->
    <a-flex align="center" wrap="nowrap">
      <a-tooltip
        :title="item.title ?? item.url ?? item.link"
        placement="topLeft"
        :overlay-style="{ maxWidth: 'min(60vw, 600px)' }"
        :overlay-inner-style="{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }"
      >
        <span style="flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
          <a-typography-link
            :href="item.url"
            rel="noopener noreferrer nofollow"
            style="font-size: 16px"
            target="_blank"
          >
            {{ item.title ?? item.url ?? item.link }}
          </a-typography-link>
        </span>
      </a-tooltip>

      <!-- 种子的媒体信息 -->
      <div style="flex: 0 0 auto; margin-left: 8px">
        <template v-if="showSocial && configStore.searchEntifyControl.showSocialInformation">
          <template v-for="(meta, key) in socialBuildUrlMap" :key="key">
            <a-dropdown v-if="item[`ext_${key}`]" :trigger="['hover']" placement="bottomRight">
              <a-avatar
                :size="20"
                :src="`/icons/social/${key}.png`"
                shape="square"
                style="margin-left: 4px; cursor: pointer"
                @click="
                  () => {
                    activateSocialMenu(key);
                    loadSocialInformation(key as TSupportSocialSite);
                  }
                "
                @mouseenter="
                  () => {
                    activateSocialMenu(key);
                    loadSocialInformation(key as TSupportSocialSite);
                  }
                "
              />
              <template #overlay>
                <a-card
                  v-if="activatedSocialMenus[key]"
                  :body-style="{ padding: '4px 8px' }"
                  :bordered="false"
                  style="width: 166px"
                >
                  <div style="max-width: 150px; text-align: center">
                    <a-typography-title
                      v-if="socialInformation[key]?.loading === true"
                      :level="5"
                      style="margin: 8px 0"
                    >
                      Loading....
                    </a-typography-title>
                    <template v-else-if="socialInformation[key]?.id">
                      <a-image
                        :fallback="'/icons/movie_placeholder.png'"
                        :height="225"
                        :preview="false"
                        :src="socialInformation[key]?.poster"
                        style="margin-bottom: 4px; object-fit: cover"
                        :width="150"
                      >
                        <template #placeholder>
                          <a-skeleton active :paragraph="{ rows: 4 }" :title="false" />
                        </template>
                      </a-image>
                      <a-typography-title
                        v-if="socialInformation[key]?.title"
                        :ellipsis="{ tooltip: socialInformation[key]?.title }"
                        :level="5"
                        :style="{ fontSize: '14px', margin: '8px 0' }"
                      >
                        {{ socialInformation[key]?.title.split(" / ")[0] }}
                      </a-typography-title>
                      <a-typography-paragraph
                        v-if="socialInformation[key]?.ratingScore"
                        :style="{ fontSize: '12px', marginBottom: 0 }"
                      >
                        {{ socialInformation[key].ratingScore }}
                        <span v-if="socialInformation[key]?.ratingCount">
                          from {{ socialInformation[key].ratingCount }} votes
                        </span>
                      </a-typography-paragraph>
                    </template>
                    <!-- V-4：请求失败时给出可重试的错误态，而不是永久停在 Loading.... -->
                    <a-typography-title
                      v-else-if="socialInformation[key]?.error"
                      :level="5"
                      style="margin: 8px 0; font-size: 13px"
                    >
                      {{ t("MyClient.state.error") }}
                    </a-typography-title>
                    <a-typography-title v-else :level="5" style="margin: 8px 0">{{
                      t("common.noInformation")
                    }}</a-typography-title>

                    <template v-if="canAdvanceSearch(key as TSupportSocialSite)">
                      <a-divider style="margin: 4px 0" />
                      <a-button
                        block
                        type="text"
                        @click="doAdvanceSearch(key as TSupportSocialSite, item[`ext_${key}`] as string)"
                      >
                        <template #icon><SearchOutlined /></template>
                        {{ t("common.search") }}
                      </a-button>
                    </template>

                    <a-divider style="margin: 4px 0" />
                    <a-button
                      block
                      :href="meta(item[`ext_${key}`]! as string)"
                      rel="noopener noreferrer nofollow"
                      target="_blank"
                      :title="`${key}: ${item[`ext_${key}`]}`"
                      type="text"
                    >
                      <template #icon><SelectOutlined /></template>
                      {{ t("common.visit") }}
                    </a-button>
                    <a-divider style="margin: 4px 0" />
                    <a-typography-paragraph :style="{ fontSize: '12px', marginTop: '4px' }">
                      ( {{ key }}: {{ item[`ext_${key}`] }} )
                    </a-typography-paragraph>
                  </div>
                </a-card>
              </template>
            </a-dropdown>
          </template>
        </template>
      </div>
    </a-flex>

    <a-flex
      v-if="configStore.searchEntifyControl.showTorrentTag || configStore.searchEntifyControl.showTorrentSubtitle"
      align="center"
      wrap="nowrap"
    >
      <!-- 种子标签信息 -->
      <div style="flex: 0 0 auto">
        <template v-if="configStore.searchEntifyControl.showTorrentTag && item.tags && item.tags.length > 0">
          <!-- M-30：按标签自带颜色渲染（tags.ts 的 31 个预定义标签 + 站点页面抓到的真实底色），
               统一中性色会让免费/2x/H&R/官方等标签无法一眼区分 -->
          <a-tag
            v-for="tag in displayedTags"
            :key="tag.name"
            :color="resolveColor(tag.color) ?? 'default'"
            style="margin-right: 4px"
          >
            {{ tag.name }}
          </a-tag>
          <a-tag v-if="hasMoreTags" color="default" style="margin-right: 4px" @click="tagsExpanded = true">
            <template #icon><ArrowRightOutlined /></template>
            {{ hiddenTagCount }}
          </a-tag>
        </template>
      </div>

      <!-- 种子副标题信息 -->
      <a-tooltip
        v-if="configStore.searchEntifyControl.showTorrentSubtitle && item.subTitle"
        :title="item.subTitle"
        placement="topLeft"
        :overlay-style="{ maxWidth: 'min(60vw, 600px)' }"
        :overlay-inner-style="{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }"
      >
        <span class="ptd-cell-ellipsis" :style="{ flex: '1 1 0', minWidth: 0, color: 'var(--ptd-text-secondary)' }">
          {{ item.subTitle }}
        </span>
      </a-tooltip>
    </a-flex>
  </div>
</template>
