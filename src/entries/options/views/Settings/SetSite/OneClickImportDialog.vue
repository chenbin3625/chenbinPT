<script setup lang="ts">
import {
  CheckCircleOutlined,
  CheckOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  ExclamationCircleOutlined,
  QuestionCircleOutlined,
  SisternodeOutlined,
  SyncOutlined,
} from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import { type Component, computed, nextTick, ref, shallowRef, watch } from "vue";
import { EResultParseStatus, ISiteMetadata, ISiteUserConfig, TSiteID } from "@ptd/site";

import { resolveColor } from "@/shared/colors.ts";
import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useResetableRef } from "@/options/directives/useResetableRef.ts";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import CheckSwitchButton from "@/options/components/CheckSwitchButton.vue";
import LazyMount from "@/options/components/LazyMount.vue";
import PageSkeleton from "@/options/components/PageSkeleton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

import { iterateCanAddedSiteMetadata } from "./utils.ts";

const showDialog = defineModel<boolean>();

interface IImportStatus {
  isWorking: boolean;
  toWork: TSiteID[];
  working: TSiteID;
  success: TSiteID[];
  failed: TSiteID[];
}

const { ref: importStatus, reset: resetImportStatus } = useResetableRef<IImportStatus>(() => ({
  isWorking: false,
  toWork: [],
  working: "",
  success: [],
  failed: [],
}));

const { t } = useI18n();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

// 待添加的站点列表：站点定义是一个站点一个 chunk 的动态 import，读满一批就先渲染一批（见 utils.ts）
const canAddSites = shallowRef<ISiteMetadata[]>([]);
// 加载期间：一条都还没读到时用骨架屏占位，读到一部分后在标题栏显示进度
const isLoadingCanAddSites = ref<boolean>(false);

// 每读满这么多条刷新一次列表，避免 300+ 条时触发 300+ 次全量重渲染
const SITE_LIST_FLUSH_STEP = 16;

// 卡片高度（ptd-list-item 两行 + 内边距），供 LazyMount 占位使用，避免懒加载过程中滚动条来回抖动
const SITE_CARD_MIN_HEIGHT = 72;

const siteMetadataById = computed(
  () => new Map<TSiteID, ISiteMetadata>(canAddSites.value.map((site) => [site.id, site])),
);

// 是否把 public 站点也列出来（public 站点不经过搜索校验就会被直接添加，所以默认不列）
const includePublicSite = ref<boolean>(false);

// 开关直接决定列表里有没有 public 站点的卡片：不显示即不参与「全选」，也不参与导入
const displayedSites = computed(() =>
  includePublicSite.value ? canAddSites.value : canAddSites.value.filter((site) => site.type === "private"),
);

// 供开关的 label 显示，否则这类站点被默认藏起来后完全看不出存在
const publicSiteCount = computed(() => canAddSites.value.filter((site) => site.type === "public").length);

watch(includePublicSite, (include) => {
  if (include) return;
  // 关掉开关后 public 卡片会消失，已选中的也要一并移出「已选择」，避免看不见却被导入
  importStatus.value.toWork = importStatus.value.toWork.filter(
    (siteId) => siteMetadataById.value.get(siteId)?.type !== "public",
  );
});

// 每次打开 dialog 递增，用来丢弃上一次尚未读完的加载
let siteListLoadToken = 0;

// 模板里每张卡片都要查「是否已选中/已成功/已失败」，用 Set 代替 Array.includes 的 O(n) 扫描
const toWorkSiteIds = computed(() => new Set(importStatus.value.toWork));
const successSiteIds = computed(() => new Set(importStatus.value.success));
const failedSiteIds = computed(() => new Set(importStatus.value.failed));

// 「全选」的可选范围：当前列出的站点里，不需要手动录入、也还没导入成功的那些
const selectableSiteIds = computed(() =>
  displayedSites.value
    .filter((site) => !site.userInputSettingMeta && !successSiteIds.value.has(site.id))
    .map((site) => site.id),
);

type TStatusIconProp = { icon: Component; color?: string; title: string };

const statusIconProp = (site: TSiteID): TStatusIconProp => {
  if (siteMetadataById.value.get(site)?.userInputSettingMeta) {
    // 需要手动添加
    return {
      icon: CloseCircleOutlined,
      color: "purple",
      title: t("SetSite.oneClickImportDialog.status.manual"),
    };
  }
  if (importStatus.value.working === site) {
    // 正在尝试中
    return { icon: SyncOutlined, color: "blue", title: t("SetSite.oneClickImportDialog.status.trying") };
  }
  if (successSiteIds.value.has(site)) {
    // 已添加成功
    return { icon: CheckCircleOutlined, color: "green", title: t("SetSite.oneClickImportDialog.status.success") };
  }
  if (failedSiteIds.value.has(site)) {
    // 添加失败
    return { icon: ExclamationCircleOutlined, color: "red", title: t("SetSite.oneClickImportDialog.status.failed") };
  }
  if (toWorkSiteIds.value.has(site)) {
    // 已选择
    return { icon: SisternodeOutlined, color: undefined, title: t("SetSite.oneClickImportDialog.status.selected") };
  }
  // 默认
  return { icon: QuestionCircleOutlined, color: "grey", title: "" };
};

function toggleToWork(siteId: TSiteID, checked: boolean) {
  const current = importStatus.value.toWork;
  importStatus.value.toWork = checked
    ? Array.from(new Set([...current, siteId]))
    : current.filter((id) => id !== siteId);
}

async function doAutoImport() {
  importStatus.value.isWorking = true;
  importStatus.value.failed = [];

  // 遍历所有需要添加的站点，在遍历过程中我们不更新 siteHostMap 和 siteNameMap
  for (const site of importStatus.value.toWork) {
    if (successSiteIds.value.has(site)) {
      continue; // 如果已经添加成功，则跳过
    }

    importStatus.value.working = site;

    try {
      let isThisSiteSuccess = false;

      // 拿到 siteMetadata, siteUserConfig
      const siteMetadata = siteMetadataById.value.get(site) as ISiteMetadata;
      const siteUserConfig = (await metadataStore.getSiteUserConfig(site, true)) as ISiteUserConfig;

      // 对于 public 站点，不需要额外测试是否能够搜索
      if (siteMetadata.type === "public") {
        // 直接将该站点设置存入 metadataStore
        await metadataStore.addSite(site, siteUserConfig, { reBuildMap: false }); // 抑制 site{Name, Host}Map 更新
        isThisSiteSuccess = true;
      } else {
        // 遍历所有 private site 预设的 urls ，找到用户实际使用的 url
        for (const siteUrl of siteMetadata.urls) {
          siteUserConfig.url = siteUrl;
          // 临时将该设置存入 metadataStore
          await metadataStore.addSite(site, siteUserConfig, { reBuildMap: false });
          const { status: testStatus } = await sendMessage("getSiteSearchResult", { siteId: site });
          if (testStatus === EResultParseStatus.success) {
            isThisSiteSuccess = true; // 如果搜索成功，说明该站点可以自动添加
            break;
          }
        }
      }

      if (isThisSiteSuccess) {
        importStatus.value.success.push(site);
      } else {
        importStatus.value.failed.push(site);
        // 如果搜索失败，说明该站点不能自动添加，移除在 metadataStore 中临时添加的配置项
        await metadataStore.removeSite(site, { reBuildMap: false });
      }
    } catch (e) {
      importStatus.value.failed.push(site);
      // OPTIONSSETTINGS-4：sendMessage 抛错时上面的 addSite 已把站点写进 store 并排入落盘，
      // 若只标记失败不回滚，界面上「添加失败」的站点其实已被添加（刷新后仍在列表里）。
      try {
        await metadataStore.removeSite(site, { reBuildMap: false });
      } catch {
        // 回滚失败不阻断后续站点：该站点的 failed 标记已经可见，用户可自行删除
      }
    }
  }

  importStatus.value.working = "";
  importStatus.value.isWorking = false;
  importStatus.value.toWork = [];

  // 所有导入完成，重构 site{Host, Name}Map
  await metadataStore.buildSiteMapCache(true);

  runtimeStore.showSnakebar(
    t("SetSite.oneClickImportDialog.importComplete", { count: importStatus.value.success.length }),
    { color: "success" },
  );
}

async function dialogEnter() {
  resetImportStatus(); // 重置状态
  canAddSites.value = [];
  includePublicSite.value = false;

  const token = ++siteListLoadToken;
  isLoadingCanAddSites.value = true;

  const loadedSites: ISiteMetadata[] = [];
  try {
    for await (const siteMetadata of iterateCanAddedSiteMetadata()) {
      if (token !== siteListLoadToken) return; // 已经被下一次打开接管，放弃这一轮追加
      if (siteMetadata.isDead) continue; // 已离线的站点不参与导入

      loadedSites.push(siteMetadata);
      if (loadedSites.length % SITE_LIST_FLUSH_STEP === 0) {
        canAddSites.value = [...loadedSites];
      }
    }

    if (token === siteListLoadToken) {
      canAddSites.value = [...loadedSites];
    }
  } finally {
    if (token === siteListLoadToken) {
      isLoadingCanAddSites.value = false;
    }
  }
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-button-props="{ disabled: importStatus.isWorking }"
    :cancel-text="t('common.dialog.cancel')"
    :closable="!importStatus.isWorking"
    :keyboard="!importStatus.isWorking"
    :mask-closable="!importStatus.isWorking"
    :ok-button-props="{ disabled: importStatus.isWorking }"
    :ok-text="t('common.import')"
    :title="t('SetSite.oneClickImportDialog.title')"
    :width="1000"
    @ok="doAutoImport"
  >
    <a-alert :message="t('SetSite.oneClickImportDialog.alert1')" show-icon style="margin-bottom: 8px" type="warning" />

    <div class="ptd-section-heading">
      <span>
        {{ t("SetSite.oneClickImportDialog.alert2") }}
        <a-typography-text type="secondary" style="margin-left: 8px">
          {{
            t("SetSite.oneClickImportDialog.stats", {
              count: importStatus.toWork.length,
              success: importStatus.success.length,
              failed: importStatus.failed.length,
            })
          }}
          <span v-if="importStatus.isWorking">
            {{ t("SetSite.oneClickImportDialog.trying", { name: siteMetadataById.get(importStatus.working)?.name }) }}
          </span>
          <span v-else-if="isLoadingCanAddSites" class="one-click-import__loading">
            <a-spin size="small" />
            {{ t("SetSite.oneClickImportDialog.loading", { loaded: displayedSites.length }) }}
          </span>
        </a-typography-text>
      </span>
      <a-flex align="center" :gap="8" wrap="wrap">
        <a-tooltip :title="t('SetSite.oneClickImportDialog.includePublicSiteHint')">
          <label class="one-click-import__public-switch">
            <a-switch v-model:checked="includePublicSite" :disabled="importStatus.isWorking" size="small" />
            {{ t("SetSite.oneClickImportDialog.includePublicSite", { count: publicSiteCount }) }}
          </label>
        </a-tooltip>
        <!-- A-27：原 color="blue-lighten-1" / variant="tonal" 都不是 antd 语义，改用低强调的 text 按钮 -->
        <CheckSwitchButton v-model="importStatus.toWork" :all="selectableSiteIds" :size="undefined" type="text" />
      </a-flex>
    </div>

    <!-- 一条都还没读到时用卡片骨架占位，避免把「尚未加载完」误显示为「无数据」；读到后边读边渲染 -->
    <PageSkeleton v-if="isLoadingCanAddSites && !displayedSites.length" :count="6" :rows="2" variant="masonry" />
    <NoDataPlaceholder v-else-if="!displayedSites.length" />
    <a-list v-else style="overflow: hidden; padding: 12px 12px 0 12px">
      <!-- 站点卡片间距由列上的 pa-1 控制，行容器保持零间距 -->
      <a-row :gutter="0">
        <a-col v-for="site in displayedSites" :key="site.id" :md="8" :sm="12" :xs="24" style="padding: 4px">
          <!-- 300+ 张卡片一次性挂载，会连带触发 300+ 次 favicon 查询（未添加的站点基本都没缓存，
               会真的去请求站点首页抓 icon），所以只在卡片进入视口后才渲染 -->
          <LazyMount :min-height="SITE_CARD_MIN_HEIGHT">
            <a-list-item
              class="ptd-list-item"
              style="
                border-bottom: 1px solid var(--ptd-border, rgba(5, 5, 5, 0.06));
                background: var(--ptd-hover, #f5f5f5);
              "
            >
              <a-list-item-meta>
                <template #avatar>
                  <a-flex align="center" :gap="8">
                    <a-checkbox
                      :checked="toWorkSiteIds.has(site.id)"
                      :disabled="!!site.userInputSettingMeta || importStatus.isWorking || successSiteIds.has(site.id)"
                      :indeterminate="!!site.userInputSettingMeta || successSiteIds.has(site.id)"
                      @update:checked="(checked: boolean) => toggleToWork(site.id, checked)"
                    >
                      <CheckOutlined v-if="successSiteIds.has(site.id)" />
                      <CloseOutlined v-else-if="site.userInputSettingMeta" />
                    </a-checkbox>
                    <SiteFavicon :site-id="site.id" flush-on-click style="margin-right: 8px" />
                  </a-flex>
                </template>

                <template #title>
                  <strong>{{ site.name ?? "" }}</strong>
                </template>

                <template #description>
                  <a-tag :color="site.type === 'private' ? resolveColor('primary') : resolveColor('secondary')">
                    {{ site.schema ?? (site.type === "private" ? "AbstractPrivateSite" : "AbstractBittorrentSite") }}
                  </a-tag>
                </template>
              </a-list-item-meta>

              <a-typography-link :href="site.urls[0]" rel="noopener noreferrer nofollow" target="_blank">
                <component
                  :is="statusIconProp(site.id).icon"
                  :style="{
                    color: resolveColor(statusIconProp(site.id).color),
                    fontSize: '24px',
                    marginRight: '8px',
                  }"
                  :title="statusIconProp(site.id).title"
                />
              </a-typography-link>
            </a-list-item>
          </LazyMount>
        </a-col>
      </a-row>
    </a-list>
  </a-modal>
</template>

<style scoped>
.one-click-import__loading {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
}

.one-click-import__public-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  white-space: nowrap;
}
</style>
