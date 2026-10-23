/**
 * happy-dom + vitest 的 `Document` 判据修复（审查 H-M1）。
 *
 * ## 问题
 *
 * 本仓库使用的 happy-dom（20.14.5）在 vitest 环境里会存在**两份** DOM 实现：
 * 环境注入的 `window.Document` 与 `DOMParser` / `document.implementation.createHTMLDocument()`
 * 产出的文档对象所属的 `Document` 不是同一个类。实测：
 *
 * ```text
 * new DOMParser().parseFromString(...) instanceof Document === false
 * window.document instanceof window.Document === false
 * // 但 Node / Element / HTMLDocument 的判据正常
 * ```
 *
 * 站点引擎里以 `doc instanceof Document` 作为「DOM 页面 vs JSON 对象」的分派条件：
 * `AbstractBittorrentSite.transformSearchPage`（DOM 行合并 / rows.filter 分支）、
 * `NexusPHP.transformSearchPage`（按表头推断字段列）、
 * `AbstractPrivateSite.loggedCheck`（`noLoginAssert.matchSelectors` 的登录页判定）。
 * 判据恒为 false 时这些分支在测试里全部走「JSON 对象」路径，搜索主链路实际零覆盖：
 * 把 `rows.selector` 改错、删掉 `super.transformSearchPage`、写坏登录页判定，测试都不会变红。
 *
 * ## 做法
 *
 * 把 `globalThis.Document` 重绑到**文档对象真实原型链上的那个 Document 类**，
 * 使 `DOMParser` 产物、`createHTMLDocument()` 产物以及 `window.document` 三者都通过
 * `instanceof Document`。只改全局构造器引用，不改 happy-dom 实现；vitest 默认按测试文件
 * 隔离运行环境，因此影响范围仅限显式调用本模块的测试文件。
 *
 * 源码侧仍建议改用跨 realm 判据（`doc?.nodeType === 9` 或 duck-typing），
 * 那样 iframe / 真实浏览器的多 realm 场景也会一起修好；本次修复范围只到测试侧，
 * 源码改动留给站点引擎所有者（见 fix report 的跟进项）。
 */

const globalObject = globalThis as any;

/** 从一个文档实例出发，沿原型链收集名字为 `Document` 的构造器（由近及远） */
function documentClassesFrom(instance: unknown): any[] {
  const classes: any[] = [];
  if (!instance || typeof instance !== "object") return classes;

  let proto = Object.getPrototypeOf(instance);
  while (proto) {
    const ctor = proto.constructor;
    if (typeof ctor === "function" && ctor.name === "Document") classes.push(ctor);
    proto = Object.getPrototypeOf(proto);
  }
  return classes;
}

/**
 * 选出「能让 `DOMParser` 产物通过 `instanceof`」的 Document 构造器。
 * 候选顺序：文档实例的原型链 → `Object.getPrototypeOf(HTMLDocument)` → 全局 Document。
 */
function resolveDocumentClass(): any | undefined {
  const parse = () =>
    new (globalObject.DOMParser as typeof DOMParser)().parseFromString("<html><body></body></html>", "text/html");

  const candidates: any[] = [...documentClassesFrom(globalObject.document), ...documentClassesFrom(parse())];

  const htmlDocumentCtor = globalObject.HTMLDocument;
  if (typeof htmlDocumentCtor === "function" && Object.getPrototypeOf(htmlDocumentCtor)) {
    candidates.push(Object.getPrototypeOf(htmlDocumentCtor));
  }
  if (typeof globalObject.Document === "function") candidates.push(globalObject.Document);

  for (const candidate of candidates) {
    if (typeof candidate !== "function") continue;
    try {
      if (parse() instanceof candidate) return candidate;
    } catch {
      // 候选不是合法的 instanceof 右值，继续尝试下一个
    }
  }
  return undefined;
}

/**
 * 把 `globalThis.Document` 重绑到真实基类（幂等）。
 *
 * @returns `DOMParser` 产物、`createHTMLDocument()` 产物与 `window.document` 是否都满足
 * `instanceof Document`；返回 false 时调用方应把相应的断言视为失败（说明 happy-dom 行为又变了）。
 */
export function installHappyDomDocumentClass(): boolean {
  const RealDocument = resolveDocumentClass();
  if (!RealDocument) return false;

  globalObject.Document = RealDocument;

  const parsed = new (globalObject.DOMParser as typeof DOMParser)().parseFromString(
    "<html><body><table></table></body></html>",
    "text/html",
  );
  const created = globalObject.document?.implementation?.createHTMLDocument?.("ptd-probe");

  return (
    parsed instanceof globalObject.Document &&
    globalObject.document instanceof globalObject.Document &&
    (!created || created instanceof globalObject.Document)
  );
}

/**
 * 解析一段 HTML 片段为 Document（自动套上 `<html><body>`）。
 * 与仓库测试里既有的 `makeDoc` 一致，只是集中在这里以便统一注释来由。
 */
export function makeHtmlDocument(html: string): Document {
  return new (globalObject.DOMParser as typeof DOMParser)().parseFromString(
    `<html><body>${html}</body></html>`,
    "text/html",
  );
}
