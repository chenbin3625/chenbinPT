<script setup lang="ts">
import { shallowRef, watch } from "vue";
import { NO_IMAGE, type TSiteID } from "@ptd/site";

import { getSiteFavicon } from "./utils.ts";

const {
  siteId,
  size = 32,
  flushOnPre = false,
  flushOnNoImage = false,
  flushOnClick = false,
} = defineProps<{
  siteId: TSiteID;
  size?: number;
  flushOnPre?: boolean;
  flushOnNoImage?: boolean;
  flushOnClick?: boolean;
}>();

const siteFavicon = shallowRef<string>(NO_IMAGE);

/**
 * OPTIONSSHELL-10：原实现只在 onMounted 取一次图，实例被复用来渲染另一个 siteId（表格/列表行复用）时
 * 图标不会更新；且 getSiteFavicon 失败没有 catch，会留下 unhandled rejection。
 * 这里改为对 siteId 的 immediate watch，并做「当前性校验 + 失败回退 NO_IMAGE」。
 */
watch(
  () => siteId,
  async (newSiteId) => {
    try {
      let favicon = await getSiteFavicon(newSiteId, flushOnPre);
      if (favicon === NO_IMAGE && flushOnNoImage) {
        favicon = await getSiteFavicon(newSiteId, true); // 强制刷新
      }

      if (siteId === newSiteId) siteFavicon.value = favicon;
    } catch {
      // 站点已下线 / 消息通道不可用时回退默认图；本组件没有日志通道，且 no-console 门禁禁止新增 console
      if (siteId === newSiteId) siteFavicon.value = NO_IMAGE;
    }
  },
  { immediate: true },
);

function doFlush() {
  if (!flushOnClick) return;
  getSiteFavicon(siteId, true)
    .then((favicon) => {
      siteFavicon.value = favicon;
    })
    .catch(() => {
      // 手动刷新失败保持原图即可（同上：不新增 console）
      siteFavicon.value = NO_IMAGE;
    });
}

const binds = {
  click: flushOnClick ? doFlush : undefined,
};
</script>

<template>
  <a-image :height="size" :preview="false" :src="siteFavicon" :width="size" v-on="binds" />
</template>
