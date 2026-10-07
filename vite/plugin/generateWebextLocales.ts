import fs from "node:fs";
import path from "node:path";

export function vitePluginGenerateWebextLocales() {
  return {
    name: "vite-plugin-generate-webext-locales",
    buildStart() {
      const localesDir = path.resolve(process.cwd(), "src/locales");
      const publicLocalesDir = path.resolve(process.cwd(), "public/_locales");

      // 生成前先清理目标目录：否则删除某个语言后，旧目录会一直残留在 public/ 中并被继续拷贝进 dist
      fs.rmSync(publicLocalesDir, { recursive: true, force: true });

      const localeFiles = fs.readdirSync(localesDir).filter((file) => file.endsWith(".json"));

      localeFiles.forEach((file) => {
        const localeName = path.basename(file, ".json");
        const localeFilePath = path.join(localesDir, file);
        const localeOutputDir = path.join(publicLocalesDir, localeName);

        try {
          // 读取 json 文件内容
          const fileContent = fs.readFileSync(localeFilePath, "utf8");
          const jsonData = JSON.parse(fileContent);

          // 提取 manifest 字段
          const manifest = jsonData.manifest;
          if (!manifest) {
            // INFRA-2：原先只 console.warn 后 return，于是 manifest.json 里引用的 `__MSG_extName__`
            // 没有对应的 messages.json，包能打出来但装到浏览器才失败（pack-crx 也会误报「自校验通过」）。
            // 构建期直接抛错，失败点离原因最近。
            throw new Error(`No manifest field found in ${file}.`);
          }

          // 生成 messages.json 文件内容
          const messages: Record<string, any> = {};
          for (const [key, value] of Object.entries(manifest)) {
            messages[key] = {
              message: value,
            };
          }

          // 创建 public/_locales/<name> 目录
          if (!fs.existsSync(localeOutputDir)) {
            fs.mkdirSync(localeOutputDir, { recursive: true });
          }

          // 写入 messages.json 文件
          const outputFilePath = path.join(localeOutputDir, "messages.json");
          fs.writeFileSync(outputFilePath, JSON.stringify(messages, null, 2));
          console.log(`Generated ${outputFilePath}`);
        } catch (error) {
          // INFRA-2：解析失败也必须让构建失败，否则会产出「manifest 有 __MSG_*__ 但没有 messages.json」的包
          console.error(`Error processing ${file}:`, error);
          throw error;
        }
      });
    },
  };
}
