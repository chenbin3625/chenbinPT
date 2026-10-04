import type { TSiteFullUrl, TSiteHost } from "../types";

/**
 * cloudflare Email 解码方法，来自 https://usamaejaz.com/cloudflare-email-decoding/
 *
 * 输入形如 `412023`：前 2 个十六进制字符是异或键，其后每 2 个字符编码 1 个明文字符。
 *
 * 修复了两个继承自上游片段的缺陷：
 * 1) `parseInt(encodedString.slice(n, 2), 16)` —— `slice` 的第二参是**结束下标**（不是长度），
 *    n >= 2 时永远取到空串，得到 `NaN`，而 `NaN ^ r === r`，于是每个字符都被解成
 *    `String.fromCharCode(r)`，整串解不出来。已改为 `slice(n, n + 2)`。
 * 2) 循环条件 `encodedString.length - n` 在长度 < 2 或为奇数时恒为真值 →
 *    **无限循环直至 OOM**（`data-cfemail` 缺失/为空时可达）。已改为 `n + 2 <= length`。
 *
 * @param encodedString 站点上 `data-cfemail` 属性的原始值
 * @returns 解码后的邮箱；输入非法（过短 / 非十六进制）时返回空串
 */
export function cfDecodeEmail(encodedString: string): string {
  // 至少需要「2 位异或键 + 2 位数据」才能解出 1 个字符
  if (encodedString.length < 4) {
    return "";
  }

  const r = parseInt(encodedString.slice(0, 2), 16);
  if (Number.isNaN(r)) {
    return "";
  }

  let email = "";
  for (let n = 2; n + 2 <= encodedString.length; n += 2) {
    const i = parseInt(encodedString.slice(n, n + 2), 16) ^ r;
    if (Number.isNaN(i)) {
      continue;
    }
    email += String.fromCharCode(i);
  }
  return email;
}

// From: https://stackoverflow.com/a/28899585/8824471
export function extractContent(s: string): string {
  const span = document.createElement("span");
  span.innerHTML = s;
  return span.textContent || span.innerText;
}

/**
 * 通用版本：按**谓词**排除元素及其子树后再取文本。
 *
 * 谓词签名 `(element, isDirectChild) => boolean`，作用与 `extractTextExcluding` 一致，
 * 但可以表达"按内容判断是否排除"这类无法用选择器描述的条件
 * （例如 hdcity 要删掉 textContent 里包含 "star" 的 i/span/div）。
 *
 * 与旧写法「clone → 逐个 remove → textContent」等价的原因：被删元素的 textContent
 * 是元素自身固有属性，不会因为兄弟/子元素先被删除而改变；因此"静态列表 + 逐个跳过"
 * 与"逐个 remove"得到的保留集合相同。
 */
export function extractTextExcludingByPredicate(
  element: Element,
  isExcluded: (target: Element, isDirectChild: boolean) => boolean,
): string {
  let text = "";

  const walk = (node: Node, isDirectChild: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.nodeValue ?? "";
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const childElement = node as Element;
    if (isExcluded(childElement, isDirectChild)) {
      return; // 该元素及其子树被排除（等价于 remove()）
    }

    childElement.childNodes.forEach((child) => walk(child, false));
  };

  element.childNodes.forEach((child) => walk(child, true));
  return text;
}

/**
 * 读取 element 的文本内容，但排除匹配 excludeSelector 的后代元素（element 自身不会被排除）。
 *
 * 等价于 `cloneNode(true)` 后删除这些后代元素再取文本，但不需要深克隆整棵子树，
 * 适合在每行解析的热路径上替代「先深克隆再删节点」的写法。
 *
 * 支持以 `>` 开头的"仅直接子元素"选择器（如 `">span, div.torrent_info"`），
 * 语义与 Sizzle/querySelector 中以当前元素为上下文的 `>span` 一致 ——
 * 注意 `Element.matches(">span")` 本身是非法选择器，因此这里显式拆开处理。
 */
export function extractTextExcluding(element: Element, excludeSelector: string): string {
  const parts = excludeSelector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const directChildSelectors: string[] = [];
  const descendantSelectors: string[] = [];
  for (const part of parts) {
    if (part.startsWith(">")) {
      directChildSelectors.push(part.slice(1).trim());
    } else {
      descendantSelectors.push(part);
    }
  }

  return extractTextExcludingByPredicate(element, (target, isDirectChild) => {
    if (isDirectChild && directChildSelectors.some((selector) => target.matches(selector))) {
      return true;
    }
    return descendantSelectors.some((selector) => target.matches(selector));
  });
}

export function createDocument(str: string, type: DOMParserSupportedType = "text/html"): Document {
  return new DOMParser().parseFromString(str, type);
}

const inputChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".split("");
const outputChars = "NOPQRSTUVWXYZABCDEFGHIJKLMnopqrstuvwxyzabcdefghijklm".split("");

// 创建映射表，使用 Record 类型明确键和值的类型
const lookupTable: Record<string, string> = inputChars.reduce(
  (map, char, index) => ({ ...map, [char]: outputChars[index] }),
  {} as Record<string, string>,
);

/**
 * 对输入字符串执行 ROT13 加密/解密
 * @param input 待处理的字符串
 * @returns 处理后的字符串
 */
export function rot13(input: string): string {
  return input
    .split("")
    .map((char) => lookupTable[char] || char)
    .join("");
}

export function restoreSecureLink(url: string): TSiteFullUrl {
  return (url.startsWith("uggc") ? rot13(url) : url) as TSiteFullUrl;
}

export function getHostFromUrl(url: string): TSiteHost {
  let host = url;
  try {
    const urlObj = new URL(url);
    host = urlObj.host;
  } catch (e) {
    // P1-5：URL 非法时回落为原字符串（调用方依赖该兜底行为，不能改为抛出）。
    // 这里刻意只用 console.debug 而不接 logger：html.ts 是 content-script 引导入口
    // （content-script/index.ts）静态依赖的纯工具模块，引入 adapter/logger 会把 axios
    // 等重资源带进每次页面加载都要执行的引导包（见 docs/performance-audit.md P1-3）。
    console.debug(`[PTD] getHostFromUrl: invalid url, fallback to raw value`, url, e);
  }

  return host;
}
