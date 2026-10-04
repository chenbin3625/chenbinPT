/**
 * Conventional Commits 提交信息校验
 *
 * 为什么加：本仓库的提交信息一直遵循 `<type>(<scope>): <subject>` 风格（近 300 条里 97% 符合），
 * 这是 GitHub Releases 自动生成变更说明、以及后续任何 changelog 工具的前提。
 * 但没有强制手段时，一旦有人写成 `fix:xxx`（缺空格）或随手写一句话，工具链就会静默降级。
 *
 * 规则取舍（对齐仓库现有习惯，而不是照搬默认值）：
 * - `type-enum` 额外允许 `deps` / `core`：发布准备流程里有 `deps: bump version`、
 *   `core: bump min browser version` 这类既有用法。
 * - `header-max-length` 放宽到 130：中文 subject 一字一"字符"，实测历史最长 125，
 *   默认的 100 会误伤正常的详细描述。
 * - 关闭 `subject-case`：中文 subject 不受大小写规则约束，保留默认值只会在
 *   「中英混排 + 拉丁缩写」时产生噪声。
 * - 关闭 body/footer 的行长限制：中文换行位置无法用 100 列约束表达。
 *
 * 校验范围只针对**新提交**（由 .husky/commit-msg 在提交时调用），历史提交不参与。
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "build",
        "chore",
        "ci",
        "core",
        "deps",
        "docs",
        "feat",
        "fix",
        "perf",
        "refactor",
        "revert",
        "style",
        "test",
      ],
    ],
    "header-max-length": [2, "always", 130],
    "subject-case": [0],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    "body-leading-blank": [2, "always"],
    "footer-leading-blank": [2, "always"],
  },
};
