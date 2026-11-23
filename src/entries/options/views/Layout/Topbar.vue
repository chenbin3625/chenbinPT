<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { BulbFilled, BulbOutlined, DesktopOutlined, DownOutlined, SearchOutlined } from "@ant-design/icons-vue";

import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

import { siteMetadataIndex } from "@ptd/site/metadataIndex";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import SiteName from "@/options/components/SiteName.vue";
import RecommendationMenu from "./RecommendationMenu.vue";
import { useDisplay } from "@/options/composables/useDisplay.ts";

const route = useRoute();
const router = useRouter();
const display = useDisplay();
const { t } = useI18n();

const configStore = useConfigStore();
const metadataStore = useMetadataStore();

const searchKey = ref<string>("");
const searchPlanKey = ref<string>("default");
const searchInputRef = ref<{ focus?: () => void; blur?: () => void; input?: HTMLInputElement | null } | null>(null);
const isSearchFocused = ref(false);

const currentTheme = computed<"auto" | "light" | "dark">(() => {
  const mode = configStore.theme;
  return mode === "light" || mode === "dark" ? mode : "auto";
});

const themeTitle = computed(
  () => `${t("SetBase.ui.displayMode.index")}: ${t(`SetBase.ui.displayMode.${currentTheme.value}`)}`,
);

function selectTheme({ key }: { key: string | number }) {
  const next = String(key);
  if (next === "auto" || next === "light" || next === "dark") {
    configStore.theme = next;
    void configStore.$save?.();
  }
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function focusSearchInput() {
  const instance = searchInputRef.value;
  const input = instance?.input ?? document.querySelector<HTMLInputElement>("#ptd-topbar .ptd-search-key input");
  if (input) {
    input.focus();
    input.select();
  } else {
    instance?.focus?.();
  }
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === "k") {
    event.preventDefault();
    focusSearchInput();
    return;
  }
  if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditableElement(event.target)) {
    event.preventDefault();
    focusSearchInput();
  }
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    (event.target as HTMLInputElement | null)?.blur?.();
    searchInputRef.value?.blur?.();
  }
}

onMounted(() => window.addEventListener("keydown", onGlobalKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKeydown));
/**
 * 防重复提交只覆盖「导航尚未完成」这一小段时间。
 *
 * 旧实现把「搜索正在进行」也算进禁用态：用户想换个关键词重搜时必须先回搜索页点「取消」，
 * 否则回车、搜索按钮、热门推荐全部无效。而新一轮 flush 搜索本身已经会作废旧轮次与旧队列
 * （见 SearchEntity/utils/search.ts 的 epoch 机制），搜索中再搜是安全且有价值的操作。
 */
const isSubmittingSearch = ref(false);

const searchPlans = computed(() =>
  metadataStore.getSearchSolutions
    .filter((x) => !!x.enabled) // 过滤掉未启用的搜索方案
    .sort((a, b) => (b.sort ?? 0) - (a.sort ?? 0)) // 按照 sort 降序排序（缺失 sort 视为 0，避免 NaN 打乱顺序）
    .map((x) => ({
      id: x.id,
      name: x.name,
    })),
);

/**
 * 单个站点搜索方案中可搜索的站点ID列表。
 * 过滤条件为 allowSearch 开启 且 非 isOffline 且 站点定义非 isDead，
 * 与 getSiteDefaultSearchSolution 的过滤条件（isOffline || isDead 不返回搜索方案）相比，
 * 额外排除了未开启搜索的站点（与原菜单项的 allowSearch 判断保持一致）。
 * refs: https://github.com/chenbin3625/chenbinPT/issues/1083
 *
 * 只需要 isDead，所以直接查构建期轻量索引（虚拟模块，见 vite/plugin/generateSiteIndex.ts）：
 * 这里是 immediate + deep watch，原来每触发一次都要为每个已添加站点解析一遍完整站点定义。
 */
const singleSearchSiteIds = ref<string[]>([]);

function refreshSingleSearchSiteIds() {
  singleSearchSiteIds.value = metadataStore.getSortedAddedSites
    .filter((siteUserConfig) => (siteUserConfig.allowSearch ?? false) && !siteUserConfig.isOffline)
    .filter((siteUserConfig) => !siteMetadataIndex[siteUserConfig.id]?.isDead)
    .map((siteUserConfig) => siteUserConfig.id);
}

// 监听整个已添加站点配置（而非仅ID列表），使站点编辑器中切换 allowSearch/isOffline 后菜单同步刷新
watch(() => metadataStore.getAddedSites, refreshSingleSearchSiteIds, { immediate: true, deep: true });

async function startSearchEntity() {
  if (isSubmittingSearch.value) return;
  isSubmittingSearch.value = true;
  try {
    await router.push({
      name: "SearchEntity",
      query: {
        search: searchKey.value,
        plan: searchPlanKey.value,
        flush: 1,
        // D2-Medium-02：加一个单调递增的 nonce。同一关键词/方案再次搜索时，若 query 完全相同，
        // vue-router 会把它当成重复导航直接丢弃 → `SearchEntity` 的 `watch(route.query)` 不触发，
        // 用户看到的是「点搜索/回车没有任何反应」。nonce 让每次导航都是不同的 location。
        t: Date.now(),
      },
    });
  } finally {
    isSubmittingSearch.value = false;
  }
}

function onSearchEnter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  void startSearchEntity();
}

function searchRecommendation(title: string) {
  searchKey.value = title;
  void startSearchEntity();
}

watch(
  () => route.query,
  (newQuery) => {
    if (typeof newQuery.search === "string") {
      searchKey.value = newQuery.search;
    }
    if (typeof newQuery.plan === "string") {
      searchPlanKey.value = newQuery.plan;
    }
  },
  { immediate: true },
);

const searchPlanLabel = computed(() => {
  if (searchPlanKey.value == "default") {
    return t("layout.header.searchPlan.default");
  }
  if (searchPlanKey.value.startsWith("site:")) {
    const siteId = searchPlanKey.value.slice(5);
    return metadataStore.siteNameMap?.[siteId] ?? siteId;
  }
  return metadataStore.getSearchSolutionName(searchPlanKey.value);
});

function selectSearchPlan({ key }: { key: string | number }) {
  searchPlanKey.value = String(key);
}
</script>

<template>
  <a-layout-header id="ptd-topbar">
    <!--
      折叠/展开导航栏已改用 antd 侧栏（a-layout-sider）原生的折叠触发器，见 Navigation.vue；
      原顶栏自绘的折叠按钮已移除（窄屏展开入口同样由原生的零宽悬浮按钮提供）。
    -->
    <div class="ptd-topbar-title ptd-inline-center">
      <a-avatar alt="logo" :size="24" shape="square" src="/icons/logo/64.png" />
      <span v-show="display.smAndUp.value">{{ t("manifest.extName") }}</span>
    </div>

    <!-- 快捷主题切换（置于标题右侧，不影响搜索栏贴右与热门推荐气泡锚点） -->
    <a-dropdown :trigger="['click']" placement="bottomLeft">
      <a-button
        aria-haspopup="menu"
        :aria-label="themeTitle"
        :title="themeTitle"
        class="ptd-topbar-theme-btn"
        type="text"
      >
        <template #icon>
          <BulbFilled v-if="currentTheme === 'dark'" />
          <BulbOutlined v-else-if="currentTheme === 'light'" />
          <DesktopOutlined v-else />
        </template>
      </a-button>
      <template #overlay>
        <a-menu :selected-keys="[currentTheme]" @click="selectTheme">
          <a-menu-item key="auto">
            <span class="ptd-topbar-theme-item">
              <DesktopOutlined />
              {{ t("SetBase.ui.displayMode.auto") }}
            </span>
          </a-menu-item>
          <a-menu-item key="light">
            <span class="ptd-topbar-theme-item">
              <BulbOutlined />
              {{ t("SetBase.ui.displayMode.light") }}
            </span>
          </a-menu-item>
          <a-menu-item key="dark">
            <span class="ptd-topbar-theme-item">
              <BulbFilled />
              {{ t("SetBase.ui.displayMode.dark") }}
            </span>
          </a-menu-item>
        </a-menu>
      </template>
    </a-dropdown>

    <!-- 搜索输入框 -->
    <a-space-compact class="ptd-search-input">
      <!-- 搜索方案选择框 -->
      <a-dropdown :trigger="['click']">
        <a-button aria-haspopup="menu" class="ptd-search-plan-btn" :title="searchPlanLabel">
          <span class="ptd-search-plan-label">{{ searchPlanLabel }}</span>
          <DownOutlined />
        </a-button>
        <template #overlay>
          <a-menu :selected-keys="[searchPlanKey]" @click="selectSearchPlan">
            <!-- 默认搜索方案 -->
            <a-menu-item key="default">
              {{ t("layout.header.searchPlan.default") }}
              <span class="ptd-search-plan-subtitle">
                &lt;{{
                  metadataStore.defaultSolutionId !== "default"
                    ? metadataStore.getSearchSolutionName(metadataStore.defaultSolutionId)
                    : t("layout.header.searchPlan.all")
                }}&gt;
              </span>
            </a-menu-item>

            <!-- 全部站点搜索方案（仅当默认搜索不是全部站点时出现） -->
            <a-menu-item v-if="metadataStore.defaultSolutionId !== 'default'" key="all">
              {{ t("layout.header.searchPlan.all") }}
            </a-menu-item>

            <!-- 单个站点搜索方案 -->
            <a-sub-menu
              v-if="configStore.searchEntity.allowSingleSiteSearch"
              key="singleSite"
              :title="t('layout.header.searchPlan.singleSite')"
            >
              <template v-for="siteMetadata in metadataStore.getSortedAddedSites" :key="siteMetadata.id">
                <a-menu-item v-if="singleSearchSiteIds.includes(siteMetadata.id)" :key="`site:${siteMetadata.id}`">
                  <div class="ptd-single-site-item ptd-inline-center">
                    <SiteFavicon :site-id="siteMetadata.id" :size="16" />
                    <SiteName :site-id="siteMetadata.id" class="" tag="span" />
                  </div>
                </a-menu-item>
              </template>
            </a-sub-menu>

            <a-menu-divider />

            <!-- 用户自定义的搜索方案列表 -->
            <a-menu-item v-for="item in searchPlans" :key="item.id">
              {{ metadataStore.getSearchSolutionName(item.id) }}
            </a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>

      <a-input
        ref="searchInputRef"
        v-model:value="searchKey"
        :aria-label="t('common.search')"
        :placeholder="t('layout.header.searchTip')"
        allow-clear
        class="ptd-search-key"
        enterkeyhint="search"
        @blur="isSearchFocused = false"
        @focus="isSearchFocused = true"
        @keydown="onSearchKeydown"
        @press-enter="onSearchEnter"
      >
        <template #suffix>
          <kbd
            v-if="display.smAndUp.value && !searchKey && !isSearchFocused"
            class="ptd-search-shortcut"
            aria-hidden="true"
            >/</kbd
          >
          <RecommendationMenu
            v-if="configStore.searchEntity.showHotRecommendations"
            :disabled="isSubmittingSearch"
            @search="searchRecommendation"
          />
        </template>
      </a-input>

      <!-- 搜索按键 -->
      <a-button
        :disabled="isSubmittingSearch"
        :loading="isSubmittingSearch"
        :aria-label="t('common.search')"
        :title="t('common.search')"
        type="primary"
        @click="startSearchEntity"
      >
        <template #icon><SearchOutlined /></template>
      </a-button>
    </a-space-compact>
  </a-layout-header>
</template>

<style lang="scss" scoped>
/*
 * 搜索方案按钮与搜索按钮是紧凑组里的固定控件：窄屏（420px）时应当由输入框让出宽度，
 * 而不是反过来把这两个按钮压扁 —— 图标按钮一旦被 flex 收缩，命中区域就会小于
 * 24px 的触控下限。antd 的 Space.Compact 没有「子项不收缩」的 prop，只能在这里声明。
 */
.ptd-search-plan-btn,
.ptd-search-input > .ant-btn {
  flex: 0 0 auto;
}

/*
 * 输入框后缀里的热门推荐入口是 size="small" 的 text 按钮。compact 算法下 sm 控件高度
 * 在不同版本里曾出现 21px（小于 24px 目标尺寸），显式固定为 24×24，窄屏也能稳定点中。
 */
.ptd-search-key :deep(.ant-btn-sm) {
  width: 24px;
  min-width: 24px;
  height: 24px;
  padding-inline: 0;
}

.ptd-topbar-theme-btn {
  flex: 0 0 auto;
  width: 28px;
  min-width: 28px;
  height: 28px;
  padding-inline: 0;
  color: var(--ptd-text-secondary, rgba(0, 0, 0, 0.65));
}

.ptd-topbar-theme-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.ptd-search-shortcut {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid var(--ptd-border-strong, rgba(5, 5, 5, 0.15));
  border-radius: 4px;
  background: var(--ptd-surface-soft, rgba(0, 0, 0, 0.03));
  color: var(--ptd-text-tertiary, rgba(0, 0, 0, 0.45));
  font-family: inherit;
  font-size: 11px;
  line-height: 1;
  pointer-events: none;
  user-select: none;
}
</style>
