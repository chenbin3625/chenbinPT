<!--suppress HtmlUnknownTag -->
<script setup lang="ts">
import {
  ArrowLeftOutlined,
  DisconnectOutlined,
  ExportOutlined,
  HistoryOutlined,
  SaveOutlined,
  VerticalAlignBottomOutlined,
} from "@ant-design/icons-vue";
import { saveAs } from "@/options/utils/saveAs.ts";
import { computed, nextTick, onMounted, onUpdated, ref, shallowRef, useTemplateRef } from "vue";
// konva 按需加载（见 vue-konva README「Minimal Bundle (Tree-Shaking)」，上游 #1594）：
// konva/lib/Core 只含 Stage / Layer / Group 等核心节点，模板里用到的形状必须逐个引入，
// 否则 vue-konva 会在创建节点时抛 `xxx is not available. Did you forget to import it?`。
// favicon 的 blur/grayscale 用的是 CSS 字符串滤镜，由 Core 的 Node 直接支持，不需要 konva/lib/filters。
import Konva from "konva/lib/Core";
import "konva/lib/shapes/Rect";
import "konva/lib/shapes/Text";
import "konva/lib/shapes/Line";
import "konva/lib/shapes/Image";
// 仅取类型（运行时由上面那行副作用 import 完成注册）；Konva.Image 不在 Core 的类型面里
import type { Image as KonvaImage } from "konva/lib/shapes/Image";
// P2-2：vue-konva 组件在此局部注册（原来在 options/main.ts 里 app.use(VueKonva, { prefix: "Vk" })，
// 会把 konva 打进 options 入口 chunk）。别名保持 Vk* 以匹配模板里现有的 <vk-xxx> 标签。
// 从 vue-konva/core 引入：它不会再 import 完整的 konva。
import {
  Group as VkGroup,
  Image as VkImage,
  Layer as VkLayer,
  Line as VkLine,
  Rect as VkRect,
  Stage as VkStage,
  Text as VkText,
  type VueKonvaRef,
} from "vue-konva/core";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { useElementSize } from "@vueuse/core";

import { formatDate, formatTimeAgo } from "@/options/utils.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import {
  defaultTimelineBackgroundColor,
  defaultTimelineTextColor,
  defaultTimelineUserNameColor,
  useConfigStore,
} from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import SiteName from "@/options/components/SiteName.vue";
import NavButton from "@/options/components/NavButton.vue";
import CheckSwitchButton from "@/options/components/CheckSwitchButton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

import {
  canThisSiteShow,
  timelineDataRef,
  selectedSites,
  topSiteRenderAttr,
  CTimelineUserInfoField,
  image,
  text,
  divider,
  icon,
  type ITimelineUserInfoField,
  type TKonvaConfig,
  fixedLastUserInfo,
  loadFullData,
} from "./utils.ts";
import { allAddedSiteMetadata, loadAllAddedSiteMetadata } from "../utils/siteMetadata.ts";

const ext_version = __EXT_VERSION__;

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();
const control = configStore.userDataTimelineControl;
const timelineTitle = computed({
  get: () => timelineData.value.title,
  set: (value: string) => {
    // F8：`timelineData` 是 shallowRef（useResetableRef({ shallow: true })），
    // 直接改 `.title` 只改了内部属性、不会触发 render effect —— 输入框自己会显示新值，
    // 但 Konva 画布（以及「导出图片」）仍停留在旧标题。这里整体替换以触发重渲染。
    timelineData.value = { ...timelineData.value, title: value };
    control.title = value;
  },
});

const isLoading = ref<boolean>(false);
const { ref: timelineData, reset: resetTimelineData } = timelineDataRef;

function resetTimelineDataWithControl() {
  // 开始生成 timeline 的数据
  resetTimelineData();

  // 将 control 中的 name 和 timelineTitle 覆盖掉自动生成的
  if (configStore.userName == "") {
    configStore.userName = configStore.getUserNames.perfName;
  }

  if (control.title !== "") {
    timelineData.value.title = control.title;
  }
}

// vue-konva 组件的模板 ref 类型：VueKonvaRef<T> 提供 getNode()/getStage()。
// 注意 getNode() 的泛型要按实际节点类型给（favicon 是 Image，因为要用到 image()）。
const { width: containerWidth } = useElementSize(useTemplateRef("canvasContainer"));
const canvasStage = useTemplateRef<VueKonvaRef<Konva.Stage>>("canvasStage");
const canvasLayer = useTemplateRef<VueKonvaRef<Konva.Layer>>("canvasLayer");

const realAllSite = shallowRef<string[]>([]);

// 动态计算 canvas 的的各类属性
const canvasWidth = 650; // 650px 是设计稿的宽度，下面各类宽高均根据设计稿进行调整，然后使用 scale 来控制缩放
const nameInfoHeight = 70;
const topAndTotalInfoHeight = computed<number>(() => 10 + (realShowField.value.length + 2) * 30);
const perSiteHeight = computed<number>(
  () => (control.showPerSiteField.siteName ? 24 : 20) + (realShowField.value.length + 1) * 20 + 20,
); // 给每个站点 160px 的高度
// F14：高度按实际会绘制的站点数（siteInfo 已按 canThisSiteShow / 数据有效性过滤）计算。
// 修复前用 selectedSites.length：勾选里含「无法展示」的站点时，画布底部会多留一整行空白。
const siteTimeHeight = computed<number>(() =>
  control.showTimeline ? 95 + perSiteHeight.value * siteInfo.value.length : 0,
);
const canvasHeight = computed<number>(() => nameInfoHeight + topAndTotalInfoHeight.value + siteTimeHeight.value + 25);

// 得到 scale 和 stageConfig
const scale = computed(() => Math.min(containerWidth.value, canvasWidth) / canvasWidth); // 按照 650 来绘图，然后缩放显示
const stageConfig = computed(() => {
  return {
    width: canvasWidth,
    height: canvasHeight.value,
    scaleX: scale.value,
    scaleY: scale.value,
  };
});

// 展示面板的内边距：画布容器宽度 = 面板宽度 - 2 * (previewPadding + 1px 边框)，据此反推面板宽度
const previewPadding = 16;
const previewPanelWidth = canvasWidth + (previewPadding + 1) * 2;

// 画布在展示面板中的实际显示尺寸（用于给容器预留高度、显示尺寸提示）
const displaySize = computed(() => {
  const s = scale.value;
  return { width: Math.round(canvasWidth * s), height: Math.round(canvasHeight.value * s) };
});

// 绘制相关辅助函数
//
// 这里的两层缓存都是为了「同一个 favicon 不重复做同样的活」（上游 #1594）：
// 1. 合成画布：favicon() 是在模板里按节点调用的，每次渲染都会跑一遍；不缓存的话每个图标
//    每次渲染都要新建一个 OffscreenCanvas 并重绘。而且 konva 的 Image 会监听 imageChange
//    去摘挂图片的 load 监听器，image 身份频繁变化本身也有开销。
// 2. 滤镜数组：konva 的 Node._setAttr 对数组不做内容比较（只有 `oldVal === val &&
//    !Util.isObject(val)` 才短路），每次传新数组都会把 _filterUpToDate 置 false，
//    使每次重绘都重跑一遍 blur 滤镜。
const faviconCanvasCache = new Map<string, OffscreenCanvas>();
const faviconFilterCache = new Map<string, string[]>();

const favicon = (config: TKonvaConfig) => {
  const imageBaseSize = config.size ?? 24;

  const siteConfig = allAddedSiteMetadata[config.site];

  // OPTIONSOVERVIEW-2：站点定义已不在构建产物里时，loadAllAddedSiteMetadata 会把该站点跳过，
  // allAddedSiteMetadata 里就没有它。原先这里裸读 siteConfig.faviconElement / siteConfig.isDead，
  // 渲染期抛 TypeError 会让整个 vk-stage 渲染失败（时间线只剩骨架屏）。
  // 这里降级为「不画 favicon 的占位」：image() 仍按 canvas/size 给出正确尺寸，站点名与数据照常展示。
  if (!siteConfig) {
    return image({ image: undefined, ...config });
  }

  const filterKey = `${control.faviconBlue}|${siteConfig.isDead ? 1 : 0}`;
  let imageFilters = faviconFilterCache.get(filterKey);
  if (!imageFilters) {
    imageFilters = [`blur(${control.faviconBlue}px)`];
    if (siteConfig.isDead) {
      imageFilters.push("grayscale(1)");
    }
    faviconFilterCache.set(filterKey, imageFilters);
  }

  let imageElement: HTMLImageElement | OffscreenCanvas = siteConfig.faviconElement;

  // 如果设置中传入了 canvas 这个自定义参数，我们为这个 favicon 生成一个带有背景的 canvas，然后在 canvas 上居中绘制 favicon
  if (config.canvas) {
    const { width: canvasWidth = imageBaseSize, height: canvasHeight = imageBaseSize } = config.canvas;
    const fillStyle = config.canvas.fillStyle ?? "#fff";
    const canvasKey = `${config.site}|${imageBaseSize}|${canvasWidth}x${canvasHeight}|${fillStyle}`;

    let canvas = faviconCanvasCache.get(canvasKey);
    if (!canvas) {
      canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

      // 填充背景
      ctx.fillStyle = fillStyle;
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      // 计算缩放比例和位置，并将 favicon 居中填充
      const x = (canvasWidth - imageBaseSize) / 2;
      const y = (canvasHeight - imageBaseSize) / 2;
      ctx.drawImage(siteConfig.faviconElement, x, y, imageBaseSize, imageBaseSize);

      // 背景色可随时调整，限容避免拖动取色器时缓存无限增长
      if (faviconCanvasCache.size > 500) faviconCanvasCache.clear();
      faviconCanvasCache.set(canvasKey, canvas);
    }

    // 防止辅助函数 image() 又一次设置 scaleX 和 scaleY
    config.scaleX = 1;
    config.scaleY = 1;

    // 将imageElement重写为我们的canvas
    imageElement = canvas;
  }

  return image({
    image: imageElement,
    filters: imageFilters,
    ...config,
  });
};

// clipFunc 只需要把路径描出来，konva 随后自己调 ctx.clip()（见 konva 的
// Container._drawChildren：save → transform → beginPath → clipFunc → clip）。
// 也就是说 clipFunc 里的 fill()/stroke() 会**真的画到画布上**，而且是 scene 与 hit
// 两张画布各画一次。这里原来画的白盘会被上面 48x48 白底 favicon 完全盖住，属于纯浪费（上游 #1594）。
const siteFaviconClipFunc =
  (radius: number = 24, position: [number, number] = [stageConfig.value.width / 2, 0]) =>
  (ctx: any) => {
    ctx.beginPath();
    ctx.arc(position[0], position[1], radius, 0, 2 * Math.PI);
  };

const siteInfo = computed(() => timelineData.value.siteInfo.filter((x) => selectedSites.value.includes(x.site)));
const realShowField = computed(() => {
  const showField: ITimelineUserInfoField[] = [];
  for (const key of CTimelineUserInfoField) {
    if (control.showField[key.name]) {
      showField.push(key);
    }
  }
  return showField;
});

// P1-19：原来是「每次调用都返回一个新 computed」的工厂，模板每次渲染都会新建 computed
// 并立即读取 .value，旧的 computed 会永久留在依赖集合中。这里改成纯函数 + 结果缓存。
const siteDateTextCache = new Map<string, string>();
const formatSiteDate = (siteDate: number): string => {
  const key = `${control.dateFormat}:${siteDate}`;
  const cached = siteDateTextCache.get(key);
  if (cached !== undefined) return cached;

  const text =
    control.dateFormat === "time_added"
      ? (formatDate(siteDate, "yyyy-MM-dd") as string)
      : (formatTimeAgo(siteDate) as string);

  // 简单限容，避免长时间运行后无限增长
  if (siteDateTextCache.size > 2000) siteDateTextCache.clear();
  siteDateTextCache.set(key, text);
  return text;
};

// P1-18：favicon 节点引用按 key 覆盖写入 Map，同一节点只保留一份（数组 push 会随渲染次数无限增长）。
//
// 上游 #1594 进一步把 ref 改成「同一个 key 返回同一个函数」：内联箭头函数每次渲染都是新身份，
// Vue 会先以 null 调用旧函数、再以节点调用新函数，并在每次更新时都执行一遍里面的 `cache()` ——
// 拖一下模糊滑块，所有 favicon 都要重新 cache 一次。稳定的 ref 函数只在挂载 / 卸载时被调用，
// 原先配套的 onBeforeUpdate 清空也随之去掉（否则更新后没有 ref 回调来重新填充，Map 会被清空）。
const faviconNodes = new Map<string, VueKonvaRef<KonvaImage>>();
const faviconRefCache = new Map<string, (el: unknown) => void>();

// 记录每个 favicon 节点「已按哪张底图缓存过」。
// 用 WeakMap 而不是往 konva 节点上挂自定义属性：不污染节点对象，也不需要 any 断言。
const faviconCachedImage = new WeakMap<KonvaImage, unknown>();

function syncFaviconNode(key: string, el: unknown) {
  if (!el) {
    faviconNodes.delete(key);
    return;
  }

  const component = el as VueKonvaRef<KonvaImage>;
  faviconNodes.set(key, component);

  // 只在「节点还没缓存」或「底图换了」时重新 cache —— 模糊值变化不需要重新 cache：
  // konva 的滤镜是在绘制时作用在 cache 画布上的（Node._getCachedSceneCanvas），
  // 改 filters 只会把 _filterUpToDate 置 false，下一次绘制自动重算。
  const node = component.getNode?.();
  if (node && (!node.isCached() || faviconCachedImage.get(node) !== node.image())) {
    node.cache();
    faviconCachedImage.set(node, node.image());
  }
}

// 同一个 key 返回同一个函数，避免每次渲染都生成新 ref 导致 Vue 反复卸载/重挂
const faviconRef = (key: string) => {
  let refFn = faviconRefCache.get(key);
  if (!refFn) {
    refFn = (el: unknown) => syncFaviconNode(key, el);
    faviconRefCache.set(key, refFn);
  }
  return refFn;
};

function syncAllFaviconCaches() {
  const prevAutoDrawEnabled = Konva.autoDrawEnabled;
  Konva.autoDrawEnabled = false;
  try {
    for (const component of faviconNodes.values()) {
      const node = component.getNode?.();
      if (node && (!node.isCached() || faviconCachedImage.get(node) !== node.image())) {
        node.cache();
        faviconCachedImage.set(node, node.image());
      }
    }
  } finally {
    // 原来没有 try/finally：cache() 一旦抛错，autoDrawEnabled 会永久停在 false，
    // 整个应用的 konva 自动重绘都会停摆。
    Konva.autoDrawEnabled = prevAutoDrawEnabled;
  }

  canvasLayer.value?.getNode()?.batchDraw();
}

async function updateBlue() {
  // 等这一轮渲染把新的 filters 应用到节点上再重绘，否则会按旧滤镜画一次
  await nextTick();
  syncAllFaviconCaches();
}

// 稳定的 ref 函数不会在更新时再被调用，而底图会在更新中换掉（改背景色 → 新的合成画布；
// 重新加载数据 → 同一位置换了站点）。vue-konva 用 pre-flush 的 watch 把 config 写进节点，
// 到父组件 onUpdated 时 image 已是新值；这里只给「底图确实换了」的节点重新 cache，
// 其余更新（例如拖动模糊滑块）不做任何 cache 工作。
onUpdated(() => {
  let changed = false;
  for (const component of faviconNodes.values()) {
    const node = component.getNode?.();
    if (node?.isCached() && faviconCachedImage.get(node) !== node.image()) {
      node.cache();
      faviconCachedImage.set(node, node.image());
      changed = true;
    }
  }
  if (changed) canvasLayer.value?.getNode()?.batchDraw();
});

onMounted(async () => {
  isLoading.value = true;

  try {
    // metadata store 从 chrome.storage 的恢复是异步的，而 loadFullData 会按「已添加站点」过滤：
    // 水合完成前读取会得到空数据，时间轴会错误地显示空状态。这里先等水合完成。
    await metadataStore.$onReady();

    // 加载所有站点的元数据
    await loadAllAddedSiteMetadata(Object.keys(metadataStore.sites));

    // 加载 fixedLastUserInfo
    fixedLastUserInfo.value = await loadFullData();

    realAllSite.value = Object.keys(fixedLastUserInfo.value).filter((x) => canThisSiteShow(x));

    const { sites = [] } = route.query ?? {};

    // 路由 query 在只有 1 个站点时会被反序列化成字符串（Vue Router 的已知行为），这里统一归一化为数组
    const routeSites = Array.isArray(sites) ? (sites as string[]) : typeof sites === "string" && sites ? [sites] : [];

    // 勾选站点，优先使用 route 参数，其次是上次保存的配置，最后是全部站点
    if (routeSites.length > 0) {
      selectedSites.value = routeSites;
    } else if ((configStore.userDataTimelineControl.selectedSites ?? []).length > 0) {
      selectedSites.value = configStore.userDataTimelineControl.selectedSites;
    } else {
      selectedSites.value = realAllSite.value;
    }

    // 开始生成 timeline 的数据
    resetTimelineDataWithControl();
  } finally {
    // 无论成功失败都要收起骨架屏，失败时由空状态占位兜底
    isLoading.value = false;
    console.debug(fixedLastUserInfo);
  }
});

function exportTimelineImg() {
  const stage = canvasStage.value!.getStage();
  stage.toDataURL({
    mimeType: "image/png",
    pixelRatio: 3,
    callback: (dataUrl: string) => {
      saveAs(
        dataUrl,
        t("UserDataTimeline.exportFilename", {
          name: configStore.userName,
          date: formatDate(timelineData.value.createAt),
        }) + ".png",
      );
    },
  });
}

function saveControl() {
  configStore.userDataTimelineControl.selectedSites = selectedSites.value;
  configStore.$save();
  useRuntimeStore().showSnakebar(t("common.saveSuccess"), { color: "success" });
}
</script>

<template>
  <a-card>
    <!-- 顶部工具条：整页级操作 -->
    <div class="ptd-timeline-toolbar">
      <NavButton color="grey" :icon="ArrowLeftOutlined" :text="t('common.back')" @click="() => router.back()" />
      <div style="flex: 1 1 auto"></div>
      <NavButton
        color="info"
        :disabled="realAllSite.length === 0"
        :icon="ExportOutlined"
        :text="t('common.exportImage')"
        @click="exportTimelineImg"
      />
      <NavButton color="green" :icon="SaveOutlined" :text="t('common.saveSettings')" @click="saveControl" />
    </div>

    <div class="ptd-timeline-layout">
      <!-- 左侧：展示面板（内容与导出的图片一致） -->
      <section class="ptd-timeline-panel ptd-timeline-preview" :style="{ width: `${previewPanelWidth}px` }">
        <div class="ptd-timeline-panel__head">
          <span>{{ t("UserDataTimeline.controls.previewPanel") }}</span>
          <span class="ptd-timeline-panel__meta ptd-meta-text"
            >{{ displaySize.width }} × {{ displaySize.height }} px</span
          >
        </div>

        <div
          ref="canvasContainer"
          class="ptd-timeline-preview__body"
          :style="{ height: `${displaySize.height + previewPadding * 2}px` }"
        >
          <a-skeleton v-if="isLoading" active> </a-skeleton>

          <!-- 没有任何可用于生成时间轴的站点数据 -->
          <NoDataPlaceholder v-else-if="realAllSite.length === 0" :description="t('MyData.table.noData')" />

          <!-- 使用 konva 来绘制 UserDataTimeLine -->
          <vk-stage v-else ref="canvasStage" :config="stageConfig">
            <!-- listening: false —— 这张图是静态的、不响应任何事件，关掉后 konva 不再绘制
                 hit canvas（Node.shouldDrawHit 只看 isListening()），并顺带释放它的内存。 -->
            <vk-layer ref="canvasLayer" :config="{ listening: false }">
              <!-- 1. 添加背景颜色，并填满整个画布 -->
              <vk-rect
                :config="{
                  fill: control.backgroundColor,
                  x: 0,
                  y: 0,
                  width: stageConfig.width,
                  height: stageConfig.height,
                }"
              />

              <!-- 2. 绘制顶端概况 -->
              <vk-group :config="{ x: 0, y: 0 }">
                <!-- 2.1 用户图标（跟着「用户名颜色」走，而不是「其他文本颜色」） -->
                <vk-text
                  :config="icon({ x: 20, y: 20, text: '󰀉' /* account-circle */, fill: control.userNameColor })"
                />
                <!-- 2.2 用户名 -->
                <vk-text
                  :config="
                    text({ x: 65, y: 26, text: configStore.userName, fontSize: 26, fill: control.userNameColor })
                  "
                />
                <!-- 2.3 创建时间 -->
                <vk-text
                  :config="
                    text({
                      y: 20,
                      text: formatDate(timelineData.createAt),
                      fontSize: 12,
                      fill: '#9E9E9E',
                      width: stageConfig.width - 20,
                      align: 'right',
                    })
                  "
                />
              </vk-group>

              <!-- 3. 绘制基础信息 -->
              <vk-group :config="{ x: 20, y: nameInfoHeight }">
                <!-- 3.1 左侧 totalInfo -->
                <vk-group :config="{ x: 0, y: 0 }">
                  <vk-text
                    :config="
                      text({
                        y: 0,
                        text: `${t('UserDataTimeline.total')}${t('UserDataTimeline.field.site')}: ${timelineData.totalInfo.sites}`,
                      })
                    "
                  />
                  <vk-text
                    v-if="timelineData.totalInfo.deadSites > 0"
                    :config="
                      text({
                        x: 160,
                        y: 0,
                        text: `󰖛: ${timelineData.totalInfo.deadSites}`,
                        fontFamily: 'Material Design Icons For PTD',
                        fill: '#9E9E9E',
                      })
                    "
                  />
                </vk-group>
                <vk-text
                  v-for="(key, index) in realShowField"
                  :key="key.name"
                  :config="
                    text({
                      y: 30 * (index + 1),
                      text: `${t('UserDataTimeline.total')}${t('UserDataTimeline.field.' + key.name)}: ${key.format(timelineData.totalInfo[key.name])}`,
                    })
                  "
                />
                <vk-text
                  :config="
                    text({
                      y: 30 * (realShowField.length + 1),
                      text: t('UserDataTimeline.ptAge', { years: timelineData.joinTimeInfo.years }),
                    })
                  "
                />

                <!-- 3.2 中间分隔线、右侧冠军及亚军站点 -->
                <vk-group v-if="control.showTop" :config="{ x: 280, y: 0 }">
                  <!-- 3.2.1 中间分隔线 -->
                  <vk-line :config="divider({ points: [0, 5, 0, topAndTotalInfoHeight - 15] })" />
                  <!-- 3.2.2 右侧冠军及亚军站点 -->
                  <template v-for="(type, index) in topSiteRenderAttr" :key="type.iconFill">
                    <vk-group :config="{ x: 20 + index * 170, y: 0 }">
                      <vk-text :config="icon({ y: 0, fill: type.iconFill, fontSize: 24, text: `󰔸` /* trophy */ })" />
                      <template v-for="(key, index) in realShowField" :key="key.name">
                        <vk-group
                          v-if="timelineData.topInfo[key.name][type.valueKey] > 0"
                          :config="{ x: 0, y: 30 * (index + 1) }"
                        >
                          <vk-image
                            :ref="faviconRef(`top-${type.valueKey}-${key.name}`)"
                            :config="
                              favicon({
                                site: timelineData.topInfo[key.name][type.siteKey].site,
                                size: 20,
                                canvas: { fillStyle: control.backgroundColor },
                              })
                            "
                          />
                          <vk-text
                            v-if="timelineData.topInfo[key.name][type.valueKey] > 0"
                            :config="text({ x: 30, text: key.format(timelineData.topInfo[key.name][type.valueKey]) })"
                          />
                        </vk-group>
                      </template>
                    </vk-group>
                  </template>
                </vk-group>
              </vk-group>

              <!-- 4. 绘制站点信息 -->
              <vk-group v-if="control.showTimeline" :config="{ x: 0, y: nameInfoHeight + topAndTotalInfoHeight }">
                <!-- 4.1 分割线 -->
                <vk-line :config="divider({ points: [20, 0, 630, 0] })" />
                <!-- 4.2 提示词 -->
                <vk-text
                  :config="
                    text({
                      y: 15,
                      text: `... ${timelineData.title} ...`,
                      align: 'center',
                      fontStyle: 'bold',
                      width: stageConfig.width,
                    })
                  "
                />

                <!-- 4.3 站点信息 -->
                <vk-group :config="{ x: 0, y: 40 }">
                  <!-- 4.3.1 分割线 -->
                  <vk-line
                    :config="
                      divider({
                        x: stageConfig.width / 2,
                        y: 0,
                        points: [0, 10, 0, siteInfo.length * perSiteHeight + 10],
                      })
                    "
                  />
                  <!-- 4.3.2 不同站点的信息 -->
                  <template v-for="(userInfo, index) in siteInfo" :key="userInfo.site">
                    <vk-group :config="{ x: 0, y: index * perSiteHeight }">
                      <!-- 首先画出 favicon 并 clip -->
                      <vk-group :config="{ y: perSiteHeight / 2, clipFunc: siteFaviconClipFunc(24) }">
                        <vk-image
                          :ref="faviconRef(`site-${userInfo.site}`)"
                          :config="
                            favicon({
                              site: userInfo.site,
                              size: 38,
                              x: stageConfig.width / 2 - 24,
                              y: 0 - 24,
                              canvas: { width: 48, height: 48 },
                            })
                          "
                        />
                      </vk-group>

                      <!-- 站点数据（上传下载等） -->
                      <vk-group
                        :config="{
                          x: index % 2 == 0 ? 30 : stageConfig.width / 2 + 60,
                          y: perSiteHeight / 2 - 10 - realShowField.length * 10,
                        }"
                      >
                        <vk-text
                          v-if="control.showPerSiteField.siteName"
                          :config="
                            text({
                              y: 0,
                              text: `${allAddedSiteMetadata[userInfo.site]?.isDead ? '󰖛' : ''}${allAddedSiteMetadata[userInfo.site]?.siteName ?? userInfo.site}`,
                              fill: allAddedSiteMetadata[userInfo.site]?.isDead ? '#9E9E9E' : control.textColor,
                              fontFamily: allAddedSiteMetadata[userInfo.site]?.isDead
                                ? 'Material Design Icons For PTD'
                                : undefined,
                              fontStyle: 'bold',
                            })
                          "
                        />
                        <vk-group
                          :config="{
                            x: 0,
                            y: control.showPerSiteField.siteName ? 10 : 0,
                          }"
                        >
                          <vk-text
                            v-for="(key, index) in realShowField"
                            :key="key.name"
                            :config="
                              text({
                                y: 20 * (index + 1),
                                text: `${t('UserDataTimeline.field.' + key.name)}: ${key.format(userInfo[key.name] ?? 0)}`,
                                fontSize: 16,
                              })
                            "
                          />
                          <vk-line
                            v-if="
                              index != siteInfo.length - 1 &&
                              (control.showPerSiteField.siteName || realShowField.length > 0)
                            "
                            :config="
                              divider({
                                points: [
                                  0,
                                  (realShowField.length + 1.5) * 20,
                                  stageConfig.width / 2 - 80,
                                  (realShowField.length + 1.5) * 20,
                                ],
                              })
                            "
                          />
                        </vk-group>
                      </vk-group>

                      <!-- 站点数据（用户名、用户等级、用户UID等） -->
                      <vk-group
                        :config="{ x: index % 2 == 0 ? stageConfig.width / 2 + 60 : 30, y: perSiteHeight / 2 - 20 }"
                      >
                        <vk-text
                          :config="text({ y: 0, text: formatSiteDate(userInfo.joinTime!), fontStyle: 'bold' })"
                        />
                        <vk-text
                          :config="
                            text({
                              y: 28,
                              width: stageConfig.width / 2 - 80,
                              wrap: 'char',
                              lineHeight: 1.25,
                              text: [
                                control.showPerSiteField.name ? userInfo.name! : '',
                                control.showPerSiteField.level ? `<${userInfo.levelName!}>` : '',
                                control.showPerSiteField.uid && userInfo.id && userInfo.id !== '0' && userInfo.id !== 0
                                  ? `<${userInfo.id}>`
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(' '),
                              fontSize: 16,
                            })
                          "
                        ></vk-text>
                      </vk-group>
                    </vk-group>
                  </template>
                </vk-group>
              </vk-group>

              <!-- 5. 构建信息 -->
              <vk-group :config="{ x: 0, y: nameInfoHeight + topAndTotalInfoHeight + siteTimeHeight }">
                <vk-line :config="divider({ points: [20, -10, 630, -10] })" />
                <vk-text
                  :config="
                    text({
                      width: stageConfig.width - 20,
                      align: 'right',
                      text: 'Created By chenbinPT (' + ext_version + ') at ' + formatDate(timelineData.createAt),
                      fontSize: 12,
                      fill: '#b5b5b5',
                    })
                  "
                />
              </vk-group>
            </vk-layer>
          </vk-stage>
        </div>
      </section>

      <!-- 右侧：控制台 -->
      <section class="ptd-timeline-panel ptd-timeline-console">
        <div class="ptd-timeline-panel__head">
          <span>{{ t("UserDataTimeline.controls.consolePanel") }}</span>
        </div>

        <div class="ptd-timeline-console__body">
          <div class="ptd-timeline-settings">
            <div class="ptd-section-heading ptd-timeline-settings__heading">
              {{ t("UserDataTimeline.controls.styleSettings") }}
            </div>

            <section class="ptd-timeline-settings__group">
              <div class="ptd-timeline-settings__label">{{ t("UserDataTimeline.controls.usernameAndTitle") }}</div>
              <div class="ptd-timeline-settings__inputs">
                <div>
                  <span class="ptd-timeline-settings__caption">{{ t("common.username") }}</span>
                  <div class="ptd-timeline-settings__input-control">
                    <a-auto-complete
                      v-model:value="configStore.userName"
                      :aria-label="t('common.username')"
                      :options="
                        Object.keys(configStore.getUserNames.names).map((name) => ({ value: name, label: name }))
                      "
                      :placeholder="t('common.username')"
                    />
                    <a-button
                      type="text"
                      :aria-label="t('common.dialog.reset')"
                      :title="t('common.dialog.reset')"
                      @click="configStore.userName = configStore.getUserNames.perfName"
                    >
                      <HistoryOutlined />
                    </a-button>
                  </div>
                </div>
                <a-form-item
                  class="ptd-timeline-settings__title-field"
                  :label="t('UserDataTimeline.controls.timelineTitle')"
                >
                  <a-input v-model:value="timelineTitle">
                    <template #suffix>
                      <a-button
                        type="text"
                        size="small"
                        :aria-label="t('common.dialog.reset')"
                        :title="t('common.dialog.reset')"
                        @click="
                          () => {
                            control.title = '';
                            resetTimelineDataWithControl();
                          }
                        "
                      >
                        <HistoryOutlined />
                      </a-button>
                    </template>
                  </a-input>
                </a-form-item>
              </div>
            </section>

            <section class="ptd-timeline-settings__group">
              <div class="ptd-timeline-settings__label">{{ t("UserDataTimeline.controls.components") }}</div>
              <div class="ptd-timeline-settings__toggles">
                <div class="ptd-timeline-settings__toggle">
                  <a-switch
                    v-model:checked="control.showTop"
                    :aria-label="t('UserDataTimeline.controls.showTopSites')"
                  />
                  <span>{{ t("UserDataTimeline.controls.showTopSites") }}</span>
                </div>
                <div class="ptd-timeline-settings__toggle">
                  <a-switch
                    v-model:checked="control.showTimeline"
                    :aria-label="t('UserDataTimeline.controls.showTimeline')"
                  />
                  <span>{{ t("UserDataTimeline.controls.showTimeline") }}</span>
                </div>
              </div>
              <div class="ptd-timeline-settings__color-row">
                <span>{{ t("UserDataTimeline.controls.customBgColor") }}</span>
                <div class="ptd-timeline-settings__color-control">
                  <input
                    v-model="control.backgroundColor"
                    type="color"
                    :aria-label="t('UserDataTimeline.controls.customBgColor')"
                  />
                  <a-button
                    type="text"
                    :aria-label="t('common.dialog.reset')"
                    :title="t('common.dialog.reset')"
                    @click="control.backgroundColor = defaultTimelineBackgroundColor"
                  >
                    <HistoryOutlined />
                  </a-button>
                </div>
              </div>
              <!-- 上游 #1594：用户名颜色（含用户图标）与其他文本颜色，深色/浅色背景都能调出可读的对比度 -->
              <div class="ptd-timeline-settings__color-row">
                <span>{{ t("UserDataTimeline.controls.userNameColor") }}</span>
                <div class="ptd-timeline-settings__color-control">
                  <input
                    v-model="control.userNameColor"
                    type="color"
                    :aria-label="t('UserDataTimeline.controls.userNameColor')"
                  />
                  <a-button
                    type="text"
                    :aria-label="t('common.dialog.reset')"
                    :title="t('common.dialog.reset')"
                    @click="control.userNameColor = defaultTimelineUserNameColor"
                  >
                    <HistoryOutlined />
                  </a-button>
                </div>
              </div>
              <div class="ptd-timeline-settings__color-row">
                <span>{{ t("UserDataTimeline.controls.textColor") }}</span>
                <div class="ptd-timeline-settings__color-control">
                  <input
                    v-model="control.textColor"
                    type="color"
                    :aria-label="t('UserDataTimeline.controls.textColor')"
                  />
                  <a-button
                    type="text"
                    :aria-label="t('common.dialog.reset')"
                    :title="t('common.dialog.reset')"
                    @click="control.textColor = defaultTimelineTextColor"
                  >
                    <HistoryOutlined />
                  </a-button>
                </div>
              </div>
            </section>

            <section class="ptd-timeline-settings__group">
              <div class="ptd-timeline-settings__label">{{ t("UserDataTimeline.controls.siteDisplay") }}</div>
              <div class="ptd-timeline-settings__slider-row">
                <span>{{ t("UserDataTimeline.controls.faviconBlur") }}</span>
                <a-slider
                  v-model:value="control.faviconBlue"
                  :aria-label="t('UserDataTimeline.controls.faviconBlur')"
                  :max="8"
                  :min="0"
                  :step="1"
                  @change="updateBlue"
                />
                <output>{{ control.faviconBlue }} px</output>
              </div>
            </section>

            <section class="ptd-timeline-settings__group">
              <div class="ptd-timeline-settings__label">{{ t("UserDataTimeline.controls.displayContent") }}</div>
              <div class="ptd-timeline-settings__subheading">{{ t("UserDataTimeline.controls.statsSection") }}</div>
              <div class="ptd-timeline-settings__field-grid">
                <a-checkbox v-for="(v, key) in control.showField" :key="key" v-model:checked="control.showField[key]">
                  {{ t("UserDataTimeline.field." + key) }}
                </a-checkbox>
              </div>
              <div class="ptd-timeline-settings__subheading">{{ t("UserDataTimeline.controls.timelineSection") }}</div>
              <div class="ptd-timeline-settings__field-grid">
                <a-checkbox
                  v-for="(v, key) in control.showPerSiteField"
                  :key="key"
                  v-model:checked="control.showPerSiteField[key]"
                >
                  {{ t("UserDataTimeline.field." + key) }}
                </a-checkbox>
              </div>
            </section>

            <section class="ptd-timeline-settings__group">
              <div class="ptd-timeline-settings__label">{{ t("UserDataTimeline.controls.timeDisplay") }}</div>
              <a-radio-group v-model:value="control.dateFormat" class="ptd-timeline-settings__radio-group">
                <a-radio value="time_added">{{ t("UserDataTimeline.controls.timeAdded") }}</a-radio>
                <a-radio value="time_alive">{{ t("UserDataTimeline.controls.timeAlive") }}</a-radio>
              </a-radio-group>
            </section>
          </div>

          <div class="ptd-section-heading" style="margin-top: 16px">
            <span>{{ t("UserDataTimeline.controls.displaySiteSettings") }}</span>
            <CheckSwitchButton
              v-model="selectedSites"
              :all="realAllSite"
              color="grey"
              @update:model-value="resetTimelineDataWithControl"
            />
          </div>

          <a-row :gutter="0" style="margin: 8px 0">
            <a-col v-for="(site, siteId) in fixedLastUserInfo" :key="siteId" :span="12" :sm="8" style="padding: 0">
              <a-checkbox
                :checked="selectedSites.includes(siteId)"
                :disabled="!canThisSiteShow(siteId)"
                :indeterminate="!canThisSiteShow(siteId)"
                @update:checked="
                  (checked: boolean) => {
                    selectedSites = checked
                      ? Array.from(new Set([...selectedSites, siteId]))
                      : selectedSites.filter((x) => x !== siteId);
                    resetTimelineDataWithControl();
                  }
                "
              >
                <SiteFavicon :site-id="siteId" :size="16" />
                <span style="margin-left: 4px">
                  <SiteName :site-id="siteId" tag="span" />
                  <VerticalAlignBottomOutlined
                    v-if="allAddedSiteMetadata[siteId]?.isDead"
                    style="margin-left: 4px; color: var(--ptd-text-secondary)"
                  />
                  <DisconnectOutlined
                    v-if="allAddedSiteMetadata[siteId]?.isOffline && !allAddedSiteMetadata[siteId]?.isDead"
                    style="margin-left: 4px; color: var(--ptd-text-secondary)"
                  />
                </span>
              </a-checkbox>
            </a-col>
          </a-row>
        </div>
      </section>
    </div>
  </a-card>
</template>

<style scoped>
/* 时间轴页：左侧展示面板（画布）+ 右侧控制台，两栏在空间不足时自动改为上下排列 */
.ptd-timeline-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.ptd-timeline-layout {
  display: flex;
  flex-wrap: wrap;
  /* 顶部对齐：控制台不会被展示面板拉高 */
  align-items: flex-start;
  gap: 16px;
}

.ptd-timeline-panel {
  min-width: 0;
  background: var(--ptd-surface, #fff);
  border: 1px solid var(--ptd-border, rgba(5, 5, 5, 0.06));
  border-radius: 8px;
}

.ptd-timeline-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--ptd-border, rgba(5, 5, 5, 0.06));
  font-weight: 600;
}

.ptd-timeline-panel__meta {
  font-weight: 400;
}

.ptd-timeline-preview {
  /* 宽度由内联样式给出（画布宽度 + 内边距），窄屏时收缩到容器宽度，画布随之等比缩放 */
  flex: 0 0 auto;
  max-width: 100%;
}

.ptd-timeline-preview__body {
  padding: 16px;
}

.ptd-timeline-console {
  /* 占满剩余宽度；剩余宽度不足时（flex-wrap）整块换行到展示面板下方 */
  flex: 1 1 420px;
}

.ptd-timeline-console__body {
  padding: 16px;
}

.ptd-timeline-settings {
  min-width: 0;
}

.ptd-timeline-settings__heading {
  margin-top: 0;
}

.ptd-timeline-settings__group {
  padding: 12px 0;
  border-bottom: 1px solid var(--ptd-border, rgba(5, 5, 5, 0.06));
}

.ptd-timeline-settings__group:last-child {
  border-bottom: 0;
}

.ptd-timeline-settings__label {
  margin-bottom: 10px;
  font-weight: 600;
}

.ptd-timeline-settings__inputs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  align-items: end;
  gap: 12px;
}

.ptd-timeline-settings__caption {
  display: block;
  margin-bottom: 6px;
}

.ptd-timeline-settings__input-control {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ptd-timeline-settings__input-control .ant-select {
  flex: 1 1 0;
  min-width: 0;
}

.ptd-timeline-settings__input-control .ant-btn,
.ptd-timeline-settings__color-control .ant-btn {
  flex: none;
}

.ptd-timeline-settings__title-field {
  margin-bottom: 0;
}

.ptd-timeline-settings__title-field :deep(.ant-form-item-row) {
  display: block;
}

.ptd-timeline-settings__title-field :deep(.ant-form-item-label) {
  padding-bottom: 6px;
  text-align: left;
}

.ptd-timeline-settings__title-field :deep(.ant-form-item-label > label) {
  height: auto;
}

.ptd-timeline-settings__title-field :deep(.ant-input-suffix .ant-btn) {
  width: 24px;
  height: 24px;
  padding: 0;
}

.ptd-timeline-settings__toggles {
  display: grid;
  gap: 8px;
}

.ptd-timeline-settings__toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
}

.ptd-timeline-settings__toggle .ant-switch {
  flex: none;
}

.ptd-timeline-settings__toggle span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.ptd-timeline-settings__color-row,
.ptd-timeline-settings__color-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ptd-timeline-settings__color-row {
  flex-wrap: wrap;
  justify-content: space-between;
  margin-top: 12px;
}

.ptd-timeline-settings__color-control input {
  width: 56px;
  height: 32px;
  padding: 2px;
  cursor: pointer;
}

.ptd-timeline-settings__slider-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 8px;
}

.ptd-timeline-settings__slider-row > span {
  grid-column: 1 / -1;
}

.ptd-timeline-settings__slider-row .ant-slider {
  min-width: 0;
  margin: 8px 0;
}

.ptd-timeline-settings__slider-row output {
  min-width: 36px;
  text-align: right;
  white-space: nowrap;
  color: var(--ptd-text-secondary, #666);
}

.ptd-timeline-settings__subheading {
  margin: 12px 0 8px;
  color: var(--ptd-text-secondary, #666);
}

.ptd-timeline-settings__field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 130px), 1fr));
  gap: 8px 12px;
}

.ptd-timeline-settings__field-grid :deep(.ant-checkbox-wrapper) {
  min-width: 0;
  margin-inline-start: 0;
  overflow-wrap: anywhere;
}

.ptd-timeline-settings__radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}

.ptd-timeline-settings__radio-group :deep(.ant-radio-wrapper) {
  margin-inline-end: 0;
}
</style>
