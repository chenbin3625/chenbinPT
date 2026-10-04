/**
 * 统一管理页面响应式断点，保持迁移前（Vuetify 4.2.2）的布局阈值与语义一致。
 *
 * 依据（node_modules 中 vuetify 已卸载，以下取自官方源码 vuetify@4.2.2 `lib/composables/display.js`，
 * https://unpkg.com/vuetify@4.2.2/lib/composables/display.js）：
 *
 *   thresholds: { xs: 0, sm: 600, md: 840, lg: 1145, xl: 1545, xxl: 2138 }
 *   mobileBreakpoint: 'lg'
 *
 *   const xs = width < thresholds.sm;                              // width < 600
 *   const sm = width < thresholds.md && !xs;                       // 600 <= width < 840
 *   const md = width < thresholds.lg && !(sm || xs);               // 840 <= width < 1145
 *   const lg = width < thresholds.xl && !(md || sm || xs);         // 1145 <= width < 1545
 *   const mobile = width < thresholds[mobileBreakpoint];           // width < 1145（mobileBreakpoint = 'lg'）
 *   state.smAndUp   = !xs;                       // width >= 600
 *   state.mdAndUp   = !(xs || sm);               // width >= 840
 *   state.lgAndUp   = !(xs || sm || md);         // width >= 1145
 *   state.smAndDown = !(md || lg || xl || xxl);  // == xs || sm  → width < 840
 *   state.mdAndDown = !(lg || xl || xxl);        // == xs||sm||md → width < 1145
 *
 * 即：Vuetify 中 `*AndDown` 是「本级及以下」→ smAndDown 的上界是 **md 阈值(840)**、
 * mdAndDown 的上界是 **lg 阈值(1145)**；mobile 由 mobileBreakpoint='lg' 决定 → width < 1145。
 * 因此下面各值即为 Vuetify 4.2.2 的等价实现（不要照抄 `docs/functional-audit/06-shell-entry.md`
 * SH-06 的「smAndDown 应为 <1145 / mdAndDown 应为 <1545」，该结论把 Vuetify 源码里的
 * 布尔表达式换算错了一档；`mobile` 与 `smAndDown` 在 mobileBreakpoint='lg' 下本来就不同值）。
 */
import { computed } from "vue";
import { useWindowSize } from "@vueuse/core";

const thresholds = { sm: 600, md: 840, lg: 1145, xl: 1545 } as const;

export function useDisplay() {
  const { width } = useWindowSize();

  return {
    width,
    // Vuetify: smAndDown = !(md || lg || xl || xxl) === xs || sm  → width < md(840)
    smAndDown: computed(() => width.value < thresholds.md),
    // Vuetify: smAndUp = !xs → width >= sm(600)
    smAndUp: computed(() => width.value >= thresholds.sm),
    // Vuetify: mdAndDown = !(lg || xl || xxl) === xs || sm || md → width < lg(1145)
    mdAndDown: computed(() => width.value < thresholds.lg),
    // Vuetify: mdAndUp = !(xs || sm) → width >= md(840)
    mdAndUp: computed(() => width.value >= thresholds.md),
    // Vuetify: lgAndUp = !(xs || sm || md) → width >= lg(1145)
    lgAndUp: computed(() => width.value >= thresholds.lg),
    // Vuetify: mobile = width < thresholds[mobileBreakpoint]，默认 mobileBreakpoint = 'lg'(1145)
    mobile: computed(() => width.value < thresholds.lg),
  };
}
