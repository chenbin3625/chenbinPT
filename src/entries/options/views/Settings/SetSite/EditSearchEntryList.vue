<script setup lang="ts">
import { reactive, onMounted } from "vue";
import { ISiteMetadata, ISiteUserConfig, TSiteID } from "@ptd/site";

import { useMetadataStore } from "@/options/stores/metadata.ts";

const { item } = defineProps<{
  item: {
    id: TSiteID;
    metadata: ISiteMetadata;
    userConfig: ISiteUserConfig;
  };
}>();

const metadataStore = useMetadataStore();

const searchEntryEnabledStatus = reactive<Record<string, boolean>>({});

onMounted(() => {
  for (const [entryKey, entry] of Object.entries(item.metadata.searchEntry!)) {
    let entryEnabledStatus = false;
    if (typeof item.userConfig.merge?.searchEntry?.[entryKey]?.enabled === "boolean") {
      entryEnabledStatus = item.userConfig.merge.searchEntry[entryKey].enabled;
    } else {
      entryEnabledStatus = entry.enabled ?? true;
    }

    searchEntryEnabledStatus[entryKey] = entryEnabledStatus;
  }
});
</script>

<template>
  <a-list>
    <a-list-item v-for="(searchEntry, entryKey) in item.metadata.searchEntry" :key="entryKey">
      <a-flex align="center" :gap="8" style="margin-inline: 12px">
        <a-switch
          v-model:checked="searchEntryEnabledStatus[entryKey]"
          @change="
            (v: boolean) => metadataStore.simplePatch('sites', item.id, `merge.searchEntry.${entryKey}.enabled`, v)
          "
        />
        <a-typography-text>{{ searchEntry.name }}</a-typography-text>
      </a-flex>
    </a-list-item>
  </a-list>
</template>
