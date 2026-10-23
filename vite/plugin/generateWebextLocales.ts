import fs from "node:fs";
import path from "node:path";

import type { Plugin } from "vite";

export interface IGenerateWebextLocalesResult {
  generated: string[];
  removed: string[];
  /** 清理掉的原子写临时文件（`*.tmp-*`）；构建中断的残留会随 `public/` 被拷进发布包（task-12） */
  cleaned: string[];
}

/** 原子写临时文件名特征（`messages.json.tmp-<pid>`） */
const TEMPORARY_ARTIFACT_MARKER = ".tmp-";

/**
 * 清理 `public/_locales` 下（含各语言子目录）上次构建中断留下的临时文件。
 *
 * `public/` 会被 Vite 原样复制进 `dist-*`，残留的 `messages.json.tmp-<pid>` 会跟着进发布包；
 * 旧实现只在成功 `renameSync` 后让临时文件消失，Ctrl-C / 磁盘写满时会永久残留（task-12）。
 */
function removeTemporaryArtifacts(publicLocalesDir: string): string[] {
  const cleaned: string[] = [];
  for (const entry of fs.readdirSync(publicLocalesDir, { withFileTypes: true })) {
    const fullPath = path.join(publicLocalesDir, entry.name);
    if (entry.isDirectory()) {
      for (const fileName of fs.readdirSync(fullPath)) {
        if (!fileName.includes(TEMPORARY_ARTIFACT_MARKER)) continue;
        const artifact = path.join(fullPath, fileName);
        fs.rmSync(artifact, { force: true });
        cleaned.push(artifact);
      }
    } else if (entry.isFile() && entry.name.includes(TEMPORARY_ARTIFACT_MARKER)) {
      fs.rmSync(fullPath, { force: true });
      cleaned.push(fullPath);
    }
  }
  return cleaned;
}

/**
 * 由 `src/locales/*.json#manifest` 生成浏览器扩展的 `public/_locales/<locale>/messages.json`。
 *
 * 缺陷清单 G17 修复了旧实现的三个副作用问题：
 * 1. **先删后写**：旧版在 `buildStart` 里先 `rmSync(整个 _locales 目录)` 再逐个语言写文件 ——
 *    构建被 Ctrl-C / 磁盘写满打断时，工作区会留下**缺失 key 的半成品**，下一次 `vite dev`
 *    直接把它当输入用（`pack-crx` 只拦 default_locale）。现在改成：先把所有语言包完整解析到
 *    内存（解析失败在**写盘之前**抛错），再逐文件「写临时文件 + rename」原子替换，最后才清理
 *    已经没有源文件的语言目录 —— 任何时刻磁盘上的 `messages.json` 都是完整的一份。
 * 2. **用 `process.cwd()` 定位**：从子目录或 `vite --config` 运行时会把 `src/locales` 读错、
 *    把 `public/_locales` 清错位置。现在由 `configResolved` 提供 `config.root`（与 `vite.config.ts`
 *    自己用 `base_path(import.meta.dirname)` 的口径一致）；`root` 参数也让这段逻辑可以被单测直接调用。
 * 3. **总是重写工作区**：仍然在 dev/build 都生成（`_locales` 是 gitignore 的构建输入，dev 也需要它，
 *    否则全新克隆 `npm run dev` 直接加载失败），但不再做「整目录预删」，且写入是幂等/原子的。
 */
export function generateWebextLocales(root: string): IGenerateWebextLocalesResult {
  const localesDir = path.resolve(root, "src/locales");
  const publicLocalesDir = path.resolve(root, "public/_locales");
  const localeFiles = fs.readdirSync(localesDir).filter((file) => file.endsWith(".json"));

  // 1) 全部解析到内存：任何语言包缺 manifest / JSON 非法都在写盘之前失败
  const outputs: Array<{ localeName: string; content: string }> = [];
  for (const file of localeFiles) {
    const localeName = path.basename(file, ".json");
    const fileContent = fs.readFileSync(path.join(localesDir, file), "utf8");
    let jsonData: any;
    try {
      jsonData = JSON.parse(fileContent);
    } catch (error) {
      // INFRA-2：解析失败必须让构建失败，否则会产出「manifest 有 __MSG_*__ 但没有 messages.json」的包
      console.error(`Error processing ${file}:`, error);
      throw error;
    }

    const manifest = jsonData.manifest;
    if (!manifest) {
      // INFRA-2：原先只 console.warn 后 return，于是 manifest.json 里引用的 `__MSG_extName__`
      // 没有对应的 messages.json，包能打出来但装到浏览器才失败（pack-crx 也会误报「自校验通过」）。
      throw new Error(`No manifest field found in ${file}.`);
    }

    const messages: Record<string, any> = {};
    for (const [key, value] of Object.entries(manifest)) {
      messages[key] = { message: value };
    }
    outputs.push({ localeName, content: JSON.stringify(messages, null, 2) });
  }

  // 2) 逐文件原子写：先写 .tmp 再 rename，构建中断不会留下半份文件
  //    task-12：写盘前先清掉上次中断留下的 `*.tmp-*`（否则它们会被 public/ 原样拷进 dist-*）
  fs.mkdirSync(publicLocalesDir, { recursive: true });
  const cleaned = removeTemporaryArtifacts(publicLocalesDir);
  const generated: string[] = [];
  for (const output of outputs) {
    const localeOutputDir = path.join(publicLocalesDir, output.localeName);
    fs.mkdirSync(localeOutputDir, { recursive: true });
    const target = path.join(localeOutputDir, "messages.json");
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, output.content);
    fs.renameSync(tmp, target);
    generated.push(target);
  }
  // 成功路径再清一次：确保本次运行没有留下自己的临时文件（正常应为空）
  cleaned.push(...removeTemporaryArtifacts(publicLocalesDir));

  // 3) 成功写入之后再清理「已经没有源语言包」的旧目录（放在最后，避免中断时丢文件）
  const liveLocaleNames = new Set(outputs.map((output) => output.localeName));
  const removed: string[] = [];
  for (const entry of fs.readdirSync(publicLocalesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || liveLocaleNames.has(entry.name)) {
      continue;
    }
    const staleDir = path.join(publicLocalesDir, entry.name);
    fs.rmSync(staleDir, { recursive: true, force: true });
    removed.push(staleDir);
  }

  return { generated, removed, cleaned };
}

export function vitePluginGenerateWebextLocales(): Plugin {
  let configRoot = process.cwd();
  return {
    name: "vite-plugin-generate-webext-locales",
    configResolved(config) {
      // 用 Vite 解析后的 root，而不是 process.cwd()：`vite --config` / 从子目录调用时两者不同（G17）
      configRoot = config.root;
    },
    buildStart() {
      for (const file of generateWebextLocales(configRoot).generated) {
        console.log(`Generated ${file}`);
      }
    },
  };
}
