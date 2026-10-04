<script setup lang="ts">
import { QuestionCircleOutlined } from "@ant-design/icons-vue";
import { computed, nextTick, provide, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ISiteMetadata, type ISiteUserConfig, type TSiteID } from "@ptd/site";

import { resolveColor } from "@/shared/colors.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { getCanAddedSiteMetadata } from "./utils.ts";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import Editor from "./Editor.vue";

import { REPO_URL } from "~/helper.ts";

const showDialog = defineModel<boolean>();

const { t } = useI18n();
const metadataStore = useMetadataStore();

const currentStep = ref<0 | 1>(0);
const selectedSiteId = ref<TSiteID | null>(null);
const storedSiteUserConfig = ref<ISiteUserConfig>({});
const isFormValid = ref<boolean>(false);

provide("storedSiteUserConfig", storedSiteUserConfig);

function resetDialog() {
  currentStep.value = 0;
  selectedSiteId.value = null;
  storedSiteUserConfig.value = {};
}

const showDeadSite = ref<boolean>(false);
const allUnAddedSites = shallowRef<ISiteMetadata[]>([]);
const canAddSites = computed(() =>
  allUnAddedSites.value.filter((site) => (showDeadSite.value && site.isDead) || !site.isDead),
);

const siteOptions = computed(() => canAddSites.value.map((site) => ({ label: site.name ?? "", site, value: site.id })));

/** a-select 的 #option / #filter-option / #optionLabel 回调拿到的对象形态不同（原始 option 或 vc-select 的扁平记录） */
function optionSite(option: any): ISiteMetadata | undefined {
  return option?.site ?? option?.data?.site;
}

function filterSite(input: string, option: any) {
  const site = optionSite(option);
  if (!site) return false;
  const haystack = [site.name, site.urls, site.aka].flat().filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(String(input).toLowerCase());
}

async function loadCanAddSites() {
  // Load the sites that can be added
  const sites = await getCanAddedSiteMetadata();
  allUnAddedSites.value = Object.values(sites);
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(loadCanAddSites);
});

async function saveSite() {
  await metadataStore.addSite(selectedSiteId.value!, storedSiteUserConfig.value!);
  showDialog.value = false;
}
</script>

<template>
  <a-modal v-model:open="showDialog" :title="t('SetSite.add.title')" :width="800" :after-close="resetDialog">
    <div v-if="currentStep === 0">
      <!-- 选取可添加的站点 -->
      <a-select
        v-model:value="selectedSiteId"
        :filter-option="filterSite"
        :options="siteOptions"
        :placeholder="selectedSiteId ? '' : t('SetSite.add.selectSitePlaceholder')"
        autofocus
        show-search
        style="width: 100%"
      >
        <template #option="option">
          <a-flex align="center" :gap="8" style="min-width: 0">
            <SiteFavicon v-if="optionSite(option)" :site-id="optionSite(option)!.id" style="margin-right: 8px" />
            <a-flex vertical style="flex: 1 1 auto; min-width: 0">
              <a-flex align="center" :gap="8">
                <strong :style="{ textDecoration: optionSite(option)?.isDead ? 'line-through' : undefined }">
                  {{ optionSite(option)?.name ?? "" }}
                </strong>
                <a-tag
                  :color="optionSite(option)?.type === 'private' ? resolveColor('primary') : resolveColor('secondary')"
                >
                  {{
                    optionSite(option)?.schema ??
                    (optionSite(option)?.type === "private" ? "AbstractPrivateSite" : "AbstractBittorrentSite")
                  }}
                </a-tag>
                <a-tag :color="resolveColor('green')">
                  {{ optionSite(option)?.version ? "v" + optionSite(option)?.version : "" }}
                </a-tag>
              </a-flex>
              <a-typography-text
                :ellipsis="true"
                :title="optionSite(option)?.description ?? ''"
                style="max-width: 500px"
                type="secondary"
              >
                {{ optionSite(option)?.description ?? "" }}
              </a-typography-text>
            </a-flex>
            <span style="margin-left: auto">{{ optionSite(option)?.tags?.join(", ") ?? "" }}</span>
          </a-flex>
        </template>
        <template #optionLabel="option">
          <a-flex align="center" :gap="8">
            <SiteFavicon v-if="optionSite(option)" :site-id="optionSite(option)!.id" flush-on-no-image />
            <span :style="{ textDecoration: optionSite(option)?.isDead ? 'line-through' : undefined }">
              {{ optionSite(option)?.name ?? "" }}
            </span>
          </a-flex>
        </template>
      </a-select>
      <div style="margin-top: 4px">
        <a-typography-text type="secondary">
          {{ canAddSites.find((i) => i.id === selectedSiteId)?.description ?? "" }}
        </a-typography-text>
      </div>
    </div>
    <div v-if="currentStep === 1">
      <!-- 具体配置站点 -->
      <Editor ref="editor" v-model="selectedSiteId!" @update:form-valid="(v) => (isFormValid = v)" />
    </div>

    <template #footer>
      <a-flex align="center" justify="space-between">
        <a-flex align="center" :gap="8">
          <a-button
            :href="`${REPO_URL}/wiki/config-site`"
            :title="t('layout.header.wiki')"
            rel="noopener noreferrer nofollow"
            target="_blank"
            type="link"
          >
            <QuestionCircleOutlined />
          </a-button>
          <a-flex v-if="currentStep === 0" align="center" :gap="8" style="margin-left: 20px">
            <a-switch v-model:checked="showDeadSite" />
            <a-typography-text>{{ t("SetSite.AddDialog.showDeadSite") }}</a-typography-text>
          </a-flex>
        </a-flex>

        <a-flex align="center" :gap="8">
          <a-button @click="showDialog = false">{{ t("common.dialog.cancel") }}</a-button>
          <a-button v-if="currentStep === 1" @click="currentStep--">{{ t("common.dialog.prev") }}</a-button>
          <a-button v-if="currentStep === 0" :disabled="selectedSiteId == null" type="primary" @click="currentStep++">
            {{ t("common.dialog.next") }}
          </a-button>
          <a-button v-if="currentStep === 1" :disabled="!isFormValid" type="primary" @click="saveSite">
            {{ t("common.dialog.ok") }}
          </a-button>
        </a-flex>
      </a-flex>
    </template>
  </a-modal>
</template>
