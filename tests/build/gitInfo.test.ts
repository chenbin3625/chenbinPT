/**
 * vite/gitInfo.ts：构建期 git 信息（替代 git-rev-sync，移植自上游 3ff6550a）。
 *
 * 断言与原 git-rev-sync 的取值口径一致（count = `rev-list --all --count`、short = 长 hash 前 7 位、
 * 分离头指针时 branch 形如 `Detached: <hash>`），以及取不到 git 时不抛错、退化为占位值（G19）。
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// @ts-expect-error TS6305：vite/** 属于 tsconfig.node 的 composite project，主项目引用其源文件时要求先构建。
// 方案 B（把测试并入 tsconfig.node.json 的 include）实测会让该 directive 在 check:node 里变成 TS2578 unused，故保留行级豁免（task-12）。
import { getGitInfo } from "../../vite/gitInfo.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
  GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
};

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

describe("getGitInfo", () => {
  let repo: string;
  let plain: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ptd-gitinfo-repo-"));
    plain = mkdtempSync(join(tmpdir(), "ptd-gitinfo-plain-"));
    git(repo, "init -q -b main");
    for (const name of ["a", "b"]) {
      writeFileSync(join(repo, name), name);
      git(repo, `add ${name}`);
      git(repo, `commit -q -m ${name}`);
    }
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("在 git 仓库里取到与 git CLI 一致的值", () => {
    const long = git(repo, "rev-parse HEAD");
    expect(getGitInfo(repo)).toEqual({
      count: 2,
      short: long.substring(0, 7),
      long,
      date: Date.parse("2026-01-02T03:04:05Z"),
      branch: "main",
    });
  });

  it("分离头指针时 branch 为 `Detached: <hash>`（与 git-rev-sync 一致）", () => {
    const first = git(repo, "rev-parse HEAD~1");
    git(repo, `checkout -q --detach ${first}`);
    try {
      expect(getGitInfo(repo).branch).toBe(`Detached: ${first}`);
    } finally {
      git(repo, "checkout -q main");
    }
  });

  it("没有 .git 时不抛错，退化为占位值（G19）", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GITHUB_SHA", "");
    vi.stubEnv("GITHUB_REF_NAME", "");
    try {
      expect(getGitInfo(plain)).toEqual({ count: 0, short: "unknown", long: "unknown", date: 0, branch: "unknown" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("没有 .git 但有 CI 环境变量时用 GITHUB_SHA / GITHUB_REF_NAME", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GITHUB_SHA", "0123456789abcdef0123456789abcdef01234567");
    vi.stubEnv("GITHUB_REF_NAME", "release");
    try {
      expect(getGitInfo(plain)).toMatchObject({
        short: "0123456",
        long: "0123456789abcdef0123456789abcdef01234567",
        branch: "release",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
