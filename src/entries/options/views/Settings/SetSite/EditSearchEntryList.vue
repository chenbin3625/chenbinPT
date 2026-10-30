<script setup lang="ts">
import { reactive, onMounted } from "vue";
import { TSiteID, ISiteUserConfig } from "@ptd/site";
import type { ISiteMetadataIndexEntry } from "@ptd/site/metadataIndex";

import { useMetadataStore } from "@/options/stores/metadata.ts";

const { item } = defineProps<{
  item: {
    id: TSiteID;
    metadata: ISiteMetadataIndexEntry;
    userConfig: ISiteUserConfig;
  };
}>();

const metadataStore = useMetadataStore();

const searchEntryEnabledStatus = reactive<Record<string, boolean>>({});

onMounted(() => {
  // 索引里的 searchEntries 只保留了 name / enabled 两个标量（每个入口自己的搜索参数可能含函数）
  for (const [entryKey, entry] of Object.entries(item.metadata.searchEntries ?? {})) {
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
    <a-list-item v-for="(searchEntry, entryKey) in item.metadata.searchEntries" :key="entryKey">
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
