/**
 * 性能修复的"不变量"守卫（见 docs/performance-audit.md）。
 *
 * 为什么需要静态断言：本轮的多数修复（storage 读缓存、路径读写、写入合并、
 * 节流持久化、并发队列…）都依赖 chrome API / 浏览器环境，无法在单测里做行为验证；
 * 而它们又很容易在后续重构（尤其是大规模批量改写）中被"顺手改回"更直观但更慢的写法。
 * 这里锁住这些修复的**形态**，一旦被改回就在 `npm test` 里直接失败并指出是哪一条。
 *
 * ⚠️ 写这类不变量的纪律（Q-3 教训）：只锁「调用了哪个 API / 保留了哪个结构」，
 * **不要锁参数的具体写法**。本轮的实证：P0-3 原本写成
 * `mustMatch: /applyMinimalPatch\(changes\[key\]\.newValue\)/`，另一个代理在重构
 * `webExtPersistence.ts` 时只是先把 `changes[key].newValue` 存进一个局部变量（行为完全等价），
 * 这条不变量就变红，最后被迫回退成字面量写法 —— 文本不变量拦住了等价重构。
 *
 * 因此：**当一个行为已经被 tests/ 里的行为用例覆盖时，不要再为它加形态断言**；
 * 形态断言只用于「没有可用的行为验证手段」的那部分（chrome API / 构建期常量 / 依赖图）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), "utf8");
}

type Invariant = { id: string; description: string; file: string; mustMatch?: RegExp; mustNotMatch?: RegExp };

const invariants: Invariant[] = [
  {
    id: "P1-1",
    description: "messages.ts 不再对每个消息体做 JSON 深拷贝，改用 toSerializable 解代理",
    file: "src/entries/messages.ts",
    mustMatch: /toSerializable\(data\)/,
    mustNotMatch: /JSON\.parse\(JSON\.stringify\(data\)\)/,
  },
  {
    id: "P0-1",
    description: "runtime store 不再声明 persist（避免插件 deep+sync 全量序列化）",
    file: "src/entries/options/stores/runtime.ts",
    mustMatch: /function schedulePersist/,
    mustNotMatch: /\n\s*persist:\s*\{/,
  },
  {
    id: "P0-1",
    description: "pinia.ts 挂载 runtime store 的节流持久化",
    file: "src/entries/options/plugins/pinia.ts",
    mustMatch: /setupRuntimeStorePersistence\(useRuntimeStore\(piniaInstance\)\)/,
  },
  {
    id: "P0-2",
    description: "service worker 保留 chrome.storage 读缓存",
    file: "src/entries/background/utils/base.ts",
    mustMatch: /storageReadCache/,
  },
  {
    id: "P0-2",
    description: "提供 getExtStoragePath（避免整份大对象跨上下文传输）",
    file: "src/entries/background/utils/base.ts",
    mustMatch: /onMessage\("getExtStoragePath"/,
  },
  {
    id: "P0-2",
    description: "patchExtStoragePath 走串行写队列（避免读改写竞态）",
    file: "src/entries/background/utils/base.ts",
    mustMatch: /onMessage\("patchExtStoragePath"[\s\S]{0,200}patchExtStoragePathLocal/,
  },
  {
    id: "P0-3",
    description: "userInfo 刷新不再整份回写 metadata，改用路径写",
    file: "src/entries/offscreen/utils/userInfo.ts",
    mustMatch: /patchExtStoragePath/,
    mustNotMatch: /sendMessage\("setExtStorage",\s*\{\s*key:\s*"metadata"/,
  },
  {
    // 这里**刻意只锁"调用了 applyMinimalPatch 而不是整店 $patch"这个结构**，
    // 不锁参数表达式：行为本身（外部删除/新增/孙级字段递归删除/回声抑制）已由
    // tests/extends/pinia/webExtPersistenceDeletionAndEcho.test.ts 的 12 个用例行为验证，
    // 形态断言只作为"别把最小 patch 改回整店替换"的快速护栏。
    // 详情见文件头「写这类不变量的纪律」。
    id: "P0-3",
    description: "webExtPersistence 的 onChanged 使用最小字段 patch 而非整店 $patch",
    file: "src/extends/pinia/webExtPersistence.ts",
    mustMatch: /applyMinimalPatch\(/,
  },
  {
    id: "P1-5",
    description: "webExtPersistence 的 $save 采用单飞 + 尾部合并写",
    file: "src/extends/pinia/webExtPersistence.ts",
    mustMatch: /function flushQueued/,
  },
  {
    id: "P0-3",
    description: "webExtPersistence 保留自身写入回声抑制窗口（否则每次 $save 都会触发整棵子树 patch）",
    file: "src/extends/pinia/webExtPersistence.ts",
    mustMatch: /SELF_WRITE_ECHO_WINDOW[\s\S]{0,400}Date\.now\(\) < selfWriteUntil/,
  },
  {
    id: "P1-2",
    description: "logger 不再用 useSessionStorage（deep watch 全量重序列化），改为环形缓冲 + 节流落盘",
    file: "src/entries/offscreen/utils/logger.ts",
    mustMatch: /scheduleFlush/,
    mustNotMatch: /(?:import[^;\n]*useSessionStorage|useSessionStorage\s*[<(])/,
  },
  {
    id: "P1-3",
    description: "content script 引导不再整份读取 metadata/userInfo",
    file: "src/entries/content-script/index.ts",
    mustNotMatch: /sendMessage\("getExtStorage",\s*"metadata"\)/,
  },
  {
    id: "P2-17",
    description: "content script 优先读 siteIndex 小 key",
    file: "src/entries/content-script/index.ts",
    mustMatch: /key:\s*"siteIndex"/,
  },
  {
    id: "P1-22",
    description: "下载任务经并发队列执行",
    file: "src/entries/offscreen/utils/download.ts",
    mustMatch: /downloadQueue\.add\(\(\) => downloadTorrent\(/,
  },
  {
    id: "P1-22",
    description: "下载链路不再整份读取 config（改 config.download 子表）",
    file: "src/entries/offscreen/utils/download.ts",
    mustNotMatch: /sendMessage\("getExtStorage",\s*"config"\)/,
  },
  {
    id: "P1-9",
    description: "DNR 规则按 URL+method+headers 复用",
    file: "src/extends/axios/replaceUnsafeHeader.ts",
    mustMatch: /dnrRuleCache/,
  },
  {
    id: "P1-9",
    description: "webRequest 热路径不再每请求发 logger 消息",
    file: "src/entries/background/utils/webRequest.ts",
    mustNotMatch: /sendMessage\("logger"/,
  },
  {
    id: "P2-1",
    description: "downloader 根入口不再静态转发 getRemoteTorrentFile（避免把 utils 拖进 cs-app 依赖图）",
    file: "src/packages/downloader/index.ts",
    mustNotMatch: /export\s*\{\s*getRemoteTorrentFile\s*\}/,
  },
  {
    id: "P2-1",
    description: "downloader/utils.ts 不再依赖 urlencode（iconv-lite 308KB）",
    file: "src/packages/downloader/utils.ts",
    mustNotMatch: /from\s*"urlencode"/,
  },
  {
    id: "P2-20",
    description: "locales 生成前清理残留目录",
    file: "vite/plugin/generateWebextLocales.ts",
    mustMatch: /rmSync/,
  },
  {
    id: "correctness",
    description: "Vite 浏览器构建保留 path polyfill（parse-torrent 会调用 path.join）",
    file: "vite.config.ts",
    mustMatch: /include:\s*\[[^\]]*"buffer"[^\]]*"path"[^\]]*\]/,
  },
  {
    id: "correctness",
    description: "Firefox 构建使用独立体积预算（background script 与 Chrome service worker 产物不同）",
    file: "scripts/check-bundle-budget.mjs",
    mustMatch: /firefox:\s*\{[\s\S]*"largest-js-chunk"/,
  },
];

describe("性能修复不变量（防止后续重构改回慢实现）", () => {
  for (const invariant of invariants) {
    it(`[${invariant.id}] ${invariant.description}`, () => {
      const content = read(invariant.file);

      if (invariant.mustMatch) {
        expect(content, `${invariant.file} 应匹配 ${invariant.mustMatch}`).toMatch(invariant.mustMatch);
      }
      if (invariant.mustNotMatch) {
        expect(content, `${invariant.file} 不应再匹配 ${invariant.mustNotMatch}`).not.toMatch(invariant.mustNotMatch);
      }
    });
  }

  /**
   * P0-3 的**作用域版**不变量：只看 `onChanged` 的函数体。
   *
   * 为什么不放进上面的表：表里的正则是"整个文件"级别的，而 `store.$patch(` 在本文件里
   * 有合法的其它用法（备份恢复、落盘前合并），全文件否定会误报。
   * 这里把断言限定在 onChanged 体内 —— 依然不锁参数写法，因此
   * `const newValue = changes[key].newValue; applyMinimalPatch(newValue);` 这类等价重构不会变红。
   */
  it("[P0-3] webExtPersistence 的 onChanged 只做最小字段 patch，不整店 $patch", () => {
    const source = read("src/extends/pinia/webExtPersistence.ts");
    const body = source.match(/function onChanged\([\s\S]*?\n {2}\}/)?.[0];

    expect(body, "应能定位到 onChanged 函数体").toBeTruthy();
    expect(body!, "外部变更必须走最小字段 patch").toMatch(/applyMinimalPatch\(/);
    expect(body!, "外部变更不得整店 $patch（会重建整棵子树的响应式对象）").not.toMatch(/\$patch\(/);
  });

  /**
   * 顺带守住一类"类型检查看不见"的运行时缺陷：旧版全局类型声明曾把 `Sizzle` 暴露为全局变量，
   * 因此即使某文件没有 import 它，`npm run check` 也不会报错，但运行时每一行解析都会抛
   * ReferenceError（uhdbits / azusa 就踩过）。
   *
   * 说明：选择器层替换完成后，`src/**` 里已不存在 `Sizzle(...)` 调用（改用自研
   * `~packages/site/utils/selector`），本用例作为「不得再引入未 import 的全局选择器调用」
   * 的守卫继续保留；解析实现见 tests/packages/site/utils/selector.test.ts。
   */
  it("[correctness] 语法定义里使用 Sizzle 的文件必须真的 import 它", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const raw = readFileSync(full, "utf8");
          // 去掉块注释与行注释后再扫描，避免把文档注释里的 "Sizzle(...)" 误判为使用
          const content = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
          const usesSizzleAsCall = /(?<![.\w])Sizzle\s*\(/.test(content);
          const importedSizzle = /^\s*import\s+Sizzle\b/m.test(raw);
          if (usesSizzleAsCall && !importedSizzle) {
            offenders.push(full.replace(`${repoRoot}/`, ""));
          }
        }
      }
    };
    walk(resolve(repoRoot, "src"));

    expect(offenders).toEqual([]);
  });
});
