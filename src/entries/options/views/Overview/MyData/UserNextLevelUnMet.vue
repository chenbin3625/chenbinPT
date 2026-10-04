<script setup lang="ts">
import { VerticalAlignBottomOutlined } from "@ant-design/icons-vue";
import { type IImplicitUserInfo, type ILevelRequirement, IUserInfo } from "@ptd/site";

import UserLevelsComponent from "./UserLevelsComponent.vue";

const {
  nextLevelUnMet,
  userInfo,
  showNextLevelName = true,
  // A-23：默认值原为 "mr-3"，但 src/ 内不存在 `.mr-3` 规则（Vuetify 迁移残留的死类名），
  // 需要间距时请由调用方传入自己的 class。
  iconClass = "",
} = defineProps<{
  nextLevelUnMet: Partial<IImplicitUserInfo & { level?: ILevelRequirement }>;
  userInfo: IUserInfo;
  showNextLevelName?: boolean;
  iconClass?: string;
}>();
</script>

<template>
  <!-- 计算剩余升级情况 -->
  <VerticalAlignBottomOutlined :class="iconClass" style="color: var(--ptd-warning)" />

  <span v-if="showNextLevelName && nextLevelUnMet.level">{{ nextLevelUnMet.level.name }}:&nbsp;</span>

  <UserLevelsComponent :user-info="userInfo" :level-requirement="nextLevelUnMet" :hide-ratio-in-table="true" />
</template>
