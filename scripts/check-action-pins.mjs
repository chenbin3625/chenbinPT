/**
 * 校验 GitHub Actions 的 `uses:` 是否都固定在不可变的 commit SHA 上（供应链加固，见审查报告 Q-4）。
 *
 * 背景：这些 workflow 持有商店发布密钥（`secrets.CHROME_SELF_SIGN_CRX_PRIVATE_KEY` 等）。
 * 把 action pin 在**可变 tag / 分支**（`actions/checkout@v7`、`cardinalby/...@v1`）时，
 * 上游一旦移动或劫持该 ref，下一次发布就会在我们持钥的环境里执行别人的代码。
 *
 * 规则：
 * - `uses: owner/repo[/path]@<ref>`：`<ref>` 必须是 40 位小写十六进制（commit SHA，可带 `# vX` 注释）；
 * - `uses: ./.github/workflows/x.yml`（本地复用 workflow）与 `docker://` 例外，不做要求。
 *
 * 用法：
 *   node scripts/check-action-pins.mjs            # 校验，失败 exit 1
 *   node scripts/check-action-pins.mjs --list     # 只列出解析结果，便于人工核对
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = resolve(repoRoot, ".github/workflows");
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** @returns {{file: string, line: number, source: string, ref: string|null, ok: boolean, reason?: string}[]} */
function collectUses() {
  const results = [];

  for (const name of readdirSync(workflowsDir).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))) {
    const lines = readFileSync(resolve(workflowsDir, name), "utf8").split("\n");

    lines.forEach((raw, index) => {
      // 只认真实的 `uses:` 键（允许 `- uses:` 形式的 step），忽略注释行
      const matched = raw.match(/^\s*(?:-\s*)?uses:\s*(\S+)\s*(?:#.*)?$/);
      if (!matched) return;

      const source = matched[1];
      const line = index + 1;
      const base = { file: `.github/workflows/${name}`, line, source };

      if (source.startsWith("./") || source.startsWith("docker://")) {
        results.push({ ...base, ref: null, ok: true, reason: "本地 / docker ref，免检" });
        return;
      }

      const at = source.lastIndexOf("@");
      if (at === -1) {
        results.push({ ...base, ref: null, ok: false, reason: "缺少 @<ref>" });
        return;
      }

      const ref = source.slice(at + 1);
      results.push({
        ...base,
        ref,
        ok: COMMIT_SHA.test(ref),
        reason: COMMIT_SHA.test(ref) ? "已固定" : "ref 不是 40 位 commit SHA（可变 ref）",
      });
    });
  }

  return results;
}

const uses = collectUses();
const failures = uses.filter((item) => !item.ok);

if (process.argv.includes("--list") || failures.length > 0) {
  for (const item of uses) {
    const mark = item.ok ? "OK  " : "FAIL";
    console.log(`${mark} ${item.file}:${item.line}  ${item.source}  (${item.reason})`);
  }
}

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} 个 action 未固定在 commit SHA 上（Q-4 供应链加固要求）。`);
  console.error("解析命令：curl -s https://api.github.com/repos/<owner>/<repo>/git/ref/tags/<tag>");
  console.error("（若 object.type 为 tag 是 annotated tag，需再取 .../git/tags/<sha> 并取其 object.sha）");
  process.exit(1);
}

console.log(`\n✅ 所有 ${uses.length} 处 uses 均已固定（或属于免检的本地 workflow / docker ref）。`);
