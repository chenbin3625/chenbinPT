<script setup lang="ts">
import { inject, shallowRef, ref } from "vue";
import { useI18n } from "vue-i18n";
import { SearchOutlined } from "@ant-design/icons-vue";
import { ISocialSitePageInformation, socialPageParserMatchesMap } from "@ptd/social";

import { useConfigStore } from "@/options/stores/config.ts";
import { doKeywordSearch, type IPtdData } from "../utils.ts";

import SpeedDialBtn from "@/content-script/app/components/SpeedDialBtn.vue";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import SocialSiteParseResultsDialog from "@/content-script/app/components/SocialSiteParseResultsDialog.vue";

const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();
const { t } = useI18n();
const ptdData = inject<IPtdData>("ptd_data", {});
const socialSiteParseResults = shallowRef<ISocialSitePageInformation[]>([]);
const showSocialSiteParseResultsDialog = ref<boolean>(false);

function buildSearchKeywordById(parseResult: ISocialSitePageInformation) {
  return `${ptdData.socialSite!}|${parseResult.id}`;
}

/** 与引导期 `matchSocialPageUrl` 保持一致：只用 origin + pathname 匹配，避免 query 影响页面识别 */
function getPageUrlForMatch(): string {
  try {
    return `${window.location.origin}${window.location.pathname}`;
  } catch {
    return window.location.href;
  }
}

/** 站点定义里的模式串可能是非法正则：解析失败按「不匹配」处理，不让整条动作抛错 */
function testPageParserPattern(pattern: unknown, url: string): boolean {
  try {
    return new RegExp(pattern as string | RegExp, "i").test(url);
  } catch {
    return false;
  }
}

async function handleSearch() {
  // 解析页面
  try {
    const parserMatches = socialPageParserMatchesMap[ptdData.socialSite!];
    const pageUrl = getPageUrlForMatch();
    let anyPatternMatched = false;

    for (const [pattern, parser] of parserMatches) {
      if (!testPageParserPattern(pattern, pageUrl)) continue;
      anyPatternMatched = true;

      const parseResult = await parser(document.cloneNode(true) as Document);
      if (parseResult) {
        const shouldShowChosenDialog =
          Array.isArray(parseResult) || (configStore.contentScript?.socialSiteSearchBy ?? "chosen") === "chosen";
        if (shouldShowChosenDialog) {
          socialSiteParseResults.value = Array.isArray(parseResult) ? parseResult : [parseResult];
          showSocialSiteParseResultsDialog.value = true;
          return;
        } else {
          if (configStore.contentScript?.socialSiteSearchBy === "id") {
            return doKeywordSearch(buildSearchKeywordById(parseResult));
          } else if (configStore.contentScript?.socialSiteSearchBy === "imdb") {
            if (ptdData.socialSite === "imdb") {
              return doKeywordSearch(`imdb|${parseResult.id}`);
            } else if (parseResult?.external_ids?.imdb) {
              return doKeywordSearch(`imdb|${parseResult.external_ids.imdb}`);
            } else {
              return doKeywordSearch(parseResult.titles[0] ?? "");
            }
          } else if (configStore.contentScript?.socialSiteSearchBy === "title") {
            return doKeywordSearch(parseResult.titles[0] ?? "");
          }

          // 其他情况默认按 主标题 搜索
          return doKeywordSearch(parseResult.titles[0] ?? "");
        }
      } else {
        runtimeStore.showSnakebar(t("contentScript.parseResultEmpty"), { color: "error" });
      }
    }

    // 引导期按 origin+pathname 匹配到了本站点，但这里没有任何页面解析器命中：
    // 静默无反应会让用户以为按钮失灵，明确提示一次（例如引导期匹配到了页面、解析器只认另一种页面形态）。
    if (!anyPatternMatched) {
      runtimeStore.showSnakebar(t("contentScript.parsePageFailed"), { color: "error" });
    }
  } catch (e) {
    console.error("页面解析失败", e);
    runtimeStore.showSnakebar(t("contentScript.parsePageFailed"), { color: "error" });
    return;
  }
}
</script>

<template>
  <SpeedDialBtn
    key="search"
    :icon="SearchOutlined"
    :title="t('contentScript.quickSearch')"
    :label="t('contentScript.speedDial.quickSearch')"
    @click="handleSearch"
  />
  <SocialSiteParseResultsDialog v-model="showSocialSiteParseResultsDialog" :parse-results="socialSiteParseResults" />
</template>
