/**
 * 选择器层差分测试：`selectElements` / `matchesSelector` vs **真实 Sizzle 2.3.10**。
 *
 * ## 这个测试怎么保证「行为零变化」
 *
 * 1. **选择器从真实源码提取**（TypeScript AST），不是手抄：
 *    - 所有 `Sizzle(...)` / 迁移后的 `selectElements(...)` 调用点的第一个实参，
 *      支持字符串字面量、模板串、`a ? b : c`、`+` 拼接，以及同文件内的 `const` 间接引用；
 *    - 站点定义里动态流入选择器的扩展选择器池（`selector:` 属性、`guessSearchFieldIndexConfig()`
 *      数组、`matchSelectors` 数组）——这些值运行时同样会进 `Sizzle()`。
 * 2. **每个选择器都跑在一组真实结构 fixture 上**（NexusPHP / Gazelle / Unit3D / bibliotik /
 *    豆瓣 / AniDB XML / 伪随机 DOM …），并且对 document、body、以及**每个出现过的标签名的代表元素**
 *    作为上下文各求值一遍 —— 上下文相关的语义（作用域、`> td`、`~ table`）才会被真正覆盖。
 * 3. 断言的是**元素序列**（同长度、同顺序、同元素），不是数量。
 *
 * ## oracle 说明
 *
 * `./oracle/selector-oracle-2.3.10.js.txt` 是从 `sizzle@2.3.10` 的 `dist/sizzle.js`
 * **逐字节复制**的只读参照实现（sha256 `a86344a9…401f6155`，与 `node_modules/sizzle/dist/sizzle.js` 相同），
 * 只作为测试参照物，不参与构建、不进产物。它被当作文本读入后执行，因此不会被
 * 打包器/模块图引用，删除 npm 依赖后本测试依然可用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import { matchesSelector, selectElements } from "~/packages/site/utils/selector";

/* -------------------------------------------------------------------------- */
/* oracle：加载冻结的 Sizzle 2.3.10                                            */
/* -------------------------------------------------------------------------- */

/** 仓库根目录：从 cwd 向上找回带 `src/packages` 的 package.json 目录 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "src", "packages", "site")) && fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return process.cwd();
}

const REPO_ROOT = findRepoRoot();

const ORACLE_PATH = path.join(
  REPO_ROOT,
  "tests",
  "packages",
  "site",
  "utils",
  "oracle",
  "selector-oracle-2.3.10.js.txt",
);

type SizzleFn = ((selector: string, context?: ParentNode) => ArrayLike<Element>) & {
  matchesSelector: (elem: Element, selector: string) => boolean;
};

let sizzle: SizzleFn;

beforeAll(() => {
  const code = fs.readFileSync(ORACLE_PATH, "utf8");
  // UMD 尾部：`typeof define === "function"` / `module.exports` 都不成立时会挂到 `window.Sizzle`
  const sandbox: { document: Document; Sizzle?: SizzleFn } = { document };
  const run = new Function("window", "module", "define", code) as (
    window: unknown,
    module: unknown,
    define: unknown,
  ) => void;
  run(sandbox, undefined, undefined);
  if (!sandbox.Sizzle) {
    throw new Error("未能加载 Sizzle oracle");
  }
  sizzle = sandbox.Sizzle;
});

/* -------------------------------------------------------------------------- */
/* 1. 从真实源码提取选择器                                                     */
/* -------------------------------------------------------------------------- */

const SOURCE_ROOTS = [
  "src/packages/site/schemas",
  "src/packages/site/definitions",
  "src/packages/site/utils",
  "src/packages/social",
];

/** 调用点识别：迁移前是 `Sizzle(`，迁移后是 `selectElements(` */
const CALL_NAMES = new Set(["Sizzle", "selectElements"]);

/** 扩展伪类（原生 CSS 不支持）判定 */
const EXTENSION_RE =
  /:contains\(|:has\(|:(?:eq|gt|lt|nth)\(|:(?:first|last|even|odd)(?!-)|:not\(:(?:eq|gt|lt|first|last|even|odd|nth)/;

interface ExtractContext {
  scope: Map<string, ts.Expression[]>;
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function buildScope(source: ts.SourceFile): Map<string, ts.Expression[]> {
  const scope = new Map<string, ts.Expression[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const list = scope.get(node.name.text) ?? [];
      list.push(node.initializer);
      scope.set(node.name.text, list);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return scope;
}

/** 把表达式解析成它可能取到的所有字符串值；无法静态求值时返回 null */
function resolveStrings(ctx: ExtractContext, node: ts.Expression, depth = 0): string[] | null {
  if (depth > 6) {
    return null;
  }
  if (ts.isParenthesizedExpression(node)) {
    return resolveStrings(ctx, node.expression, depth + 1);
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return resolveStrings(ctx, node.expression, depth + 1);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (ts.isNumericLiteral(node)) {
    return [node.text];
  }
  if (ts.isTemplateExpression(node)) {
    let acc = [node.head.text];
    for (const span of node.templateSpans) {
      // 模板占位符无法静态求值（如 sizeIndex）时按 0/1/2 展开，覆盖 :eq(n) 的主要取值
      const values = resolveStrings(ctx, span.expression, depth + 1) ?? ["0", "1", "2"];
      const next: string[] = [];
      for (const prefix of acc) {
        for (const value of values) {
          next.push(prefix + value);
        }
      }
      acc = dedupe(next.map((value) => value + span.literal.text));
    }
    return acc;
  }
  if (ts.isConditionalExpression(node)) {
    const a = resolveStrings(ctx, node.whenTrue, depth + 1);
    const b = resolveStrings(ctx, node.whenFalse, depth + 1);
    if (!a && !b) {
      return null;
    }
    return dedupe([...(a ?? []), ...(b ?? [])]);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = resolveStrings(ctx, node.left, depth + 1);
    const b = resolveStrings(ctx, node.right, depth + 1);
    if (!a || !b) {
      return null;
    }
    const out: string[] = [];
    for (const left of a) {
      for (const right of b) {
        out.push(left + right);
      }
    }
    return dedupe(out);
  }
  if (ts.isIdentifier(node)) {
    const declarations = ctx.scope.get(node.text);
    if (!declarations) {
      return null;
    }
    const values: string[] = [];
    for (const declaration of declarations) {
      const resolved = resolveStrings(ctx, declaration, depth + 1);
      if (resolved) {
        values.push(...resolved);
      }
    }
    return values.length > 0 ? dedupe(values) : null;
  }
  return null;
}

interface SourceExtraction {
  /** 调用点总数（Sizzle 或 selectElements） */
  callSiteCount: number;
  /** 第一个实参可静态求解的调用点数 */
  resolvableCallSiteCount: number;
  /** 第一个实参无法静态求解的调用点数（运行时由站点配置注入） */
  dynamicCallSiteCount: number;
  /** 调用点选择器（去重、排序） */
  callSiteSelectors: string[];
  /** 动态选择器池：站点定义里会流入选择器引擎的扩展选择器 */
  dynamicSelectors: string[];
  fileCount: number;
}

function extractFromSource(): SourceExtraction {
  let callSiteCount = 0;
  let resolvableCallSiteCount = 0;
  const callSiteValues: string[] = [];
  const dynamicValues: string[] = [];
  let fileCount = 0;

  for (const root of SOURCE_ROOTS) {
    for (const file of walkTsFiles(path.join(REPO_ROOT, root))) {
      if (file.endsWith(path.join("site", "utils", "selector.ts"))) {
        // 引擎自身的内部调用不是「调用点」，排除以免污染提取结果
        continue;
      }
      fileCount++;
      const text = fs.readFileSync(file, "utf8");
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
      const ctx: ExtractContext = { scope: buildScope(source) };
      const visit = (node: ts.Node): void => {
        // (a) 调用点
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          CALL_NAMES.has(node.expression.text) &&
          node.arguments.length > 0
        ) {
          callSiteCount++;
          const values = resolveStrings(ctx, node.arguments[0]);
          if (values && values.length > 0) {
            resolvableCallSiteCount++;
            callSiteValues.push(...values);
          }
        }
        // (b) 站点定义里的动态选择器池
        if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "selector") {
          const values = resolveStrings(ctx, node.initializer);
          if (values) {
            dynamicValues.push(...values.filter((value) => EXTENSION_RE.test(value)));
          }
        }
        if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "matchSelectors") {
          const values = resolveStrings(ctx, node.initializer);
          if (values) {
            dynamicValues.push(...values);
          }
        }
        if (
          (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
          node.name !== undefined &&
          ts.isIdentifier(node.name) &&
          node.name.text === "guessSearchFieldIndexConfig"
        ) {
          const collect = (child: ts.Node): void => {
            if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) {
              dynamicValues.push(child.text);
            }
            ts.forEachChild(child, collect);
          };
          ts.forEachChild(node, collect);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  const dynamicCallSiteCount = callSiteCount - resolvableCallSiteCount;
  return {
    callSiteCount,
    resolvableCallSiteCount,
    dynamicCallSiteCount,
    callSiteSelectors: dedupe(callSiteValues).sort(),
    dynamicSelectors: dedupe(dynamicValues)
      .filter((value) => value.length > 0 && EXTENSION_RE.test(value))
      .sort(),
    fileCount,
  };
}

const extraction = extractFromSource();

/* -------------------------------------------------------------------------- */
/* 2. fixtures                                                                 */
/* -------------------------------------------------------------------------- */

/** NexusPHP 搜索结果页：torrents 表（thead 版与 tbody 版）、分页条 */
const FIXTURE_NEXUSPHP_TORRENTS = `
<div id="outer">
  <table class="torrents" id="torrents-main">
    <thead><tr><th>类型</th><th>标题</th><th>评论</th><th>完成</th><th>下载</th><th>种子</th><th>大小</th><th>时间</th></tr></thead>
    <tbody>
      <tr id="torrent-row-1">
        <td class="cat"><img class="category" src="cat.png" alt="Movies" title="Movies"></td>
        <td class="torrentname"><table class="torrentname"><tbody><tr><td><a href="details.php?id=1" title="Movie A">Movie A</a></td></tr></tbody></table></td>
        <td><img class="comments" src="c.png" alt="3"></td>
        <td><img class="snatched" src="s.png" alt="2"></td>
        <td><img class="leechers" src="l.png" alt="1"></td>
        <td><img class="seeders" src="sd.png" alt="9"></td>
        <td><img class="size" src="z.png" alt="1.2 GB"></td>
        <td><img class="time" src="t.png" alt="2024-01-01"></td>
      </tr>
      <tr id="torrent-row-2">
        <td class="cat"><img class="category" src="cat.png" alt="Music" title="Music"></td>
        <td class="torrentname"><a href="details.php?id=2" title="Album B">Album B</a></td>
        <td><img class="comments" src="c.png" alt="0"></td>
        <td><img class="snatched" src="s.png" alt="7"></td>
        <td><img class="leechers" src="l.png" alt="4"></td>
        <td><img class="seeders" src="sd.png" alt="12"></td>
        <td><img class="size" src="z.png" alt="700 MB"></td>
        <td><img class="time" src="t.png" alt="2024-02-02"></td>
      </tr>
    </tbody>
  </table>
  <table class="torrents" id="torrents-alt">
    <thead><tr id="alt-thead-row"><th>类型</th><th>标题</th><th>评论</th><th>完成</th><th>下载</th><th>种子</th><th>大小</th><th>时间</th></tr></thead>
    <tbody>
      <tr id="alt-head"><td>Total: 2</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td><td>8</td></tr>
      <tr id="alt-row"><td>类型</td><td>标题</td><td>评论</td><td>完成</td><td>下载</td><td>种子</td><td>大小</td><td>时间</td></tr>
    </tbody>
  </table>
  <p class="np-pager"><b>1</b><b>2</b><b>3</b></p>
  <div class="tagssh"><script type="application/json">var pageToken = "x";</script></div>
  <div class="titles"><span itemprop="name">Anime</span><label itemprop="genre">Action</label></div>
  <meta property="og:image" content="https://example.com/poster.jpg">
  <span itemprop="ratingValue">8.5</span><span itemprop="ratingCount" content="1200">1200</span>
  <picture><img src="picture.jpg" alt="poster"></picture>
</div>`;

/** NexusPHP 用户页：菜单/条幅里的 `div:has( ~ table) > div:contains(' | ')`、ratio 表、b-content 里的 lista 表 */
const FIXTURE_NEXUSPHP_USER = `
<div id="wrapper">
  <div id="info">
    <span class="pl">又名:</span><span class="pl">IMDb:</span><span class="pl">Rating:</span>
  </div>
  <div id="mcol">
    <div class="b-content">
      <table class="lista" id="lista-1"><tbody><tr><td>0</td><td>a</td></tr><tr><td>1</td><td>b</td></tr><tr><td>2</td><td>c</td></tr></tbody></table>
      <table class="lista" id="lista-2"><tbody><tr><td>0</td><td>a</td></tr><tr><td>1</td><td>b</td></tr><tr><td>2</td><td>c</td></tr></tbody></table>
      <table class="lista" id="lista-3"><tbody><tr><td>0</td><td>a</td></tr><tr><td>1</td><td>b</td></tr><tr><td>2</td><td>c</td></tr></tbody></table>
    </div>
  </div>
  <div id="seed-status"><div id="seed-status-text">做种中: 3 | 12.5 GB</div></div>
  <table id="profile-seedingTable"><tbody>
    <tr id="seeding-head"><td>种子</td><td>大小</td></tr>
    <tr id="seeding-1"><td>Torrent 1</td><td>1.2 GB</td></tr>
    <tr id="seeding-2"><td>Torrent 2</td><td>2.4 GB</td></tr>
  </tbody></table>
  <div id="upload-status"><div>上传中: 1 | 300 MB</div></div>
  <table id="profile-uploadTable"><tbody>
    <tr id="upload-head"><td>种子</td><td>大小</td></tr>
    <tr id="upload-1"><td>Torrent 3</td><td>300 MB</td></tr>
  </tbody></table>
  <table class="overlay" id="overlay-table">
    <tbody>
      <tr id="ov-1"><td>one</td></tr>
      <tr id="ov-2"><td>two</td></tr>
      <tr id="ov-3"><td>three</td><td class="rightOverlay">right</td></tr>
    </tbody>
  </table>
  <table id="torrents_table"><tbody>
    <tr class="torrent_row" id="bt-1"><td><span class="title">Book A</span></td><td><span class="t_files_size_added"><span data-bytecount="123">1.2 MB</span></span></td></tr>
    <tr class="torrent_row" id="bt-2"><td><span class="title">Book B</span></td><td><span class="t_files_size_added"><span data-bytecount="456">456 KB</span></span></td></tr>
  </tbody></table>
  <div class="pagination"><a href="torrents.php?page=2">2</a><a href="torrents.php?page=9">Last >></a></div>
  <span class="__cf_email__" data-cfemail="abcdef">[email protected]</span>
  <div class="ratio-bar">
    <div class="container">
      <div>Uploaded</div>
      <div><span class="user-group">VIP</span><span class="badge-user">vip</span></div>
    </div>
    <ul>
      <li><span class="badge-user">A</span></li>
      <li title="0">B</li>
      <li title="1">B1</li>
      <li><a href="/profile/1"><span class="user-group">C</span><span class="badge-user">c</span></a></li>
    </ul>
    <a href="/profile/2" title="2"><span class="user-group">D</span></a>
    <div class="d-inline-block">E</div>
  </div>
  <div class="card"><span class="tag">Tag</span></div>
  <div class="well"><ul><li>well-item</li></ul></div>
  <h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4><h5>H5</h5><h6>H6</h6>
  <ul class="subject-list-list"><li id="douban-li-1">Subject A</li><li id="douban-li-2">Subject B</li></ul>
  <div id="torrents-pages"><a href="?page=1">1</a><a href="?page=2">2</a></div>
</div>`;

/** Gazelle / Luminance 搜索结果页 */
const FIXTURE_GAZELLE = `
<div id="content">
  <table class="torrent_table" id="torrent_table" data-extra="1">
    <tbody>
      <tr class="colhead" id="colhead"><td><a href="?order_by=time">Time</a></td><td><a href="?order_by=size">Size</a></td><td><a href="?order_by=seeders">Seeders</a></td><td><a href="?order_by=leechers">Leechers</a></td><td><a href="?order_by=snatched">Snatched</a></td></tr>
      <tr class="torrent" id="g-torrent-1"><td><a href="/torrents.php?id=1">A</a></td><td>1.1 GB</td><td><span alt="Seeders">5</span></td><td><span alt="Leechers">1</span></td><td><span alt="Snatches">2</span></td></tr>
      <tr class="torrent" id="g-torrent-2"><td><a href="/torrents.php?id=2">B</a></td><td>2.2 GB</td><td><span alt="Seeders">6</span></td><td><span alt="Leechers">2</span></td><td><span alt="Snatches">3</span></td></tr>
    </tbody>
  </table>
  <table class="torrent_table" id="torrent_table_alt">
    <tbody>
      <tr class="colhead" id="alt-colhead"><td>Time</td><td>Size</td><td>Seeders</td><td>Leechers</td><td>Snatched</td></tr>
      <tr class="torrent" id="g-alt-1"><td>A</td><td>1 GB</td><td>1</td><td>1</td><td>1</td></tr>
    </tbody>
  </table>
  <table id="torrents-table-3" class="file-list"><tbody><tr class="torrent"><td>file</td></tr></tbody></table>
  <div class="ratio-bar">
    <ul class="stats">
      <li>Ratio: 1.5</li>
      <li><a href="/user.php?id=1" class="username">me</a></li>
    </ul>
    <div class="container"><div>
      <ul><li class="ratio-bar__ratio"><a href="/user.php?id=1">1.5</a><i class="fa-sync-alt"></i></li></ul>
    </div></div>
  </div>
  <div class="post" id="post-1"><div class="body">Forum post body <img src="i.png" alt="Seeders"><img src="i.png" alt="Leechers"><img src="i.png" alt="Snatches"></div></div>
</div>`;

/** 通用页面：dl/dt/dd、stats、脚本、字体、span/strong、翻页 */
const FIXTURE_GENERIC = `
<div id="page">
  <dl id="user-stats">
    <dt>Seeding Points: 1234</dt><dd>1234</dd>
    <dt>Overall rank: 42</dt><dd>42</dd>
    <dt>Class: Power User</dt><dd>PU</dd>
    <dt>Joined on</dt><dd>2020-01-01</dd>
    <dt>Last access</dt><dd>2024-01-01</dd>
  </dl>
  <ul class="stats" id="stats-list">
    <li>Seeding: 3</li>
    <li>Leeching: 1</li>
    <li>Class: VIP</li>
    <li><span class="user_name">alice</span></li>
  </ul>
  <strong id="s-1">strong one</strong><strong id="s-2">strong two</strong>
  <span id="sp-1">span one</span><span id="sp-2">span two</span>
  <font color="blue">font</font><font id="f-2">font2</font>
  <div class="post" id="gpost"><div class="body">recommend <td class="block">Our Team Recommend</td></div></div>
  <div id="scripts">
    <script type="application/json" src="a.js"></script>
    <script type="application/json" src="b.js" defer></script>
    <script type="application/json" src="c.js"></script>
    <script type="application/json">inline</script>
    <script type="application/json">trailing</script>
  </div>
  <div id="tables">
    <table id="tbl-1"><tbody><tr id="tbl-1-head"><td>Total</td><td>x</td></tr><tr id="tbl-1-row"><td>1</td><td>2</td></tr></tbody></table>
    <div id="after-first-table"><b>bold one</b><b>bold two</b></div>
    <table id="tbl-2"><tbody><tr id="tbl-2-head"><td>header</td><td>y</td></tr><tr id="tbl-2-row"><td>3</td><td>4</td></tr></tbody></table>
  </div>
  <table id="week-table"><tbody>
    <tr id="9"><td><ul>
      <li><span>≥1</span></li>
      <li><span>≥1 2</span></li>
      <li><span>req /300000</span></li>
      <li><span>size &gt;200MiB</span></li>
    </ul></td></tr>
  </tbody></table>
  <div id="audiobook">
    <table><tbody>
      <tr><td>Info Hash:</td><td>abcdef0123456789</td></tr>
      <tr><td>Tracker:</td><td>udp://tracker.example:80</td></tr>
    </tbody></table>
  </div>
  <div id="retroflix-item" class="movie"><div class="info">Genre: Action</div><a href="/browse/t/1">browse</a><a href="/browse/t/2">browse2</a></div>
  <div id="hhanclub"><table id="h-table"><tbody><tr><td>x</td></tr></tbody></table><div><b>pages</b><b>2</b></div></div>
  <div id="audiences"><table id="aud-table"><tbody><tr id="aud-total"><td>Total</td><td>5</td></tr><tr id="aud-row"><td>a</td><td>b</td></tr></tbody></table></div>
  <table id="cinema-table"><tbody>
    <tr id="cm-head"><td>h</td><td>h</td><td>h</td></tr>
    <tr id="cm-1"><td>a</td><td>b</td><td>c</td></tr>
    <tr id="cm-2"><td>d</td><td>e</td><td>f</td></tr>
  </tbody></table>
  <div id="sportscult"><div id="mcol-root"><div class="b-content">
    <table class="lista" id="sc-l1"><tbody><tr><td>h</td><td>h</td></tr><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>
    <table class="lista" id="sc-l2"><tbody><tr><td>h</td><td>h</td></tr><tr><td>c</td><td>3</td></tr><tr><td>d</td><td>4</td></tr></tbody></table>
    <table class="lista" id="sc-l3"><tbody><tr><td>h</td><td>h</td></tr><tr><td>e</td><td>5</td></tr><tr><td>f</td><td>6</td></tr></tbody></table>
  </div></div></div>
  <div id="page-two"><a href="/page/2/">2</a><a href="/page/9/">9</a></div>
  <div id="torrenting"><table id="tor-table"><tbody><tr id="to-1"><td><a href="/t/1">t1</a></td></tr><tr id="to-2"><td>no link</td></tr></tbody></table></div>
  <div id="starspace"><table id="ss-table"><tbody>
    <tr class="tm_tr_x" id="ss-1"><td>a</td><td>b</td><td>c</td><td>1.1 GB</td></tr>
    <tr class="tm_tr_y" id="ss-2"><td>a</td><td>b</td><td>c</td><td>2.2 GB</td></tr>
  </tbody></table></div>
  <div id="totheglory"><table id="ttg-table"><tbody>
    <tr id="ttg-head"><td>h</td><td>h</td><td>h</td><td>h</td></tr>
    <tr id="ttg-1"><td>a</td><td>b</td><td>c</td><td>1.1 GB</td></tr>
    <tr id="ttg-2"><td>d</td><td>e</td><td>f</td><td>2.2 GB</td></tr>
  </tbody></table></div>
  <div id="secretcinema">
    <ul id="sc-user"><li id="sc-li-1">Seeding Points: 999</li><li id="sc-li-2">Overall rank: 7</li></ul>
  </div>
  <div id="inbox">
    <a href="messages.php" onmousedown="inbox()">inbox</a>
    <a href="staff.php" onmousedown="staffpm()">staff</a>
  </div>
  <table id="nebulance"><tbody><tr id="nb-1"><td><div class="tagssh"><script type="application/json">var overlay = 1;</script></div></td><td class="last">1</td></tr></tbody></table>
  <div id="pter-pager"><p class="np-pager"><b>1</b><b>2</b></p></div>
  <div id="exttorrents">
    <script type="application/json" id="inject-1">window.pageToken = "pt";</script>
    <script type="application/json" id="inject-2">window.csrfToken = "cs";</script>
  </div>
  <div id="myanonamouse"><a class="tmnb" href="/b/1">a</a><a class="tmn" href="/b/2">b</a><a class="tmng" href="/b/3">c</a></div>
  <div id="azusa"><div id="az-seed">Seeding 1 | 2 | 3</div><div id="az-up">Upload 4 | 5 | 6</div></div>
</div>`;

/** 空页面 */
const FIXTURE_EMPTY = `<div id="nothing"></div>`;

/** AniDB XML API 响应（anidb.ts 的三个 XML 查询） */
const FIXTURE_ANIDB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<anime id="1">
  <titles><title xml:lang="x-jat">Titles</title><title xml:lang="en">Title EN</title></titles>
  <picture>picture.jpg</picture>
  <ratings><permanent>800</permanent><temporary>700</temporary></ratings>
  <meta property="og:image" content="https://cdn.example/poster.jpg"/>
  <span itemprop="ratingValue">8.1</span>
  <span itemprop="ratingCount" content="321">321</span>
</anime>`;

/* -------------------------------------------------------------------------- */
/* 3. fixture 装载与上下文采样                                                 */
/* -------------------------------------------------------------------------- */

interface Fixture {
  name: string;
  html?: string;
  xml?: string;
}

const FIXTURES: Fixture[] = [
  { name: "nexusphp-torrents", html: FIXTURE_NEXUSPHP_TORRENTS },
  { name: "nexusphp-user", html: FIXTURE_NEXUSPHP_USER },
  { name: "gazelle", html: FIXTURE_GAZELLE },
  { name: "generic", html: FIXTURE_GENERIC },
  { name: "empty", html: FIXTURE_EMPTY },
  { name: "anidb-xml", xml: FIXTURE_ANIDB_XML },
];

/** 伪随机 DOM：确定性 LCG，制造大量类名/文本/嵌套组合，让扩展选择器真的命中 */
function buildRandomFixture(seed: number): string {
  let state = seed >>> 0;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const tags = ["div", "span", "td", "li", "a", "b", "strong", "table", "tbody", "tr", "ul", "p", "font", "dt", "dd"];
  const classes = [
    "pl",
    "title",
    "tag",
    "user-group",
    "badge-user",
    "lista",
    "torrent",
    "stats",
    "post",
    "np-pager",
    "ratio-bar",
    "t_file",
  ];
  const texts = [
    "Seeding Points: 1",
    "Overall rank: 2",
    "Size",
    "Total",
    "Info Hash:",
    "Tracker:",
    "Genre:",
    "又名",
    "IMDb:",
    " | ",
    "≥1",
    "Class: VIP",
    "Seeding: 3",
    "day",
    "Last access",
    "Joined on",
  ];
  const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)];
  const build = (depth: number): string => {
    if (depth <= 0) {
      return pick(texts);
    }
    const count = 1 + Math.floor(rand() * 3);
    let inner = "";
    for (let i = 0; i < count; i++) {
      inner += build(depth - 1);
    }
    const tag = pick(tags);
    const cls = rand() < 0.6 ? ` class="${pick(classes)} ${pick(classes)}"` : "";
    const id = rand() < 0.5 ? ` id="rand-${Math.floor(rand() * 1000)}-${depth}"` : "";
    const attr =
      rand() < 0.3 ? ` title="${pick(["0", "1", "Seeding", "day"])}" href="?page=${Math.floor(rand() * 3) + 1}"` : "";
    return `<${tag}${id}${cls}${attr}>${inner}</${tag}>`;
  };
  let html = "";
  for (let i = 0; i < 6; i++) {
    html += build(3);
  }
  return `<div id="random-root">${html}</div>`;
}

FIXTURES.push({ name: "random-1", html: buildRandomFixture(20240101) });
FIXTURES.push({ name: "random-2", html: buildRandomFixture(987654321) });

/** 把 fixture 装载进当前文档（XML 直接返回一个独立 Document） */
function loadFixture(fixture: Fixture): { doc: Document; root: ParentNode } {
  if (fixture.xml !== undefined) {
    const doc = new DOMParser().parseFromString(fixture.xml, "application/xml");
    return { doc, root: doc.documentElement };
  }
  document.body.innerHTML = fixture.html ?? "";
  return { doc: document, root: document.body };
}

/**
 * 采样上下文：document + body + 每个出现过的标签名最多 2 个代表元素。
 * Element 上下文的语义（作用域、`> td`、`~ table`）只有这样才能覆盖到。
 */
function sampleContexts(doc: Document, root: ParentNode): ParentNode[] {
  const contexts: ParentNode[] = [doc];
  const perTag = new Map<string, number>();
  const all = Array.from(doc.querySelectorAll("*"));
  for (const element of all) {
    const tag = element.tagName.toLowerCase();
    const used = perTag.get(tag) ?? 0;
    if (used >= 2) {
      continue;
    }
    perTag.set(tag, used + 1);
    contexts.push(element);
    if (contexts.length >= 26) {
      break;
    }
  }
  if (!contexts.includes(root)) {
    contexts.push(root);
  }
  return contexts;
}

/** 元素 → 稳定的序号（避免往页面里塞属性） */
function buildElementIndex(doc: Document): Map<Element, number> {
  const index = new Map<Element, number>();
  let counter = 0;
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    index.set(element, counter++);
  }
  return index;
}

interface Outcome {
  threw: boolean;
  ids: number[];
}

function outcomeOf(run: () => ArrayLike<Element>, index: Map<Element, number>): Outcome {
  try {
    const elements = Array.from(run());
    return { threw: false, ids: elements.map((element) => index.get(element) ?? -1) };
  } catch {
    return { threw: true, ids: [] };
  }
}

interface Failure {
  fixture: string;
  context: string;
  selector: string;
  expected: string;
  actual: string;
}

function describeContext(context: ParentNode): string {
  if ((context as Node).nodeType === 9) {
    return "document";
  }
  const element = context as Element;
  return `<${element.tagName.toLowerCase()}${element.id ? "#" + element.id : ""}>`;
}

/** 元素命中覆盖统计（按选择器来源分组，报告更有意义） */
const seenByTag = new Map<string, Set<string>>();
const matchedByTag = new Map<string, Set<string>>();
let assertionCount = 0;

function track(tag: string, selector: string, matched: boolean): void {
  let seen = seenByTag.get(tag);
  if (!seen) {
    seen = new Set<string>();
    seenByTag.set(tag, seen);
  }
  seen.add(selector);
  if (!matched) {
    return;
  }
  let hit = matchedByTag.get(tag);
  if (!hit) {
    hit = new Set<string>();
    matchedByTag.set(tag, hit);
  }
  hit.add(selector);
}

function comparePair(
  failures: Failure[],
  fixture: string,
  selector: string,
  context: ParentNode,
  index: Map<Element, number>,
  tag = "misc",
): void {
  assertionCount++;
  const expected = outcomeOf(() => sizzle(selector, context) as ArrayLike<Element>, index);
  const actual = outcomeOf(() => selectElements(selector, context), index);
  track(tag, selector, expected.ids.length > 0);
  if (expected.threw !== actual.threw || expected.ids.join(",") !== actual.ids.join(",")) {
    failures.push({
      fixture,
      context: describeContext(context),
      selector,
      expected: expected.threw ? "THREW" : `[${expected.ids.join(",")}]`,
      actual: actual.threw ? "THREW" : `[${actual.ids.join(",")}]`,
    });
  }
}

function formatFailures(failures: Failure[], limit = 25): string {
  const head = failures
    .slice(0, limit)
    .map(
      (f) =>
        `- [${f.fixture} / ${f.context}] ${JSON.stringify(f.selector)}\n    sizzle=${f.expected}\n    mine  =${f.actual}`,
    )
    .join("\n");
  return `${failures.length} mismatches:\n${head}${failures.length > limit ? `\n… 另有 ${failures.length - limit} 条` : ""}`;
}

/** 跑一整轮：所有 fixture × 所有上下文 × 所有选择器 */
function runMatrix(selectors: string[], options: { fullContexts: boolean }, tag: string): Failure[] {
  const failures: Failure[] = [];
  for (const fixture of FIXTURES) {
    const { doc, root } = loadFixture(fixture);
    const index = buildElementIndex(doc);
    const contexts = options.fullContexts ? sampleContexts(doc, root) : [doc, root];
    for (const selector of selectors) {
      for (const context of contexts) {
        comparePair(failures, fixture.name, selector, context, index, tag);
      }
    }
  }
  return failures;
}

function coverageOf(tag: string): { seen: number; matched: number; ratio: number; missed: string[] } {
  const seen = seenByTag.get(tag) ?? new Set<string>();
  const hit = matchedByTag.get(tag) ?? new Set<string>();
  const missed = Array.from(seen).filter((selector) => !hit.has(selector));
  return { seen: seen.size, matched: hit.size, ratio: seen.size === 0 ? 1 : hit.size / seen.size, missed };
}

/* -------------------------------------------------------------------------- */
/* 4. 用例                                                                     */
/* -------------------------------------------------------------------------- */

describe("选择器层 / Sizzle 差分", () => {
  it("源码里全部 Sizzle/selectElements 调用点都可提取", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[extract] files=${extraction.fileCount} callSites=${extraction.callSiteCount} ` +
        `resolvable=${extraction.resolvableCallSiteCount} dynamic=${extraction.dynamicCallSiteCount} ` +
        `uniqueCallSiteSelectors=${extraction.callSiteSelectors.length} dynamicPool=${extraction.dynamicSelectors.length}`,
    );
    expect(extraction.fileCount).toBeGreaterThan(20);
    // 迁移前真实调用点是 92 个（另有 1 处注释提及在 types/site.ts，不是调用）。
    // 允许并发改动把某些调用临时注释掉（例如 azusa.ts 目前整类被注释），因此留出下限。
    expect(extraction.callSiteCount).toBeGreaterThanOrEqual(90);
    expect(extraction.callSiteSelectors.length).toBeGreaterThanOrEqual(60);
  });

  it("调用点选择器 × 全部 fixture × 采样上下文：元素序列与 Sizzle 完全一致", () => {
    const failures = runMatrix(extraction.callSiteSelectors, { fullContexts: true }, "callSite");
    expect(failures.length, formatFailures(failures)).toBe(0);
  });

  it("站点定义动态选择器池 × 全部 fixture：元素序列与 Sizzle 完全一致", () => {
    expect(extraction.dynamicSelectors.length).toBeGreaterThan(100);
    const failures = runMatrix(extraction.dynamicSelectors, { fullContexts: false }, "dynamic");
    expect(failures.length, formatFailures(failures)).toBe(0);
  });

  it("显式元素上下文用例（作用域 / 前置组合符 / 位置伪类）与 Sizzle 完全一致", () => {
    const failures: Failure[] = [];
    document.body.innerHTML = FIXTURE_NEXUSPHP_TORRENTS + FIXTURE_NEXUSPHP_USER + FIXTURE_GENERIC;
    const index = buildElementIndex(document);
    const cases: Array<{ selector: string; context: Element }> = [
      { selector: "> td", context: document.querySelector("#torrent-row-1") as Element },
      { selector: "> td:eq(0)", context: document.querySelector("#torrent-row-1") as Element },
      { selector: "> td:eq(4), > td:eq(5), > td:eq(6)", context: document.querySelector("#alt-head") as Element },
      { selector: "> td:last", context: document.querySelector("#alt-head") as Element },
      { selector: "tr:not(:eq(0))", context: document.querySelector("#torrents-main tbody") as Element },
      { selector: "tr:eq(1)", context: document.querySelector("#torrents-main tbody") as Element },
      { selector: "td:contains('Total') ~ td", context: document.querySelector("#alt-head") as Element },
      { selector: "> li", context: document.querySelector("#stats-list") as Element },
      { selector: "li:contains('Seeding: ')", context: document.querySelector("#stats-list") as Element },
      { selector: "table:last tr:not(:eq(0))", context: document.querySelector("#wrapper") as Element },
      { selector: "div:has( ~ table) > div:contains(' | ')", context: document.querySelector("#wrapper") as Element },
      { selector: ".t_files_size_added span[data-bytecount]", context: document.querySelector("#bt-1") as Element },
      { selector: "a", context: document.querySelector("#bt-1") as Element },
      { selector: "~ tr", context: document.querySelector("#torrent-row-1") as Element },
      { selector: "+ tr", context: document.querySelector("#torrent-row-1") as Element },
      { selector: "> tr", context: document.querySelector("#torrents-main tbody") as Element },
    ];
    for (const { selector, context } of cases) {
      comparePair(failures, "explicit", selector, context, index, "explicit");
    }
    expect(failures.length, formatFailures(failures)).toBe(0);
  });

  it("边界：空结果 / :contains 大小写与引号 / :eq 越界 / 嵌套 :has", () => {
    const failures: Failure[] = [];
    document.body.innerHTML = `
      <div id="edge-root">
        <ul id="edge-list">
          <li id="edge-1">Alpha</li>
          <li id="edge-2">alpha</li>
          <li id="edge-3" title="has 'quote'">with 'quote'</li>
          <li id="edge-4">中文 text</li>
          <li id="edge-5">  spaced  </li>
        </ul>
        <div id="edge-empty"></div>
        <div id="edge-has-outer"><div id="edge-has-mid"><span id="edge-has-inner">deep</span></div></div>
        <table id="edge-table"><tbody>
          <tr id="edge-tr-1"><td>a</td></tr>
          <tr id="edge-tr-2"><td>b</td></tr>
          <tr id="edge-tr-3"><td>c</td></tr>
        </tbody></table>
      </div>`;
    const index = buildElementIndex(document);
    const root = document.getElementById("edge-root") as Element;
    const selectors = [
      "li:contains('nosuchtext')",
      "li:contains('Alpha')",
      "li:contains('alpha')",
      "li:contains('ALPHA')",
      "li:contains(\"with 'quote'\")",
      "li:contains('中文')",
      "li:contains('')",
      "li:contains('  spaced  ')",
      "li:eq(0)",
      "li:eq(4)",
      "li:eq(5)",
      "li:eq(-1)",
      "li:eq(-99)",
      "li:eq(99)",
      "li:lt(0)",
      "li:lt(2)",
      "li:lt(99)",
      "li:gt(99)",
      "li:gt(-1)",
      "li:even",
      "li:odd",
      "li:first",
      "li:last",
      "li:not(:eq(0))",
      "li:not(:last)",
      "div:has(div span)",
      "div:has(div:has(span))",
      "div:has(> div > span)",
      "div:has( span)",
      "table:last tr:not(:eq(0)):first",
      "tr:not(:eq(0)) td",
      // 多位置伪类：尾随位置伪类必须作用于「存活上下文的并集」（A-18）
      "tr:gt(0) td:eq(0)",
      "tr:gt(0) td:last",
      "tr:gt(0) td",
      "tr:lt(2) td:eq(1)",
      "tr:even td:odd",
      "tr:not(:eq(0)) td:first",
      "table:last tr:eq(1) td:first",
      "tr:gt(0) td:contains('b')",
      "tr:gt(0) td:contains('b'):first",
      "tr:first td:last, tr:last td:first",
      "#edge-has-outer:has(#edge-has-inner)",
      "ul:has(li:nth-child(2))",
      "*:last",
      "*:first",
      "li:nth-child(2)",
      "li:not(:first-child)",
      "li:not(.nope)",
    ];
    for (const selector of selectors) {
      for (const context of [document, root]) {
        comparePair(failures, "edge", selector, context, index, "edge");
      }
    }
    expect(failures.length, formatFailures(failures)).toBe(0);
  });

  it("matchesSelector 与 Sizzle.matchesSelector 一致", () => {
    const failures: string[] = [];
    let checked = 0;
    document.body.innerHTML = FIXTURE_NEXUSPHP_USER + FIXTURE_GENERIC + FIXTURE_NEXUSPHP_TORRENTS;
    const elements = Array.from(document.querySelectorAll("*"));
    for (const selector of extraction.callSiteSelectors) {
      // 每个选择器抽 6 个元素（首/中/尾 + 固定步长），覆盖命中与未命中
      const step = Math.max(1, Math.floor(elements.length / 6));
      for (let i = 0; i < elements.length; i += step) {
        const element = elements[i];
        checked++;
        const expected = outcomeOf(
          () => (sizzle.matchesSelector(element, selector) ? [element] : []),
          new Map<Element, number>([[element, 0]]),
        );
        const actual = outcomeOf(
          () => (matchesSelector(element, selector) ? [element] : []),
          new Map<Element, number>([[element, 0]]),
        );
        if (expected.threw !== actual.threw || expected.ids.join(",") !== actual.ids.join(",")) {
          failures.push(
            `- ${JSON.stringify(selector)} on <${element.tagName.toLowerCase()}> expected=${expected.threw ? "THREW" : expected.ids.length} actual=${actual.threw ? "THREW" : actual.ids.length}`,
          );
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[matchesSelector] checked=${checked}`);
    expect(failures.length, `${failures.length} mismatches:\n${failures.slice(0, 20).join("\n")}`).toBe(0);
  });

  it("断言规模与命中覆盖统计", () => {
    const callSite = coverageOf("callSite");
    const dynamic = coverageOf("dynamic");
    let totalSeen = 0;
    let totalMatched = 0;
    for (const [tag, seen] of seenByTag) {
      const matched = (matchedByTag.get(tag) ?? new Set<string>()).size;
      totalSeen += seen.size;
      totalMatched += matched;
      // eslint-disable-next-line no-console
      console.log(`[coverage:${tag}] seen=${seen.size} matched=${matched}`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[coverage] assertions=${assertionCount} selectors=${totalSeen} matched=${totalMatched} ` +
        `callSite=${callSite.matched}/${callSite.seen} dynamic=${dynamic.matched}/${dynamic.seen}`,
    );
    // 调用点选择器里没能在任何 fixture 上命中的（用于人工确认不是"空集 vs 空集"）
    // eslint-disable-next-line no-console
    console.log(`[coverage:callSite-missed] ${JSON.stringify(callSite.missed)}`);

    expect(assertionCount).toBeGreaterThan(10000);
    // 调用点选择器必须绝大多数都在 fixture 上真的命中过
    expect(callSite.ratio).toBeGreaterThan(0.9);
    // 动态池（站点定义里的选择器）包含大量站点特有结构，整体命中率只做下限约束
    expect(totalMatched / Math.max(1, totalSeen)).toBeGreaterThan(0.25);
  });
});
