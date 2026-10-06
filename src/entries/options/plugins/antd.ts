import type { App, VNode } from "vue";
import { computed, watch } from "vue";
import {
  Alert,
  AutoComplete,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  ConfigProvider,
  DatePicker,
  Divider,
  Dropdown,
  Empty,
  type EmptyProps,
  Flex,
  FloatButton,
  Form,
  Image,
  Input,
  InputNumber,
  Layout,
  List,
  Menu,
  Modal,
  Popover,
  Progress,
  Radio,
  Row,
  Select,
  Skeleton,
  Slider,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
  Upload,
  theme,
  type ConfigProviderProps,
} from "ant-design-vue";
import { StyleProvider } from "ant-design-vue/es/_util/cssinjs";
import zhCN from "ant-design-vue/es/locale/zh_CN";
import enUS from "ant-design-vue/es/locale/en_US";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";

import { i18nInstance, type TLangCode } from "./i18n.ts";
import { useConfigStore } from "@/options/stores/config.ts";

/**
 * 全局注册的 antd 组件（见 docs/performance-audit.md P2-2）。
 *
 * 背景：`import Antd from "ant-design-vue"` + `app.use(Antd)` 会把**整库**注册进来，
 * antd 的 ESM 源码里约 5MB 落在本项目未使用的组件目录中（date-picker/tree/carousel…），
 * 这些都会进入 options 入口 chunk（实测该 chunk 约 1.7MB）。
 *
 * 做法：只注册项目实际用到的组件。清单来自对 `src/**\/*.vue` 中 `<a-xxx>` 标签的静态扫描
 * （兼容层已移除，不再有 `resolveComponent("AName")` 这类动态解析），
 * 并由 `tests/entries/options/antdRegistration.test.ts` 守卫：
 * 该测试用 antd 官方的 `app.use(Antd)` 得到"标准答案"，逐一断言本注册表的
 * 名字与组件对象完全一致 —— 漏注册/映射错会直接测试失败，而不是运行时静默丢组件。
 *
 * 注意：新增 `<a-xxx>` 用法时，需要同步在下面的注册表里加一行（测试会提示缺哪个）。
 */
const antdGlobalComponents: Record<string, any> = {
  AAlert: Alert,
  AAutoComplete: AutoComplete,
  AAvatar: Avatar,
  ABadge: Badge,
  AButton: Button,
  AButtonGroup: Button.Group,
  ACard: Card,
  ACheckbox: Checkbox,
  ACheckboxGroup: Checkbox.Group,
  ACol: Col,
  ACollapse: Collapse,
  ACollapsePanel: Collapse.Panel,
  AConfigProvider: ConfigProvider,
  ADivider: Divider,
  ADropdown: Dropdown,
  AEmpty: Empty,
  AFlex: Flex,
  AFloatButton: FloatButton,
  AFloatButtonGroup: FloatButton.Group,
  AForm: Form,
  AFormItem: Form.Item,
  AImage: Image,
  AInput: Input,
  AInputNumber: InputNumber,
  ALayout: Layout,
  ALayoutContent: Layout.Content,
  ALayoutHeader: Layout.Header,
  ALayoutSider: Layout.Sider,
  AList: List,
  AListItem: List.Item,
  AListItemMeta: List.Item.Meta,
  AMenu: Menu,
  AMenuDivider: Menu.Divider,
  AMenuItem: Menu.Item,
  AMenuItemGroup: Menu.ItemGroup,
  AModal: Modal,
  APopover: Popover,
  AProgress: Progress,
  ARadio: Radio,
  ARadioButton: Radio.Button,
  ARadioGroup: Radio.Group,
  ARangePicker: DatePicker.RangePicker,
  ARow: Row,
  ASelect: Select,
  ASelectOption: Select.Option,
  ASkeleton: Skeleton,
  ASlider: Slider,
  ASpace: Space,
  ASpaceCompact: Space.Compact,
  ASpin: Spin,
  ASubMenu: Menu.SubMenu,
  ASwitch: Switch,
  ATabPane: Tabs.TabPane,
  ATable: Table,
  ATabs: Tabs,
  ATag: Tag,
  ATextarea: Input.TextArea,
  ATimePicker: TimePicker,
  ATooltip: Tooltip,
  ATypographyLink: Typography.Link,
  ATypographyParagraph: Typography.Paragraph,
  ATypographyText: Typography.Text,
  ATypographyTitle: Typography.Title,
  AUpload: Upload,
};

/**
 * antd 插件（仅注册用到的组件）。
 *
 * 与 antd 官方 `install` 的差异：官方还会挂 `$message/$notification/$confirm` 等全局方法
 * （本项目没有任何 `$message` 用法，全部走 `import { message } from "ant-design-vue"`），
 * 但 **StyleProvider 必须注册**（cssinjs 的样式注入上下文），否则组件样式会异常。
 */
export const antdInstance = {
  install(app: App) {
    for (const [name, component] of Object.entries(antdGlobalComponents)) {
      if (component) {
        app.component(name, component);
      }
    }
    app.use(StyleProvider as any);
  },
};

/**
 * 全项目统一的空状态插画：antd 内置的「简洁线稿」（即 `Empty.PRESENTED_IMAGE_SIMPLE`）。
 *
 * 为什么要统一：`<a-empty>` 不传 `image` 时会渲染那张 184×152 的大灰图，而 antd 自己的内部
 * 空状态（`ConfigProvider` 的 `defaultRenderEmpty`，见 es/config-provider/renderEmpty.js）
 * 用的就是这张 simple 线稿 —— 于是「表格没传 #emptyText 时的空态」与「我们自己写的 `<a-empty>`」
 * 观感不一致。所有空状态（`NoDataPlaceholder`、直接写 `<a-empty>` 的地方）都从这里取图。
 *
 * 为什么要断言：ant-design-vue 4.2.6 把 `PRESENTED_IMAGE_SIMPLE` 只挂在**运行时**对象上
 * （es/empty/index.js），d.ts 里没有声明（只有 `Result` 声明了 PRESENTED_IMAGE_*）；
 * 而 `image` prop 声明的 `VueNode` 也不含函数类型 —— 运行时却专门支持函数形式
 * （es/empty/index.js 会调用它，并据此给根节点加上 `ant-empty-normal` 紧凑样式）。
 * 两个类型缺口在这里一次性收口成 prop 本身的类型，调用点直接
 * `:image="EMPTY_PLACEHOLDER_IMAGE"` 即可，不必各自 `as any`。
 */
export const EMPTY_PLACEHOLDER_IMAGE = (Empty as unknown as { PRESENTED_IMAGE_SIMPLE: () => VNode })
  .PRESENTED_IMAGE_SIMPLE as unknown as EmptyProps["image"];

const antdLocaleMap: Record<TLangCode, { locale: ConfigProviderProps["locale"]; dayjs: string }> = {
  en: { locale: enUS, dayjs: "en" },
  zh_CN: { locale: zhCN, dayjs: "zh-cn" },
};

/**
 * 手写 CSS 仍在用的 `--ptd-*` 变量，值**全部取自 antd 的 Design Token**。
 *
 * 这样主题只有 antd 一个来源：`uiTheme` 一变，antd 组件（cssinjs）与手写
 * CSS（这些变量）同时切换，不再需要 style.css 里手抄一份深色十六进制值
 * （原 `.ptd-theme--dark` 块）。
 *
 * 参数化导出是为了让 **content-script overlay** 也能拿到显式的一套值：
 * 它跑在别人的页面里、`contentScript.applyTheme` 关闭时必须强制浅色，
 * 不能跟着宿主页面的 `uiTheme` 走（见 content-script/app/themeVars.ts）。
 *
 * 命名的两条约定（避免再次出现「同一个语义两个名字」/「引用了却没人定义」）：
 * 1. 主色只有 `--ptd-primary`（= `colorPrimary`）一个名字。曾经的 `--ptd-link` 与它同值
 *    且无任何消费方，已删除；style.css 早先引用的 `var(--ptd-primary, #1677ff)` 因此长期
 *    走回退值，现在能真正跟随 token。
 * 2. 语义色只有 `--ptd-{primary,success,danger,warning}` 四个，**图标与文字共用同一个值**。
 *    ant-design-vue 4.2.6 里 `colorSuccessText` 与 `colorSuccess` 完全相等（`*Text` 系列只多了
 *    Hover/Active 两个派生值），再拆一层 `--ptd-x-text` 就是同一个值挂两个名字。
 *    组件里不要再写 Material 十六进制（#1b5e20/#b71c1c/#4caf50/#f44336…）：那些值不随
 *    algorithm 变化，深色主题下会直接掉对比度。
 */
export function buildThemeVars(dark: boolean): Record<string, string> {
  const token = (dark ? theme.darkAlgorithm : theme.defaultAlgorithm)(theme.defaultSeed);
  return {
    "--ptd-bg": token.colorBgLayout,
    "--ptd-surface": token.colorBgContainer,
    "--ptd-elevated": token.colorBgElevated,
    "--ptd-text": token.colorText,
    "--ptd-text-secondary": token.colorTextSecondary,
    "--ptd-text-tertiary": token.colorTextTertiary,
    "--ptd-border": token.colorBorderSecondary,
    "--ptd-hover": token.colorFillTertiary,
    "--ptd-stripe": token.colorFillQuaternary,
    "--ptd-table-highlight": token.colorFillSecondary,
    // 基础排版：options 页面与 content-script overlay 共用同一份定义（此前 overlay 手抄了
    // 一遍字体栈，options 侧则完全没有基准排版，裸文本落到 reset.css 的 `sans-serif` + 16px）。
    "--ptd-font-family": token.fontFamily,
    "--ptd-font-size": `${token.fontSize}px`,
    "--ptd-line-height": `${token.lineHeight}`,
    "--ptd-primary": token.colorPrimary,
    "--ptd-success": token.colorSuccess,
    "--ptd-danger": token.colorError,
    "--ptd-warning": token.colorWarning,
  };
}

/**
 * 根据 configStore 的语言与主题设置生成 <a-config-provider> 所需的属性
 */
export function useAntdConfig() {
  const configStore = useConfigStore();

  const resolveLangItem = (lang: TLangCode) => antdLocaleMap[lang] ?? antdLocaleMap.zh_CN;

  // 纯 computed：只做映射，不在求值过程中产生副作用
  const locale = computed(() => resolveLangItem(configStore.lang).locale);

  // dayjs.locale() 修改的是全局单例，属于副作用，必须移出 computed。
  // 放在 watch 里并 immediate，保证首次挂载即生效、语言变化时同步更新。
  // 两个调用点（options/App.vue setup、content-script/app/init.ts setup）都在
  // setup 上下文中，watch 会随组件卸载自动停止。
  watch(
    () => configStore.lang,
    (lang) => {
      dayjs.locale(resolveLangItem(lang).dayjs);
      // L-7：vue-i18n 的全局语言也在这里同步。options 页另有 App.vue 的 watch，但内容脚本覆盖层只经过这里 ——
      // 不同步的话 configStore.lang="en" 时 antd 组件是英文、覆盖层自己的文案（t("contentScript.*")）仍是中文。
      if (lang && i18nInstance.global.locale.value !== lang) {
        i18nInstance.global.locale.value = lang;
      }
    },
    { immediate: true },
  );

  const themeConfig = computed<ConfigProviderProps["theme"]>(() => ({
    algorithm:
      configStore.uiTheme === "dark"
        ? [theme.darkAlgorithm, theme.compactAlgorithm]
        : [theme.defaultAlgorithm, theme.compactAlgorithm],
  }));

  /** 跟随 `uiTheme` 的 `--ptd-*`：由 options/App.vue 写到 document.documentElement */
  const themeVars = computed<Record<string, string>>(() => buildThemeVars(configStore.uiTheme === "dark"));

  return { locale, themeConfig, themeVars };
}
