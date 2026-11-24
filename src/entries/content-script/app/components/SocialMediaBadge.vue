<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { CheckCircleOutlined, CloseOutlined } from "@ant-design/icons-vue";
import { socialPageParserMatchesMap, type ISocialSitePageInformation } from "@ptd/social";

import { sendMessage } from "@/messages.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { usePtdData, usePtdDataReady } from "../injectionKeys.ts";

interface IMediaBadgeHit {
  serverName: string;
  serverType: string;
  itemName: string;
  year?: string | number;
  played?: boolean;
  videoQuality?: string;
}

const configStore = useConfigStore();
const { t } = useI18n();
const ptdData = usePtdData();
const dataReady = usePtdDataReady();

const matches = shallowRef<IMediaBadgeHit[]>([]);
const expanded = ref<boolean>(false);
const dismissed = ref<boolean>(false);
let unmounted = false;

function getPageUrlForMatch(): string {
  try {
    return `${window.location.origin}${window.location.pathname}`;
  } catch {
    return window.location.href;
  }
}

function testPattern(pattern: unknown, url: string): boolean {
  try {
    return new RegExp(pattern as string | RegExp, "i").test(url);
  } catch {
    return false;
  }
}

async function checkMediaLibrary() {
  if (!ptdData.socialSite) return;
  if (dataReady) {
    await dataReady;
  } else {
    await configStore.$onReady();
  }
  if (unmounted) return;
  if (configStore.contentScript?.showSocialMediaServerBadge === false) return;

  const parserMatches = socialPageParserMatchesMap[ptdData.socialSite];
  if (!parserMatches) return;

  const pageUrl = getPageUrlForMatch();
  let parsed: ISocialSitePageInformation | null = null;
  for (const [pattern, parser] of parserMatches) {
    if (!testPattern(pattern, pageUrl)) continue;
    try {
      const result = await parser(document.cloneNode(true) as Document);
      if (result && !Array.isArray(result)) {
        parsed = result;
        break;
      }
    } catch {
      // 静默忽略解析异常，避免影响宿主页面体验
    }
  }
  if (!parsed || unmounted) return;

  const titles = (parsed.titles ?? []).map((x) => String(x ?? "").trim()).filter(Boolean);
  const imdbId =
    ptdData.socialSite === "imdb"
      ? String(parsed.id ?? "").trim() || undefined
      : parsed.external_ids?.imdb
        ? String(parsed.external_ids.imdb).trim()
        : undefined;
  const doubanId =
    ptdData.socialSite === "douban"
      ? String(parsed.id ?? "").trim() || undefined
      : parsed.external_ids?.douban
        ? String(parsed.external_ids.douban).trim()
        : undefined;

  if (titles.length === 0 && !imdbId && !doubanId) return;

  try {
    const res = await sendMessage("checkMediaServerBySocialInfo", {
      title: titles[0],
      altTitles: titles.slice(1, 5),
      imdbId,
      doubanId,
      year: (parsed as unknown as Record<string, unknown>).year as string | number | undefined,
    });
    if (!unmounted && Array.isArray(res) && res.length > 0) {
      matches.value = res;
    }
  } catch {
    // 媒体库未配置或离线时静默忽略
  }
}

onMounted(() => {
  void checkMediaLibrary();
});

onUnmounted(() => {
  unmounted = true;
});
</script>

<template>
  <div v-if="matches.length > 0 && !dismissed" class="ptd-cs-badge-float" @click.stop>
    <div v-if="expanded" class="ptd-cs-badge-detail">
      <div v-for="(hit, idx) in matches" :key="`${hit.serverName}-${hit.itemName}-${idx}`" class="ptd-cs-badge-row">
        <span class="ptd-cs-badge-title" :title="hit.itemName">
          {{ hit.itemName }}<template v-if="hit.year"> ({{ hit.year }})</template>
        </span>
        <a-flex align="center" :gap="4">
          <a-tag color="blue">{{ hit.serverName }}</a-tag>
          <a-tag v-if="hit.videoQuality" color="purple">{{ hit.videoQuality }}</a-tag>
          <a-tag v-if="hit.played === true" color="success">{{ t("contentScript.mediaBadge.played") }}</a-tag>
          <a-tag v-else-if="hit.played === false">{{ t("contentScript.mediaBadge.unplayed") }}</a-tag>
        </a-flex>
      </div>
    </div>

    <div
      class="ptd-cs-badge-pill"
      role="button"
      tabindex="0"
      @click="expanded = !expanded"
      @keydown.enter.prevent="expanded = !expanded"
    >
      <CheckCircleOutlined style="color: #52c41a" />
      <span>
        {{
          t("contentScript.mediaBadge.inLibrary", {
            server: matches[0]!.serverName,
            count: matches.length,
          })
        }}
      </span>
      <a-tag v-if="matches[0]!.videoQuality" color="purple">{{ matches[0]!.videoQuality }}</a-tag>
      <a-tag v-if="matches[0]!.played === true" color="success">{{ t("contentScript.mediaBadge.played") }}</a-tag>
      <a-tag v-else-if="matches[0]!.played === false">{{ t("contentScript.mediaBadge.unplayed") }}</a-tag>
      <button type="button" class="ptd-cs-badge-close" :title="t('common.dialog.close')" @click.stop="dismissed = true">
        <CloseOutlined />
      </button>
    </div>
  </div>
</template>
