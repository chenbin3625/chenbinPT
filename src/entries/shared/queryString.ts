/**
 * qs 风格的查询串序列化（只支持 UTF-8）。
 *
 * 替代 `urlencode` 的 `stringify`：该包会静态引入 `iconv-lite` 的全套编码表（约 300KB），
 * 而本仓库的调用点从不传 charset，只走 UTF-8 分支。这里按 urlencode@2.0.0 `stringify()` 的
 * UTF-8 行为逐条对齐（见 tests/entries/shared/queryString.test.ts 的对照用例）：
 *
 * - 嵌套对象展开为 `a[b]=1`，数组展开为 `c[0]=1&c[1]=2`（括号本身不编码）；
 * - 值为 `null` / `undefined` 时输出 `key=`（注意：嵌套层级里也只输出**裸 key**，不带父级前缀，
 *   这是 urlencode 的既有行为，保留以免改变 POST body 的字节）；
 * - 空字符串 key 被跳过；`for...in` 遍历（含原型链上的可枚举属性）；
 * - 顶层传入数组或原始值会抛 `TypeError("stringify expects an object")`。
 */
export function stringifyQuery(obj: unknown, prefix?: string): string {
  if (Array.isArray(obj)) {
    if (!prefix) {
      throw new TypeError("stringify expects an object");
    }
    return obj.map((value, index) => stringifyQuery(value, `${prefix}[${index}]`)).join("&");
  }

  const objValue = String(obj);
  if (obj && typeof obj === "object" && objValue === "[object Object]") {
    const items: string[] = [];
    for (const key in obj as Record<string, unknown>) {
      if (key === "") {
        continue;
      }
      const value = (obj as Record<string, unknown>)[key];
      if (value === null || value === undefined) {
        items.push(encodeURIComponent(key) + "=");
      } else {
        const keyPrefix = prefix ? `${prefix}[${encodeURIComponent(key)}]` : encodeURIComponent(key);
        items.push(stringifyQuery(value, keyPrefix));
      }
    }
    return items.join("&");
  }

  if (!prefix) {
    throw new TypeError("stringify expects an object");
  }
  return `${prefix}=${encodeURIComponent(objValue)}`;
}
