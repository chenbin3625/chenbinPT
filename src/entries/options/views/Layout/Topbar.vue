<script lang="ts" setup>
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { DownOutlined, SearchOutlined } from "@ant-design/icons-vue";

import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import SiteName from "@/options/components/SiteName.vue";
import RecommendationMenu from "./RecommendationMenu.vue";
import { useDisplay } from "@/options/composables/useDisplay.ts";
import { getCachedSiteMetadata } from "@/options/views/Overview/MyData/utils/siteMetadataCache.ts";

const route = useRoute();
const router = useRouter();
const display = useDisplay();
const { t } = useI18n();

const configStore = useConfigStore();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

const searchKey = ref<string>("");
const searchPlanKey = ref<string>("default");

const searchPlans = computed(() =>
  metadataStore.getSearchSolutions
    .filter((x) => !!x.enabled) // 过滤掉未启用的搜索方案
    .sort((a, b) => b.sort - a.sort) // 按照 sort 降序排序
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
 */
const singleSearchSiteIds = ref<string[]>([]);

let watchVersion = 0;
async function refreshSingleSearchSiteIds() {
  const currentVersion = ++watchVersion;
  const siteIds = await Promise.all(
    metadataStore.getSortedAddedSites
      .filter((siteUserConfig) => (siteUserConfig.allowSearch ?? false) && !siteUserConfig.isOffline)
      .map(async (siteUserConfig) => {
        // P1-21：站点定义走模块级 memo，避免每次刷新都重复动态 import + cloneDeep
        const siteMetadata = await getCachedSiteMetadata(siteUserConfig.id);
        return siteMetadata.isDead ? undefined : siteUserConfig.id;
      }),
  );
  if (currentVersion !== watchVersion) return; // stale, discard
  singleSearchSiteIds.value = siteIds.filter((id) => id !== undefined);
}

// 监听整个已添加站点配置（而非仅ID列表），使站点编辑器中切换 allowSearch/isOffline 后菜单同步刷新
watch(() => metadataStore.getAddedSites, refreshSingleSearchSiteIds, { immediate: true, deep: true });

function startSearchEntity() {
  router.push({
    name: "SearchEntity",
    query: {
      search: searchKey.value,
      plan: searchPlanKey.value,
      flush: 1,
    },
  });
}

function searchRecommendation(title: string) {
  searchKey.value = title;
  startSearchEntity();
}

watch(
  () => route.query,
  (newQuery) => {
    if (newQuery?.search && (newQuery.search as string) !== searchKey.value) {
      searchKey.value = newQuery.search as string;
    }
    if (newQuery?.plan && (newQuery.plan as string) !== searchPlanKey.value) {
      searchPlanKey.value = newQuery.plan as string;
    }
  },
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

    <!-- 搜索输入框 -->
    <a-space-compact class="ptd-search-input">
      <!-- 搜索方案选择框 -->
      <a-dropdown :trigger="['click']">
        <a-button class="ptd-search-plan-btn" type="primary">
          <span class="ptd-search-plan-label">{{ searchPlanLabel }}</span>
          <DownOutlined />
        </a-button>
        <template #overlay>
          <a-menu @click="selectSearchPlan">
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
        v-model:value="searchKey"
        :placeholder="t('layout.header.searchTip')"
        allow-clear
        class="ptd-search-key"
        enterkeyhint="search"
        @press-enter="startSearchEntity"
      >
        <template #suffix>
          <RecommendationMenu
            v-if="configStore.searchEntity.showHotRecommendations"
            :disabled="runtimeStore.search.isSearching"
            @search="searchRecommendation"
          />
        </template>
      </a-input>

      <!-- 搜索按键 -->
      <a-button :disabled="runtimeStore.search.isSearching" :title="t('common.search')" @click="startSearchEntity">
        <template #icon><SearchOutlined /></template>
      </a-button>
    </a-space-compact>
  </a-layout-header>
</template>
