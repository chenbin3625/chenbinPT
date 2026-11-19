<script setup lang="ts">
import { reactive, ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { ArrowRightOutlined, SearchOutlined, SelectOutlined } from "@ant-design/icons-vue";

import { socialBuildUrlMap } from "@ptd/social";
import { isPromotionTagName, tagsToPromotion, type ITorrent, type ITorrentTag } from "@ptd/site";
import type { ISocialInformation, TSupportSocialSite } from "@ptd/social/types.ts";

import { useConfigStore } from "@/options/stores/config.ts";
import { useDisplay } from "@/options/composables/useDisplay.ts";
import { resolveColor } from "@/shared/colors.ts";
import { sendMessage } from "@/messages.ts";

const {
  item,
  showSocial = true,
  maxWidth,
  tagFilterable = false,
  activeTagNames = [],
} = defineProps<{
  item: Partial<ITorrent>;
  showSocial?: boolean;
  maxWidth?: string | number;
  /** 标签是否可点击筛选（仅搜索结果页由父组件开启；默认 false 保持纯展示） */
  tagFilterable?: boolean;
  /** 当前已激活的标签筛选名（用于高亮与 aria-pressed） */
  activeTagNames?: string[];
}>();

const emit = defineEmits<{
  (e: "filter-tag", tagName: string): void;
}>();

const { t } = useI18n();
const router = useRouter();
const configStore = useConfigStore();
const display = useDisplay();

/** 种子自带封面的加载失败状态：失败后隐藏缩略图，避免留下破图占位 */
const coverError = ref(false);
watch(
  () => item.cover,
  () => {
    coverError.value = false;
  },
);

/** 是否展示种子自带封面（需要站点提供 cover，且用户开启展示） */
const showCover = computed(() => !!item.cover && configStore.searchEntifyControl.showTorrentCover && !coverError.value);

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
  // 「仅数值」（factor）与「不显示」（none）模式下不再展示优惠标签：优惠信息由「优惠」列 / 高级筛选承担，
  // 再叠一遍标签只会让同一信息出现两次。其他标签（H&R / 官方 / 可退款 / 分辨率和编码等）照常展示。
  const hidePromotionTags = ["factor", "none"].includes(configStore.searchEntifyControl.promotionDisplay);
  return tags.filter((tag) => !hiddenNames.includes(tag.name) && !(hidePromotionTags && isPromotionTagName(tag.name)));
});

/**
 * 优惠标签的数值释义：由 `tagsToPromotion` 反推该标签确定了哪一维系数，非优惠标签返回 undefined。
 *
 * 标签名本身是「计费比例」口径（`25%` = 按 25% 计费），对用户不够直观，悬停时给出「下载量按 x% 计算 /
 * 上传量 ×2 / 不计流量」这类解释。注意**不要**把它塞进 `tagFilterBindings()` 的 title：
 * 那个 title 是「点击筛选」的操作提示，两者不能互相覆盖。
 */
function tagTooltip(tag: ITorrentTag): string | undefined {
  const { downloadVolumeFactor, uploadVolumeFactor } = tagsToPromotion([tag]);
  const parts: string[] = [];

  if (downloadVolumeFactor !== undefined) {
    parts.push(
      downloadVolumeFactor === 0
        ? t("SearchEntity.index.tagTooltip.freeDownload")
        : t("SearchEntity.index.tagTooltip.downloadPercent", [Math.round(downloadVolumeFactor * 100)]),
    );
  }

  if (uploadVolumeFactor !== undefined && uploadVolumeFactor !== 1) {
    parts.push(
      uploadVolumeFactor === 0
        ? t("SearchEntity.index.tagTooltip.noUpload")
        : t("SearchEntity.index.tagTooltip.uploadTimes", [uploadVolumeFactor]),
    );
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** 预先算好每个标签的释义，避免模板里 v-if / :title 各算一次、每行每标签跑一遍正则 */
const tagTooltips = computed<Record<string, string | undefined>>(() => {
  const map: Record<string, string | undefined> = {};
  for (const tag of item.tags ?? []) {
    map[tag.name] = tagTooltip(tag);
  }
  return map;
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

/**
 * 标签「点击筛选」的绑定项。
 *
 * tagFilterable 为 false（默认）时返回空对象：DownloadHistory、content-script 等复用点里的标签
 * 保持纯展示，不会多出 class / role / tabindex / title，更不会挂上事件监听。
 * 用 v-bind 的对象写法而不是 `@click` + 内部判断，正是为了在关闭时连监听都不挂。
 */
function tagFilterBindings(tagName: string) {
  if (!tagFilterable) return {};

  const filtered = activeTagNames.includes(tagName);
  return {
    class: ["ptd-torrent-tag--filterable", ...(filtered ? ["ptd-torrent-tag--filtered"] : [])],
    role: "button",
    tabindex: 0,
    "aria-pressed": filtered,
    title: t(filtered ? "SearchEntity.index.tagFilterActiveHint" : "SearchEntity.index.tagFilterHint", [tagName]),
    onClick: () => emit("filter-tag", tagName),
    onKeydown: (event: KeyboardEvent) => {
      // 键盘可操作性：Enter / Space 与鼠标点击等价（阻止 Space 的滚动默认行为）
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        emit("filter-tag", tagName);
      }
    },
  };
}

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
  // D2-Medium-02 孪生：同一个标题连点两次「搜索同名」时，query 完全相同会被 vue-router
  // 判成重复导航、`SearchEntity` 的 watch 不触发；加 nonce 保证每次点击都是一次新导航。
  const toRoute = { name: "SearchEntity", query: { search: `${site}|${sid}`, flush: 1, t: Date.now() } };

  if (configStore.searchEntifyControl.socialInformationSearchOnNewTab) {
    window.open(router.resolve(toRoute).href, "_blank");
  } else {
    void router.push(toRoute);
  }
}

function canAdvanceSearch(site: TSupportSocialSite) {
  return site !== "tmdb";
}

/** 标题的展示文本（通过 content-script 拖拽等方式获取的不完整种子可能只有 url / link） */
const titleText = computed(() => item.title ?? item.url ?? item.link ?? "");

/** 标题超长时的显示方式，见 设置 - 搜索 - 种子标题显示方式 */
const titleDisplayMode = computed<"end" | "middle" | "scroll">(() => {
  const mode = configStore.searchEntifyControl.titleDisplayMode;
  return mode === "middle" || mode === "scroll" ? mode : "end";
});

/**
 * 中间省略时尾部保留的字符数：尾部用于查看小组等后缀，宽屏多留一些；
 * 窄屏下标题列只有 32vw，缩短尾部以免把标题开头挤没。
 */
const middleTailLength = computed(() => (display.smAndDown.value ? 14 : 24));

/**
 * 把标题切成「开头 + 结尾」两段，切点尽量落在分隔符上，避免把小组名等后缀切成两半。
 * 空间充足时两段会原样拼回完整标题，不需要额外的省略号。
 */
const middleTitleParts = computed(() => {
  const text = titleText.value;
  const tailLength = middleTailLength.value;
  if (text.length <= tailLength + 8) {
    return { head: text, tail: "" };
  }

  let splitAt = text.length - tailLength;
  const separatorOffset = text.slice(splitAt, splitAt + 8).search(/[\s._()[\]-]/);
  if (separatorOffset !== -1) {
    splitAt += separatorOffset;
  }

  // 两段是独立的 flex item，若切点落在空白上，普通空格会被 CSS 折叠掉（短标题不需省略时也会丢空格）。
  // 把整段空白留给 head（配合 .torrent-title__title-head 的 white-space: pre 保留行尾空格），tail 从下一个非空白字符开始。
  while (splitAt < text.length && /\s/.test(text[splitAt])) {
    splitAt++;
  }
  if (splitAt >= text.length) {
    return { head: text, tail: "" };
  }

  return { head: text.slice(0, splitAt), tail: text.slice(splitAt) };
});

/** 滚动模式的时长：标题越长滚得越久，但一次完整滚动控制在 2–5 秒内 */
const scrollDuration = computed(() => `${Math.min(5, Math.max(2, Math.round(titleText.value.length / 20)))}s`);
</script>

<template>
  <div class="torrent-title" :style="{ maxWidth, minWidth: 0 }">
    <!-- 种子自带的封面：缩略图与标题/副标题同列，悬停显示大图 -->
    <div v-if="showCover" class="torrent-title__cover-wrap">
      <a-popover placement="right" trigger="hover">
        <template #content>
          <a-image
            :src="item.cover"
            :preview="false"
            alt=""
            class="torrent-title__cover-preview"
            :style="{
              display: 'block',
              width: 'auto',
              height: 'auto',
              maxWidth: '60vw',
              maxHeight: 'min(55vh, 720px)',
              objectFit: 'contain',
            }"
          />
        </template>
        <a-image
          :src="item.cover"
          :preview="false"
          alt=""
          class="torrent-title__cover"
          :width="30"
          :height="43"
          :style="{ objectFit: 'cover', borderRadius: '4px' }"
          @error="coverError = true"
        />
      </a-popover>
    </div>

    <div class="torrent-title__content">
      <!-- 种子主标题信息 -->
      <a-flex align="center" wrap="nowrap">
        <a-tooltip
          :title="titleText"
          placement="topLeft"
          :overlay-style="{ maxWidth: 'min(60vw, 600px)' }"
          :overlay-inner-style="{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }"
        >
          <span class="torrent-title__main">
            <a-typography-link
              :href="item.url"
              rel="noopener noreferrer nofollow"
              :class="{
                'torrent-title__link--middle': titleDisplayMode === 'middle' && !!middleTitleParts.tail,
                'torrent-title__link--scroll': titleDisplayMode === 'scroll',
              }"
              class="torrent-title__link"
              target="_blank"
            >
              <template v-if="titleDisplayMode === 'middle' && middleTitleParts.tail">
                <span class="torrent-title__title-head">{{ middleTitleParts.head }}</span>
                <span class="torrent-title__title-tail"
                  ><bdi>{{ middleTitleParts.tail }}</bdi></span
                >
              </template>
              <span
                v-else-if="titleDisplayMode === 'scroll'"
                class="torrent-title__title-scroll-inner"
                :style="{ animationDuration: scrollDuration }"
                >{{ titleText }}</span
              >
              <template v-else>{{ titleText }}</template>
            </a-typography-link>
          </span>
        </a-tooltip>

        <!-- 种子的媒体信息 -->
        <div class="torrent-title__social">
          <template v-if="showSocial && configStore.searchEntifyControl.showSocialInformation">
            <template v-for="(meta, key) in socialBuildUrlMap" :key="key">
              <!--
              不要移除 mouse-leave-delay：卡片里是可点击的（搜索 / 访问），而激活它的头像只有 20px，
              指针斜向移向卡片的过程中必然先离开头像；antd 默认 0.1s 后关闭，稍慢移动就会超时。
              这里留出 0.8s，指针进入卡片后即可取消关闭（上游 #1580 / #1582 同类问题）。
            -->
              <a-dropdown
                v-if="item[`ext_${key}`]"
                :mouse-leave-delay="0.8"
                :trigger="['hover']"
                placement="bottomRight"
              >
                <a-avatar
                  :size="20"
                  :src="`/icons/social/${key}.png`"
                  shape="square"
                  class="torrent-title__social-avatar"
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
                    class="torrent-title__card"
                  >
                    <div class="torrent-title__card-inner">
                      <a-typography-title
                        v-if="socialInformation[key]?.loading === true"
                        :level="5"
                        class="torrent-title__card-heading"
                      >
                        Loading....
                      </a-typography-title>
                      <template v-else-if="socialInformation[key]?.id">
                        <a-image
                          :fallback="'/icons/movie_placeholder.png'"
                          :height="225"
                          :preview="false"
                          :src="socialInformation[key]?.poster"
                          class="torrent-title__poster"
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
                        class="torrent-title__card-heading torrent-title__card-heading--error"
                      >
                        {{ t("MyClient.state.error") }}
                      </a-typography-title>
                      <a-typography-title v-else :level="5" class="torrent-title__card-heading">{{
                        t("common.noInformation")
                      }}</a-typography-title>

                      <template v-if="canAdvanceSearch(key as TSupportSocialSite)">
                        <a-divider class="torrent-title__divider" />
                        <a-button
                          block
                          type="text"
                          @click="doAdvanceSearch(key as TSupportSocialSite, item[`ext_${key}`] as string)"
                        >
                          <template #icon><SearchOutlined /></template>
                          {{ t("common.search") }}
                        </a-button>
                      </template>

                      <a-divider class="torrent-title__divider" />
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
                      <a-divider class="torrent-title__divider" />
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
        <div class="torrent-title__tags">
          <template v-if="configStore.searchEntifyControl.showTorrentTag && item.tags && item.tags.length > 0">
            <!-- M-30：按标签自带颜色渲染（tags.ts 的 31 个预定义标签 + 站点页面抓到的真实底色），
               统一中性色会让免费/2x/H&R/官方等标签无法一眼区分 -->
            <!-- 优惠标签：悬停给出「按 x% 计费 / 上传 ×2」的释义（非优惠标签没有释义，不额外挂 Tooltip 组件） -->
            <template v-for="tag in displayedTags" :key="tag.name">
              <a-tooltip v-if="tagTooltips[tag.name]" :title="tagTooltips[tag.name]" placement="top">
                <a-tag
                  v-bind="tagFilterBindings(tag.name)"
                  :color="resolveColor(tag.color) ?? 'default'"
                  class="torrent-title__tag"
                >
                  {{ tag.name }}
                </a-tag>
              </a-tooltip>
              <a-tag
                v-else
                v-bind="tagFilterBindings(tag.name)"
                :color="resolveColor(tag.color) ?? 'default'"
                class="torrent-title__tag"
              >
                {{ tag.name }}
              </a-tag>
            </template>
            <a-tag v-if="hasMoreTags" color="default" class="torrent-title__tag" @click="tagsExpanded = true">
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
  </div>
</template>

<style scoped>
/*
 * 原先 27 处静态行内样式按语义收敛到这里（`:style` 动态绑定保持原样）：
 * 既让模板可读，也避免同一组「省略号 / 社交卡片」样式在每个复用点各写一遍却可能写歪。
 */
.torrent-title__main {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.torrent-title__link {
  font-size: 16px;
}

.torrent-title__social {
  flex: 0 0 auto;
  margin-left: 8px;
}

.torrent-title__social-avatar {
  margin-left: 4px;
  cursor: pointer;
}

.torrent-title__card {
  width: 166px;
}

.torrent-title__card-inner {
  max-width: 150px;
  text-align: center;
}

.torrent-title__card-heading {
  margin: 8px 0;
}

.torrent-title__card-heading--error {
  font-size: var(--ptd-font-size, 13px);
}

.torrent-title__poster {
  margin-bottom: 4px;
  object-fit: cover;
}

.torrent-title__divider {
  margin: 4px 0;
}

.torrent-title__tags {
  flex: 0 0 auto;
}

.torrent-title__tag {
  margin-right: 4px;
}

/* 种子自带封面：缩略图与内容列并排，悬停显示按视口高度缩放的大图 */
.torrent-title {
  display: flex;
  align-items: center;
  min-width: 0;
}

.torrent-title__content {
  flex: 1 1 auto;
  min-width: 0;
}

.torrent-title__cover-wrap {
  flex: 0 0 auto;
  margin-right: 6px;
}

/* 影视剧海报常见 2:3（876 × 1314）：高度固定 43px，宽度取比例与最小 30px 中的较大值。
 * 尺寸与圆角通过 a-image 的 width/height/style 传入（落到内部 <img> 上），
 * 避免被 antd 自带的 .ant-image-img { width: 100%; height: auto } 覆盖。 */
.torrent-title__cover {
  cursor: zoom-in;
}

.torrent-title__cover-preview {
  display: block;
}

/* 中间省略：开头可收缩并在末尾显示省略号，结尾（小组后缀）固定保留 */
.torrent-title__link--middle {
  display: flex;
  align-items: baseline;
  min-width: 0;
}

.torrent-title__title-head {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre;
}

.torrent-title__title-tail {
  flex: 0 0 auto;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
}

.torrent-title__title-tail > bdi {
  direction: ltr;
}

/* 滚动：默认隐藏超出部分，悬停时按标题长度往返滚动 */
.torrent-title__link--scroll {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  container-type: inline-size;
}

.torrent-title__title-scroll-inner {
  display: inline-block;
  min-width: 100%;
  white-space: nowrap;
}

.torrent-title__link--scroll:hover .torrent-title__title-scroll-inner {
  animation: torrent-title-scroll 12s linear infinite alternate;
}

@keyframes torrent-title-scroll {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(calc(-100% + 100cqw));
  }
}

/* 尊重系统的「减少动态效果」：不滚动，退回末端省略 */
@media (prefers-reduced-motion: reduce) {
  .torrent-title__link--scroll {
    text-overflow: ellipsis;
  }

  .torrent-title__link--scroll:hover .torrent-title__title-scroll-inner {
    animation: none;
  }

  .torrent-title__title-scroll-inner {
    display: inline;
    min-width: 0;
    animation: none;
  }
}
</style>
