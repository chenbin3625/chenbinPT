import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, type AliasOptions, type Plugin, type ResolvedConfig } from "vite";

/**
 * 生成结果（站点 id → 索引条目）。
 *
 * 这里**故意不 import `src/**` 的类型**：`vite/**` 属于 `tsconfig.node.json` 这个 composite
 * project（`npm run check:node`），一旦从它 import `src` 里的模块，整个 `src/packages/site`
 * 文件图都会被拉进该 project 并触发一串 TS6307（"File ... is not listed within the file list"）。
 * 抽取逻辑因此改成在**嵌套构建的入口文件里**调用（那里走的是完整 Vite 构建，`src` 侧的
 * `pickSiteMetadataIndexEntry()` 才是唯一出处）；本插件只负责把结果 JSON 序列化，不需要知道
 * 条目的字段结构 —— 消费方拿到的类型由 `src/vite-env.d.ts` 的 `virtual:site-metadata-index`
 * 声明保证。
 */
type TGeneratedSiteMetadataIndex = Record<string, Record<string, unknown>>;

/**
 * 构建期生成「站点定义轻量索引」，以虚拟模块 `virtual:site-metadata-index` 暴露给 app。
 *
 * 移植自上游 `8c6022c98c`（#1611），主体逻辑与上游一致，差异有四处（wxt 适配）：
 *  1. 生成结果用**模块级** memo（`generatedIndexBySourceHash`）缓存：一次 `wxt build` 会跑多个
 *     Vite 构建（background / content scripts / html entries），`vite: (env) => ({ plugins: [...] })`
 *     返回的插件在每个子构建里都会被重新实例化，插件工厂闭包里的 memo 挡不住重复生成；
 *  2. 缓存目录 / 中转目录总是 `path.join(config.root, "node_modules/.cache/ptd-depiler/…")`：
 *     产物要在 Node 里求值，而站点定义链会用 `axios` / `date-fns` / `es-toolkit` 等**外部依赖**，
 *     只有放在项目内 `node_modules` 下才能被 Node 解析到（写到 `/tmp` 会解析失败）；
 *  3. `collectSourceFiles()` 把 fork 的 barrel（`src/packages/site/utils.ts`）与
 *     `src/packages/site/index.ts`（`getDefinedSiteMetadata` 口径）也纳入 hash：fork 的
 *     `index.ts` 与 `utils.ts` 各有一层聚合/默认值补全（如 `tags ??= []`），改了它们同样要重新生成，
 *     否则缓存会复用旧索引；
 *  4. 抽取（`pickSiteMetadataIndexEntry`）的调用点从本插件挪到**生成的入口文件**里：fork 的
 *     `vite/**` 属于 composite project（`npm run check:node`），插件直接 import `src/**`
 *     会把整张站点定义文件图拉进该 project 并触发 TS6307（详见上方 TGeneratedSiteMetadataIndex
 *     的说明）。行为不变 —— 入口文件同样由 Vite 打包 `src` 侧的真实模块。
 *
 * ## 为什么需要它
 *
 * 站点定义被 `import.meta.glob` 拆成一个个独立 chunk，全仓有十几处（Topbar 的 isDead、
 * MyData 的 type/aka、SetSearchSolution 的 isDead/name/urls、AddDialog / 一键导入的整张列表……）
 * 只为了读固定属性就把完整定义拉起来解析。
 *
 * ## 为什么值不会漂移
 *
 * 生成时用 Vite 的 SSR 构建把**真正的** `src/packages/site/index.ts` 打成一个包
 * （`import.meta.glob` 由 Vite 展开），在 Node 里配合一份最小 DOM 打桩求值，然后对每个 id
 * 调 `getDefinedSiteMetadata()` —— 也就是 app 自己走的那条路（含 `restoreSecureLink`
 * 还原 rot13、`tags ??= []`、`timezoneOffset` 补全），再交给 `pickSiteMetadataIndexEntry()`
 * 抽取字段。所以「索引里有什么」只有一处定义。
 *
 * ## 成本
 *
 * 一次生成实测约 2~5 s（Vite 打包 + 求值），因此：
 * - 只在真的有人 import 这个虚拟模块时才生成（`load()` 里惰性触发，没用到就不花钱）；
 * - 进程内 memo，一次构建的多个子构建只生成一次；
 * - 结果按「definitions + schemas + 抽取逻辑 + 聚合层」的 sha256 缓存到
 *   `node_modules/.cache/ptd-depiler/`，命中就直接复用（dev 重启、连续构建都不再重算）。
 */
const VIRTUAL_MODULE_ID = "virtual:site-metadata-index";
const RESOLVED_VIRTUAL_MODULE_ID = "\0" + VIRTUAL_MODULE_ID;

/** 索引格式版本：改了字段集或抽取口径就 +1，用来让磁盘缓存失效 */
const INDEX_FORMAT_VERSION = 1;

const SITE_PACKAGE_DIR = path.join("src", "packages", "site");
const CACHE_DIR = path.join("node_modules", ".cache", "ptd-depiler");
const CACHE_FILE = path.join(CACHE_DIR, "site-metadata-index.json");
const BUILD_WORK_DIR = path.join(CACHE_DIR, "site-metadata-index-build");

/**
 * 嵌套构建必须的 `define`：站点定义链会用到 `__BROWSER__`（`definitions/hdsky.ts` 的
 * 选择器按浏览器分支）与 `__RESOURCE_SITE_ICONS__`（`utils/favicon.ts`）。
 * 正常情况下主构建（wxt）已经提供，这里只作为兜底 —— 单测/工具直接调用本插件时
 * （如 `vitest.config.ts`）没有这些常量，缺了会在求值期 ReferenceError。
 */
const FALLBACK_DEFINE: Record<string, string> = {
  __BROWSER__: JSON.stringify("chrome"),
  __EXT_VERSION__: JSON.stringify("v0.0.0-index-gen"),
  __GIT_VERSION__: JSON.stringify({ short: "site-index-gen", long: "", date: 0, count: 0, branch: "" }),
  __BUILD_TIME__: JSON.stringify(0),
  __RESOURCE_SITE_ICONS__: JSON.stringify([]),
  global: "globalThis",
};

/** 索引只依赖这些源码，任何一个变了都必须重新生成 */
function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const subDir of ["definitions", "schemas"]) {
    const dir = path.join(root, SITE_PACKAGE_DIR, subDir);
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".ts")) files.push(path.join(dir, name));
    }
  }
  // 抽取逻辑本身也参与 hash，否则「改了字段集但缓存没失效」。
  // 类型文件也一起算进来：给 ISiteMetadataIndexEntry 加字段却忘了动抽取函数时，
  // 缓存的旧索引会缺字段，而消费方只会静默拿到 undefined。
  files.push(path.join(root, SITE_PACKAGE_DIR, "utils", "metadataIndex.ts"));
  files.push(path.join(root, SITE_PACKAGE_DIR, "utils", "helper.ts"));
  files.push(path.join(root, SITE_PACKAGE_DIR, "types", "metadataIndex.ts"));
  // fork 额外依赖：barrel 与 getDefinedSiteMetadata 的补全口径都在 index.ts / utils.ts 里，
  // 它们变了同样会影响索引内容（例如给所有站点补默认 description）
  files.push(path.join(root, SITE_PACKAGE_DIR, "utils.ts"));
  files.push(path.join(root, SITE_PACKAGE_DIR, "index.ts"));
  return files.sort();
}

function computeSourceHash(root: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(`v${INDEX_FORMAT_VERSION}`);
  for (const file of collectSourceFiles(root)) {
    hash.update(path.relative(root, file).replace(/\\/g, "/"));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * 一份最小 DOM 打桩。
 *
 * 站点定义链路上有依赖在**模块顶层**就摸 DOM（例如 `AbstractBittorrentSite` 引入的选择器工具），
 * 而生成器跑在 Node 里。桩必须「看起来像 document」，否则会在求值期直接抛。
 *
 * ⚠️ 只补 Node 上**不存在**的键，并在用完立刻删掉：Vite 自己也在同一个进程里跑，
 * 不能让 `window` / `document` 在整个构建期间一直存在 —— 有些库靠
 * `typeof window !== "undefined"` 选分支，留着会把构建带偏。
 */
function installBrowserStubs(): () => void {
  const noop = () => {};
  const createElement = (tag = "div") => {
    const node: Record<string, unknown> = {
      nodeType: 1,
      nodeName: tag.toUpperCase(),
      tagName: tag.toUpperCase(),
      style: {},
      dataset: {},
      attributes: {},
      childNodes: [],
      parentNode: null,
      innerHTML: "",
      setAttribute: noop,
      removeAttribute: noop,
      getAttribute: () => null,
      hasAttribute: () => false,
      appendChild: (child: Record<string, unknown>) => (child.parentNode = node),
      removeChild: noop,
      insertBefore: noop,
      cloneNode: () => createElement(tag),
      compareDocumentPosition: () => 0,
      contains: () => false,
      getElementsByTagName: () => [],
      getElementsByClassName: () => [],
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
      removeEventListener: noop,
      matches: () => false,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    };
    return node;
  };

  const htmlElement = createElement("html");
  const documentStub: Record<string, unknown> = {
    ...createElement("#document"),
    nodeType: 9,
    documentElement: htmlElement,
    head: htmlElement,
    body: createElement("body"),
    createElement,
    createElementNS: (_ns: string, tag: string) => createElement(tag),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text, parentNode: null }),
    createDocumentFragment: () => createElement("#fragment"),
    getElementsByTagName: () => [],
  };
  documentStub.implementation = { createHTMLDocument: () => documentStub };

  const addedKeys: string[] = [];
  const stub = (key: string, value: unknown) => {
    if (key in globalThis) return; // navigator 之类 Node 自带的就别动
    addedKeys.push(key);
    (globalThis as Record<string, unknown>)[key] = value;
  };

  stub("window", globalThis);
  stub("self", globalThis);
  stub("document", documentStub);
  stub("location", {
    href: "chrome-extension://site-index-gen/index.html",
    origin: "chrome-extension://site-index-gen",
  });
  stub("localStorage", { getItem: () => null, setItem: noop, removeItem: noop });
  stub("matchMedia", () => ({ matches: false, addEventListener: noop, removeEventListener: noop }));

  return () => {
    for (const key of addedKeys) delete (globalThis as Record<string, unknown>)[key];
  };
}

/** 生成索引时需要从主构建复用/兜底的信息（wxt 从 configResolved 拿，单测可直接传） */
export interface IGenerateSiteIndexContext {
  root: string;
  mode: string;
  define: Record<string, any>;
  alias: AliasOptions | undefined;
}

/**
 * 用 Vite 的 SSR 构建把整个 `@ptd/site`（含全部站点定义）打成一个包，写到中转目录后
 * 在 Node 里求值，逐个抽出轻量索引。
 */
export async function generateSiteMetadataIndex(
  context: IGenerateSiteIndexContext,
): Promise<TGeneratedSiteMetadataIndex> {
  const { root } = context;
  const workDir = path.join(root, BUILD_WORK_DIR);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  // 这个入口交给 Vite 打包；`import.meta.glob` 由 Vite 展开，所以走的是 app 相同的那条路
  const entryFile = path.join(workDir, "entry.ts");
  const toModuleSpecifier = (file: string) => JSON.stringify(file.replace(/\\/g, "/"));
  const siteIndexPath = path.join(root, SITE_PACKAGE_DIR, "index.ts");
  const metadataIndexPath = path.join(root, SITE_PACKAGE_DIR, "utils", "metadataIndex.ts");
  fs.writeFileSync(
    entryFile,
    `import { definitionList, getDefinedSiteMetadata } from ${toModuleSpecifier(siteIndexPath)};
import { pickSiteMetadataIndexEntry } from ${toModuleSpecifier(metadataIndexPath)};

export async function buildAllSiteMetadataIndex() {
  const index = {};
  for (const siteId of definitionList) {
    index[siteId] = pickSiteMetadataIndexEntry(await getDefinedSiteMetadata(siteId));
  }
  return index;
}
`,
    "utf8",
  );

  // 复用主构建的 alias / define，避免两处各写一份而漂移。
  // configFile: false 保证不会把本插件再加载一遍（否则递归）。
  const buildOutput = await build({
    configFile: false,
    root,
    mode: context.mode,
    logLevel: "error",
    publicDir: false,
    define: { ...FALLBACK_DEFINE, ...context.define },
    resolve: { alias: context.alias },
    build: {
      ssr: true,
      write: false,
      minify: false,
      target: "esnext",
      emptyOutDir: false,
      rollupOptions: {
        input: entryFile,
        output: { format: "es", entryFileNames: "entry.mjs", chunkFileNames: "chunks/[name]-[hash].mjs" },
      },
    },
  });

  // write: false ⇒ 不会是 RollupWatcher；Vite 的返回类型是三者的联合，这里收窄一下
  const bundle = (Array.isArray(buildOutput) ? buildOutput[0] : buildOutput) as Extract<
    Awaited<ReturnType<typeof build>>,
    { output: unknown }
  >;
  for (const output of bundle.output) {
    const dest = path.join(workDir, output.fileName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, output.type === "chunk" ? output.code : output.source);
  }

  const restoreStubs = installBrowserStubs();
  try {
    const entryModule = (await import(pathToFileURL(path.join(workDir, "entry.mjs")).href)) as {
      buildAllSiteMetadataIndex: () => Promise<TGeneratedSiteMetadataIndex>;
    };
    // 抽取（pickSiteMetadataIndexEntry）已经在生成的入口里做完 —— 与 app 走完全同一条路
    return await entryModule.buildAllSiteMetadataIndex();
  } finally {
    restoreStubs();
  }
}

function readCachedIndex(cacheFile: string, sourceHash: string): TGeneratedSiteMetadataIndex | undefined {
  if (!fs.existsSync(cacheFile)) return undefined;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    return cached?.sourceHash === sourceHash ? (cached.index as TGeneratedSiteMetadataIndex) : undefined;
  } catch {
    return undefined; // 缓存坏了就按未命中处理，重新生成即可
  }
}

/**
 * 跨「插件实例 / 子构建」的生成 memo：key 是源码 hash。
 *
 * wxt 会把同一份 `vite()` 返回的插件分别塞进 background / content-script / html 等多个
 * Vite 构建里（每个构建各自 `configResolved`），插件工厂闭包里的 promise 只对单个实例有效，
 * 所以 memo 必须放在模块作用域。
 */
const generatedIndexBySourceHash = new Map<string, Promise<TGeneratedSiteMetadataIndex>>();

export interface IVitePluginGenerateSiteIndexOptions {
  /**
   * 直接指定 root / define / alias，跳过 `configResolved`。
   *
   * 给「不在 wxt 里、但也要解析虚拟模块」的消费者用（`vitest.config.ts`）：
   * 那里的 root 仍是项目根，但 define 里没有 `__BROWSER__` 这些构建期常量。
   */
  context?: Partial<IGenerateSiteIndexContext>;
}

export function vitePluginGenerateSiteIndex(options: IVitePluginGenerateSiteIndexOptions = {}): Plugin {
  let config: ResolvedConfig;

  const resolveContext = (): IGenerateSiteIndexContext => ({
    root: options.context?.root ?? config.root,
    mode: options.context?.mode ?? config.mode,
    define: { ...options.context?.define, ...config.define },
    alias: options.context?.alias ?? config.resolve.alias,
  });

  const loadIndex = (): Promise<TGeneratedSiteMetadataIndex> => {
    const context = resolveContext();
    const sourceHash = computeSourceHash(context.root);

    let promise = generatedIndexBySourceHash.get(sourceHash);
    if (!promise) {
      promise = (async () => {
        const cacheFile = path.join(context.root, CACHE_FILE);

        const cached = readCachedIndex(cacheFile, sourceHash);
        if (cached) return cached;

        const index = await generateSiteMetadataIndex(context);
        try {
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
          fs.writeFileSync(cacheFile, JSON.stringify({ sourceHash, index }));
        } catch (error) {
          config?.logger?.warn(`[site-metadata-index] 索引缓存写入失败（不影响本次使用）：${String(error)}`);
        }
        return index;
      })();

      // 生成失败不要把 rejected 的 promise 永久留在 memo 里：修好源码后同进程重跑仍能重试
      const current = promise;
      current.catch(() => {
        if (generatedIndexBySourceHash.get(sourceHash) === current) {
          generatedIndexBySourceHash.delete(sourceHash);
        }
      });
      generatedIndexBySourceHash.set(sourceHash, current);
    }

    return promise;
  };

  return {
    name: "vite-plugin-generate-site-index",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) return RESOLVED_VIRTUAL_MODULE_ID;
      return undefined;
    },

    async load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) return undefined;

      let index: TGeneratedSiteMetadataIndex;
      try {
        index = await loadIndex();
      } catch (error) {
        // 生成失败要让构建红掉，而不是悄悄给一个空索引
        throw new Error(`[site-metadata-index] 站点轻量索引生成失败：${String(error)}`, { cause: error });
      }

      return `export const siteMetadataIndex = ${JSON.stringify(index)};`;
    },

    // dev 下改了站点定义 / schema 要让索引重新生成，否则一直用旧的
    configureServer(server) {
      const root = options.context?.root ?? config.root;
      const watchedDirs = ["definitions", "schemas"].map((subDir) => path.join(root, SITE_PACKAGE_DIR, subDir));
      server.watcher.add(watchedDirs);

      const onSourceFileChanged = (file: string) => {
        if (!watchedDirs.some((dir) => file.startsWith(dir))) return;
        generatedIndexBySourceHash.clear();
        const module = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE_ID);
        if (module) server.moduleGraph.invalidateModule(module);
      };

      server.watcher.on("add", onSourceFileChanged);
      server.watcher.on("change", onSourceFileChanged);
      server.watcher.on("unlink", onSourceFileChanged);
    },
  };
}
