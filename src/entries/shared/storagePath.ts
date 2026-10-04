/**
 * chrome.storage 路径读写工具（见 docs/performance-audit.md P0-2 / P2-17）。
 *
 * 单独成纯函数模块的原因：service worker 侧（`background/utils/base.ts`）
 * 与测试都需要它，而 base.ts 依赖 chrome API、无法在 node 下直接单测。
 */

export type TStoragePath = string | Array<string | number>;

/**
 * 会沿原型链「写穿」到全局对象的段名。
 *
 * `cursor["__proto__"]` 取到的就是 `Object.prototype` 本身，而它也是对象，
 * 于是 `setValueByPath({}, ["__proto__", "polluted"], 1)` 会把属性写到全局原型上
 * （任意对象都能读到）——重构前用的 `es-toolkit set` 自身免疫，属迁移引入的回归（B-22）。
 *
 * 这些段名不是站点配置里会出现的字段名，因此统一**拒绝**（而不是跳过该段）：
 * 跳过会让路径指向另一个位置，静默写错目标比拒绝更危险。
 */
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function hasUnsafePathSegment(keys: Array<string | number>): boolean {
  return keys.some((key) => typeof key === "string" && UNSAFE_PATH_SEGMENTS.has(key));
}

/**
 * 解析路径字符串/数组为段列表。
 *
 * 注意：本函数只做词法切分，**不做段名安全校验**。含 `__proto__` 等危险段的路径由下面
 * 三个函数各自兜住（见 `UNSAFE_PATH_SEGMENTS`）：写入与删除直接拒绝，读取只认自有属性。
 */
export function parsePath(path: TStoragePath): Array<string | number> {
  if (Array.isArray(path)) {
    return path;
  }
  return path
    .split(".")
    .filter((x) => x.length > 0)
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
}

export function getValueByPath(source: unknown, path: TStoragePath): unknown {
  let cursor: any = source;
  for (const key of parsePath(path)) {
    // `Object.hasOwn` 保证只读自有属性：既不会读到 `Object.prototype` 上的成员
    // （如单标签 host 解析到 `constructor`），也不会沿原型链取到污染值（B-22 / A-3）。
    if (cursor === null || cursor === undefined || typeof cursor !== "object" || !Object.hasOwn(cursor, key)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}

export function setValueByPath(target: any, path: TStoragePath, value: unknown): void {
  const keys = parsePath(path);
  if (keys.length === 0 || hasUnsafePathSegment(keys)) {
    return;
  }

  let cursor = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (cursor[key] === null || typeof cursor[key] !== "object") {
      cursor[key] = typeof keys[i + 1] === "number" ? [] : {};
    }
    cursor = cursor[key];
  }

  cursor[keys[keys.length - 1]!] = value;
}

export function removeValueByPath(target: any, path: TStoragePath): void {
  const keys = parsePath(path);
  if (keys.length === 0 || hasUnsafePathSegment(keys) || target === null || typeof target !== "object") {
    return;
  }

  let cursor = target;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object" || !Object.hasOwn(cursor, keys[i]!)) {
      return;
    }
    cursor = cursor[keys[i]!];
    if (cursor === null || typeof cursor !== "object") {
      return;
    }
  }

  if (cursor === null || typeof cursor !== "object" || !Object.hasOwn(cursor, keys[keys.length - 1]!)) {
    return;
  }
  delete cursor[keys[keys.length - 1]!];
}
