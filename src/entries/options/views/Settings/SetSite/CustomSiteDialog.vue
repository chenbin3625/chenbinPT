<script setup lang="ts">
import { nanoid } from "nanoid";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { normalizeCustomSiteUrls } from "@ptd/site";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import type { ICustomSiteDefinition, TCustomSiteSchema } from "@/shared/types.ts";

const showDialog = defineModel<boolean>();
const props = defineProps<{
  editSiteId?: string | null;
}>();

const { t } = useI18n();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

const saving = ref(false);
const name = ref("");
const schema = ref<TCustomSiteSchema>("Torznab");
const siteType = ref<"private" | "public">("private");
const urlsText = ref("");
const apiPath = ref("/api/torznab");
const requiresApiKey = ref(true);
const apiKey = ref("");
const tagsText = ref("");
const description = ref("");

const isEditMode = computed(() => Boolean(props.editSiteId && metadataStore.customSites?.[props.editSiteId]));

const schemaOptions = computed(() => [
  { label: "Torznab (Prowlarr / Jackett / Newznab)", value: "Torznab" },
  { label: "NexusPHP", value: "NexusPHP" },
  { label: "UNIT3D", value: "Unit3D" },
]);

const typeOptions = computed(() => [
  { label: t("SetSite.custom.typePrivate"), value: "private" },
  { label: t("SetSite.custom.typePublic"), value: "public" },
]);

function applyPreset(preset: "prowlarr" | "jackett" | "nexusphp" | "unit3d") {
  if (preset === "prowlarr") {
    name.value = name.value || "Prowlarr";
    schema.value = "Torznab";
    siteType.value = "public";
    urlsText.value = urlsText.value || "http://127.0.0.1:9696/";
    apiPath.value = "/1/api";
    requiresApiKey.value = true;
    tagsText.value = tagsText.value || "Prowlarr, Torznab";
  } else if (preset === "jackett") {
    name.value = name.value || "Jackett";
    schema.value = "Torznab";
    siteType.value = "public";
    urlsText.value = urlsText.value || "http://127.0.0.1:9117/";
    apiPath.value = "/api/v2.0/indexers/all/results/torznab";
    requiresApiKey.value = true;
    tagsText.value = tagsText.value || "Jackett, Torznab";
  } else if (preset === "nexusphp") {
    schema.value = "NexusPHP";
    siteType.value = "private";
    requiresApiKey.value = false;
  } else {
    schema.value = "Unit3D";
    siteType.value = "private";
    requiresApiKey.value = true;
  }
}

watch(showDialog, (open) => {
  if (!open) return;
  const existing = props.editSiteId ? metadataStore.customSites?.[props.editSiteId] : undefined;
  if (existing) {
    name.value = existing.name;
    schema.value = existing.schema;
    siteType.value = existing.type;
    urlsText.value = existing.urls.join("\n");
    apiPath.value = existing.apiPath || "/api/torznab";
    requiresApiKey.value = existing.requiresApiKey ?? existing.schema === "Torznab";
    apiKey.value = metadataStore.sites[existing.id]?.inputSetting?.apikey ?? "";
    tagsText.value = (existing.tags ?? []).join(", ");
    description.value = existing.description ?? "";
  } else {
    name.value = "";
    schema.value = "Torznab";
    siteType.value = "public";
    urlsText.value = "";
    apiPath.value = "/api/torznab";
    requiresApiKey.value = true;
    apiKey.value = "";
    tagsText.value = "";
    description.value = "";
  }
});

const parsedUrls = computed(() =>
  normalizeCustomSiteUrls(
    urlsText.value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
);

const canSave = computed(() => Boolean(name.value.trim()) && parsedUrls.value.length > 0 && !saving.value);

async function submit() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const id = isEditMode.value ? props.editSiteId! : `custom_${nanoid(8).toLowerCase()}`;
    const tags = tagsText.value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const def: ICustomSiteDefinition = {
      id,
      name: name.value.trim(),
      schema: schema.value,
      type: siteType.value,
      urls: parsedUrls.value,
      description: description.value.trim(),
      tags,
      apiPath: schema.value === "Torznab" ? apiPath.value.trim() || "/api/torznab" : undefined,
      requiresApiKey: schema.value === "Torznab" || schema.value === "Unit3D" ? requiresApiKey.value : false,
      timezoneOffset: schema.value === "NexusPHP" ? "+0800" : "+0000",
      createdAt: isEditMode.value ? (metadataStore.customSites[id]?.createdAt ?? Date.now()) : Date.now(),
    };

    const existingUserConfig = metadataStore.sites[id];
    const resolvedUrl = (
      existingUserConfig?.url && parsedUrls.value.includes(existingUserConfig.url)
        ? existingUserConfig.url
        : parsedUrls.value[0]
    ) as `${"http" | "https"}://${string}/`;
    const nextUserConfig = {
      ...(existingUserConfig ?? {}),
      id,
      url: resolvedUrl,
      isOffline: existingUserConfig?.isOffline ?? false,
      sortIndex: existingUserConfig?.sortIndex ?? 100,
      allowSearch: existingUserConfig?.allowSearch ?? true,
      allowQueryUserInfo: existingUserConfig?.allowQueryUserInfo ?? schema.value !== "Torznab",
      groups: tags.length > 0 ? tags : (existingUserConfig?.groups ?? []),
      timeout: existingUserConfig?.timeout ?? 30e3,
      downloadInterval: existingUserConfig?.downloadInterval ?? 0,
      uploadSpeedLimit: existingUserConfig?.uploadSpeedLimit ?? 0,
      allowContentScript: existingUserConfig?.allowContentScript ?? schema.value !== "Torznab",
      inputSetting: {
        ...(existingUserConfig?.inputSetting ?? {}),
        ...(requiresApiKey.value ? { apikey: apiKey.value.trim() } : {}),
      },
      merge: {
        ...(existingUserConfig?.merge ?? {}),
        name: def.name,
      },
    };

    await metadataStore.saveCustomSite(def, nextUserConfig);
    runtimeStore.showSnackbar(t("SetSite.custom.saved"), { color: "success" });
    showDialog.value = false;
  } catch (e) {
    runtimeStore.showSnackbar(e instanceof Error ? e.message : t("common.saveFailed"), { color: "error" });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :title="isEditMode ? t('SetSite.custom.editTitle') : t('SetSite.custom.addTitle')"
    :width="680"
    :confirm-loading="saving"
    :ok-button-props="{ disabled: !canSave }"
    @ok="submit"
  >
    <div v-if="!isEditMode" class="custom-site__presets">
      <span class="custom-site__presets-label">{{ t("SetSite.custom.presets") }}</span>
      <a-space :size="6" wrap>
        <a-button size="small" @click="applyPreset('prowlarr')">Prowlarr</a-button>
        <a-button size="small" @click="applyPreset('jackett')">Jackett</a-button>
        <a-button size="small" @click="applyPreset('nexusphp')">NexusPHP</a-button>
        <a-button size="small" @click="applyPreset('unit3d')">UNIT3D</a-button>
      </a-space>
    </div>

    <a-form layout="vertical">
      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item :label="t('SetSite.common.name')" required>
            <a-input v-model:value="name" :placeholder="t('SetSite.custom.namePlaceholder')" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item :label="t('SetSite.custom.schema')" required>
            <a-select v-model:value="schema" :options="schemaOptions" />
          </a-form-item>
        </a-col>
        <a-col :span="4">
          <a-form-item :label="t('common.type')">
            <a-select v-model:value="siteType" :options="typeOptions" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-form-item :label="t('SetSite.custom.urls')" :extra="t('SetSite.custom.urlsHint')" required>
        <a-textarea v-model:value="urlsText" :rows="3" placeholder="https://example.com/" />
      </a-form-item>

      <a-row v-if="schema === 'Torznab'" :gutter="12">
        <a-col :span="16">
          <a-form-item :label="t('SetSite.custom.apiPath')" :extra="t('SetSite.custom.apiPathHint')">
            <a-input v-model:value="apiPath" placeholder="/api/torznab" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item :label="t('SetSite.custom.requiresApiKey')">
            <a-switch v-model:checked="requiresApiKey" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-row v-else-if="schema === 'Unit3D'" :gutter="12">
        <a-col :span="8">
          <a-form-item :label="t('SetSite.custom.requiresApiKey')">
            <a-switch v-model:checked="requiresApiKey" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-form-item v-if="(schema === 'Torznab' || schema === 'Unit3D') && requiresApiKey" label="API Key">
        <a-input v-model:value="apiKey" type="password" :placeholder="t('SetSite.custom.apiKeyPlaceholder')" />
      </a-form-item>

      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item :label="t('SetSite.common.groups')">
            <a-input v-model:value="tagsText" :placeholder="t('SetDownloader.routing.commaSeparated')" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item :label="t('SetSite.custom.description')">
            <a-input v-model:value="description" />
          </a-form-item>
        </a-col>
      </a-row>
    </a-form>
  </a-modal>
</template>

<style scoped>
.custom-site__presets {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 8px 10px;
  border-radius: var(--ptd-radius, 6px);
  background: var(--ptd-surface-soft);
}

.custom-site__presets-label {
  font-size: var(--ptd-font-size-sm);
  color: var(--ptd-text-secondary);
}
</style>
