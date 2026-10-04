<script setup lang="ts">
import { SettingOutlined } from "@ant-design/icons-vue";
import { computed } from "vue";
import type { DataTableHeader } from "@/options/types/dataTable.ts";

const props = defineProps<{
  headers: DataTableHeader[];
  visibleKeys?: string[];
  title?: string;
}>();

const emit = defineEmits<{ (e: "update:visibleKeys", keys: string[]): void }>();

const requiredKeys = computed(
  () =>
    new Set(
      props.headers.filter((h) => (h.props as Record<string, unknown> | undefined)?.disabled).map((h) => String(h.key)),
    ),
);
const options = computed(() =>
  props.headers
    .filter((h) => h.key)
    .map((h) => ({
      disabled: requiredKeys.value.has(String(h.key)),
      label: h.title ?? String(h.key),
      value: String(h.key),
    })),
);
const selectedKeys = computed(() =>
  Array.from(new Set([...(props.visibleKeys ?? []).map(String), ...requiredKeys.value])),
);

function onChange(keys: (string | number | boolean)[]) {
  emit(
    "update:visibleKeys",
    keys.map(String).filter((key) => !requiredKeys.value.has(key)),
  );
}
</script>

<template>
  <a-popover placement="bottomRight" trigger="click">
    <a-button shape="circle" size="small" type="text" :title="title">
      <template #icon><SettingOutlined /></template>
    </a-button>
    <template #content>
      <div style="max-height: 320px; min-width: 180px; overflow-y: auto">
        <a-checkbox-group :options="options" :value="selectedKeys" style="display: grid; gap: 6px" @change="onChange" />
      </div>
    </template>
  </a-popover>
</template>
