/**
 * TESTS-9：跨站点定义的静态校验。
 *
 * 背景：341 个 `src/packages/site/definitions/*.ts` 里此前只有 8 个被任何用例读取，
 * 上一轮清单里的定义层缺陷（H-12、D-4/D-5/D-6/D-8/D-9/D-34 等）没有回归网 ——
 * 「参数名写错 / 选择器指向旧布局」这两类问题类型检查与构建都看不见，第四轮会再次全绿地复发。
 * 本文件对所有定义做**跨定义**的不变量校验（单站点行为回归仍由 definitionFixes.test.ts 等负责）：
 *
 * - 定义可被加载、`id` 与文件名一致且全局唯一；
 * - 具名 filter 必须来自 `@ptd/site/utils/filter.ts` 的 definedFilters（写错名字 = 静默不筛选）；
 * - 时间格式串不得包含 date-fns v4 已删除的 token（`YYYY`/`YY`/`DD`/`D`）；
 * - `category` 分组：key 唯一、首字母小写（D-34：大写 key 会让 PHP 侧键名不匹配）、
 *   `cross.key` 不含 `[]`（D-4：brackets 会自行补 `[]`，多写一层会发出 `category[][0]`）；
 * - `search.selectors.rows` 若定义则选择器非空；
 * - `seeders` 与 `leechers` 不能是同一个查询（D-8：复制粘贴后两个字段都取到种子数）；
 * - `urls` 非空。
 *
 * 2026-10-23 审查（H-M3 / H-L7）补齐的跨定义不变量：
 *
 * - **任意两个字段**不得指向同一个 `(selector, attr, elementProcess)` 组合（原先只比 seeders/leechers，
 *   于是 E2-01 的 `completed === leechers` 在同一份文件上永远绿灯）；`completed` 单独再断言一次
 *   ≠ `seeders` / `leechers`（完成数与下载者数没有合法同值例外，不像 `text:"N/A"`）；
 * - `schema` 必须能在 `src/packages/site/schemas/` 找到同名模块，或定义自带 `default class`
 *   （G24：`schema` 指向不存在的引擎时 `getSite` 会静默回落到 Abstract*Site，站点行为整体变样）；
 * - `rows` 的结构性检查覆盖 `search` / `searchEntry[*]` / `list[*]`（原先只查 `search`），
 *   并检查「schema 引擎既不提供 rows、站点也没写、引擎又不自动生成」这种必然搜不到东西的组合；
 * - `tags` 每项必须有 `name` 与非空 `selector`；`timezoneOffset` 必须是 `^[+-]\d{4}$`；
 * - `requestConfig` 里出现的 `$field$` 占位符必须在该步骤的 `assertion` 里声明；
 * - **ratchet（暂不硬失败）**：几类需要站点语义/产品裁决才能判定的可疑点先按「数量不得超过当前已知值」
 *   的棘轮守住 —— ① 两个字段共享同一查询（`0magnet` 的 url/id 是有意复用）；② `assertion` 声明了依赖
 *   但路径是静态串（teamhd / wihd，E6 遗留）；③ 等级阶梯倒挂（含插入在阶梯中间的特殊等级，不能简单判错）。
 *   这些条目在 fix report 里列为「待收紧」，修好之后请把上界一起下调。
 *
 * 对照上游 182140c2 的 `vite/checkSiteDefinition.ts`（上游挂在 `pnpm check`；fork 没有这个脚本，
 * 站点定义静态校验统一放在本文件，随 `npm test` 运行）补齐的检查：
 *
 * - 必填字段：`version` 是数字、`name` 非空、`type` 只能是 private / public；
 *   非模板类引擎的 `version` 必须 > 0（types/site.ts 的 version 约定）；
 * - `urls` / `legacyUrls` 每项经 `restoreSecureLink`（rot13 还原）后必须是 http(s) 地址，
 *   `legacyUrls` 不得与 `urls` 重复；
 * - `category` 每组都有非空 `name` / `key` 与 `options` 数组；
 * - `levelRequirements` 的 id 是数字、唯一且严格递增，且每级都有 `name`；
 * - `default class` 必须继承 `schema` 声明的引擎类（否则 schema 字段只是摆设）；
 * - `TPatterns` 字段（urlPattern / excludeUrlPattern / urlPatterns / refreshHeaderPattern / officialGroupPattern）
 *   里的字符串字面量必须能 `new RegExp(pattern, "i")`：坏一个括号会在内容脚本里抛 SyntaxError，
 *   把整页列表解析带崩。这一项按源码 AST 扫描 definitions 与 schemas 全部文件（与上游一致），
 *   因此也覆盖 `listTorrentPageMetadata` 这类不挂在 siteMetadata 上的导出常量。
 *
 * - 具名过滤器的源码级守卫（上游 a269aa8c）：按 AST 扫描 definitions 与 schemas 里所有 `filters` / `switchFilters`
 *   的 `{ name: "xxx" }`，补上运行时用例走不到的位置（类方法里内联的查询、未挂到 metadata 的导出常量）。
 *   第一层守卫是 filter.ts 的 `satisfies Record<string, TQueryFilterFn>` + vue-tsc（见 utils/filterNameTyping.test.ts）。
 * - 成人站点地址保护（上游 22573d1c）：tags 含 成人 / xxx / adult 的站点，urls / legacyUrls / trackerUrls 必须写成 rot13，
 *   且定义文件里其它字符串字面量不得出现本站域名的明文地址；trackerUrls 同样要求 rot13 还原后是 http(s)。
 * - favicon 守卫（上游 0f300197）：显式 `./x` 引用的本地文件必须存在；实际命中的本地图标不超过 256x256（棘轮）；
 *   远端地址 / data URI 只打印提示（上游同样只是警告）。
 *
 * 上游的「id 合法/唯一」「schema 存在或有 default class」「category key 唯一」「timezoneOffset 格式」
 * 上面已有对应用例；「明文 http」与 version 口径只是上游的提示/警告，不在这里断言。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { get } from "es-toolkit/compat";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

const definitionModules = import.meta.glob("../../../../src/packages/site/definitions/*.ts");
const schemaModules = import.meta.glob("../../../../src/packages/site/schemas/*.ts");

interface IDefinition {
  fileId: string;
  path: string;
  metadata: any;
  /** 定义自带的站点类（`export default class`）；没有时由 schema 引擎类承载 */
  hasDefaultClass: boolean;
  defaultClass?: Function;
}

const definitions: IDefinition[] = [];
let filterNames = new Set<string>();
/** `src/packages/site/schemas/*.ts` 的模块名集合（`schema` 必须指向其中之一，或定义自带 default class） */
let schemaNames = new Set<string>();
/** 各 schema 引擎的 SchemaMetadata 是否自带 `search.selectors.rows`（NexusPHP 会运行时自动生成，另行豁免） */
const schemaProvidesRows = new Map<string, boolean>();
/** 各 schema 模块导出的引擎类（`export default class`），用于校验定义的 default class 继承关系 */
const schemaClasses = new Map<string, Function>();
/** 引擎自己补齐 rows / 走 JSON 行的 schema：不需要站点写 rows 也不会「取不到行」 */
const ROWS_ENGINE_EXEMPT = new Set(["NexusPHP", "GazelleJSONAPI"]);

/** 计数/度量类字段：两个字段同源时用户看到的是同一个数（D-8 / E2-01） */
const metricFields = [
  "title",
  "subTitle",
  "url",
  "link",
  "id",
  "time",
  "size",
  "seeders",
  "leechers",
  "completed",
] as const;

/** 收集一个配置子树里所有「选择器查询」对象（含 filters / switchFilters / selector 的对象） */
function collectQueries(node: unknown, out: any[], seen = new Set<unknown>()): void {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectQueries(item, out, seen);
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.filters || record.switchFilters || record.selector !== undefined) out.push(record);
  for (const value of Object.values(record)) collectQueries(value, out, seen);
}

/** 取出一个查询里所有具名 filter（函数式 filter 直接跳过：它们不需要登记在 definedFilters） */
function namedFilters(query: any): Array<{ name: string; args?: unknown[] }> {
  const entries = [...(query.filters ?? []), ...Object.values(query.switchFilters ?? {}).flat()] as any[];
  return entries.filter(
    (filter): filter is { name: string; args?: unknown[] } =>
      !!filter && typeof filter === "object" && typeof filter.name === "string",
  );
}

/** 所有的 (定义, 查询) 对：search / searchEntry / detail / userInfo / list */
function allQueries(metadata: any): Array<{ id: string; query: any }> {
  const queries: any[] = [];
  for (const section of [
    metadata.search,
    (metadata as any).searchEntry,
    metadata.detail,
    metadata.userInfo,
    metadata.list,
  ]) {
    collectQueries(section, queries);
  }
  return queries.map((query) => ({ id: metadata.id, query }));
}

/** 结构签名：函数按引用区分（否则两个不同 elementProcess 会被 JSON 抹成同一个签名） */
function sameSignature(left: unknown, right: unknown): boolean {
  // 函数 id 必须在同一次比较内分配，否则不同函数会各自拿到 fn#0 而被误判为相同
  const fnIds = new Map<unknown, number>();
  const signature = (value: unknown) =>
    JSON.stringify(value, (_key, item) => {
      if (typeof item === "function") {
        if (!fnIds.has(item)) fnIds.set(item, fnIds.size);
        return `fn#${fnIds.get(item)}`;
      }
      return item;
    });
  return signature(left) === signature(right);
}

/** 收集 requestConfig 里所有 `$field$` 占位符（含其所在 JSON 路径） */
function collectPlaceholders(node: unknown, path: string, out: Array<{ field: string; path: string }>): void {
  if (typeof node === "string") {
    for (const match of node.matchAll(/\$([A-Za-z0-9_]+)\$/g)) {
      out.push({ field: match[1], path });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectPlaceholders(item, `${path}[${index}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      collectPlaceholders(value, path === "" ? key : `${path}.${key}`, out);
    }
  }
}

/**
 * 找出「占位符已在 assertion 里声明、但 assertion 指向的 pathKey 不是占位符所在路径」的条目。
 * 只检查已声明的（未声明的由另一条用例负责）。
 */
function findMisplacedPlaceholderPaths(process: any[]): { misplaced: string[]; compared: number } {
  const misplaced: string[] = [];
  let compared = 0;
  for (const [index, step] of process.entries()) {
    const placeholders: Array<{ field: string; path: string }> = [];
    collectPlaceholders(step?.requestConfig ?? {}, "", placeholders);
    if (placeholders.length === 0) continue;

    const assertion = (step?.assertion ?? {}) as Record<string, unknown>;
    for (const { field, path } of placeholders) {
      if (!(field in assertion)) continue;
      compared++;
      if (assertion[field] !== path) {
        misplaced.push(
          `process[${index}]: $${field}$ 位于 ${path}，但 assertion.${field} = ${String(assertion[field])}`,
        );
      }
    }
  }
  return { misplaced, compared };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** 会被 `new RegExp(pattern, "i")` 编译的字段（类型里的 `TPatterns`），与上游 checkSiteDefinition.ts 一致 */
const PATTERN_FIELDS = new Set([
  "urlPattern", // site.urlPattern / list[].urlPattern / search.urlPattern / detail.urlPattern
  "excludeUrlPattern",
  "urlPatterns", // noLoginAssert.urlPatterns
  "refreshHeaderPattern",
  "officialGroupPattern",
]);

/** 收集一棵子树里的所有字符串字面量（无插值的模板串也算） */
function collectStringLiterals(node: ts.Node, out: ts.StringLiteralLike[] = []): ts.StringLiteralLike[] {
  if (ts.isStringLiteralLike(node)) {
    out.push(node);
    return out;
  }
  // 回调必须返回 undefined：`ts.forEachChild` 的回调返回真值就会停止遍历，
  // 只收到数组里的第一个字面量（上游 182140c2 修过的同一个坑）
  ts.forEachChild(node, (child) => {
    collectStringLiterals(child, out);
  });
  return out;
}

/**
 * 按源码 AST 找出 PATTERN_FIELDS 属性里所有字符串字面量，并尝试编译。
 * 用 AST 而不是运行时对象，是为了覆盖不挂在 siteMetadata 上的导出常量与类内部的配置。
 */
function checkPatternLiterals(fileName: string, text: string): { errors: string[]; count: number } {
  const errors: string[] = [];
  let count = 0;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))) {
      const field = node.name.text;
      if (PATTERN_FIELDS.has(field)) {
        for (const literal of collectStringLiterals(node.initializer)) {
          count++;
          try {
            new RegExp(literal.text, "i");
          } catch (e) {
            const { line } = source.getLineAndCharacterOfPosition(literal.getStart(source));
            errors.push(`${fileName}:${line + 1} ${field} = ${JSON.stringify(literal.text)}：${(e as Error).message}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { errors, count };
}

/**
 * 按源码 AST 检查 `filters` / `switchFilters` 里 `{ name: "xxx" }` 的名字是否存在于 definedFilters（上游 a269aa8c）。
 *
 * 运行时用例（「具名 filter 必须属于 definedFilters」）只能走到挂在 siteMetadata 上的查询；
 * 这里补上类方法里内联的 getFieldData 查询、未挂到 metadata 的导出常量等运行时遍历不到的位置。
 * 函数式过滤器、常量引用、非字面量名字静态看不出来，交给类型系统（filter.ts 的 satisfies）。
 */
function checkFilterNameLiterals(
  fileName: string,
  text: string,
  names: Set<string>,
): { errors: string[]; count: number } {
  const errors: string[] = [];
  let count = 0;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const unwrap = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
    }
    return current;
  };

  const checkOne = (node: ts.Expression) => {
    const obj = unwrap(node);
    if (!ts.isObjectLiteralExpression(obj)) return;
    const nameProp = obj.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "name",
    );
    if (!nameProp) return;
    count++;
    const nameNode = unwrap(nameProp.initializer);
    if (!ts.isStringLiteralLike(nameNode)) return; // 动态拼接的名字静态查不了
    if (!names.has(nameNode.text)) {
      const { line } = source.getLineAndCharacterOfPosition(nameNode.getStart(source));
      errors.push(`${fileName}:${line + 1} filters 里的 name "${nameNode.text}" 不在 definedFilters 中`);
    }
  };

  const checkArray = (node: ts.Expression) => {
    const arr = unwrap(node);
    if (ts.isArrayLiteralExpression(arr)) arr.elements.forEach(checkOne);
  };

  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const field = node.name.text;
      if (field === "filters" || field === "switchFilters") {
        const init = unwrap(node.initializer);
        if (ts.isArrayLiteralExpression(init)) {
          init.elements.forEach(checkOne); // filters: TQueryFilter[]
        } else if (ts.isObjectLiteralExpression(init)) {
          if (field === "switchFilters") {
            // switchFilters: Record<selector, TQueryFilter[]>
            for (const p of init.properties) if (ts.isPropertyAssignment(p)) checkArray(p.initializer);
          } else {
            checkOne(init); // filters 也允许写成单个对象
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { errors, count };
}

/**
 * 成人站点的标记（上游 22573d1c）。命中时该站点的 urls / legacyUrls / trackerUrls 必须写成 rot13，
 * 避免仓库里出现明文成人站点域名（加载时由 site/index.ts 的 restoreSecureLink 还原）。
 * `adult` 一并收进来是因为 pornbits 用的是 `tags: ["Adult"]`，词汇不统一会留下漏网口子。
 */
const ADULT_TAG_PATTERN = /^(成人|xxx|adult)$/i;

/** 会被 restoreSecureLink 还原的地址字段（trackerUrls 为可选字段） */
const SECURE_URL_FIELDS = ["urls", "legacyUrls", "trackerUrls"] as const;

/** 取 http(s) 地址的主机名（去掉 `www.` 与端口），取不到返回 undefined */
function urlHost(url: string): string | undefined {
  const match = url.match(/^https?:\/\/([^/?#\s]+)/i);
  if (!match) return undefined;
  const host = match[1].toLowerCase().replace(/:\d+$/, "");
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * 按源码 AST 找出「主机名属于 ownHosts 的明文 http(s) 字符串字面量」（上游 22573d1c §7.1）。
 * `skip` 里的字面量（urls 等字段本身的值）由字段级检查负责，这里不重复报。
 */
function findPlainOwnHostLiterals(fileName: string, text: string, ownHosts: Set<string>, skip: Set<string>): string[] {
  const found: string[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && /^https?:\/\/[^\s/]+/i.test(node.text) && !skip.has(node.text)) {
      const host = urlHost(node.text);
      if (host && ownHosts.has(host)) found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** 本地站点图标目录（wxt.config.ts 注入的 `__RESOURCE_SITE_ICONS__` 就是这个目录的文件列表） */
const ICONS_DIR = "public/icons/site";

/**
 * 本地图标的尺寸上限（上游 0f300197）。站点图标在界面里只显示 14~36px，
 * 超过这个边长基本说明资产没压缩过（上游曾出现 512x512 / 264KB 的 favicon）。
 */
const MAX_LOCAL_ICON_DIM = 256;

/**
 * 本地图标的候选文件名，顺序与 site/utils/favicon.ts 的 getFavicon 一致：
 * `favicon` 以 `./` 开头时该文件排在最前，否则依次是 `<id>.png` / `<id>.ico` / `<id>.svg`。
 */
function localIconCandidates(siteId: string, favicon: unknown): string[] {
  const byId = [`${siteId}.png`, `${siteId}.ico`, `${siteId}.svg`];
  return typeof favicon === "string" && favicon.startsWith("./") ? [favicon.slice(2), ...byId] : byId;
}

/**
 * 只读文件头解析图片尺寸（PNG / ICO / GIF / WebP / JPEG / SVG 的显式 width、height），移植自上游 0f300197。
 * 识别不出来的格式返回 null，调用方按「跳过」处理，不产生误报。
 */
function readImageSize(buf: Buffer): { width: number; height: number } | null {
  // PNG：IHDR 里的宽高
  if (buf.length >= 24 && buf.toString("latin1", 1, 4) === "PNG") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // ICO：取所有帧里最大的声明尺寸（目录项里 0 表示 256）
  if (buf.length >= 22 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) {
    let width = 0;
    let height = 0;
    const count = buf.readUInt16LE(4);
    for (let i = 0; i < count; i++) {
      const offset = 6 + i * 16;
      if (offset + 16 > buf.length) break;
      width = Math.max(width, buf[offset] === 0 ? 256 : buf[offset]);
      height = Math.max(height, buf[offset + 1] === 0 ? 256 : buf[offset + 1]);
    }
    return width && height ? { width, height } : null;
  }

  // GIF
  if (buf.length >= 10 && buf.toString("latin1", 0, 3) === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WebP：VP8X / VP8L / VP8 三种块头的宽高编码各不相同
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8X") return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    if (chunk === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }

  // JPEG：扫到 SOFn 段取宽高
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }

  // SVG：矢量没有固有像素尺寸，只认显式 width / height（读不到就跳过）
  const head = buf.toString("utf8", 0, Math.min(buf.length, 2000));
  if (head.includes("<svg")) {
    const width = head.match(/\bwidth\s*=\s*["']?(\d+(?:\.\d+)?)/i);
    const height = head.match(/\bheight\s*=\s*["']?(\d+(?:\.\d+)?)/i);
    if (width && height) return { width: Math.round(Number(width[1])), height: Math.round(Number(height[1])) };
  }

  return null;
}

beforeAll(async () => {
  const { definedFilters } = await import("@ptd/site/utils/filter.ts");
  filterNames = new Set(Object.keys(definedFilters));

  for (const path of Object.keys(schemaModules)) {
    const name = path.split("/").pop()!.replace(/\.ts$/, "");
    schemaNames.add(name);
  }

  for (const [path, loader] of Object.entries(schemaModules)) {
    const name = path.split("/").pop()!.replace(/\.ts$/, "");
    const mod = (await loader()) as any;
    const schemaMetadata = mod?.SchemaMetadata ?? mod?.default?.SchemaMetadata ?? {};
    schemaProvidesRows.set(name, !!(schemaMetadata as any)?.search?.selectors?.rows);
    if (typeof mod?.default === "function") schemaClasses.set(name, mod.default);
  }

  for (const [path, loader] of Object.entries(definitionModules)) {
    const mod = (await loader()) as any;
    definitions.push({
      fileId: path.split("/").pop()!.replace(/\.ts$/, ""),
      path,
      metadata: mod?.siteMetadata,
      hasDefaultClass: typeof mod?.default === "function",
      defaultClass: typeof mod?.default === "function" ? mod.default : undefined,
    });
  }
});

describe("站点点定义的跨定义静态不变量（TESTS-9）", () => {
  it("扫描不是空跑：341 个定义全部可加载，且 definedFilters 有内容", () => {
    expect(Object.keys(definitionModules).length).toBeGreaterThan(300);
    expect(definitions).toHaveLength(Object.keys(definitionModules).length);
    expect(filterNames.size).toBeGreaterThan(10);
    const withoutMetadata = definitions.filter((item) => !item.metadata?.id).map((item) => item.path);
    expect(withoutMetadata, "定义必须导出 siteMetadata.id").toEqual([]);
  });

  it("id 与文件名一致、符合 [0-9a-z]+ 且全局唯一", () => {
    const problems: string[] = [];
    const seen = new Map<string, string>();

    for (const { fileId, metadata } of definitions) {
      if (metadata.id !== fileId) problems.push(`${fileId}: id=${metadata.id} 与文件名不一致`);
      if (!/^[0-9a-z]+$/.test(metadata.id)) problems.push(`${fileId}: id=${metadata.id} 含非法字符`);
      const previous = seen.get(metadata.id);
      if (previous) problems.push(`${fileId}: id=${metadata.id} 与 ${previous} 重复`);
      seen.set(metadata.id, fileId);
    }

    expect(problems, "站点 id 必须唯一且与文件名一致").toEqual([]);
  });

  it("具名 filter 必须属于 definedFilters，且不使用 date-fns v4 已删除的时间 token", () => {
    const unknownFilters: string[] = [];
    const badDateTokens: string[] = [];
    let namedFilterCount = 0;

    for (const { metadata } of definitions) {
      for (const { id, query } of allQueries(metadata)) {
        for (const filter of namedFilters(query)) {
          namedFilterCount++;
          if (!filterNames.has(filter.name)) unknownFilters.push(`${id}: ${filter.name}`);

          for (const arg of filter.args ?? []) {
            if (typeof arg !== "string") continue;
            // date-fns v4 删除了 YYYY / YY / DD / D（大写 token），留着会让 parse 抛错或解析成别的日期
            if (/(^|[^a-zA-Z])(YYYY|YY|DD|D)([^a-zA-Z]|$)/.test(arg)) {
              badDateTokens.push(`${id}: ${filter.name}("${arg}")`);
            }
          }
        }
      }
    }

    // 自证：遍历必须真的走到大量具名 filter，否则上面两条断言是空跑
    expect(namedFilterCount, "没有扫到具名 filter，说明 queries 遍历坏了").toBeGreaterThan(500);
    expect(unknownFilters, "filter 名写错时筛选会静默失效").toEqual([]);
    expect(badDateTokens, "时间格式串里出现 date-fns v4 已删除的 token").toEqual([]);
  });

  it("category 分组的 key 唯一且小写，cross.key 不含 []（H-12 / D-4 / D-34）", () => {
    const duplicateKeys: string[] = [];
    const upperCaseKeys: string[] = [];
    const bracketedCrossKeys: string[] = [];
    let categoryGroupCount = 0;

    for (const { metadata } of definitions) {
      const keys = new Set<string>();
      for (const group of (metadata.category ?? []) as any[]) {
        categoryGroupCount++;
        if (keys.has(group.key)) duplicateKeys.push(`${metadata.id}: ${group.key}`);
        keys.add(group.key);

        if (/^[A-Z]/.test(group.key)) upperCaseKeys.push(`${metadata.id}: ${group.key}`);

        if (typeof group.cross === "object" && group.cross?.key && /[[\]]/.test(group.cross.key)) {
          bracketedCrossKeys.push(`${metadata.id}: ${group.key} -> cross.key="${group.cross.key}"`);
        }
      }
    }

    expect(categoryGroupCount, "没有扫到 category 分组，说明定义结构变了").toBeGreaterThan(100);
    expect(duplicateKeys).toEqual([]);
    expect(upperCaseKeys, "分组 key 大写会被 PHP 侧按区分大小写拒收，整条筛选静默失效").toEqual([]);
    expect(bracketedCrossKeys, "brackets 模式会自行补 []，cross.key 里多写一层会发出嵌套数组").toEqual([]);
  });

  it("search.selectors.rows 若定义则非空；urls 必须非空", () => {
    const emptyRows: string[] = [];
    const missingUrls: string[] = [];

    for (const { metadata } of definitions) {
      const selector = metadata.search?.selectors?.rows?.selector;
      if (selector !== undefined) {
        const isEmpty =
          (typeof selector === "string" && selector.trim() === "") ||
          (Array.isArray(selector) &&
            (selector.length === 0 ||
              selector.some((item: unknown) => typeof item === "string" && item.trim() === "")));
        if (isEmpty) emptyRows.push(metadata.id);
      }

      if (!Array.isArray(metadata.urls) || metadata.urls.length === 0) missingUrls.push(metadata.id);
    }

    expect(emptyRows).toEqual([]);
    expect(missingUrls).toEqual([]);
  });

  it("seeders 与 leechers 不能是同一个查询（D-8：复制粘贴后两个字段取到同一个数）", () => {
    const identicalQueries: string[] = [];

    for (const { metadata } of definitions) {
      const selectors = metadata.search?.selectors;
      if (!selectors?.seeders || !selectors?.leechers) continue;
      // 源站明确不提供该字段时约定写 text: "N/A"，两者同为 N/A 是合法的
      if (selectors.seeders.text === "N/A" && selectors.leechers.text === "N/A") continue;

      if (sameSignature(selectors.seeders, selectors.leechers)) {
        identicalQueries.push(metadata.id);
      }
    }

    expect(identicalQueries, "seeders / leechers 指向同一查询时下载者数会等于做种数").toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 2026-10-23 审查 H-M3 / H-L7 新增的跨定义不变量
  // -------------------------------------------------------------------------

  it("completed 不得与 seeders / leechers 同源（E2-01：bwtorrents 的完成数曾恒等于下载者数）", () => {
    const clashes: string[] = [];
    let compared = 0;

    for (const { metadata } of definitions) {
      const selectors = metadata.search?.selectors;
      if (!selectors?.completed?.selector) continue;

      for (const other of ["seeders", "leechers"] as const) {
        if (!selectors[other]?.selector) continue;
        compared++;
        // 完成数与下载者数是两个不同的量，不像 seeders/leechers 那样存在「源站都不提供」的 N/A 例外
        if (sameSignature(selectors.completed, selectors[other])) clashes.push(`${metadata.id}: completed == ${other}`);
      }
    }

    expect(compared, "没有扫到 completed 与 seeders/leechers 的字段对，说明遍历坏了").toBeGreaterThan(20);
    expect(clashes, "completed 与 seeders/leechers 指向同一列时「完成数」会变成下载者数").toEqual([]);
  });

  it("任意两个字段不得指向同一查询（字段对级不变量；同源字段会让两个指标变成同一个数）", () => {
    const duplicates: string[] = [];
    let compared = 0;

    for (const { metadata } of definitions) {
      const selectors = metadata.search?.selectors;
      if (!selectors) continue;

      for (let i = 0; i < metricFields.length; i++) {
        const left = selectors[metricFields[i]];
        if (!left?.selector) continue;
        for (let j = i + 1; j < metricFields.length; j++) {
          const right = selectors[metricFields[j]];
          if (!right?.selector) continue;
          // 源站明确不提供时约定写 text:"N/A"：两个字段同为 N/A 是合法的
          if (left.text === "N/A" && right.text === "N/A") continue;
          compared++;
          if (sameSignature(left, right)) duplicates.push(`${metadata.id}: ${metricFields[i]} == ${metricFields[j]}`);
        }
      }
    }

    expect(compared, "没有扫到字段对，说明遍历坏了").toBeGreaterThan(1000);

    // 棘轮：`0magnet` / `sexypics` 的 url / id 有意复用同一个 <a href>（id 只是「用链接当标识」）；
    // `damagnet` 的列表行本身就是磁力链接，url 与 link 指向同一个 <a href>（与 Jackett 定义一致）。
    // 这些都不是缺陷。除此之外不允许新增同源字段对；把缺陷修掉后请把上界一起下调。
    const knownSharedQueryPairs = new Set(["0magnet: url == id", "sexypics: url == id", "damagnet: url == link"]);
    const unexpected = duplicates.filter((item) => !knownSharedQueryPairs.has(item));
    if (duplicates.length) console.warn("[static] 已知的同源字段对：", duplicates);
    expect(unexpected, "两个字段指向同一个 (selector, attr, elementProcess) 时，两个指标必然显示同一个数").toEqual([]);
  });

  it("schema 必须存在于 schemas/，或定义自带 default class（G24：指向不存在的引擎会静默回落）", () => {
    const missing: string[] = [];

    for (const { metadata, hasDefaultClass } of definitions) {
      if (!metadata?.schema) continue; // 未声明时由 site/index.ts 按 type 补默认值
      if (schemaNames.has(metadata.schema)) continue;
      if (hasDefaultClass) continue; // 定义自带引擎类，等价于实现了该 schema

      missing.push(`${metadata.id}: ${metadata.schema}`);
    }

    // 棘轮：以下 6 个定义的 schema 指向未实现的引擎，`getSite` 会静默回落到 Abstract*Site
    // （定义层修复属 DEF 分片：实现 schemas/<name>.ts 或改 schema）。修好后请删掉对应条目。
    const knownMissingSchemas = new Set([
      "ccfbits: TBSource",
      "cnlang: Discuz",
      "fsm: FSM",
      "hdspace: XBTIT",
      "hdtorrents: XBTIT",
      "minept: meanTorrent",
    ]);
    const unexpected = missing.filter((item) => !knownMissingSchemas.has(item));
    if (missing.length) console.warn("[static] 已知的 schema 缺失：", missing);
    expect(unexpected, "schema 指向不存在的引擎时站点会悄悄改用 Abstract*Site，选择器/分页整体变样").toEqual([]);
  });

  it("rows 结构在 search / searchEntry / list 三处都合法，且 DOM 引擎必须能拿到 rows（M3）", () => {
    const structural: string[] = [];
    const unavailable: string[] = [];
    let rowsSpots = 0;

    const checkRows = (id: string, spot: string, rows: any) => {
      if (rows === undefined) return;
      rowsSpots++;
      const selector = rows?.selector;
      const isEmpty =
        selector === undefined ||
        (typeof selector === "string" && selector.trim() === "") ||
        (Array.isArray(selector) &&
          (selector.length === 0 || selector.some((item: unknown) => String(item ?? "").trim() === "")));
      if (isEmpty) structural.push(`${id} ${spot}: rows.selector 为空`);

      if (rows.merge !== undefined && !(Number.isInteger(rows.merge) && rows.merge >= 2)) {
        structural.push(`${id} ${spot}: rows.merge=${rows.merge}（应为 >=2 的整数，1 等于不合并）`);
      }
      if (rows.filter !== undefined && typeof rows.filter !== "function") {
        structural.push(`${id} ${spot}: rows.filter 不是函数`);
      }
    };

    for (const { fileId, metadata, hasDefaultClass } of definitions) {
      const searchRows = metadata?.search?.selectors?.rows;
      checkRows(fileId, "search", searchRows);

      for (const [entryId, entry] of Object.entries((metadata?.searchEntry ?? {}) as Record<string, any>)) {
        checkRows(fileId, `searchEntry.${entryId}`, entry?.selectors?.rows);
      }
      (metadata?.list ?? []).forEach((item: any, index: number) =>
        checkRows(fileId, `list[${index}]`, item?.selectors?.rows),
      );

      // 冒烟：声明了 search 却拿不到 rows 的 DOM 站点一定搜不到结果。
      // 例外：NexusPHP 在 transformSearchPage 里按表头自动生成 rows（见 defs-dom-search 用例）、
      //       GazelleJSONAPI 由类方法把 JSON 映射成行；定义自带引擎类的站点也可能自己实现 rows。
      if (!metadata?.search || searchRows || hasDefaultClass) continue;
      const schema =
        metadata.schema ?? (metadata.type === "private" ? "AbstractPrivateSite" : "AbstractBittorrentSite");
      if (!schemaNames.has(schema)) continue; // schema 不存在由上面那条用例负责
      if (ROWS_ENGINE_EXEMPT.has(schema)) continue;
      if (schemaProvidesRows.get(schema)) continue;
      unavailable.push(`${fileId}: schema=${schema} 不提供 rows，定义也没写 rows`);
    }

    expect(rowsSpots, "没有扫到任何 rows 配置，说明定义结构变了").toBeGreaterThan(50);
    expect(structural, "rows 配置结构非法会让整站搜索结果为空").toEqual([]);
    expect(unavailable, "DOM 引擎既不提供 rows、站点也没声明时，该站点永远解析不出种子").toEqual([]);
  });

  it("tags 每项都有 name 与非空 selector；timezoneOffset 必须是 ±HHmm", () => {
    const badTags: string[] = [];
    const badOffsets: string[] = [];
    let tagCount = 0;

    for (const { fileId, metadata } of definitions) {
      const tags = metadata?.search?.selectors?.tags;
      if (tags !== undefined) {
        if (!Array.isArray(tags)) {
          badTags.push(`${fileId}: tags 不是数组`);
        } else {
          tags.forEach((tag: any, index: number) => {
            tagCount++;
            if (!tag?.name) badTags.push(`${fileId} tags[${index}]: 缺 name`);
            if (typeof tag?.selector !== "string" || tag.selector.trim() === "") {
              badTags.push(`${fileId} tags[${index}]: selector 为空或不是字符串`);
            }
          });
        }
      }

      if (metadata?.timezoneOffset !== undefined && !/^[+-]\d{4}$/.test(String(metadata.timezoneOffset))) {
        badOffsets.push(`${fileId}: ${metadata.timezoneOffset}`);
      }
    }

    expect(tagCount, "没有扫到 tags，说明定义结构变了").toBeGreaterThan(200);
    expect(badTags).toEqual([]);
    expect(badOffsets, "timezoneOffset 格式错误会让 parseTime 静默回落成宿主时区").toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 上游 182140c2（vite/checkSiteDefinition.ts）中 fork 此前缺少的检查
  // -------------------------------------------------------------------------

  it("必填字段：version 是数字、name 非空、type 只能是 private / public；非模板类引擎 version > 0", () => {
    // types/site.ts 的 version 约定：模板类 -1，NexusPHP / Unit3D / Gazelle / GazelleJSONAPI / AvistazNetwork 为 0，
    // 其余站点必须 > 0。仓库现状多数写 1（保持站点内一致即可），这里只拦「非模板类却写了 <= 0」。
    const templateEngines = new Set([
      "AbstractBittorrentSite",
      "AbstractPrivateSite",
      "NexusPHP",
      "Unit3D",
      "Gazelle",
      "GazelleJSONAPI",
      "AvistazNetwork",
    ]);
    const problems: string[] = [];

    for (const { fileId, metadata } of definitions) {
      if (typeof metadata.version !== "number" || Number.isNaN(metadata.version)) {
        problems.push(`${fileId}: version=${String(metadata.version)} 不是数字`);
      }
      if (typeof metadata.name !== "string" || metadata.name.trim() === "") problems.push(`${fileId}: 缺少 name`);
      if (metadata.type !== "private" && metadata.type !== "public") {
        problems.push(`${fileId}: type=${String(metadata.type)} 只能是 "private" 或 "public"`);
      }

      const engine = metadata.schema ?? (metadata.type === "public" ? "AbstractBittorrentSite" : "AbstractPrivateSite");
      if (!templateEngines.has(engine) && typeof metadata.version === "number" && metadata.version <= 0) {
        problems.push(`${fileId}: schema=${engine} 不是模板类引擎，version=${metadata.version} 应 > 0`);
      }
    }

    expect(problems).toEqual([]);
  });

  it("urls / legacyUrls / trackerUrls 经 rot13 还原后都是 http(s) 地址，且 legacyUrls 不与 urls 重复", async () => {
    const { restoreSecureLink } = await import("@ptd/site/utils/html.ts");
    const isHttpUrl = (url: string) => /^https?:\/\/[^\s/]+/i.test(url);
    const problems: string[] = [];
    let urlCount = 0;

    for (const { fileId, metadata } of definitions) {
      const urls = (metadata.urls ?? []) as unknown[];
      urls.forEach((url, index) => {
        urlCount++;
        if (typeof url !== "string" || !isHttpUrl(restoreSecureLink(url))) {
          problems.push(`${fileId}: urls[${index}] = ${JSON.stringify(url)} 不是 http(s) 地址（rot13 还原后也不是）`);
        }
      });

      ((metadata.legacyUrls ?? []) as unknown[]).forEach((url, index) => {
        if (typeof url !== "string" || !isHttpUrl(restoreSecureLink(url))) {
          problems.push(`${fileId}: legacyUrls[${index}] = ${JSON.stringify(url)} 不是 http(s) 地址`);
        } else if (urls.includes(url)) {
          problems.push(`${fileId}: legacyUrls[${index}] 与 urls 重复：${url}`);
        }
      });

      // 上游 22573d1c：trackerUrls 与 urls 一样会被 restoreSecureLink 还原，坏值同样要拦下来。
      // 该字段由 0538dcf9（按 tracker 识别站点）引入，这里按可选字段读取
      (((metadata as any).trackerUrls ?? []) as unknown[]).forEach((url, index) => {
        if (typeof url !== "string" || !isHttpUrl(restoreSecureLink(url))) {
          problems.push(`${fileId}: trackerUrls[${index}] = ${JSON.stringify(url)} 不是 http(s) 地址`);
        }
      });
    }

    expect(urlCount, "没有扫到 urls，说明定义结构变了").toBeGreaterThan(300);
    expect(problems, "站点地址写错时 index.ts 还原出的地址无法请求").toEqual([]);
  });

  it("category 每组都有 name / key 与 options 数组；levelRequirements 的 id 唯一、严格递增且每级有 name", () => {
    const badCategories: string[] = [];
    const badLevels: string[] = [];
    let levelCount = 0;

    for (const { fileId, metadata } of definitions) {
      ((metadata.category ?? []) as any[]).forEach((group, index) => {
        if (typeof group?.key !== "string" || group.key === "") badCategories.push(`${fileId}[${index}]: 缺少 key`);
        if (typeof group?.name !== "string" || group.name === "") badCategories.push(`${fileId}[${index}]: 缺少 name`);
        if (!Array.isArray(group?.options)) badCategories.push(`${fileId}[${index}] ${group?.key}: 缺少 options 数组`);
      });

      const levels = (metadata.levelRequirements ?? []) as any[];
      const ids: number[] = [];
      levels.forEach((level, index) => {
        levelCount++;
        if (typeof level?.id !== "number") badLevels.push(`${fileId}[${index}]: id 不是数字`);
        else ids.push(level.id);
        if (!level?.name) badLevels.push(`${fileId}[${index}] id${level?.id}: 缺少 name`);
      });
      const duplicated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      if (duplicated.length) badLevels.push(`${fileId}: id 重复 ${duplicated.join(", ")}`);
      // utils/level.ts 按 id 大小比较等级高低（`level.id <= currentLevelId`、`levelRequirement.id > testLevel`），
      // 数组顺序与 id 顺序不一致时界面上的「下一等级」会错位，因此 id 必须严格递增
      for (let i = 1; i < ids.length; i++) {
        if (ids[i] <= ids[i - 1]) {
          badLevels.push(`${fileId}: id 非严格递增 ${ids[i - 1]} → ${ids[i]}（第 ${i} 项）`);
          break;
        }
      }
    }

    expect(levelCount, "没有扫到 levelRequirements，说明定义结构变了").toBeGreaterThan(500);
    expect(badCategories, "缺 key / options 的分类组在搜索方案界面里无法勾选").toEqual([]);
    expect(badLevels, "等级 id 重复或乱序时下一等级的计算会错位").toEqual([]);
  });

  it("default class 必须继承 schema 声明的引擎类（否则 schema 字段与实际行为不一致）", () => {
    const mismatched: string[] = [];
    let compared = 0;

    for (const { fileId, metadata, defaultClass } of definitions) {
      const schemaClass = metadata.schema ? schemaClasses.get(metadata.schema) : undefined;
      if (!defaultClass || !schemaClass) continue; // schema 不在 schemas/ 时由上面的 G24 用例负责
      compared++;
      if (defaultClass !== schemaClass && !(defaultClass.prototype instanceof schemaClass)) {
        mismatched.push(
          `${fileId}: schema=${metadata.schema}，default class 继承 ${Object.getPrototypeOf(defaultClass)?.name}`,
        );
      }
    }

    expect(compared, "没有扫到带 default class 的定义，说明遍历坏了").toBeGreaterThan(50);
    expect(mismatched).toEqual([]);
  });

  it("TPatterns 字段里的字符串字面量都能编译为正则（按源码扫描 definitions 与 schemas）", () => {
    // 自证：数组第二项的坏正则也要能扫到（上游修过的 forEachChild 早停问题）
    const synthetic = checkPatternLiterals(
      "synthetic.ts",
      `export const x = { list: [{ urlPattern: ["/ok", "/bad(", /re/] }], noLoginAssert: { urlPatterns: ["["] } };`,
    );
    expect(synthetic.count).toBe(3);
    expect(synthetic.errors).toEqual([expect.stringContaining('"/bad("'), expect.stringContaining('"["')]);

    const errors: string[] = [];
    let count = 0;
    for (const dir of ["src/packages/site/definitions", "src/packages/site/schemas"]) {
      for (const file of fs.readdirSync(path.join(repoRoot, dir)).filter((name) => name.endsWith(".ts"))) {
        const relPath = `${dir}/${file}`;
        const result = checkPatternLiterals(relPath, fs.readFileSync(path.join(repoRoot, relPath), "utf8"));
        count += result.count;
        errors.push(...result.errors);
      }
    }

    expect(count, "没有扫到 pattern 字面量，说明遍历坏了").toBeGreaterThan(200);
    expect(errors, "pattern 写坏时内容脚本里 new RegExp 会抛 SyntaxError，整页列表解析一起失败").toEqual([]);
  });

  it("源码里所有 filters / switchFilters 的具名过滤器都存在于 definedFilters（含 metadata 之外的位置）", () => {
    // 自证：数组项、switchFilters 的分支、单对象写法、satisfies 包装都要扫到；函数与非字面量名字跳过
    const synthetic = checkFilterNameLiterals(
      "synthetic.ts",
      `const a = { filters: [{ name: "parseSize" }, (q) => q, { name: "divide", args: [24] }] };
       const b = { switchFilters: { "td": [{ name: "parseTime" }], "th": [{ name: "parseValidTimeString" }] } };
       const c = { filters: { name: "nope" } satisfies object, other: { filters: [{ name: dynamicName }] } };`,
      filterNames,
    );
    expect(synthetic.count).toBe(6);
    expect(synthetic.errors).toEqual([
      expect.stringContaining('"divide"'),
      expect.stringContaining('"parseValidTimeString"'),
      expect.stringContaining('"nope"'),
    ]);

    const errors: string[] = [];
    let count = 0;
    for (const dir of ["src/packages/site/definitions", "src/packages/site/schemas"]) {
      for (const file of fs.readdirSync(path.join(repoRoot, dir)).filter((name) => name.endsWith(".ts"))) {
        const relPath = `${dir}/${file}`;
        const result = checkFilterNameLiterals(
          relPath,
          fs.readFileSync(path.join(repoRoot, relPath), "utf8"),
          filterNames,
        );
        count += result.count;
        errors.push(...result.errors);
      }
    }

    expect(count, "没有扫到具名过滤器，说明遍历坏了").toBeGreaterThan(1000);
    expect(errors, "过滤器名写错时 runQueryFilters 会静默跳过，只给出错值（broadcasthenet 曾因此偏高 24 倍）").toEqual(
      [],
    );
  });

  it("成人站点（tags 含 成人 / xxx / adult）的地址必须写成 rot13，文件其它位置也不得出现本站明文域名", async () => {
    // 自证：明文字面量里属于本站域名的要报（含 www. 与端口归一），urls 本身的值与其它域名不报
    expect(
      findPlainOwnHostLiterals(
        "synthetic.ts",
        `const a = { urls: ["https://adult.example/"], Origin: "https://www.adult.example:8443/x", b: "https://other.example/" };`,
        new Set(["adult.example"]),
        new Set(["https://adult.example/"]),
      ),
    ).toEqual(["https://www.adult.example:8443/x"]);

    const { restoreSecureLink } = await import("@ptd/site/utils/html.ts");
    const problems: string[] = [];
    const adultSites: string[] = [];

    for (const { fileId, metadata } of definitions) {
      const tags = metadata.tags as unknown;
      if (!Array.isArray(tags) || !tags.some((tag) => typeof tag === "string" && ADULT_TAG_PATTERN.test(tag))) {
        continue;
      }
      adultSites.push(fileId);

      const ownHosts = new Set<string>();
      const fieldLiterals = new Set<string>();
      for (const field of SECURE_URL_FIELDS) {
        (((metadata as any)[field] ?? []) as unknown[]).forEach((url, index) => {
          if (typeof url !== "string") return;
          fieldLiterals.add(url);
          const host = urlHost(restoreSecureLink(url));
          if (host) ownHosts.add(host);
          if (/^https?:\/\//i.test(url)) problems.push(`${fileId}: ${field}[${index}] 是明文地址`);
        });
      }

      // §7.1：只有 urls / legacyUrls / trackerUrls 会被 rot13 还原，favicon / Origin / Referer /
      // 绝对 requestConfig.url 这类字段必须改用 this.url 派生、本地图标，或者省略
      const relPath = `src/packages/site/definitions/${fileId}.ts`;
      const text = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
      for (const literal of new Set(findPlainOwnHostLiterals(relPath, text, ownHosts, fieldLiterals))) {
        problems.push(`${fileId}: ${literal}`);
      }
    }

    // 自证：大小写与三种写法都要认（pornbits 用 "Adult"、pussytorrents 用 "XXX"）
    expect(adultSites).toEqual(expect.arrayContaining(["pornbits", "pussytorrents", "ehentai"]));
    expect(adultSites.length, "没有扫到成人站点，说明 tags 结构变了").toBeGreaterThan(30);

    // 已知条目：上游 22573d1c 已修好这两个站点（0dayfiles 改 rot13 并去掉明文 favicon，pussytorrents 用
    // restoreSecureLink 派生 Origin / Referer），lane-b 移植该提交后这里应为空 —— lane-b 集成后删除。
    const knownPlainAdultUrls = new Set([
      "0dayfiles: urls[0] 是明文地址",
      "0dayfiles: https://0dayfiles.net/favicon.ico",
      "pussytorrents: https://pussytorrents.org",
      "pussytorrents: https://pussytorrents.org/user/account/snatchlist",
      "pussytorrents: https://pussytorrents.org/user/account/uploadedtorrents",
    ]);
    const unexpected = problems.filter((item) => !knownPlainAdultUrls.has(item));
    if (problems.length) console.warn("[static] 已知的成人站点明文地址：", problems);
    expect(unexpected, "成人站点的地址必须写成 rot13（types/base.ts 的 TSiteUrl），其它字段不得出现明文域名").toEqual(
      [],
    );
  });

  it("favicon：显式 ./x 引用的本地文件必须存在；本地图标不超过 256x256（[ratchet]）；远端地址只提示", () => {
    const iconsDir = path.join(repoRoot, ICONS_DIR);
    const icons = new Set(fs.readdirSync(iconsDir));

    // 自证：尺寸解析对 PNG / ICO 都要有结果，且与文件头一致
    const pngSample = [...icons].find((name) => name.endsWith(".png"))!;
    const pngBuf = fs.readFileSync(path.join(iconsDir, pngSample));
    expect(readImageSize(pngBuf)).toEqual({ width: pngBuf.readUInt32BE(16), height: pngBuf.readUInt32BE(20) });
    const icoSample = [...icons].find((name) => name.endsWith(".ico"))!;
    expect(readImageSize(fs.readFileSync(path.join(iconsDir, icoSample)))).not.toBeNull();

    const missing: string[] = [];
    const oversize: string[] = [];
    const remote: string[] = [];
    let checkedIcons = 0;

    for (const { fileId, metadata } of definitions) {
      const favicon = metadata.favicon as unknown;

      if (typeof favicon === "string") {
        if (/^https?:\/\//i.test(favicon)) remote.push(`${fileId}: ${favicon}`);
        else if (favicon.startsWith("data:image/")) remote.push(`${fileId}: 内联 data URI`);
        // favicon.ts 会静默跳过不存在的本地文件，最终回落到运行时抓取
        else if (favicon.startsWith("./") && !icons.has(favicon.slice(2))) missing.push(`${fileId}: ${favicon}`);
      }

      // 真正会命中的那一个（favicon.ts 按顺序取第一个存在于包内的文件）
      const hit = localIconCandidates(fileId, favicon).find((name) => icons.has(name));
      if (!hit) continue;
      const size = readImageSize(fs.readFileSync(path.join(iconsDir, hit)));
      if (!size) continue; // 识别不出格式时跳过，与上游一致
      checkedIcons++;
      if (size.width > MAX_LOCAL_ICON_DIM || size.height > MAX_LOCAL_ICON_DIM) {
        oversize.push(`${hit} ${size.width}x${size.height}`);
      }
    }

    expect(checkedIcons, "没有解析到本地图标尺寸，说明遍历或解析坏了").toBeGreaterThan(200);
    expect(missing, "favicon 指向的本地文件不存在时会静默回落到运行时抓取").toEqual([]);

    // 上游只把远端 / data URI 的 favicon 作为提示：本地资产优先，且不受站点改版、防盗链、CF 拦截影响
    if (remote.length) console.warn("[static] favicon 使用远端地址或 data URI，建议落成本地资产：", remote);

    // [ratchet] 已知超限图标：上游 0f300197 已把它们压到 128x128，lane-b 移植该提交后应为空 —— lane-b 集成后删除。
    const knownOversizeIcons = new Set([
      "fsm.jpg 640x640",
      "homiehelpdesk.png 512x512",
      "rastastugan.png 500x500",
      "tlzdigital.png 512x512",
      "ydypt.jpg 320x320",
    ]);
    const unexpected = oversize.filter((item) => !knownOversizeIcons.has(item));
    if (oversize.length) console.warn("[static] 已知的超限本地图标：", oversize);
    expect(unexpected, "站点图标只显示 14~36px，超过 256x256 说明资产没压缩，会让扩展包体积变大").toEqual([]);
  });

  it("requestConfig 里的 $field$ 占位符必须出现在 assertion 声明的 pathKey 处（占位符名对、路径写错）", () => {
    /**
     * 继上一条只校验「占位符名出现在 assertion key 里」之后，这里补路径级不变量：
     * `AbstractPrivateSite.getUserInfoResult` 的替换逻辑是「对 assertion[field] 指向的字符串做
     * `String.replace("$field$", 值)`」，所以只声明 key 不够 —— pathKey 必须正好是占位符所在的那个字符串，
     * 否则占位符会原样发到站点（旧 torrentleech 的 `assertion: {id:"valid"}` + `data.userID:"$id$"` 就是这种）。
     *
     * 自证：先用一条合成的 torrentleech 型坏配置断言 helper 能抓到它，避免「遍历坏了但全绿」。
     */
    const synthetic = findMisplacedPlaceholderPaths([
      { requestConfig: { url: "/profile/$name$", data: { userID: "$id$" } }, assertion: { id: "valid", name: "url" } },
    ]);
    expect(synthetic.compared).toBe(2);
    expect(synthetic.misplaced).toEqual([expect.stringContaining("data.userID")]);

    const misplaced: string[] = [];
    let compared = 0;

    for (const { fileId, metadata } of definitions) {
      const result = findMisplacedPlaceholderPaths((metadata?.userInfo?.process ?? []) as any[]);
      compared += result.compared;
      misplaced.push(...result.misplaced.map((item) => `${fileId} ${item}`));
    }

    expect(compared, "没有扫到 assertion 覆盖的占位符，说明 userInfo 结构变了").toBeGreaterThan(10);

    // 白名单：当前无已知合法例外；若后续确有「占位符通过 requestConfigTransformer 自行替换」等合法形态，
    // 在此登记 `fileId process[n]: ...` 完整字符串并注明原因与验证方法（不要放宽成按站点全放过）。
    const knownLegitPlaceholderPaths = new Set<string>([]);
    const unexpected = misplaced.filter((item) => !knownLegitPlaceholderPaths.has(item));
    if (misplaced.length) console.warn("[static] 占位符路径与 assertion 不一致：", misplaced);
    expect(unexpected, "占位符不在 assertion 指向的 pathKey 处时不会被替换，会原样发到站点").toEqual([]);
  });

  it("requestConfig 里的 $field$ 占位符必须由该步骤的 assertion 声明", () => {
    const undeclared: string[] = [];
    let placeholderCount = 0;

    for (const { fileId, metadata } of definitions) {
      for (const [index, step] of ((metadata?.userInfo?.process ?? []) as any[]).entries()) {
        const assertionKeys = new Set(Object.keys((step?.assertion ?? {}) as Record<string, unknown>));
        for (const match of JSON.stringify(step?.requestConfig ?? {}).matchAll(/\$([A-Za-z0-9_]+)\$/g)) {
          placeholderCount++;
          if (!assertionKeys.has(match[1])) {
            undeclared.push(`${fileId} process[${index}]: $${match[1]}$ 未在 assertion 中声明`);
          }
        }
      }
    }

    expect(placeholderCount, "没有扫到 $field$ 占位符，说明 userInfo 结构变了").toBeGreaterThan(10);
    expect(undeclared, "未声明的占位符会被原样发到站点，等于请求参数写错").toEqual([]);
  });

  it("[ratchet] assertion 声明的路径若已在 requestConfig 里，就必须真的用到 $field$", () => {
    const staticPaths: string[] = [];

    for (const { fileId, metadata } of definitions) {
      for (const [index, step] of ((metadata?.userInfo?.process ?? []) as any[]).entries()) {
        for (const [field, pathKey] of Object.entries((step?.assertion ?? {}) as Record<string, string>)) {
          const value = get(step.requestConfig ?? {}, pathKey);
          if (typeof value === "string" && !value.includes(`$${field}$`)) {
            staticPaths.push(
              `${fileId} process[${index}]: assertion.${field} -> ${pathKey} = ${JSON.stringify(value)}`,
            );
          }
        }
      }
    }

    // E6 遗留（定义层修复属 DEF 分片）：teamhd / wihd 声明了 assertion 但路径是静态串，
    // 断言「依赖 id/name」实际没有进入请求。修好后请把上界下调到 0 并改成 toEqual([])。
    if (staticPaths.length) console.warn("[static] assertion 静态路径：", staticPaths);
    expect(staticPaths.length, "assertion 声明了依赖但请求里没用到，属于静默失效").toBeLessThanOrEqual(2);
  });

  it("[ratchet] 等级阶梯倒挂只允许当前已知的少量条目（含插在阶梯中间的特殊等级）", () => {
    // 注意：这里刻意不做硬断言 —— darkpeers 的 Seeder(3)/SuperUser(4) 这类「特殊等级插在普通阶梯中间」
    // 会让做种量门槛有意回退，不能简单判成缺陷。先用数量棘轮防止新增，具体站点语义交 DEF 组/产品裁决。
    const inversions: string[] = [];

    for (const { fileId, metadata } of definitions) {
      const userLevels = ((metadata?.levelRequirements ?? []) as any[]).filter(
        (level) => (level.groupType ?? "user") === "user",
      );
      for (const field of ["uploaded", "downloaded", "ratio", "seedingSize"] as const) {
        const values = userLevels
          .filter((level) => level[field] !== undefined)
          .map((level) => ({ id: level.id, value: Number(level[field] instanceof Object ? 0 : level[field]) }));
        for (let i = 1; i < values.length; i++) {
          if (values[i].value < values[i - 1].value) {
            inversions.push(`${fileId}: ${field} id${values[i - 1].id} > id${values[i].id}`);
          }
        }
      }
    }

    if (inversions.length) console.warn("[static] 等级阶梯倒挂：", inversions);
    // 当前已知 6 处（均为 ratio，DEF 组正在逐站确认）；留 2 个余量避免并行修复期间误红。
    expect(inversions.length, "等级阶梯倒挂数量增加，可能把高等级用户判低").toBeLessThanOrEqual(8);
  });
});
