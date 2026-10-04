import { describe, expect, it } from "vitest";
import Sizzle from "./oracle/selector-oracle.mjs";
import { matchesSelector, selectElements } from "~/packages/site/utils/selector";

/**
 * Sizzle 行为契约测试 —— 现作为「自研选择器层必须复刻的语义」回归网。
 *
 * 背景
 * ----
 * Sizzle 依赖已退役：`src/**` 里全部 `Sizzle(...)` / `Sizzle.matchesSelector(...)`
 * 调用点都迁移到了自研薄选择器层（`~packages/site/utils/selector` 的
 * `selectElements` / `matchesSelector`），依赖已从 package.json / package-lock.json 移除。
 *
 * 本文件因此变成**第二道网**：
 *  - 主验证网见 `tests/packages/site/utils/selector.test.ts` —— 它从真实源码提取全部调用点
 *    选择器（含模板串展开与站点定义里的动态选择器池），在多组真实结构 fixture ×
 *    document/element 上下文上与冻结的 Sizzle 2.3.10 逐元素比对；
 *  - 本文件用更小、可读的用例把「我们曾经依赖 Sizzle 的哪些行为」钉成可执行契约，
 *    将来若有人调整自研引擎，这里能一眼看出破坏了哪条语义。
 *
 * 参照实现：`tests/packages/site/utils/oracle/selector-oracle-2.3.10.js.txt`
 * （npm 包 Sizzle 2.3.10 发行版引擎文件的逐字节副本，仅测试使用，不参与构建）。
 *
 * ⚠️ 环境说明：本文件跑在 happy-dom 下（该环境下 Sizzle 的 `support.qsa === false`，
 * 走的是它自研 `select` 分支）。已确认这里观察到的行为与 jQuery/Sizzle 的文档语义一致
 * （位置伪类 `:first/:last/:eq/:gt` 都是**对全局匹配集**的下标过滤，不是按父节点分组）。
 * 真实浏览器上的端到端站点验证仍需另行进行。
 */

/** 每个用例独立的夹具：文档顺序明确，避免位置伪类出现歧义 */
function setup(html: string): void {
  document.body.innerHTML = html;
}

const ids = (els: unknown) => Array.from(els as Element[]).map((e) => e.id);

/**
 * 双向求值：**自研实现**与**冻结的 Sizzle 2.3.10** 必须给出完全一致的结果
 * （同长度、同顺序、同元素），并返回自研实现的结果供断言「文档化的期望值」。
 *
 * 这一步很关键：只断言 oracle 的行为只能证明"Sizzle 是这样"，无法在有人改坏
 * `selectElements` 时报警；这里让每条用例同时钉住"新实现 == oracle"。
 */
function both(selector: string, context?: ParentNode) {
  const actual = selectElements(selector, context);
  const expected = Sizzle(selector, context);
  expect(ids(actual)).toEqual(ids(expected));
  return actual;
}

describe("选择器层行为契约（自研实现 vs 冻结的 Sizzle 2.3.10）", () => {
  it(":contains 单用 —— azusa / secretcinema / douban 形状", () => {
    setup(`
      <ul><li id="l1">Seeding Points: 10</li><li id="l2">Overall rank: 3</li><li id="l3">其它</li></ul>
      <div id="info"><span class="pl" id="pl1">又名: 中文名</span><span class="pl" id="pl2">IMDb: tt123</span></div>
    `);
    expect(ids(both("li:contains('Seeding Points: ')"))).toEqual(["l1"]);
    expect(ids(both("li:contains('Overall rank: ')"))).toEqual(["l2"]);
    expect(ids(both("#info span.pl:contains('又名')"))).toEqual(["pl1"]);
    expect(ids(both('#info span.pl:contains("IMDb:")'))).toEqual(["pl2"]);
  });

  it(":contains 与 :first 链式 —— tjupt 形状", () => {
    setup(`<div id="spans"><span id="sp1">≥1 个</span><span id="sp2">≥1 个</span><span id="sp3">其它</span></div>`);
    expect(ids(both("#spans span:contains('≥1'):first"))).toEqual(["sp1"]);
  });

  it(":contains 后跟兄弟组合子 —— audiobookbay 形状", () => {
    setup(`
      <table><tbody>
        <tr id="r1"><td id="c11">Info Hash:</td><td id="c12">HASH1</td><td id="c13">x</td></tr>
        <tr id="r2"><td id="c21">Tracker:</td><td id="c22">TR1</td><td id="c23">y</td></tr>
      </tbody></table>
    `);
    // `~` 取该 td 的**后续所有兄弟**
    expect(ids(both("td:contains('Info Hash:') ~ td"))).toEqual(["c12", "c13"]);
    expect(ids(both("td:contains('Tracker:') ~ td"))).toEqual(["c22", "c23"]);
  });

  it("位置伪类是对全局匹配集的下标过滤 —— :eq / :first / :last / :gt", () => {
    setup(`
      <table id="t1"><tbody><tr id="r1"><td id="c11">a</td></tr><tr id="r2"><td id="c21">b</td></tr></tbody></table>
      <table id="t2"><tbody><tr id="r3"><td id="c31">c</td></tr></tbody></table>
    `);
    expect(ids(both("table:first"))).toEqual(["t1"]);
    expect(ids(both("table:last"))).toEqual(["t2"]);
    expect(ids(both("table:eq(1)"))).toEqual(["t2"]);
    expect(ids(both("tr:eq(0)"))).toEqual(["r1"]);
    expect(ids(both("tr:gt(0)"))).toEqual(["r2", "r3"]);
    expect(ids(both("td:last"))).toEqual(["c31"]);
  });

  it(":eq 嵌在 :not 内 —— totheglory 形状", () => {
    setup(`
      <table><tbody><tr id="r1"><td>a</td></tr><tr id="r2"><td>b</td></tr><tr id="r3"><td>c</td></tr></tbody></table>
    `);
    expect(ids(both("tr:not(:eq(0))"))).toEqual(["r2", "r3"]);
  });

  it("位置伪类作用在祖先段 —— NexusPHP 用户信息页形状", () => {
    setup(`
      <table id="t1"><tbody><tr id="a1"><td>1</td></tr></tbody></table>
      <table id="t2"><tbody>
        <tr id="b1"><td>含义行</td></tr>
        <tr id="b2"><td> | 100</td></tr>
        <tr id="b3"><td> | 200</td></tr>
      </tbody></table>
    `);
    // table:last 先取文档顺序最后一张表，再在其行上做 :not(:eq(0)) 全局过滤
    expect(ids(both("table:last tr:not(:eq(0))"))).toEqual(["b2", "b3"]);
  });

  it(":has( ~ table) 相对选择器 —— NexusPHP 做种/上传区块形状", () => {
    setup(`
      <div id="group"><div id="inner"> 100 | 200 | 300 </div></div>
      <table id="siblingTable"><tbody><tr><td>z</td></tr></tbody></table>
      <div id="lonely"> 1 | 2 </div>
    `);
    expect(ids(both("div:has( ~ table)"))).toEqual(["group"]);
    expect(ids(both("div:has( ~ table) > div:contains(' | ')"))).toEqual(["inner"]);
  });

  it("选择器链中段的位置伪类 —— sportscult 形状", () => {
    setup(`
      <div id="mcol"><div class="b-content">
        <table class="lista" id="la1"><tbody><tr id="la1r1"><td>p</td></tr><tr id="la1r2"><td>q</td></tr></tbody></table>
      </div></div>
    `);
    expect(ids(both("#mcol div.b-content table.lista:eq(0)"))).toEqual(["la1"]);
    expect(ids(both("#mcol div.b-content table.lista:eq(1)"))).toEqual([]);
    expect(ids(both("#mcol div.b-content table.lista:eq(0) tbody tr:gt(0)"))).toEqual(["la1r2"]);
  });

  it("以组合子开头的相对选择器 —— skyeyesnow 形状", () => {
    setup(`<table><tbody><tr id="r1"><td id="c1">a</td><td id="c2">b</td><td id="c3">c</td></tr></tbody></table>`);
    const row = document.getElementById("r1") as HTMLElement;
    expect(ids(both("> td:eq(1)", row))).toEqual(["c2"]);
  });

  it("以元素为上下文时只在其后代中查找，且不含上下文自身 —— 引擎核心行为", () => {
    setup(`<div id="box"><span id="s1">x</span><span id="s2">y</span></div>`);
    const box = document.getElementById("box") as HTMLElement;
    expect(ids(both("span", box))).toEqual(["s1", "s2"]);
    expect(ids(both("#box", box))).toEqual([]);
  });

  it("matchesSelector 是元素匹配语义 —— 引擎回落逻辑依赖", () => {
    setup(`<table id="t1"><tbody><tr id="r1"><td id="c11">a</td></tr></tbody></table>`);
    const c11 = document.getElementById("c11") as HTMLElement;
    // 双向：自研 matchesSelector 必须与 oracle 一致，并满足文档化的期望
    for (const sel of ["td", "#t1 td", "th"]) {
      expect(matchesSelector(c11, sel)).toBe(Sizzle.matchesSelector(c11, sel));
    }
    expect(matchesSelector(c11, "td")).toBe(true);
    expect(matchesSelector(c11, "#t1 td")).toBe(true);
    expect(matchesSelector(c11, "th")).toBe(false);
  });

  it("原生伪类 :first-of-type 按原生语义透传 —— audiobookbay 形状", () => {
    setup(`<table id="t1"><tbody><tr id="r1"><td id="c11">a</td><td id="c12">b</td></tr></tbody></table>`);
    // 原生 :first-of-type 每行都会命中第一个 td，而不是全局只取第 1 个
    expect(ids(both("#t1 tbody tr td:first-of-type"))).toEqual(["c11"]);
  });

  it("属性前缀匹配 + :contains + :first 组合 —— bibliotik 形状", () => {
    setup(`
      <div class="pagination">
        <a id="a1" href="?page=2">2</a>
        <a id="a2" href="?page=9">Last >></a>
        <a id="a3" href="/other">Last >></a>
      </div>
    `);
    expect(ids(both(".pagination a[href*='?page']:contains('Last >>'):first"))).toEqual(["a2"]);
  });

  it("尾随位置伪类作用于**并集**（修复 A-18：修复前每个存活上下文各算一次）", () => {
    setup(`
      <table id="t1"><tbody>
        <tr id="r1"><td id="c11">a</td><td id="c12">b</td></tr>
        <tr id="r2"><td id="c21">c</td><td id="c22">d</td></tr>
        <tr id="r3"><td id="c31">e</td><td id="c32">f</td></tr>
      </tbody></table>
      <table id="t2"><tbody><tr id="r4"><td id="c41">g</td><td id="c42">h</td></tr></tbody></table>
    `);

    // `tr:gt(0)` 存活 r2/r3/r4，`td:eq(0)` 作用在这三行的 td 并集上 => 只取整体第一个 td
    // （修复前是「每行各取第一个 td」，会多返回 c21/c41）
    expect(ids(both("tr:gt(0) td:eq(0)"))).toEqual(["c21"]);
    expect(ids(both("tr:gt(0) td:first"))).toEqual(["c21"]);
    expect(ids(both("tr:gt(0) td:last"))).toEqual(["c42"]);
    expect(ids(both("tr:gt(0) td:lt(3)"))).toEqual(["c21", "c22", "c31"]);
    expect(ids(both("table:first tr:gt(0) td:eq(2)"))).toEqual(["c31"]);
    expect(ids(both("tr:eq(1) td:eq(1)"))).toEqual(["c22"]);
    // `tr:even` 存活 r1 / r3，`td:odd` 作用在两者 td 的并集 [c11,c12,c31,c32] 上
    expect(ids(both("tr:even td:odd"))).toEqual(["c12", "c32"]);
    // 中段位置伪类 + 尾随位置伪类混用
    expect(ids(both("tbody:first tr:not(:eq(0)) td:first"))).toEqual(["c21"]);
    // 尾随段带扩展伪类（:contains）时同样作用于并集
    expect(ids(both("tr:gt(0) td:contains('d'):first"))).toEqual(["c22"]);
    // 尾随段没有位置伪类：各上下文结果的并集（顺序不变）
    expect(ids(both("tr:gt(0) td"))).toEqual(["c21", "c22", "c31", "c32", "c41", "c42"]);
    // 尾随段用兄弟组合符时，仍是「相对每个存活元素」求值再取并集
    expect(ids(both("tr:gt(0) + tr"))).toEqual(["r3"]);
    expect(ids(both("tr:gt(0) ~ tr"))).toEqual(["r3"]);
    // 多分组：每个分组各自求值，最终结果按文档序（同 Sizzle 的 uniqueSort）
    expect(ids(both("tr:gt(0) td:eq(0), tr:eq(0) td:last"))).toEqual(["c12", "c21"]);
  });

  it("存活上下文互相嵌套时结果去重（A-18 的「结果拼接不去重」）", () => {
    setup(`
      <table id="t1"><tbody>
        <tr id="r1"><td id="c11">a</td></tr>
        <tr id="r2"><td id="c21">b</td></tr>
      </tbody></table>
      <table id="t2"><tbody><tr id="r3"><td id="c31">c</td></tr></tbody></table>
    `);
    // html/body/t1/tbody/t2 都 :has(tr)，`:even` 存活 html、t1、t2（三者上下文互相包含），
    // 它们各自查 tr 会重复命中同一批行 => 必须去重（修复前会返回重复元素）。
    // 注意这里**刻意不用 both()**：冻结的 Sizzle 2.3.10 在该嵌套场景下会返回 6 个元素
    // （r1,r2,r3,r1,r2,r3），本引擎统一按文档序去重（3 个）——这是有意的规范化。
    const actual = selectElements("*:has(tr):even tr");
    expect(ids(actual)).toEqual(["r1", "r2", "r3"]);
    expect(actual.length).toBe(new Set(actual).size);
  });
});
