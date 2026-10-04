<script setup lang="ts">
import {
  CheckCircleFilled,
  CheckOutlined,
  StopOutlined,
  TeamOutlined,
  UserSwitchOutlined,
} from "@ant-design/icons-vue";
import { computed } from "vue";
import type { Component } from "vue";
import { useI18n } from "vue-i18n";
import { isEmpty } from "es-toolkit/compat";
import { useDisplay } from "@/options/composables/useDisplay.ts";
import { resolveColor } from "@/shared/colors.ts";
import { getNextLevelUnMet, guessUserLevelGroupType, type IUserInfo, type TLevelGroupType } from "@ptd/site";

import { useConfigStore } from "@/options/stores/config.ts";

import UserLevelsComponent from "./UserLevelsComponent.vue";
import UserNextLevelUnMet from "@/options/views/Overview/MyData/UserNextLevelUnMet.vue";
import { getSiteLevelMetadata } from "./utils/siteMetadataCache.ts";

const { userInfo } = defineProps<{
  userInfo: IUserInfo;
}>();

const display = useDisplay();
const { t } = useI18n();
const configStore = useConfigStore();

// P1-21：读取模块级的站点元数据缓存，不再每行创建 2 个 computedAsync
// （每行都会走一次 metadataStore.getSiteMetadata 的动态 import + cloneDeep）。
const siteLevelMetadata = computed(() => getSiteLevelMetadata(userInfo.site));

const userLevelRequirements = computed(() => siteLevelMetadata.value.levelRequirements);

const userInfoMetadata = computed(() => siteLevelMetadata.value.userInfo);

const matchedLevelRequirements = computed(() => {
  return userLevelRequirements.value?.find((r) => r.id === userInfo.levelId);
});

const levelName = computed(() => {
  if (!configStore.myDataTableControl.normalizeLevelName) {
    return userInfo.levelName;
  }

  return matchedLevelRequirements.value?.name ?? userInfo.levelName;
});

const nextLevelUnMet = computed(() => getNextLevelUnMet(userInfo, userLevelRequirements.value!));

const userLevelGroupType = computed(() => {
  // 首先尝试从 matchedLevelRequirements 中找到对应的等级组
  if (matchedLevelRequirements.value?.groupType) {
    return matchedLevelRequirements.value.groupType;
  }

  // 如果还是没有，则考虑从用户等级名中猜测
  return guessUserLevelGroupType(userInfo.levelName ?? "user");
});

const isDonorAccountKept = computed(() => {
  return userInfo.isDonor === true && userInfoMetadata.value?.donorConfig?.isAccountKept === true;
});

const currentUserLevelColor = computed(() => {
  switch (userLevelGroupType.value) {
    case "vip":
      return "green";
    case "manager":
      return "indigo";
    case "user": {
      if (matchedLevelRequirements.value?.isKept || isDonorAccountKept.value) return "light-blue"; // 保号用户
      return "";
    }
    default:
      return "";
  }
});

const userLevelGroupIconMap: Record<TLevelGroupType, Component> = {
  user: TeamOutlined,
  vip: CheckCircleFilled,
  manager: UserSwitchOutlined,
};

const userLevelGroupIcon = computed(() => {
  return userLevelGroupIconMap[userLevelGroupType.value] || userLevelGroupIconMap.user;
});
</script>

<template>
  <span v-if="userInfo.levelName" style="white-space: nowrap">
    <a-popover
      v-if="
        configStore.myDataTableControl.showLevelRequirement && userLevelRequirements && userLevelRequirements.length > 0
      "
      placement="rightBottom"
      :overlay-style="{ maxWidth: '800px' }"
      :trigger="display.mobile.value ? ['click', 'hover', 'focus'] : ['hover', 'focus']"
    >
      <template #content>
        <div style="max-height: 500px; max-width: 800px; overflow-y: auto">
          <a-list size="small">
            <!-- 计算剩余升级情况 -->
            <template
              v-if="
                configStore.myDataTableControl.showNextLevelInDialog &&
                userLevelGroupType === 'user' &&
                !isEmpty(nextLevelUnMet)
              "
            >
              <a-list-item style="padding: 0 4px">
                <UserNextLevelUnMet :next-level-un-met="nextLevelUnMet" :user-info="userInfo" />
              </a-list-item>
            </template>

            <a-typography-text v-if="userLevelRequirements.length > 0" strong>{{
              t("MyData.UserLevelRequirementsTd.levelList")
            }}</a-typography-text>

            <!-- 展示站点用户等级 -->
            <template v-for="userLevel in userLevelRequirements" :key="userLevel.id">
              <template
                v-if="
                  configStore.myDataTableControl.onlyShowUserLevelRequirement
                    ? (userLevel.groupType !== 'vip' && userLevel.groupType !== 'manager') ||
                      userLevelGroupType !== 'user'
                    : true
                "
              >
                <a-list-item style="padding: 0 4px">
                  <a-flex align="flex-start" :gap="4">
                    <component :is="userLevel.id <= (userInfo.levelId ?? -1) ? CheckOutlined : StopOutlined" />
                    <div>
                      <span>{{ userLevel.name }}:&nbsp;</span>
                      <!-- 展示用户等级要求时， interval 向 date 的转换应该基于 joinTime 计算 -->
                      <UserLevelsComponent
                        :user-info="userInfo"
                        :level-requirement="userLevel"
                        :useJoinTimeAsRef="true"
                      />
                    </div>
                  </a-flex>

                  <div
                    :title="userLevel.privilege"
                    style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
                  >
                    {{ userLevel.privilege }}
                  </div>
                </a-list-item>
                <a-divider style="margin: 4px" />
              </template>
            </template>
          </a-list>
        </div>
      </template>

      <span>
        <component :is="userLevelGroupIcon" style="margin-right: 4px" />
        <span :style="{ color: resolveColor(currentUserLevelColor) }">{{ levelName }}</span>
        <CheckOutlined
          v-if="
            configStore.myDataTableControl.showNextLevelInTable &&
            userLevelGroupType === 'user' &&
            isEmpty(nextLevelUnMet)
          "
          style="margin-left: 4px; color: var(--ptd-success)"
        />
        <br />
        <template
          v-if="
            configStore.myDataTableControl.showNextLevelInTable &&
            userLevelGroupType === 'user' &&
            !isEmpty(nextLevelUnMet)
          "
        >
          <UserNextLevelUnMet
            :next-level-un-met="nextLevelUnMet"
            :show-next-level-name="false"
            :user-info="userInfo"
            icon-class=""
          />
        </template>
      </span>
    </a-popover>
    <span v-else>
      <component :is="userLevelGroupIcon" />
      {{ levelName }}
    </span>
  </span>

  <!-- 信息还没获取 -->
  <template v-else>-</template>
</template>
