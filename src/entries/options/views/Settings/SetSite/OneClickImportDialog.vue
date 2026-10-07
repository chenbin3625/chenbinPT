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
import { pickBy } from "es-toolkit";
import { isEmpty } from "es-toolkit/compat";
import { EResultParseStatus, ISiteMetadata, ISiteUserConfig, TSiteID } from "@ptd/site";

import { resolveColor } from "@/shared/colors.ts";
import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useResetableRef } from "@/options/directives/useResetableRef.ts";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import CheckSwitchButton from "@/options/components/CheckSwitchButton.vue";
import PageSkeleton from "@/options/components/PageSkeleton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

import { getCanAddedSiteMetadata } from "./utils.ts";

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

// 获取所有能添加的站点
const canAddSites = shallowRef<Record<TSiteID, ISiteMetadata>>({});
// 待添加站点需要逐个读取站点定义，加载期间用骨架屏占位而不是直接显示「无数据」
const isLoadingCanAddSites = ref<boolean>(false);

const realCanAutoAddSiteId = computed(() =>
  Object.values(canAddSites.value)
    .filter((x) => !x.userInputSettingMeta && x.type === "private")
    .map((x) => x.id),
);

type TStatusIconProp = { icon: Component; color?: string; title: string };

const statusIconProp = (site: TSiteID): TStatusIconProp => {
  if (canAddSites.value[site]?.userInputSettingMeta) {
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
  if (importStatus.value.success.includes(site)) {
    // 已添加成功
    return { icon: CheckCircleOutlined, color: "green", title: t("SetSite.oneClickImportDialog.status.success") };
  }
  if (importStatus.value.failed.includes(site)) {
    // 添加失败
    return { icon: ExclamationCircleOutlined, color: "red", title: t("SetSite.oneClickImportDialog.status.failed") };
  }
  if (importStatus.value.toWork.includes(site)) {
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
    if (importStatus.value.success.includes(site)) {
      continue; // 如果已经添加成功，则跳过
    }

    importStatus.value.working = site;

    try {
      let isThisSiteSuccess = false;

      // 拿到 siteMetadata, siteUserConfig
      const siteMetadata = canAddSites.value[site] as ISiteMetadata;
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
  isLoadingCanAddSites.value = true;
  try {
    const allCanAddedSite = await getCanAddedSiteMetadata(); // 加载待添加站点
    canAddSites.value = pickBy(allCanAddedSite, (site) => site.isDead !== true) as Record<string, ISiteMetadata>;
  } finally {
    isLoadingCanAddSites.value = false;
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
            {{ t("SetSite.oneClickImportDialog.trying", { name: canAddSites[importStatus.working].name }) }}
          </span>
        </a-typography-text>
      </span>
      <!-- A-27：原 color="blue-lighten-1" / variant="tonal" 都不是 antd 语义，改用低强调的 text 按钮 -->
      <CheckSwitchButton v-model="importStatus.toWork" :all="realCanAutoAddSiteId" :size="undefined" type="text" />
    </div>

    <!-- 待添加站点加载中：用卡片骨架占位，避免把「尚未加载完」误显示为「无数据」 -->
    <PageSkeleton v-if="isLoadingCanAddSites" :count="6" :rows="2" variant="masonry" />
    <NoDataPlaceholder v-else-if="isEmpty(canAddSites)" />
    <a-list v-else style="overflow: hidden; padding: 12px 12px 0 12px">
      <!-- 站点卡片间距由列上的 pa-1 控制，行容器保持零间距 -->
      <a-row :gutter="0">
        <a-col v-for="site in canAddSites" :key="site.id" :md="8" :sm="12" :xs="24" style="padding: 4px">
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
                    :checked="importStatus.toWork.includes(site.id)"
                    :disabled="
                      !!site.userInputSettingMeta || importStatus.isWorking || importStatus.success.includes(site.id)
                    "
                    :indeterminate="!!site.userInputSettingMeta || importStatus.success.includes(site.id)"
                    @update:checked="(checked: boolean) => toggleToWork(site.id, checked)"
                  >
                    <CheckOutlined v-if="importStatus.success.includes(site.id)" />
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
        </a-col>
      </a-row>
    </a-list>
  </a-modal>
</template>
