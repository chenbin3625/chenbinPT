<script setup lang="ts">
import { SelectOutlined, InfoCircleOutlined, EyeOutlined, EyeInvisibleOutlined } from "@ant-design/icons-vue";
import { watch, ref, onMounted, inject, computed } from "vue";
import { useI18n } from "vue-i18n";
import { set } from "es-toolkit/compat";
import type { timezoneOffset, ISiteUserConfig, TSiteID, ISiteMetadata, TSiteUrl } from "@ptd/site";

import { resolveColor } from "@/shared/colors.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { formatDate, formValidateRules } from "@/options/utils.ts";
import { toMerged } from "es-toolkit";

const { t } = useI18n();
const metadataStore = useMetadataStore();

const siteId = defineModel<TSiteID>({ default: "" });
const emit = defineEmits<{
  (e: "update:formValid", v: boolean): void;
}>();

const siteMetaData = ref<ISiteMetadata>({} as unknown as ISiteMetadata);
const siteUserConfig = inject<ISiteUserConfig>("storedSiteUserConfig", {});
const siteName = computed({
  get: () => siteUserConfig.value.merge?.name ?? siteMetaData.value.name,
  set: (value) => set(siteUserConfig.value, "merge.name", value),
});
const siteTimezoneOffset = computed({
  get: () => siteUserConfig.value.merge?.timezoneOffset ?? siteMetaData.value.timezoneOffset,
  set: (value) => set(siteUserConfig.value, "merge.timezoneOffset", value),
});
const customSiteUrl = ref<string>("");

// B-31：站点凭据（passkey / apikey / token / cookie ...）默认掩码显示，可按字段切换明文
const revealedInputSettings = ref<Set<string>>(new Set());
const SECRET_INPUT_SETTING_PATTERN = /passkey|passwd|password|pwd|apikey|api[_-]?key|rsskey|token|cookie|secret/i;

function isSecretInputSetting(name: string): boolean {
  return SECRET_INPUT_SETTING_PATTERN.test(name);
}

/** 该字段当前是否以掩码显示 */
function isInputSettingMasked(name: string): boolean {
  // revealedInputSettings 是 ref：在 <script setup> 的普通函数体里不会自动解包（模板里才会）
  return isSecretInputSetting(name) && !revealedInputSettings.value.has(name);
}

function toggleInputSettingReveal(name: string) {
  const next = new Set(revealedInputSettings.value);
  if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  revealedInputSettings.value = next;
}

const siteNameOptions = computed(() =>
  [siteMetaData.value.name, ...(siteMetaData.value.aka ?? [])].filter(Boolean).map((value) => ({ value })),
);
const groupOptions = computed(() => (siteMetaData.value.tags ?? []).map((value) => ({ value })));
const timeZoneOptions = computed(() => timeZone.map((item) => ({ label: item.title, value: item.value })));

function firstError(rules: ((v: unknown) => boolean | string)[], value: unknown): string | undefined {
  for (const rule of rules) {
    const result = rule(value);
    if (result !== true) return typeof result === "string" ? result : String(result);
  }
  return undefined;
}

const nameError = computed(() => firstError([formValidateRules.require()], siteName.value));
const sortIndexError = computed(() => firstError([formValidateRules.require()], siteUserConfig.value.sortIndex));
const urlError = computed(() => firstError([formValidateRules.require()], siteUserConfig.value.url));
const customUrlError = computed(() =>
  customSiteUrl.value ? firstError([formValidateRules.url()], customSiteUrl.value) : undefined,
);
const inputSettingError = computed(() => {
  if (siteMetaData.value.isDead) return undefined;
  for (const userInputMeta of siteMetaData.value.userInputSettingMeta ?? []) {
    if (userInputMeta.required && !siteUserConfig.value.inputSetting?.[userInputMeta.name]) return "Item is required";
  }
  return undefined;
});

// 与迁移前 PtdForm 广播的「表单是否合法」语义一致（站点已标记为失效时视为合法，允许保存其它配置）
const siteFormValid = computed(() => {
  if (siteMetaData.value.isDead) return true;
  return (
    !nameError.value && !sortIndexError.value && !urlError.value && !customUrlError.value && !inputSettingError.value
  );
});

// V-17：表单有效性只由 siteFormValid 驱动。此处若再命令式置位，会在 siteFormValid 未发生
// 变化时让 isFormValid 与其脱节（例如自定义 URL 本就有效时，「先置 false」将永久禁用 OK 按钮）。
watch(siteFormValid, (v) => emit("update:formValid", v), { immediate: true });

function updateCustomUrl(val: string) {
  siteUserConfig.value.url = val as unknown as TSiteUrl;
}

async function initSiteData(siteId: TSiteID, flush = false) {
  console.debug("initSiteData", siteId, flush);
  siteMetaData.value = await metadataStore.getSiteMetadata(siteId);
  siteUserConfig.value = toMerged(
    { inputSetting: {}, url: siteMetaData.value.urls[0] },
    await metadataStore.getSiteUserConfig(siteId, flush),
  );

  // fix: customSiteUrl not show in Editor (#726)
  if (!siteMetaData.value.urls.includes(siteUserConfig.value.url)) {
    customSiteUrl.value = siteUserConfig.value.url;
  }
}

onMounted(() => {
  initSiteData(siteId.value);
});

watch(siteId, (newValue) => {
  initSiteData(newValue);
});

const timeZone: Array<{ value: timezoneOffset; title: string }> = [
  { value: "-1200", title: "(UTC -12:00) Enitwetok, Kwajalien" },
  { value: "-1100", title: "(UTC -11:00) Midway Island, Samoa" },
  { value: "-1000", title: "(UTC -10:00) Hawaii" },
  { value: "-0900", title: "(UTC -09:00) Alaska" },
  { value: "-0800", title: "(UTC -08:00) Pacific Time (US & Canada)" },
  { value: "-0700", title: "(UTC -07:00) Mountain Time (US & Canada)" },
  { value: "-0600", title: "(UTC -06:00) Central Time (US & Canada), Mexico City" },
  { value: "-0500", title: "(UTC -05:00) Eastern Time (US & Canada), Bogota, Lima" },
  { value: "-0400", title: "(UTC -04:00) Atlantic Time (Canada), Caracas, La Paz" },
  { value: "-0330", title: "(UTC -03:30) Newfoundland" },
  { value: "-0300", title: "(UTC -03:00) Brazil, Buenos Aires, Falkland Is." },
  { value: "-0200", title: "(UTC -02:00) Mid-Atlantic, Ascention Is., St Helena" },
  { value: "-0100", title: "(UTC -01:00) Azores, Cape Verde Islands" },
  { value: "+0000", title: "(UTC ±00:00) Casablanca, Dublin, London, Lisbon, Monrovia" },
  { value: "+0100", title: "(UTC +01:00) Brussels, Copenhagen, Madrid, Paris" },
  { value: "+0200", title: "(UTC +02:00) Sofia, Izrael, South Africa," },
  { value: "+0300", title: "(UTC +03:00) Baghdad, Riyadh, Moscow, Nairobi" },
  { value: "+0330", title: "(UTC +03:30) Tehran" },
  { value: "+0400", title: "(UTC +04:00) Abu Dhabi, Baku, Muscat, Tbilisi" },
  { value: "+0430", title: "(UTC +04:30) Kabul" },
  { value: "+0500", title: "(UTC +05:00) Ekaterinburg, Karachi, Tashkent" },
  { value: "+0530", title: "(UTC +05:30) Bombay, Calcutta, Madras, New Delhi" },
  { value: "+0600", title: "(UTC +06:00) Almaty, Colomba, Dhakra" },
  { value: "+0700", title: "(UTC +07:00) Bangkok, Hanoi, Jakarta" },
  { value: "+0800", title: "(UTC +08:00) ShangHai, HongKong, Perth, Singapore, Taipei" },
  { value: "+0900", title: "(UTC +09:00) Osaka, Sapporo, Seoul, Tokyo, Yakutsk" },
  { value: "+0930", title: "(UTC +09:30) Adelaide, Darwin" },
  { value: "+1000", title: "(UTC +10:00) Melbourne, Papua New Guinea, Sydney" },
  { value: "+1100", title: "(UTC +11:00) Magadan, New Caledonia, Solomon Is." },
  { value: "+1200", title: "(UTC +12:00) Auckland, Fiji, Marshall Island" },
];
</script>

<template>
  <a-card style="margin-bottom: 20px; padding: 4px">
    <a-form :disabled="siteMetaData.isDead" layout="vertical">
      <div>
        <a-typography-text strong style="display: block; margin: 8px 0">
          {{ t("common.basicInfo") }}
        </a-typography-text>
        <a-row :gutter="16">
          <a-col :md="8" :xs="24">
            <a-form-item :help="nameError" :label="t('SetSite.common.name')" required>
              <a-auto-complete v-model:value="siteName" :options="siteNameOptions" style="width: 100%" />
            </a-form-item>
          </a-col>
          <a-col :md="8" :xs="24">
            <a-form-item :label="t('common.type')">
              <a-input v-model:value="siteMetaData.schema" disabled />
            </a-form-item>
          </a-col>
          <a-col :md="8" :xs="24">
            <a-form-item :help="sortIndexError" :label="t('common.sortIndex')" required>
              <a-input-number
                v-model:value="siteUserConfig.sortIndex"
                :placeholder="t('SetSite.editor.sortIndexTip')"
                :status="sortIndexError ? 'error' : undefined"
                style="width: 100%"
              />
            </a-form-item>
          </a-col>
          <a-col :span="24">
            <a-form-item :label="t('SetSite.common.groups')">
              <a-select v-model:value="siteUserConfig.groups" mode="tags" :options="groupOptions" style="width: 100%" />
            </a-form-item>
          </a-col>
          <a-col :span="24">
            <a-form-item :label="t('SetSite.editor.timezone')">
              <a-select v-model:value="siteTimezoneOffset" :options="timeZoneOptions" show-search style="width: 100%" />
            </a-form-item>
          </a-col>
        </a-row>

        <a-row>
          <a-col :span="24">
            <a-form-item :help="urlError" :label="t('SetSite.common.url')" required>
              <a-radio-group v-model:value="siteUserConfig.url" style="width: 100%">
                <a-radio v-for="url in siteMetaData.urls" :key="url" :value="url" style="display: block">
                  <span style="display: inline-flex; align-items: center; width: 100%">
                    {{ url }}
                    <span style="flex: 1 1 auto; min-width: 8px" />
                    <a-tooltip :title="t('SetSite.common.open')">
                      <a-button :href="url" shape="circle" target="_blank" type="text">
                        <template #icon>
                          <SelectOutlined />
                        </template>
                      </a-button>
                    </a-tooltip>
                  </span>
                </a-radio>
                <a-radio :value="customSiteUrl" style="display: block">
                  <a-input
                    v-model:value="customSiteUrl"
                    :placeholder="t('SetSite.editor.customUrlPlaceholder')"
                    :status="customUrlError ? 'error' : undefined"
                    style="width: 100%"
                    @update:value="updateCustomUrl"
                  />
                </a-radio>
              </a-radio-group>
            </a-form-item>
          </a-col>
        </a-row>

        <a-divider />

        <template v-if="siteMetaData.userInputSettingMeta && siteUserConfig.inputSetting">
          <a-typography-text strong style="display: block; margin: 8px 0">
            {{ t("SetSite.Editor.siteSettings") }}
          </a-typography-text>

          <a-form-item
            v-for="userInputMeta in siteMetaData.userInputSettingMeta"
            :key="userInputMeta.name"
            :help="
              !siteMetaData.isDead && userInputMeta.required && !siteUserConfig.inputSetting![userInputMeta.name]
                ? 'Item is required'
                : userInputMeta.hint
            "
            :label="userInputMeta.label"
            :required="userInputMeta.required"
          >
            <a-input
              v-model:value="siteUserConfig.inputSetting![userInputMeta.name]"
              :type="isInputSettingMasked(userInputMeta.name) ? 'password' : 'text'"
            >
              <template v-if="isSecretInputSetting(userInputMeta.name)" #suffix>
                <EyeOutlined
                  v-if="revealedInputSettings.has(userInputMeta.name)"
                  style="cursor: pointer"
                  @click="toggleInputSettingReveal(userInputMeta.name)"
                />
                <EyeInvisibleOutlined
                  v-else
                  style="cursor: pointer"
                  @click="toggleInputSettingReveal(userInputMeta.name)"
                />
              </template>
            </a-input>
          </a-form-item>

          <a-divider />
        </template>

        <a-typography-text strong style="display: block; margin: 8px 0">
          {{ t("SetSite.Editor.otherSettings") }}
        </a-typography-text>

        <a-form-item :help="t('SetSite.Editor.downloadLinkSuffixHint')" :label="t('SetSite.Editor.downloadLinkSuffix')">
          <a-input v-model:value="siteUserConfig.downloadLinkAppendix">
            <template #suffix>
              <a-tooltip :overlay-style="{ maxWidth: '400px' }" placement="top">
                <template #title>{{ t("SetSite.Editor.downloadLinkSuffixExample") }}</template>
                <InfoCircleOutlined :style="{ color: resolveColor('info'), marginRight: '16px' }" />
              </a-tooltip>
            </template>
          </a-input>
        </a-form-item>

        <a-form-item :help="t('SetSite.Editor.requestTimeoutHint')" :label="t('SetSite.Editor.requestTimeout')">
          <a-flex align="center" :gap="8">
            <a-slider
              v-model:value="siteUserConfig.timeout"
              :max="10 * 60e3"
              :min="0"
              :step="1e3"
              style="flex: 1 1 auto"
            />
            <a-button type="text" @click="siteUserConfig.timeout = 30e3">
              {{ formatDate(siteUserConfig.timeout!, "mm:ss") }}
            </a-button>
          </a-flex>
        </a-form-item>

        <a-form-item :help="t('SetSite.Editor.downloadIntervalHint')" :label="t('SetSite.Editor.downloadInterval')">
          <a-flex align="center" :gap="8">
            <a-slider
              v-model:value="siteUserConfig.downloadInterval"
              :max="(siteUserConfig.downloadInterval ?? 0) < 600 ? 600 : 1200"
              :min="0"
              :step="(siteUserConfig.downloadInterval ?? 0) <= 60 ? 1 : 10"
              style="flex: 1 1 auto"
            />
            <a-button type="text" @click="siteUserConfig.downloadInterval = 0">
              {{ formatDate((siteUserConfig.downloadInterval ?? 0) * 1e3, "mm:ss") }}
            </a-button>
          </a-flex>
        </a-form-item>

        <a-form-item :help="t('SetSite.editor.uploadSpeedLimitHint')" :label="t('SetSite.editor.uploadSpeedLimit')">
          <a-flex align="center" :gap="8">
            <a-slider
              v-model:value="siteUserConfig.uploadSpeedLimit"
              :max="1024"
              :min="0"
              :step="1"
              style="flex: 1 1 auto"
            />
            <a-button type="text" @click="siteUserConfig.uploadSpeedLimit = 0">
              {{ siteUserConfig.uploadSpeedLimit ?? 0 }} MiB/s
            </a-button>
          </a-flex>
        </a-form-item>
      </div>
    </a-form>
  </a-card>
</template>
