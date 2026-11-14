/**
 * 共享 URL 脱敏工具（L-7 / OS-1 / A4）单元测试。
 *
 * 覆盖公开 API `redactSensitiveUrls`：
 * - 文本中多个 URL 与普通文本混排；
 * - URL 的 userinfo、query 值、fragment 中的 `k=v`、路径里的凭据段；
 * - 已编码字符、无凭据文本不被改写；
 * - 2026-10-23 复检修复的 fragment 脱敏行为（`#access_token=…`）；
 * - offscreen 旧路径的 re-export 指向同一实现。
 */
import { describe, expect, it } from "vitest";

import * as legacyRedact from "@/offscreen/utils/redact.ts";
import * as sharedRedact from "@/shared/redact.ts";

const { redactSensitiveUrls } = sharedRedact;

describe("redactSensitiveUrls：文本与多个 URL", () => {
  it("多个 URL 与普通文本混排时逐个脱敏，其余文本保持不变", () => {
    const input =
      "first https://a.example/dl?token=t1 then https://b.example/dl?passkey=p2 and relative /api/download?key=k3 end";

    expect(redactSensitiveUrls(input)).toBe(
      "first https://a.example/dl?token=*** then https://b.example/dl?passkey=*** and relative /api/download?key=*** end",
    );
  });

  it("保留 query 键名与分隔符，只替换值", () => {
    expect(redactSensitiveUrls("https://site.example/dl?a=1&token=SECRET&empty=&flag")).toBe(
      "https://site.example/dl?a=***&token=***&empty=***&flag",
    );
  });

  it("保留 URL 后的自然语言标点", () => {
    expect(redactSensitiveUrls("see https://site.example/a?token=SECRET, then continue.")).toBe(
      "see https://site.example/a?token=***, then continue.",
    );
  });

  it("站内相对路径形式的下载链接同样脱敏", () => {
    expect(redactSensitiveUrls("/api/torrent/download1?token=8f3c1d9e")).toBe("/api/torrent/download1?token=***");
  });
});

describe("redactSensitiveUrls：userinfo", () => {
  it("抹掉 userinfo 凭据但保留 host、端口与 path", () => {
    expect(redactSensitiveUrls("https://alice:s3cr3t@dav.example.com/backup/file.zip")).toBe(
      "https://***@dav.example.com/backup/file.zip",
    );
    expect(redactSensitiveUrls("http://user:p%40ss@qbit.example.com:8080/api/v2/auth/login")).toBe(
      "http://***@qbit.example.com:8080/api/v2/auth/login",
    );
  });

  it("path 里普通的 @ 不被误当成 userinfo", () => {
    expect(redactSensitiveUrls("https://site.example/user/@name/profile?id=1")).toBe(
      "https://site.example/user/@name/profile?id=***",
    );
  });
});

describe("redactSensitiveUrls：fragment", () => {
  it("fragment 中的 k=v 值被替换，键名保留（锁住 fragment 未脱敏的修复）", () => {
    const result = redactSensitiveUrls("https://site.example/cb#access_token=s3cr3t&token_type=bearer");

    expect(result).toBe("https://site.example/cb#access_token=***&token_type=***");
    expect(result).not.toContain("s3cr3t");
    expect(result).not.toContain("bearer");
  });

  it("query 与 fragment 同时存在时两边都脱敏", () => {
    expect(redactSensitiveUrls("https://site.example/cb?code=abc#access_token=xyz")).toBe(
      "https://site.example/cb?code=***#access_token=***",
    );
  });

  it("不含 = 的 fragment 保持原样", () => {
    expect(redactSensitiveUrls("https://site.example/page#section-2")).toBe("https://site.example/page#section-2");
    expect(redactSensitiveUrls("https://site.example/path#frag=a&novalue")).toBe(
      "https://site.example/path#frag=***&novalue",
    );
  });
});

describe("redactSensitiveUrls：路径凭据段", () => {
  it("脱敏 ≥20 位、含字母和数字的路径段（Rartracker 形态）", () => {
    const input = "https://r.example/api/v1/torrents/download/123/0a1b2c3d4e5f60718293a4b5c6d7e8f9";

    expect(redactSensitiveUrls(input)).toBe("https://r.example/api/v1/torrents/download/123/***");
    expect(redactSensitiveUrls(input)).not.toContain("0a1b2c3d4e5f60718293a4b5c6d7e8f9");
  });

  it("数字 id、普通单词、带扩展名的文件名不被误伤", () => {
    const input = "https://nyaa.example/download/1234567.torrent and /torrents/download/98765432101234567890";

    expect(redactSensitiveUrls(input)).toBe(input);
  });
});

describe("redactSensitiveUrls：编码字符与无凭据文本", () => {
  it("已编码的 query 值同样被整体替换", () => {
    expect(redactSensitiveUrls("https://site.example/dl?token=abc%2Fdef%3D&x=a%40b")).toBe(
      "https://site.example/dl?token=***&x=***",
    );
  });

  it("无凭据的纯文本与 URL 保持原样", () => {
    const inputs = [
      "plain text without any url",
      "https://pt.site/download.php",
      "https://site.example/page#section-2",
      "path only: /downloads/files/example.torrent",
    ];

    for (const input of inputs) {
      expect(redactSensitiveUrls(input)).toBe(input);
    }
  });
});

describe("offscreen 旧路径 re-export", () => {
  it("与 shared 实现是同一个函数，行为一致", () => {
    expect(legacyRedact.redactSensitiveUrls).toBe(sharedRedact.redactSensitiveUrls);
    expect(legacyRedact.redactSensitiveUrls("/dl?token=SECRET")).toBe("/dl?token=***");
  });
});
