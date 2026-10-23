// @ts-check
/**
 * ESLint 扁平配置（flat config）。
 *
 * 第一版**只对 `src/**` 启用 3 条规则**，全部为 error。目标是把「新增回归」挡在门外，
 * 而不是一次性清洗历史代码（历史违规数见 /tmp/ptd-verify/w1/eslint-baseline.json）：
 *
 * - `@typescript-eslint/no-floating-promises`：未处理的 Promise（漏 `await` / 漏 `.catch()`）
 * - `no-console`：禁止直接使用 console
 * - `no-empty`：禁止空块（`try {} catch {}` 这类静默吞错）
 *
 * 类型感知（type-aware linting）：
 * `parserOptions.projectService: true` 让 typescript-eslint 按 `tsconfig.json` 建立 program。
 * **没有它 `no-floating-promises` 会失效**（该规则必须拿到类型信息才能判断表达式是否为 Promise）。
 * `tsconfigRootDir` 指向仓库根，避免从子目录调用 eslint 时找错 tsconfig。
 *
 * 关于 `typescript-eslint` 的 recommended 规则集：本版**故意不启用**——
 * `tseslint.configs.recommended` 会再引入数十条规则，与「第一版只启用 3 条规则」的目标冲突，
 * 也会让基线统计失去焦点。依赖已就位，下一版加进来即可平滑升级。
 * （`@eslint/js` 的 recommended 只用于本配置文件自身，见 ptd/lint-config-itself。）
 */
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";
import eslintConfigPrettier from "eslint-config-prettier/flat";

/** 仓库根目录（= 本文件所在目录），供 projectService 定位 tsconfig.json */
const tsconfigRootDir = import.meta.dirname;

/** 本版启用的规则集合：唯一事实来源，改规则只改这里 */
const enabledRules = {
  "@typescript-eslint/no-floating-promises": "error",
  "no-console": "error",
  "no-empty": "error",
};

export default tseslint.config(
  {
    name: "ptd/ignores",
    ignores: [
      // 构建产物
      "dist-*/**",
      // 依赖（flat config 默认也忽略，这里显式化）与生成的静态资源
      "node_modules/**",
      "public/**",
      // 文档与临时工作目录
      "docs/**",
      ".tmp-*/**",
      "coverage/**",
      // 注意：vite/** 不再整体忽略（G11）。它过去因 no-console 被整体 ignore，
      // 代价是 generateWebextLocales.ts 这类「构建期会写文件」的插件也失去 no-empty 保护；
      // 现在由下面的 ptd/node-scripts 块在「允许 console、保留 no-empty」的前提下覆盖。
    ],
  },

  // Vue SFC 支持：复用插件自带的 flat/base。
  // vue-eslint-parser 是 eslint-plugin-vue 的内部依赖，能否出现在根 node_modules
  // 取决于包管理器的提升策略（npm 会提升，pnpm 默认不会），
  // 所以这里不能 `import vueParser from "vue-eslint-parser"`，必须用插件导出的 config。
  // 注意：flat/base 自带 `vue/comment-directive`、`vue/jsx-uses-vars` 两条**基础设施规则**
  // （用于让 <template> 里的 eslint-disable 生效），不属于业务 lint 规则集。
  ...vue.configs["flat/base"],

  {
    name: "ptd/language-options",
    files: ["src/**/*.ts", "src/**/*.vue"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
      parserOptions: {
        // 类型感知：见文件头说明，no-floating-promises 依赖它
        projectService: true,
        tsconfigRootDir,
        // .vue 不在 TypeScript 默认识别的扩展名里，需要显式声明才能进入 program
        extraFileExtensions: [".vue"],
      },
    },
  },

  {
    name: "ptd/vue",
    // <script lang="ts"> 块交给 typescript-eslint 解析（vue-eslint-parser 会读取 parserOptions.parser）。
    // 缺了它，SFC 里的 TS 语法（泛型、`as const` 等）会被 espree 解析并报 "Parsing error"。
    files: ["src/**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },

  {
    name: "ptd/typescript",
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
  },

  {
    name: "ptd/rules",
    // .vue 由 vue-eslint-parser 解析出 <script> 后套用同一批规则
    files: ["src/**/*.ts", "src/**/*.vue"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      vue,
    },
    rules: enabledRules,
  },

  /**
   * 构建脚本 / vite 插件 / 测试的覆盖（G11）。
   *
   * 旧配置只对 src 目录启用规则：scripts、tests、`.mjs` 配置与 `.mts` 完全不参与 lint，
   * `vite/**` 又被整体 ignore（为了 no-console）—— 而这几个位置恰好是
   * `no-floating-promises`（`vi.waitFor`、异步断言、脚本入口）与 `no-empty`（静默吞错）
   * 最容易踩的地方。
   *
   * 覆盖策略（不新增豁免）：这些上下文允许 console（命令行/构建工具的正常输出手段），
   * 因此 `no-console: off`；`no-empty` 保持 error。
   *
   * 类型感知规则只加在**属于 tsconfig program** 的文件上：
   * - vite 目录下的 `.ts` 与 `vite.config.ts` 在 `tsconfig.node.json` 里，可以启用 `no-floating-promises`；
   * - `vitest.config.ts` 在 `tsconfig.json` 里；
   * - scripts 下的 `.mjs` 与 tests 目前不在任何 program 内，给它们建 project 属测试体系重构，
   *   因此只做非类型规则覆盖（见 docs/review-2026-10-23/fix-reports/g-tooling.md 的延期项）。
   * 注意：**不要**对有 `.mjs` 的块设置 `projectService` —— typescript-eslint 会把这些文件
   * 当成「不属于任何 project」直接报解析错误。
   */
  {
    name: "ptd/node-scripts",
    files: ["scripts/**/*.mjs", "*.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tseslint.parser,
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
      "no-empty": "error",
    },
  },
  {
    name: "ptd/vite-ts",
    files: ["vite/**/*.ts", "vite.config.ts", "vitest.config.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tseslint.parser,
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-console": "off",
      "no-empty": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    name: "ptd/tests",
    // task-12：`.mjs` 测试脚本（如 tests/entries/content-script/advanceListDialog.browser.mjs、
    // tests/packages/site/utils/oracle/selector-oracle.mjs）此前不在任何 lint 配置里，
    // 空 catch / 其它错误只能靠人眼发现；这里一并覆盖（`.mjs` 无类型信息，不启用类型感知规则）。
    files: ["tests/**/*.ts", "tests/**/*.mts", "tests/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tseslint.parser,
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
      "no-empty": "error",
    },
  },

  // 用 @eslint/js 的 recommended 规则集约束「lint 配置自身」：
  // 它只作用于 eslint.config.mjs，不会给 src/** 增加任何规则。
  {
    ...js.configs.recommended,
    name: "ptd/lint-config-itself",
    files: ["eslint.config.mjs"],
  },

  // 关闭与 Prettier 冲突的格式化类规则。它只会「关闭」规则，不会启用任何新规则，
  // 因此放在最后不会破坏「src 只有 3 条规则」的前提。
  eslintConfigPrettier,
);
