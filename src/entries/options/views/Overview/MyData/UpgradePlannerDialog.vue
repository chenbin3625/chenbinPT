<script setup lang="ts">
import { TrophyOutlined } from "@ant-design/icons-vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { isEmpty } from "es-toolkit/compat";
import { EResultParseStatus, getNextLevelUnMet, guessUserLevelGroupType } from "@ptd/site";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import SiteName from "@/options/components/SiteName.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import UserNextLevelUnMet from "./UserNextLevelUnMet.vue";
import { tableData, type IUserInfoItem } from "./utils/lastUserData.ts";
import { getSiteLevelMetadata } from "./utils/siteMetadataCache.ts";

const showDialog = defineModel<boolean>();
const { t } = useI18n();

interface IUpgradePlanRow {
  siteId: string;
  userInfo: IUserInfoItem;
  currentLevel: string;
  nextLevelName: string;
  unmetCount: number;
  nextLevelUnMet: ReturnType<typeof getNextLevelUnMet>;
  estimatedBonusDays: number | null;
}

const upgradeRows = computed<IUpgradePlanRow[]>(() => {
  const rows: IUpgradePlanRow[] = [];
  for (const record of tableData.value) {
    if (record.status !== EResultParseStatus.success) continue;
    const levelMeta = getSiteLevelMetadata(record.site);
    const reqs = levelMeta.levelRequirements ?? [];
    if (reqs.length === 0) continue;

    const matched = reqs.find((r) => r.id === record.levelId);
    const groupType = matched?.groupType ?? guessUserLevelGroupType(record.levelName ?? "user");
    if (groupType !== "user") continue;

    const unmet = getNextLevelUnMet(record, reqs);
    if (!unmet || isEmpty(unmet)) continue;

    const unmetKeys = Object.keys(unmet).filter(
      (k) =>
        !["level", "name", "id", "groupType", "privilege", "isKept"].includes(k) && (unmet as any)[k] !== undefined,
    );

    // 估算积分/魔力达标所需天数（基于当前 bonusPerHour）
    let estimatedBonusDays: number | null = null;
    const bonusGap = Number((unmet as any).bonus ?? 0);
    const bonusPerHour = Number(record.bonusPerHour ?? 0);
    if (Number.isFinite(bonusGap) && bonusGap > 0 && Number.isFinite(bonusPerHour) && bonusPerHour > 0) {
      estimatedBonusDays = Math.ceil(bonusGap / (bonusPerHour * 24));
    }

    rows.push({
      siteId: record.site,
      userInfo: record,
      currentLevel: matched?.name ?? record.levelName ?? "-",
      nextLevelName: unmet.level?.name ?? "-",
      unmetCount: Math.max(1, unmetKeys.length),
      nextLevelUnMet: unmet,
      estimatedBonusDays,
    });
  }

  return rows.sort((a, b) => {
    if (a.unmetCount !== b.unmetCount) return a.unmetCount - b.unmetCount;
    const daysA = a.estimatedBonusDays ?? Number.POSITIVE_INFINITY;
    const daysB = b.estimatedBonusDays ?? Number.POSITIVE_INFINITY;
    return daysA - daysB;
  });
});
</script>

<template>
  <a-modal v-model:open="showDialog" :title="t('MyData.upgradePlanner.title')" :width="860" :footer="null">
    <a-alert type="info" show-icon :message="t('MyData.upgradePlanner.hint')" class="upgrade-planner__alert" />

    <NoDataPlaceholder v-if="upgradeRows.length === 0" compact :description="t('MyData.upgradePlanner.empty')" />

    <a-list v-else :data-source="upgradeRows" size="small" class="upgrade-planner__list">
      <template #renderItem="{ item }">
        <a-list-item class="upgrade-planner__item">
          <div class="upgrade-planner__row">
            <div class="upgrade-planner__site">
              <SiteFavicon :site-id="item.siteId" :size="20" />
              <SiteName :site-id="item.siteId" tag="strong" />
              <a-tag>{{ item.currentLevel }}</a-tag>
              <span class="upgrade-planner__arrow">→</span>
              <a-tag color="blue"> <TrophyOutlined /> {{ item.nextLevelName }} </a-tag>
              <a-tag v-if="item.estimatedBonusDays !== null" color="green">
                {{ t("MyData.upgradePlanner.estBonusDays", { days: item.estimatedBonusDays }) }}
              </a-tag>
            </div>
            <div class="upgrade-planner__gaps">
              <UserNextLevelUnMet
                :next-level-un-met="item.nextLevelUnMet"
                :show-next-level-name="false"
                :user-info="item.userInfo"
              />
            </div>
          </div>
        </a-list-item>
      </template>
    </a-list>
  </a-modal>
</template>

<style scoped>
.upgrade-planner__alert {
  margin-bottom: 12px;
}

.upgrade-planner__list {
  max-height: 62vh;
  overflow-y: auto;
}

.upgrade-planner__item {
  padding: 8px 4px;
}

.upgrade-planner__row {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.upgrade-planner__site {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.upgrade-planner__arrow {
  color: var(--ptd-text-tertiary);
}

.upgrade-planner__gaps {
  padding-left: 26px;
}
</style>
