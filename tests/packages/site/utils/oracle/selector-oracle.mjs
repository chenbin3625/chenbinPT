/**
 * 冻结选择器引擎（Sizzle 2.3.10）参照实现加载器 —— **仅供测试使用**。
 *
 * `selector-oracle-2.3.10.js.txt` 是 `sizzle@2.3.10` 的 `dist/sizzle.js` **逐字节副本**
 * （sha256 `a86344a92dafd8d7b7fa4b66ac3871d8c59b07a8d414f1e9e0cd9bb8401f6155`），
 * 用来给「选择器层替换」提供不可变的差分基准。
 *
 * 为什么保存成 `.js.txt` 并用 `new Function` 执行：
 * 1. 它是历史参照物，不是本仓库的模块 —— 不该进入打包器 / 类型检查 / lint 的模块图
 *    （`eslint .` 只应关注本仓库自己的源码）；
 * 2. 线上依赖 `sizzle` 已退役，测试仍需要一个**不可变**的参照实现，
 *    否则删掉依赖后差分测试就无从对照。
 *
 * UMD 尾部在 `define` / `module` 都不成立时会把引擎挂到传入的 `window` 上，
 * 所以这里注入一个带真实 `document` 的沙箱 window。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ORACLE_RELATIVE_PATH = join(
  "tests",
  "packages",
  "site",
  "utils",
  "oracle",
  "selector-oracle-2.3.10.js.txt",
);

/** 从 cwd 向上搜索 oracle 文件（仓库根或更深层目录运行测试都能找到） */
function findOracleFile() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ORACLE_RELATIVE_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("找不到选择器参照实现: " + ORACLE_RELATIVE_PATH);
}

/** @returns {any} 与 `sizzle@2.3.10` 行为一致的引擎实例 */
export function loadSelectorOracle() {
  const file = findOracleFile();
  const code = readFileSync(file, "utf8");
  const sandbox = { document };
  new Function("window", "module", "define", code)(sandbox, undefined, undefined);
  if (!sandbox.Sizzle) {
    throw new Error("selector oracle 加载失败: " + file);
  }
  return sandbox.Sizzle;
}

export default loadSelectorOracle();
