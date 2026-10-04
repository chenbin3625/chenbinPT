<script setup lang="ts">
import {
  CloudServerOutlined,
  DashboardOutlined,
  DollarOutlined,
  DoubleLeftOutlined,
  DoubleRightOutlined,
  DownOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  FieldTimeOutlined,
  FileDoneOutlined,
  HeartOutlined,
  PlusSquareOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  UpOutlined,
  UploadOutlined,
} from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import {
  IImplicitUserInfo,
  isoDuration,
  convertIsoDurationToDate,
  convertSecondsToIsoDuration,
  type IUserInfo,
} from "@ptd/site";
import { formatNumber, formatSize, formatDate, simplifyNumber } from "@/options/utils";
import { useConfigStore } from "@/options/stores/config";

const {
  userInfo,
  levelRequirement,
  hideRatioInTable = false,
  useJoinTimeAsRef = false,
} = defineProps<{
  userInfo: IUserInfo;
  levelRequirement: IImplicitUserInfo;
  hideRatioInTable?: boolean;
  useJoinTimeAsRef?: boolean; // 在 formatIntervalDate 中是否使用 joinTime 作为参考时间，默认参考为 currentTime
}>();

const { t } = useI18n();
const configStore = useConfigStore();

// Toggle function for double-click
function toggleIntervalDisplay() {
  configStore.myDataTableControl.showIntervalAsDate = !configStore.myDataTableControl.showIntervalAsDate;
}

// Toggle function for double-click to switch number simplification
function toggleNumberSimplification() {
  configStore.myDataTableControl.simplifyBonusNumbers = !configStore.myDataTableControl.simplifyBonusNumbers;
}

// Get interval display text and title
function getIntervalDisplay(interval: number | isoDuration) {
  const showAsDate = configStore.myDataTableControl.showIntervalAsDate;
  const durationText = formatDuration(interval);
  const dateText = formatIntervalDate(interval);

  return {
    text: showAsDate ? dateText : durationText,
    title: showAsDate ? durationText : dateText,
  };
}

function formatDuration(duration: number | isoDuration) {
  try {
    if (typeof duration === "number") {
      // 如果是秒数，先转换为ISO duration格式再显示
      const isoDurationStr = convertSecondsToIsoDuration(duration);
      return isoDurationStr.substring(1);
    } else {
      if (duration === "P") return "0D"; // 修正：如果 duration 只有 P，返回 0D
      return duration.substring(1);
    }
  } catch (e) {
    console.error("Error formatting duration:", duration, e);
    return "";
  }
}

function formatIntervalDate(duration: number | isoDuration): string {
  try {
    // #1140 unmet 结果带有绝对达标时间时优先使用，避免「挂载时刻 + 重算差值」的时钟错位导致日期漂移
    if (levelRequirement.passTime) {
      const passTimeDate = formatDate(new Date(levelRequirement.passTime), "yyyy-MM-dd");
      if (typeof passTimeDate === "string") {
        return passTimeDate;
      }
    }

    // 展示剩余时间时，基于当前时刻计算；展现等级要求时，基于 joinTime 计算
    // 注意每次渲染时重新取值，不能缓存到 setup 顶层（浏览器长期不关闭时缓存值会持续陈旧）
    const refTime = useJoinTimeAsRef ? (userInfo.joinTime ?? Date.now()) : Date.now();
    if (typeof duration === "number") {
      // 如果是数字（秒）
      const targetDate = new Date(refTime + duration * 1000);
      const result = formatDate(targetDate, "yyyy-MM-dd");
      return typeof result === "string" ? result : "";
    } else {
      // 如果是isoDuration字符串
      const result = formatDate(convertIsoDurationToDate(duration, refTime), "yyyy-MM-dd");
      return typeof result === "string" ? result : "";
    }
  } catch (e) {
    console.error("Error formatting interval date:", duration, e);
    return "";
  }
}

function formatBonus(bonusKey: "bonus" | "seedingBonus") {
  return (
    (configStore.myDataTableControl.simplifyBonusNumbers
      ? simplifyNumber(levelRequirement[bonusKey]!)
      : formatNumber(levelRequirement[bonusKey]!)) +
    (configStore.myDataTableControl.showBonusNeededInterval && levelRequirement[`${bonusKey}NeededInterval`]
      ? ` (~${levelRequirement[`${bonusKey}NeededInterval`]})`
      : "")
  );
}
</script>

<template>
  <slot name="prepend"></slot>
  <template v-if="levelRequirement.interval">
    <FieldTimeOutlined :title="t('levelRequirement.interval')" />
    <span
      :title="getIntervalDisplay(levelRequirement.interval).title"
      @dblclick="toggleIntervalDisplay"
      style="cursor: pointer; user-select: none"
    >
      {{ getIntervalDisplay(levelRequirement.interval).text }} </span
    >;
  </template>
  <template v-if="levelRequirement.uploaded">
    <UpOutlined :title="t('levelRequirement.uploaded')" style="color: var(--ptd-success)" />
    {{ formatSize(levelRequirement.uploaded) }};
  </template>
  <template v-if="levelRequirement.trueUploaded">
    <DoubleLeftOutlined :title="t('levelRequirement.trueUploaded')" style="color: var(--ptd-success)" />
    {{ formatSize(levelRequirement.trueUploaded) }};
  </template>
  <template v-if="levelRequirement.downloaded">
    <DownOutlined :title="t('levelRequirement.downloaded')" style="color: var(--ptd-danger)" />
    {{ formatSize(levelRequirement.downloaded) }};
  </template>
  <template v-if="levelRequirement.trueDownloaded">
    <DoubleRightOutlined :title="t('levelRequirement.trueDownloaded')" style="color: var(--ptd-danger)" />
    {{ formatSize(levelRequirement.trueDownloaded) }};
  </template>

  <template v-if="levelRequirement.totalTraffic">
    <SwapOutlined :title="t('levelRequirement.totalTraffic')" style="color: var(--ptd-warning)" />
    {{ formatSize(levelRequirement.totalTraffic) }};
  </template>

  <template v-if="levelRequirement.ratio && !hideRatioInTable">
    <DashboardOutlined :title="t('levelRequirement.ratio')" style="color: var(--ptd-warning)" />
    {{ levelRequirement.ratio }};
  </template>

  <template v-if="levelRequirement.trueRatio && !hideRatioInTable">
    <DashboardOutlined :title="t('levelRequirement.trueRatio')" style="color: var(--ptd-warning)" />
    {{ levelRequirement.trueRatio }};
  </template>

  <template v-if="levelRequirement.seeding">
    <ExperimentOutlined :title="t('levelRequirement.seeding')" style="color: var(--ptd-success)" />
    {{ formatNumber(levelRequirement.seeding, { minimumFractionDigits: 0 }) }};
  </template>

  <template v-if="levelRequirement.seedingSize">
    <CloudServerOutlined :title="t('levelRequirement.seedingSize')" style="color: var(--ptd-primary)" />
    {{ formatSize(levelRequirement.seedingSize) }};
  </template>

  <template v-if="levelRequirement.seedingTime">
    <FieldTimeOutlined :title="t('levelRequirement.seedingTime')" style="color: var(--ptd-success)" />
    {{ formatDuration(levelRequirement.seedingTime) }};
  </template>

  <template v-if="levelRequirement.averageSeedingTime">
    <FieldTimeOutlined :title="t('levelRequirement.averageSeedingTime')" style="color: var(--ptd-primary)" />
    {{ formatDuration(levelRequirement.averageSeedingTime) }};
  </template>

  <template v-if="levelRequirement.bonus">
    <DollarOutlined :title="t('levelRequirement.bonus')" style="color: var(--ptd-success)" />
    <span
      :title="formatNumber(levelRequirement.bonus)"
      @dblclick="toggleNumberSimplification"
      style="cursor: pointer; user-select: none"
    >
      {{ formatBonus("bonus") }} </span
    >;
  </template>

  <template v-if="levelRequirement.seedingBonus">
    <ThunderboltOutlined :title="t('levelRequirement.seedingBonus')" style="color: var(--ptd-success)" />
    <span
      :title="formatNumber(levelRequirement.seedingBonus)"
      @dblclick="toggleNumberSimplification"
      style="cursor: pointer; user-select: none"
    >
      {{ formatBonus("seedingBonus") }} </span
    >;
  </template>

  <template v-if="levelRequirement.bonusPerHour">
    <ExperimentOutlined :title="t('levelRequirement.bonusPerHour')" style="color: var(--ptd-success)" />
    {{ formatNumber(levelRequirement.bonusPerHour) }};
  </template>

  <template v-if="levelRequirement.uploads">
    <UploadOutlined :title="t('levelRequirement.uploads')" style="color: var(--ptd-success)" />
    {{ formatNumber(levelRequirement.uploads, { minimumFractionDigits: 0 }) }};
  </template>

  <template v-if="levelRequirement.leeching">
    <DownloadOutlined :title="t('levelRequirement.leeching')" style="color: var(--ptd-danger)" />
    {{ formatNumber(levelRequirement.leeching, { minimumFractionDigits: 0 }) }};
  </template>

  <template v-if="levelRequirement.snatches">
    <FileDoneOutlined :title="t('levelRequirement.snatches')" style="color: var(--ptd-warning)" />
    {{ formatNumber(levelRequirement.snatches, { minimumFractionDigits: 0 }) }};
  </template>

  <template v-if="levelRequirement.posts">
    <!-- A-23：原写法 `color: green darken-4` 是 Vuetify token 残留在 style 里，非法 CSS 会被丢弃；
         同文件其它图标早已改用十六进制，这里统一为 green darken-4 的等价色值（见 src/entries/shared/colors.ts） -->
    <PlusSquareOutlined :title="t('levelRequirement.posts')" style="color: var(--ptd-success)" />
    {{ formatNumber(levelRequirement.posts, { minimumFractionDigits: 0 }) }};
  </template>

  <template v-if="levelRequirement.adoptions">
    <HeartOutlined :title="t('levelRequirement.adoptions')" style="color: var(--ptd-success)" />
    {{ formatNumber(levelRequirement.adoptions, { minimumFractionDigits: 0 }) }};
  </template>
</template>
