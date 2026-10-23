/**
 * 可信主机判定（跨范围协调：同源收紧不得成为功能回归）。
 *
 * 关键回归场景（DEF4 实测）：M-Team 的 web 域是 `kp.m-team.cc`、API 域是兄弟主机
 * `api.m-team.cc`；只允许「声明主机的子域」时，API 请求会被 `prepareRequestConfig`
 * 判为 untrusted。这里用公共 helper 固定语义：声明主机（含 API 子域/显式追加的兄弟主机）
 * 必须放行，其它主机拒绝。
 */
import { describe, expect, it } from "vitest";

import {
  buildTrustedHostnames,
  collectDeclaredRequestHostnames,
  isHostTrusted,
  normalizeSiteHost,
  parseHostname,
  siteHostMatches,
} from "@ptd/site/utils/trustedHost.ts";

describe("站点主机归一化与匹配", () => {
  it("normalizeSiteHost 去 www、小写", () => {
    expect(normalizeSiteHost("WWW.Example.COM")).toBe("example.com");
    expect(normalizeSiteHost(" Kp.M-Team.CC ")).toBe("kp.m-team.cc");
    expect(normalizeSiteHost("")).toBe("");
  });

  it("parseHostname 支持绝对地址与 ROT13 加密的 urls", () => {
    expect(parseHostname("https://kp.m-team.cc/")).toBe("kp.m-team.cc");
    expect(parseHostname("//api.m-team.cc/x")).toBeUndefined();
    expect(parseHostname("uggcf://xc.z-grnz.pp/")).toBe("kp.m-team.cc");
    expect(parseHostname("not-a-url")).toBeUndefined();
    expect(parseHostname(undefined)).toBeUndefined();
  });

  it("全等或子域放行，兄弟/相似域名不放行", () => {
    expect(siteHostMatches("pt.example.com", "pt.example.com")).toBe(true);
    expect(siteHostMatches("api.pt.example.com", "pt.example.com")).toBe(true);
    expect(siteHostMatches("www.pt.example.com", "pt.example.com")).toBe(true);
    // 兄弟主机（mteam 形态）不属于子域关系：必须显式声明
    expect(siteHostMatches("api.m-team.cc", "kp.m-team.cc")).toBe(false);
    // 后缀拼接攻击
    expect(siteHostMatches("evil-m-team.cc", "m-team.cc")).toBe(false);
    expect(siteHostMatches("m-team.cc.evil.test", "m-team.cc")).toBe(false);
  });

  it("isHostTrusted 对集合做任意匹配", () => {
    const hosts = ["kp.m-team.cc", "mc.m-team.cc"];
    // 兄弟主机 api.m-team.cc 不属于任何声明主机的子域 → 默认拒绝（必须显式声明）
    expect(isHostTrusted("api.m-team.cc", hosts)).toBe(false);
    expect(isHostTrusted("kp.m-team.cc", hosts)).toBe(true);
    expect(isHostTrusted("foo.kp.m-team.cc", hosts)).toBe(true);
  });
});

describe("构建可信主机集合", () => {
  it("合并 urls/legacyUrls/额外主机并去重（支持加密 url）", () => {
    const hosts = buildTrustedHostnames(
      ["uggcf://xc.z-grnz.pp/", "uggcf://bp.z-grnz.pp/", undefined, null, "https://kp.m-team.cc/"],
      ["api.m-team.cc", "https://cdn.m-team.cc/icon.png"],
    );
    expect(hosts).toEqual(["kp.m-team.cc", "oc.m-team.cc", "api.m-team.cc", "cdn.m-team.cc"]);
  });

  it("M-Team 形态：web 子域 + 显式追加的 API 兄弟主机后放行 API 请求", () => {
    // 定义侧按 mteam.ts 的方式自行派生 `api.<domain>` 后传入 extraHosts
    // （原 deriveSiblingHostname 公共 helper 全仓无调用点，已作为死代码删除）
    const hosts = buildTrustedHostnames(["https://kp.m-team.cc/"], ["api.m-team.cc"]);
    expect(hosts).toContain("api.m-team.cc");
    expect(isHostTrusted("api.m-team.cc", hosts)).toBe(true);
    // 未声明前是拒绝的（证明这不是子域规则放行的）
    expect(isHostTrusted("api.m-team.cc", buildTrustedHostnames(["https://kp.m-team.cc/"]))).toBe(false);
  });

  it("FSM/ SunnyPT 形态：api.<声明域> 子域本来就放行", () => {
    const hosts = buildTrustedHostnames(["https://fsm.name/"]);
    expect(isHostTrusted("api.fsm.name", hosts)).toBe(true);
    const sunny = buildTrustedHostnames(["https://sunnypt.top/"]);
    expect(isHostTrusted("api.sunnypt.top", sunny)).toBe(true);
  });
});

describe("collectDeclaredRequestHostnames：只收集 metadata 中显式写定的绝对请求主机", () => {
  it("收集 search/searchEntry/list/detail/download 的绝对 url/baseURL", () => {
    const metadata: any = {
      urls: ["https://kp.m-team.cc/"],
      search: { requestConfig: { url: "/api/v1/search", baseURL: "https://api.m-team.cc/" } },
      searchEntry: {
        advanced: { requestConfig: { url: "https://tracker.example.net/api" } },
      },
      list: [{ requestConfig: { url: "/list.php" } }],
      detail: { requestConfig: { baseURL: "//cdn.example.org/detail" } },
      download: { requestConfig: { url: "https://dl.example.com/torrent" } },
    };

    expect(collectDeclaredRequestHostnames(metadata)).toEqual([
      "api.m-team.cc",
      "tracker.example.net",
      "cdn.example.org",
      "dl.example.com",
    ]);
  });

  it("不收集相对路径、favicon 等展示字段的主机", () => {
    const metadata: any = {
      urls: ["https://site.example/"],
      favicon: "https://third-party-cdn.example/logo.png",
      search: { requestConfig: { url: "/torrents.php" } },
    };
    expect(collectDeclaredRequestHostnames(metadata)).toEqual([]);
    expect(collectDeclaredRequestHostnames(undefined)).toEqual([]);
  });

  it("接入 buildTrustedHostnames 后：声明主机与显式追加的兄弟主机均放行", () => {
    const metadata: any = {
      urls: ["https://kp.m-team.cc/"],
      searchEntry: { api: { requestConfig: { baseURL: "https://api.m-team.cc/" } } },
    };
    const hosts = buildTrustedHostnames([metadata.urls[0]], collectDeclaredRequestHostnames(metadata));
    expect(isHostTrusted("api.m-team.cc", hosts)).toBe(true);
    expect(isHostTrusted("kp.m-team.cc", hosts)).toBe(true);
    expect(isHostTrusted("attacker.example", hosts)).toBe(false);
  });
});
