<script setup lang="ts">
import { reactive, ref, useAttrs, watch } from "vue";
import { type TSiteID } from "@ptd/site";

import { useMetadataStore } from "@/options/stores/metadata.ts";

const metadataStore = useMetadataStore();

const props = defineProps<{
  siteId: TSiteID;
  tag?: string;
  class?: string[] | string;
}>();

const attrs = useAttrs();

const siteName = ref<string>("");

const tagIs = props.tag ?? "a";

const renderProp = reactive<Record<string, any>>({
  ...attrs,
  class: props.class,
});
const explicitTitle = attrs.title;

if (tagIs === "a") {
  renderProp.href = "#";
  renderProp.target = "_blank";
  renderProp.rel = "noopener noreferrer nofollow";
}

/**
 * OPTIONSSHELL-10：两个异步取值的统一写法 —— 回调里做当前性校验（实例可能被复用来渲染另一个站点，
 * 旧请求后到会覆盖新站点信息），并补 .catch（站点定义已下线时 getSiteName/getSiteUrl 会 reject，
 * 原先既没有 catch 也没有兜底，只会留下 unhandled rejection）。失败时保留 siteId / "#" 兜底值。
 */
function updateSiteLink(siteId: TSiteID) {
  if (tagIs !== "a") return;
  renderProp.href = "#";
  metadataStore
    .getSiteUrl(siteId)
    .then((url) => {
      if (props.siteId === siteId) renderProp.href = url;
    })
    .catch(() => {
      // 失败时保持 "#" 兜底（本组件无日志通道；no-console 门禁禁止新增 console）
      if (props.siteId === siteId) renderProp.href = "#";
    });
}

function updateSiteName(siteId: TSiteID) {
  // 首先赋值为 siteId，防止空白
  siteName.value = siteId;
  if (explicitTitle === undefined) renderProp.title = siteId;

  // 优先从缓存中读取
  if (metadataStore.siteNameMap?.[siteId]) {
    siteName.value = metadataStore.siteNameMap[siteId];
  } else {
    // 如果缓存中没有/或者没有生成缓存，则按之前的逻辑读取
    metadataStore
      .getSiteName(siteId)
      .then((name) => {
        if (props.siteId !== siteId) return; // 站点已切换：丢弃迟到结果
        siteName.value = name;
        if (explicitTitle === undefined) renderProp.title = name;
      })
      .catch(() => {
        // 站点定义已下线时 getSiteName 会 reject：保留 siteId 兜底，避免 unhandled rejection（不新增 console）
        if (props.siteId === siteId) {
          siteName.value = siteId;
          if (explicitTitle === undefined) renderProp.title = siteId;
        }
      });
  }
}

watch(
  () => props.siteId,
  (newSiteId) => {
    updateSiteLink(newSiteId);
    updateSiteName(newSiteId);
  },
  { immediate: true },
);
</script>

<template>
  <slot :name="siteName">
    <a-typography-link v-if="tagIs === 'a'" v-bind="renderProp">{{ siteName }}</a-typography-link>
    <component :is="tagIs" v-else v-bind="renderProp">{{ siteName }}</component>
  </slot>
</template>
