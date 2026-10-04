/**
 * 薄选择器层：用来替代已停止维护的第三方依赖 `Sizzle`（jQuery 选择器引擎）。
 *
 * ## 为什么需要它
 *
 * 站点定义（`site/definitions/**`）与站点引擎（`site/schemas/**`）、社交站点实体
 * （`social/entity/**`）里大量使用 **jQuery 扩展伪类**，原生 CSS 选择器并不支持：
 *
 * - 位置伪类：`:first` / `:last` / `:eq(n)` / `:nth(n)` / `:gt(n)` / `:lt(n)` / `:even` / `:odd`
 *   （作用于「当前匹配集合」的下标，而不是元素自身属性），以及 `:not(:eq(n))` / `:not(:last)`
 * - 内容伪类：`:contains("文字")`（对 `textContent` 做大小写敏感的子串匹配）
 * - 关系伪类：`:has(sel)`，参数支持相对选择器（`> x` / `+ x` / `~ x`）
 *
 * 本模块只用浏览器原生 DOM API 复刻上述语义，**不引入任何新依赖**。
 *
 * ## 设计
 *
 * 1. **纯原生 CSS 选择器**（不含上述扩展伪类）→ 整体交给 `querySelectorAll`，
 *    并复刻 Sizzle 对 Element 上下文的「作用域修正」：
 *    - 选择器含后代/子代组合符时，用 `:scope ` 前缀（Sizzle 在支持 `:scope` 时也这么做）；
 *    - 含兄弟组合符（`+` / `~`）时，改用父节点为查询根 + 临时 `id` 前缀（与 Sizzle 的 ID hack 一致）。
 *    这样可避免 `element.querySelectorAll()` 会把「上下文自身/祖先」也算进去的语义差异。
 * 2. **含扩展伪类** → 自研求值：
 *    - 位置伪类按 Sizzle 的「左侧先行」分阶段求值：先求出左侧选择器匹配到的集合，
 *      按位置过滤，再把右侧剩余选择器以**过滤结果的并集**为上下文求值；后续若还有位置伪类，
 *      同样作用在该阶段的并集上（对应 Sizzle `setMatcher` 的 `postFinder` 语义，
 *      因此 `tr:gt(0) td:eq(0)` 只取整体第一个 `td`，且结果按文档序去重）；
 *    - `:contains` / `:has` / `:not(扩展)` 作为**逐元素谓词**：先用「去掉扩展伪类」的选择器
 *      （只会放大匹配集）取候选，再自右向左校验整条链。
 * 3. 越界语义与 Sizzle 一致：`:eq(n)` 越界得到空集，`:eq(-1)` 取最后一个，`:gt/:lt` 支持负下标。
 *
 * ## 已知差异（无调用点，见迁移报告）
 *
 * - 非法伪类（如 `:unknownpseudo`）在 Sizzle 下抛 `Syntax error, unrecognized expression`；
 *   本模块在支持该行为的引擎（Chrome/Firefox）同样抛错，但在 happy-dom 下 `matches()` 会
 *   静默返回 false。调用点均使用合法选择器。
 * - `Document` 上下文 + 前置兄弟组合符（`~ x` / `+ x`）属于 Sizzle 的退化分支，本模块按
 *   「相对上下文的兄弟关系」处理，仓库内无调用点。
 */

/** 作用域探测结果缓存（`:scope` 前缀是否可用），undefined 表示尚未探测 */
let scopeSupportCache: boolean | undefined;

/** 临时 id 计数器（仅在需要 ID hack 时使用） */
let tempIdCounter = 0;

/** 临时 id 前缀：与 Sizzle 一样，用完立即移除，不污染页面 */
const TEMP_ID_PREFIX = "ptd-selector-scope-";

/** 空白字符类（与 CSS / Sizzle 的 `whitespace` 一致） */
const WS_CLASS = "[\\x20\\t\\r\\n\\f]";

/** 与 Sizzle 的 `rdescend` 等价：存在后代组合符（空白）或子代组合符 `>` */
const R_DESCEND = new RegExp(WS_CLASS + "|>");

/** 与 Sizzle 的 `rleadingCombinator` 等价：前置组合符（含前置空白） */
const R_LEADING = new RegExp("^" + WS_CLASS + "*([>+~]|" + WS_CLASS + ")" + WS_CLASS + "*");

/** 与 Sizzle 的 `rsibling` 等价 */
const R_SIBLING = /[+~]/;

/** 位置伪类：作用于当前匹配集合的下标 */
const POSITIONAL_PSEUDOS = new Set(["first", "last", "eq", "nth", "gt", "lt", "even", "odd"]);

/** 扩展伪类：原生 CSS 没有等价实现，需要逐元素求值 */
const CUSTOM_PSEUDOS = new Set(["contains", "has"]);

/** 伪类的求值类别 */
type PseudoKind = "positional" | "custom" | "native";

/** 组合符；`null` 仅出现在一个分组的第一个 token 上 */
type Combinator = " " | ">" | "+" | "~";

/** 解析出的单个伪类 */
interface PseudoToken {
  /** 小写化后的伪类名（不含 `:`） */
  name: string;
  /** 去掉外层引号并做 CSS 反转义后的参数；无参数时为空串 */
  argument: string;
  /** 求值类别 */
  kind: PseudoKind;
  /** 在 compound 文本中的起始下标（含 `:`） */
  start: number;
  /** 在 compound 文本中的结束下标（不含） */
  end: number;
}

/** 解析后的单个 compound（如 `div.foo:has(a)`） */
interface CompoundInfo {
  /** 该 compound 内的所有顶层伪类 */
  pseudos: PseudoToken[];
  /**
   * 去掉「位置伪类 + 扩展伪类」后剩下的片段。
   * 只会放大匹配集，用于候选集生成与原生 `matches()` 校验。
   */
  nativeText: string;
  hasPositional: boolean;
  hasCustom: boolean;
}

/** 解析后的 token：组合符 + compound */
interface GroupToken {
  combinator: Combinator | null;
  compound: CompoundInfo;
}

/* -------------------------------------------------------------------------- */
/* 词法解析                                                                    */
/* -------------------------------------------------------------------------- */

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f";
}

/**
 * 在 `text` 中从 `open`（指向 `(` 或 `[`）开始找到配对的闭合符号下标，考虑引号与转义。
 * 找不到时返回 `text.length - 1`。
 */
function findMatching(text: string, open: number): number {
  const openCh = text[open];
  const closeCh = openCh === "(" ? ")" : "]";
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === openCh) {
      depth++;
      continue;
    }
    if (ch === closeCh) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return text.length - 1;
}

/** 按顶层逗号切分选择器（忽略 `()` / `[]` 内以及引号内的逗号） */
export function splitSelectorGroups(selector: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) {
      groups.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  groups.push(selector.slice(start));
  return groups.map((group) => group.trim()).filter((group) => group.length > 0);
}

/** CSS 反转义（与 Sizzle 的 `runescape` + `funescape` 行为对齐，只处理常见情形） */
function unescapeCss(value: string): string {
  return value.replace(/\\([\da-fA-F]{1,6}[\x20\t\r\n\f]?|.)/g, (_all, escaped: string) => {
    if (!/^[\da-fA-F]{1,6}[\x20\t\r\n\f]?$/.test(escaped)) {
      return escaped;
    }
    const code = parseInt(escaped, 16);
    if (!Number.isFinite(code)) {
      return escaped;
    }
    return code <= 0xffff ? String.fromCharCode(code) : String.fromCodePoint(code);
  });
}

/** 去掉伪类参数外层的成对引号（Sizzle 的 `pseudos` 正则同样会剥掉引号） */
function stripQuotes(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    if ((first === "'" || first === '"') && raw[raw.length - 1] === first) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/**
 * 扫描一段文本里的「顶层伪类」。
 * 复合选择器与整条选择器都可复用（只识别括号深度 0 处的 `:`）。
 */
function scanPseudos(text: string): PseudoToken[] {
  const pseudos: PseudoToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      i = findMatching(text, i) + 1;
      continue;
    }
    if (ch !== ":") {
      i++;
      continue;
    }
    let j = i + 1;
    // 伪元素 `::before`：跳过第二个冒号，按普通伪类记录（保持 nativeText 不变）
    if (text[j] === ":") {
      j++;
    }
    const nameStart = j;
    while (j < text.length && /[\w-]/.test(text[j])) {
      j++;
    }
    const name = text.slice(nameStart, j).toLowerCase();
    let argument = "";
    let end = j;
    if (text[j] === "(") {
      const close = findMatching(text, j);
      argument = text.slice(j + 1, close);
      end = close + 1;
    }
    const kind: PseudoKind =
      name.length === 0
        ? "native"
        : POSITIONAL_PSEUDOS.has(name)
          ? "positional"
          : CUSTOM_PSEUDOS.has(name)
            ? "custom"
            : name === "not"
              ? classifyNotArgument(argument)
              : "native";
    pseudos.push({ name, argument: stripQuotes(unescapeCss(argument)), kind, start: i, end });
    i = end;
  }
  return pseudos;
}

/**
 * `:not(x)` 的类别取决于参数：
 * - 参数里含位置伪类 → 整个 `:not(...)` 是**位置语义**（求补集）
 * - 否则参数里含扩展伪类 → 逐元素谓词
 * - 否则 → 原生 `:not()`
 */
function classifyNotArgument(argument: string): PseudoKind {
  const inner = scanPseudos(argument);
  if (inner.some((pseudo) => pseudo.kind === "positional")) {
    return "positional";
  }
  if (inner.some((pseudo) => pseudo.kind === "custom")) {
    return "custom";
  }
  return "native";
}

/** 去掉指定伪类后的文本（只放大匹配集，用于候选集生成） */
function textWithoutPseudos(text: string, pseudos: PseudoToken[]): string {
  const removals = pseudos
    .filter((pseudo) => pseudo.kind !== "native")
    .map((pseudo) => [pseudo.start, pseudo.end] as const)
    .sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [start, end] of removals) {
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/** 构造 compound 信息 */
function buildCompound(text: string): CompoundInfo {
  const pseudos = scanPseudos(text);
  return {
    pseudos,
    nativeText: textWithoutPseudos(text, pseudos),
    hasPositional: pseudos.some((pseudo) => pseudo.kind === "positional"),
    hasCustom: pseudos.some((pseudo) => pseudo.kind === "custom"),
  };
}

/** 读取一个 compound（到顶层空白或组合符为止） */
function readCompound(text: string, from: number): { raw: string; end: number } {
  let i = from;
  let depth = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "[" || ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === "]" || ch === ")") {
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && (isWhitespace(ch) || ch === ">" || ch === "+" || ch === "~")) {
      break;
    }
    i++;
  }
  return { raw: text.slice(from, i), end: i };
}

/** 解析一个分组为 token 列表（不做语义求值，只做词法切分） */
export function parseGroupTokens(group: string): GroupToken[] {
  const tokens: GroupToken[] = [];
  let i = 0;
  // 前置组合符（含前置空白）
  const leadingWsStart = i;
  while (i < group.length && isWhitespace(group[i])) {
    i++;
  }
  let leading: Combinator | null = null;
  if (group[i] === ">" || group[i] === "+" || group[i] === "~") {
    leading = group[i] as Combinator;
    i++;
    while (i < group.length && isWhitespace(group[i])) {
      i++;
    }
  } else if (i > leadingWsStart) {
    leading = " ";
  }

  let combinator: Combinator | null = leading;
  let first = true;
  while (i < group.length) {
    const { raw, end } = readCompound(group, i);
    if (raw.length > 0) {
      tokens.push({ combinator: first ? leading : combinator, compound: buildCompound(raw) });
      first = false;
    }
    i = end;
    // 读取组合符
    const wsStart = i;
    while (i < group.length && isWhitespace(group[i])) {
      i++;
    }
    const next = group[i];
    if (next === ">" || next === "+" || next === "~") {
      combinator = next;
      i++;
      while (i < group.length && isWhitespace(group[i])) {
        i++;
      }
    } else if (i > wsStart) {
      combinator = " ";
    } else {
      break;
    }
  }
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* CSS 片段规整                                                                */
/* -------------------------------------------------------------------------- */

/** 是否为合法的 CSS 标识符开头（不能以数字开头，也不能是 `-` + 数字） */
function isValidCssIdentifier(name: string): boolean {
  if (/^\d/.test(name)) {
    return false;
  }
  if (/^-\d/.test(name)) {
    return false;
  }
  return true;
}

/**
 * 把不合法的 ID 选择器（如 `tr#9`）改写成属性选择器（`tr[id="9"]`）。
 * 原生 `querySelectorAll("tr#9")` 在浏览器里会抛 SyntaxError，而 Sizzle 的
 * `identifier` 允许以数字开头，因此这里显式对齐 Sizzle 的行为。
 */
function cssify(text: string): string {
  let out = "";
  let i = 0;
  let depth = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "[" || ch === "(") {
      depth++;
      out += ch;
      i++;
      continue;
    }
    if (ch === "]" || ch === ")") {
      depth--;
      out += ch;
      i++;
      continue;
    }
    if (ch === "#" && depth === 0) {
      let j = i + 1;
      while (j < text.length && /[\w-]/.test(text[j])) {
        j++;
      }
      const name = text.slice(i + 1, j);
      if (name.length > 0 && !isValidCssIdentifier(name)) {
        out += `[id="${name.replace(/"/g, '\\"')}"]`;
        i = j;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** 生成作用域前缀用的、被正确转义的 id 选择器 */
function escapeId(id: string): string {
  const cssGlobal = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS;
  if (cssGlobal && typeof cssGlobal.escape === "function") {
    return cssGlobal.escape(id);
  }
  return id.replace(/[^\w-]/g, (ch) => "\\" + ch);
}

/** 探测当前文档是否支持 `:scope` 前缀 */
function supportsScope(context: ParentNode): boolean {
  if (scopeSupportCache !== undefined) {
    return scopeSupportCache;
  }
  try {
    const doc = (context as Element).ownerDocument ?? (context as Document);
    const host = doc.createElement("div");
    host.appendChild(doc.createElement("span"));
    scopeSupportCache = host.querySelectorAll(":scope > span").length === 1;
  } catch {
    scopeSupportCache = false;
  }
  return scopeSupportCache;
}

/** 是否为可作为查询根的节点 */
function isQueryRoot(node: Node | null): boolean {
  if (!node) {
    return false;
  }
  return node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11;
}

/**
 * 是否为「非 HTML 文档」上下文 —— 对齐 Sizzle 的 `documentIsHTML === false`。
 *
 * Sizzle 在非 HTML 文档下会跳过 base matcher 的「上下文可达性」校验
 * （`select` 传入的 `xml` 参数为 true），于是 `Sizzle("titles > title", titlesEl)`
 * 这类选择器**允许最左段命中上下文自身**。AniDB / Douban 等 XML API 响应就落在这条分支上。
 */
function isXmlContext(context: ParentNode): boolean {
  const doc = ((context as Node).nodeType === 9 ? context : (context as Element).ownerDocument) as Document | null;
  const docElement = doc?.documentElement;
  const namespace = (context as Element).namespaceURI;
  // Sizzle: `!rhtml.test( namespace || docElem && docElem.nodeName || "HTML" )`
  const probe = namespace || (docElement && docElement.nodeName) || "HTML";
  return !/HTML$/i.test(probe);
}

/** 用「临时 id + 父节点」为根执行查询（对应 Sizzle 的 ID hack） */
function queryWithIdPrefix(root: ParentNode, scopeEl: Element, selector: string): Element[] {
  const existing = scopeEl.getAttribute("id");
  let id: string;
  let temporary = false;
  if (existing !== null && existing.length > 0) {
    id = escapeId(existing);
  } else {
    id = TEMP_ID_PREFIX + tempIdCounter++;
    scopeEl.setAttribute("id", id);
    temporary = true;
  }
  try {
    const prefixed = splitSelectorGroups(selector)
      .map((group) => "#" + id + " " + group)
      .join(",");
    return Array.from(root.querySelectorAll(prefixed)) as Element[];
  } finally {
    if (temporary) {
      scopeEl.removeAttribute("id");
    }
  }
}

/**
 * 原生查询（对齐 Sizzle 的 qSA 快路径）：
 * - Document / DocumentFragment 上下文：直接用 `querySelectorAll`；
 * - Element 上下文：选择器含组合符时补上作用域前缀，避免把上下文自身或祖先算进去。
 */
function nativeQuery(selector: string, context: ParentNode): Element[] {
  const text = cssify(selector);
  const node = context as Node;
  if (node.nodeType === 1 && !isXmlContext(context) && (R_DESCEND.test(text) || R_LEADING.test(text))) {
    const element = context as Element;
    const parent = element.parentNode;
    if (R_SIBLING.test(text) && isQueryRoot(parent)) {
      return queryWithIdPrefix(parent as ParentNode, element, text);
    }
    if (supportsScope(context)) {
      return Array.from(element.querySelectorAll(":scope " + text)) as Element[];
    }
    return queryWithIdPrefix(element, element, text);
  }
  return Array.from(context.querySelectorAll(text)) as Element[];
}

/** 原生 `matches` 包装：非法/不支持的选择器返回 false（与 happy-dom 的宽松行为一致） */
function safeMatches(elem: Element, selector: string): boolean {
  if (selector.length === 0) {
    return true;
  }
  try {
    return elem.matches(cssify(selector));
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* 逐元素谓词求值                                                              */
/* -------------------------------------------------------------------------- */

/** `:contains()` —— 对 textContent 做大小写敏感子串匹配（与 Sizzle 一致） */
function containsText(elem: Element, text: string): boolean {
  const content = elem.textContent;
  return (content ?? "").includes(text);
}

/**
 * 元素是否命中某条选择器（用于 `:not(...)` 的扩展参数）。
 * 语义等价于 Sizzle 的 `compile(sel)([elem], null, xml, [])`，即「在文档范围内判断 elem 是否命中」。
 */
function elementMatchesAnyScope(elem: Element, selector: string): boolean {
  const doc = elem.ownerDocument ?? document;
  const xml = isXmlContext(doc);
  const groups = splitSelectorGroups(selector);
  for (const group of groups) {
    const tokens = parseGroupTokens(group);
    if (tokens.length === 0) {
      continue;
    }
    if (tokens.some((token) => token.compound.hasPositional)) {
      if (selectElements(selector, doc).includes(elem)) {
        return true;
      }
      continue;
    }
    if (matchesChain(elem, tokens, doc, xml)) {
      return true;
    }
  }
  return false;
}

/** 元素是否命中某个 compound（原生片段 + 扩展伪类谓词） */
function matchesCompound(elem: Element, compound: CompoundInfo): boolean {
  if (compound.nativeText.length > 0 && !safeMatches(elem, compound.nativeText)) {
    return false;
  }
  for (const pseudo of compound.pseudos) {
    if (pseudo.kind === "native") {
      continue;
    }
    if (pseudo.kind === "positional") {
      // 位置伪类在 evalPositionalGroup 中处理，不会走到这里
      continue;
    }
    if (pseudo.name === "contains") {
      if (!containsText(elem, pseudo.argument)) {
        return false;
      }
    } else if (pseudo.name === "has") {
      if (selectElements(pseudo.argument, elem).length === 0) {
        return false;
      }
    } else if (pseudo.name === "not") {
      if (elementMatchesAnyScope(elem, pseudo.argument)) {
        return false;
      }
    }
  }
  return true;
}

/** 左侧 token 与上下文的相对关系校验（对齐 Sizzle 的 base matcher） */
function inScope(elem: Element, combinator: Combinator | null, context: ParentNode): boolean {
  if (combinator === null || combinator === " ") {
    return elem !== (context as unknown as Element) && (context as Node).contains(elem);
  }
  if (combinator === ">") {
    return elem.parentNode === (context as Node);
  }
  if (combinator === "+") {
    return elem.previousElementSibling === (context as unknown as Element);
  }
  // "~"：上下文必须是 elem 的前置兄弟元素
  let sibling: Element | null = elem.previousElementSibling;
  while (sibling) {
    if (sibling === (context as unknown as Element)) {
      return true;
    }
    sibling = sibling.previousElementSibling;
  }
  return false;
}

/**
 * 自右向左校验整条链。
 *
 * `xml` 为 true 时跳过最左段与上下文的相对关系校验 —— 这是 Sizzle 在非 HTML 文档下的行为。
 */
function matchesChain(elem: Element, tokens: GroupToken[], context: ParentNode, xml: boolean): boolean {
  const step = (index: number, current: Element): boolean => {
    if (!matchesCompound(current, tokens[index].compound)) {
      return false;
    }
    if (index === 0) {
      return xml || inScope(current, tokens[0].combinator, context);
    }
    const combinator = tokens[index].combinator;
    if (combinator === ">") {
      const parent = current.parentElement;
      return parent !== null && step(index - 1, parent);
    }
    if (combinator === "+") {
      const previous = current.previousElementSibling;
      return previous !== null && step(index - 1, previous);
    }
    if (combinator === "~") {
      let sibling: Element | null = current.previousElementSibling;
      while (sibling) {
        if (step(index - 1, sibling)) {
          return true;
        }
        sibling = sibling.previousElementSibling;
      }
      return false;
    }
    let parent: Element | null = current.parentElement;
    while (parent) {
      if (step(index - 1, parent)) {
        return true;
      }
      parent = parent.parentElement;
    }
    return false;
  };
  return step(tokens.length - 1, elem);
}

/* -------------------------------------------------------------------------- */
/* 位置伪类                                                                    */
/* -------------------------------------------------------------------------- */

/** 解析位置伪类的数字参数（`+argument` 语义，非法值得到 NaN） */
function parseIndexArgument(argument: string): number {
  const trimmed = argument.trim();
  if (trimmed.length === 0) {
    return Number.NaN;
  }
  return Number(trimmed);
}

/** 按下标集合过滤集合 */
function filterByIndices(elements: Element[], keep: Set<number>): Element[] {
  if (keep.size === elements.length) {
    return elements;
  }
  return elements.filter((_elem, index) => keep.has(index));
}

/** 按位置伪类计算要保留的下标；索引语义与 Sizzle 的 `setFilters` 完全一致 */
function positionalIndices(length: number, pseudo: PseudoToken): Set<number> {
  const argument = parseIndexArgument(pseudo.argument);
  const keep = new Set<number>();
  switch (pseudo.name) {
    case "first": {
      if (length > 0) {
        keep.add(0);
      }
      break;
    }
    case "last": {
      if (length > 0) {
        keep.add(length - 1);
      }
      break;
    }
    case "eq":
    case "nth": {
      const index = argument < 0 ? argument + length : argument;
      if (Number.isInteger(index) && index >= 0 && index < length) {
        keep.add(index);
      }
      break;
    }
    case "even": {
      for (let i = 0; i < length; i += 2) {
        keep.add(i);
      }
      break;
    }
    case "odd": {
      for (let i = 1; i < length; i += 2) {
        keep.add(i);
      }
      break;
    }
    case "lt": {
      let limit = argument < 0 ? argument + length : argument > length ? length : argument;
      if (!Number.isFinite(limit)) {
        limit = 0;
      }
      for (let i = 0; i < limit; i++) {
        keep.add(i);
      }
      break;
    }
    default: {
      // gt
      const start = argument < 0 ? argument + length : argument;
      for (let i = start + 1; i < length; i++) {
        keep.add(i);
      }
      break;
    }
  }
  return keep;
}

/** 取补集：`:not(<位置伪类>)` 的语义 */
function complementIndices(all: Set<number>, matched: Set<number>): Set<number> {
  const keep = new Set<number>();
  for (const index of all) {
    if (!matched.has(index)) {
      keep.add(index);
    }
  }
  return keep;
}

/** 对给定集合求 `:not(argument)` 的补集（argument 可能是复合条件 + 位置伪类） */
function notPositionalComplement(elements: Element[], argument: string): Set<number> {
  const all = new Set<number>(elements.map((_elem, index) => index));
  const tokens = parseGroupTokens(argument);
  if (tokens.length === 0 || tokens.some((token) => token.combinator !== null && token.combinator !== " ")) {
    // 含组合符的 `:not(位置伪类)` 没有调用点，保守地视为「不排除任何元素」
    return all;
  }
  let matched = elements.slice();
  for (const token of tokens) {
    if (token.compound.nativeText.length > 0 || token.compound.hasCustom) {
      matched = matched.filter((elem) => matchesCompound(elem, token.compound));
    }
  }
  for (const token of tokens) {
    for (const pseudo of token.compound.pseudos) {
      if (pseudo.kind === "positional") {
        matched = filterByIndices(matched, positionalIndices(matched.length, pseudo));
      }
    }
  }
  const matchedSet = new Set(matched);
  const matchedIndices = new Set<number>();
  elements.forEach((elem, index) => {
    if (matchedSet.has(elem)) {
      matchedIndices.add(index);
    }
  });
  return complementIndices(all, matchedIndices);
}

/** 按位置伪类过滤集合 */
function applyPositional(elements: Element[], pseudo: PseudoToken): Element[] {
  const keep =
    pseudo.name === "not"
      ? notPositionalComplement(elements, pseudo.argument)
      : positionalIndices(elements.length, pseudo);
  return filterByIndices(elements, keep);
}

/* -------------------------------------------------------------------------- */
/* 候选集生成                                                                  */
/* -------------------------------------------------------------------------- */

/** 把 token 列表还原成选择器文本（nativeText 优先，空 compound 退化为 `*`） */
function tokensToText(tokens: GroupToken[]): string {
  let out = "";
  tokens.forEach((token, index) => {
    if (index === 0) {
      if (token.combinator === ">" || token.combinator === "+" || token.combinator === "~") {
        out += token.combinator + " ";
      }
    } else {
      out += " " + (token.combinator ?? " ") + " ";
    }
    out += token.compound.nativeText.length > 0 ? token.compound.nativeText : "*";
  });
  return out;
}

/** 上下文的全部后代元素 */
function allElements(context: ParentNode): Element[] {
  return Array.from(context.querySelectorAll("*")) as Element[];
}

/** 某元素之后的所有兄弟元素 */
function followingElementSiblings(el: Element): Element[] {
  const out: Element[] = [];
  let sibling: Element | null = el.nextElementSibling;
  while (sibling) {
    out.push(sibling);
    sibling = sibling.nextElementSibling;
  }
  return out;
}

/**
 * 生成候选集（一定是真实结果的**超集**，随后由 matchesChain 精确过滤）。
 *
 * - 非 HTML 文档（XML）：上下文内的全部后代（最左段可能命中上下文自身，qSA 的作用域会漏掉）；
 * - 前置组合符：以「子元素 / 相邻兄弟 / 后续兄弟」为锚点，取其自身与整棵子树；
 * - 其他情况：用「去掉扩展伪类」的选择器做原生查询（去掉过滤只会放大集合）。
 *   Element 上下文的越界泄漏由 matchesChain 的 inScope 兜底。
 */
function collectCandidates(tokens: GroupToken[], context: ParentNode, xml: boolean): Element[] {
  if (xml) {
    return allElements(context);
  }
  const leading = tokens[0].combinator;
  if (leading === ">" || leading === "+" || leading === "~") {
    let anchors: Element[];
    if (leading === ">") {
      anchors = Array.from((context as Element).children ?? []);
    } else if (leading === "+") {
      const next = (context as Element).nextElementSibling;
      anchors = next ? [next] : [];
    } else {
      anchors = followingElementSiblings(context as Element);
    }
    const out: Element[] = [];
    for (const anchor of anchors) {
      out.push(anchor);
      out.push(...(Array.from(anchor.querySelectorAll("*")) as Element[]));
    }
    return out;
  }
  const text = cssify(tokensToText(tokens));
  try {
    return Array.from(context.querySelectorAll(text)) as Element[];
  } catch {
    return allElements(context);
  }
}

/* -------------------------------------------------------------------------- */
/* 分组求值                                                                    */
/* -------------------------------------------------------------------------- */

/** 按元素谓词求值（无位置伪类） */
function evalElementwiseChain(tokens: GroupToken[], context: ParentNode): Element[] {
  const xml = isXmlContext(context);
  const candidates = collectCandidates(tokens, context, xml);
  const out: Element[] = [];
  for (const candidate of candidates) {
    if (matchesChain(candidate, tokens, context, xml)) {
      out.push(candidate);
    }
  }
  return out;
}

/**
 * 若干结果集合的并集，按文档序去重。
 *
 * 位置伪类必须作用在「所有上下文命中的元素」这一个整体上，因此各子上下文的结果要先并起来，
 * 而不是首尾相接（后者既可能重复，也可能打乱文档序）。
 */
function unionInDocumentOrder(sets: Element[][]): Element[] {
  if (sets.length === 0) {
    return [];
  }
  if (sets.length === 1) {
    return sets[0];
  }
  const union: Element[] = [];
  const seen = new Set<Element>();
  for (const set of sets) {
    for (const element of set) {
      if (!seen.has(element)) {
        seen.add(element);
        union.push(element);
      }
    }
  }
  return uniqueSort(union);
}

/** 按位置伪类分阶段求值（Sizzle 的「左侧先行」语义） */
function evalPositionalGroup(tokens: GroupToken[], context: ParentNode): Element[] {
  return evalTokenStages(tokens, [context]);
}

/**
 * 在一组上下文上分阶段求值。
 *
 * Sizzle 遇到位置伪类时（`matcherFromTokens` → `setMatcher`），会把左侧命中的元素集合
 * **整体**作为后续选择器的上下文（`postFinder(null, [], temp)`，`temp` 是存活元素数组），因此：
 *
 * - 后续选择器要在「存活元素集合」上求**并集**，而不是逐个元素分别求值再拼接；
 * - 尾随位置伪类作用于**并集**：`"tr:gt(0) td:eq(0)"` 只取整体第一个 `td`，
 *   而不是每个存活行各取第一个（修复前会多返回元素，见 A-18）。
 *
 * @param contexts 首个阶段是查询根（Document / Element），后续阶段是上一阶段存活的元素
 */
function evalTokenStages(tokens: GroupToken[], contexts: ParentNode[]): Element[] {
  const position = tokens.findIndex((token) => token.compound.hasPositional);
  if (position < 0) {
    // 没有位置伪类：各上下文分别求值后取并集（对应 Sizzle 的 `multipleContexts`）
    return unionInDocumentOrder(contexts.map((context) => evalTokens(tokens, context)));
  }

  const token = tokens[position];
  const prefixTokens: GroupToken[] = tokens.slice(0, position).map((item) => ({ ...item }));

  const remainingPseudos = token.compound.pseudos.filter((pseudo) => pseudo.kind !== "positional");
  const prefixCompound: CompoundInfo = {
    pseudos: remainingPseudos,
    nativeText: token.compound.nativeText,
    hasPositional: false,
    hasCustom: remainingPseudos.some((pseudo) => pseudo.kind === "custom"),
  };
  const prefixHasContent =
    prefixCompound.nativeText.length > 0 || remainingPseudos.length > 0 || prefixTokens.length > 0;
  if (prefixHasContent) {
    prefixTokens.push({ combinator: token.combinator, compound: prefixCompound });
  }

  const candidates = unionInDocumentOrder(
    contexts.map((context) => (prefixTokens.length === 0 ? allElements(context) : evalTokens(prefixTokens, context))),
  );
  let filtered = candidates;
  for (const pseudo of token.compound.pseudos) {
    if (pseudo.kind === "positional") {
      filtered = applyPositional(filtered, pseudo);
    }
  }

  const rest = tokens.slice(position + 1);
  if (rest.length === 0) {
    return filtered;
  }
  // 后续选择器以「存活元素整体」为上下文继续分阶段求值（位置伪类仍作用于并集）
  return evalTokenStages(
    rest.map((item) => ({ ...item })),
    filtered,
  );
}

/** 分组是否以子代/兄弟组合符开头 */
function hasLeadingCombinator(tokens: GroupToken[]): boolean {
  const combinator = tokens[0]?.combinator;
  return combinator === ">" || combinator === "+" || combinator === "~";
}

/**
 * 无扩展伪类的分组求值。
 *
 * 两种情况下不能直接用 `querySelectorAll`：
 * - Document / DocumentFragment 上下文 + 前置组合符（`"> td"` 会抛 SyntaxError）；
 * - 非 HTML 文档上下文（qSA 的作用域比 Sizzle 更严，会漏掉最左段命中上下文自身的匹配）。
 */
function evalNativeGroup(tokens: GroupToken[], context: ParentNode): Element[] {
  if ((context as Node).nodeType !== 1 && hasLeadingCombinator(tokens)) {
    return evalElementwiseChain(tokens, context);
  }
  if (isXmlContext(context)) {
    return evalElementwiseChain(tokens, context);
  }
  return nativeQuery(tokensToText(tokens), context);
}

/** 求值一个分组 */
function evalTokens(tokens: GroupToken[], context: ParentNode): Element[] {
  if (tokens.length === 0) {
    return [];
  }
  if (tokens.some((token) => token.compound.hasPositional)) {
    return evalPositionalGroup(tokens, context);
  }
  if (tokens.some((token) => token.compound.hasCustom)) {
    return evalElementwiseChain(tokens, context);
  }
  return evalNativeGroup(tokens, context);
}

/* -------------------------------------------------------------------------- */
/* 结果排序                                                                    */
/* -------------------------------------------------------------------------- */

/** 按文档序排序（稳定），并去掉相邻重复项 —— 对应 `Sizzle.uniqueSort` */
function uniqueSort(elements: Element[]): Element[] {
  const indexed = elements.map((element, index) => ({ element, index }));
  indexed.sort((a, b) => {
    if (a.element === b.element) {
      return a.index - b.index;
    }
    const position = a.element.compareDocumentPosition(b.element);
    // DOCUMENT_POSITION_FOLLOWING = 4，DOCUMENT_POSITION_PRECEDING = 2
    if (position & 4) {
      return -1;
    }
    if (position & 2) {
      return 1;
    }
    return a.index - b.index;
  });
  const out: Element[] = [];
  for (const { element } of indexed) {
    if (out.length === 0 || out[out.length - 1] !== element) {
      out.push(element);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 对外 API                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 选择器求值入口：替代 `Sizzle(selector, context)`。
 *
 * @param selector CSS 选择器（可含 jQuery 扩展伪类）
 * @param context  查询上下文，默认 `document`；支持 Document / Element / DocumentFragment
 * @returns 命中的元素数组（文档序；位置伪类的语义与 Sizzle 一致）
 */
export function selectElements(selector: string, context?: ParentNode): Element[] {
  const ctx: ParentNode = context ?? document;
  if (typeof selector !== "string" || selector.length === 0) {
    return [];
  }
  const nodeType = (ctx as Node).nodeType;
  if (nodeType !== 1 && nodeType !== 9 && nodeType !== 11) {
    return [];
  }
  const groups = splitSelectorGroups(selector);
  if (groups.length === 0) {
    return [];
  }

  const parsed = groups.map((group) => parseGroupTokens(group)).filter((tokens) => tokens.length > 0);
  if (parsed.length === 0) {
    return [];
  }

  const hasAnyExtension = parsed.some((tokens) =>
    tokens.some((token) => token.compound.hasPositional || token.compound.hasCustom),
  );
  // 非 HTML 文档、以及「非 Element 上下文 + 前置组合符」都必须走自研求值：
  // 原生 qSA 的作用域语义与 Sizzle 在这两种情况下不一致。
  const needsEngineForScope =
    isXmlContext(ctx) || (nodeType !== 1 && parsed.some((tokens) => hasLeadingCombinator(tokens)));
  if (!hasAnyExtension && !needsEngineForScope) {
    return nativeQuery(selector, ctx);
  }

  const elementResults: Element[] = [];
  const elementSeen = new Set<Element>();
  const setResults: Element[] = [];
  let elementGroupCount = 0;
  let setGroupCount = 0;

  for (const tokens of parsed) {
    const isSetGroup = tokens.some((token) => token.compound.hasPositional);
    if (isSetGroup) {
      setGroupCount++;
      setResults.push(...evalTokens(tokens, ctx));
      continue;
    }
    elementGroupCount++;
    for (const element of evalTokens(tokens, ctx)) {
      if (!elementSeen.has(element)) {
        elementSeen.add(element);
        elementResults.push(element);
      }
    }
  }

  // Sizzle 的元素匹配循环按 `getElementsByTagName("*")` 顺序（文档序）push，
  // 多分组时需要重新排序才能得到同样的顺序。
  if (elementGroupCount > 1) {
    const sorted = uniqueSort(elementResults);
    elementResults.length = 0;
    elementResults.push(...sorted);
  }

  let results = elementResults.concat(setResults);
  // 对应 Sizzle 的 `if (outermost && !seed && setMatched.length > 0 && (matchedCount + setMatchers.length) > 1) uniqueSort(results)`
  if (setGroupCount > 0 && setResults.length > 0 && (elementResults.length > 0 || setGroupCount > 1)) {
    results = uniqueSort(results);
  }
  return results;
}

/**
 * 单元素匹配：替代 `Sizzle.matchesSelector(elem, selector)`。
 *
 * 纯原生选择器走 `Element.matches()`；扩展伪类走本模块求值
 * （语义等价于 Sizzle 的 `Sizzle(selector, document, null, [elem]).length > 0`）。
 *
 * 含位置伪类时必须按 **seed = [elem]** 求值：`td:last` 对任意 td 都成立
 * （单元素集合里它既是第一个也是最后一个），而不是「文档里最后一个 td」。
 */
export function matchesSelector(elem: Element, selector: string): boolean {
  if (typeof selector !== "string" || selector.length === 0) {
    return false;
  }
  const doc = elem.ownerDocument ?? document;
  const xml = isXmlContext(doc);
  const groups = splitSelectorGroups(selector);
  for (const group of groups) {
    const tokens = parseGroupTokens(group);
    if (tokens.length === 0) {
      continue;
    }
    const position = tokens.findIndex((token) => token.compound.hasPositional);
    if (position < 0) {
      if (matchesChain(elem, tokens, doc, xml)) {
        return true;
      }
      continue;
    }
    // 位置伪类之前的部分（含位置 compound 去掉位置伪类后的剩余条件）必须命中 elem
    const remainingPseudos = tokens[position].compound.pseudos.filter((pseudo) => pseudo.kind !== "positional");
    const prefixTokens: GroupToken[] = tokens.slice(0, position).map((item) => ({ ...item }));
    prefixTokens.push({
      combinator: tokens[position].combinator,
      compound: {
        pseudos: remainingPseudos,
        nativeText: tokens[position].compound.nativeText,
        hasPositional: false,
        hasCustom: remainingPseudos.some((pseudo) => pseudo.kind === "custom"),
      },
    });
    if (!matchesChain(elem, prefixTokens, doc, xml)) {
      continue;
    }
    // seed 是单元素集合：位置伪类作用在 [elem] 上
    let survivors: Element[] = [elem];
    for (const pseudo of tokens[position].compound.pseudos) {
      if (pseudo.kind === "positional") {
        survivors = applyPositional(survivors, pseudo);
      }
    }
    if (survivors.length === 0) {
      continue;
    }
    const rest = tokens.slice(position + 1);
    if (rest.length === 0) {
      return true;
    }
    // 有剩余选择器时，Sizzle 只把「同时命中剩余选择器且属于 seed」的元素算作命中
    for (const survivor of survivors) {
      if (
        evalTokens(
          rest.map((item) => ({ ...item })),
          survivor,
        ).includes(elem)
      ) {
        return true;
      }
    }
  }
  return false;
}
