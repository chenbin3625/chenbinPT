/**
 * S-2（高危）：拖拽载荷与页面解析出的链接都必须做来源校验。
 *
 * 威胁模型：扩展的 `host_permissions` 覆盖所有主机，因此「页面内容 → 扩展发起带凭据的跨站请求
 * （绕过 CORS）」是一条真实的放大器：
 * 1. 任意页面都能在 `dragstart` 里 `setData("text/json+ptd", …)` 伪造 torrent（link/site/id 全由页面决定）；
 * 2. 任意页面都能往下载列塞 `<a href="https://evil.tld/x">`，用户点「复制链接 / 本地下载 / 推送」
 *    就会让 offscreen 以扩展身份去 GET 它。
 *
 * 本用例用**真实 DataTransfer**（happy-dom 实现）喂给真实的拖拽解析链路，
 * 并直接调用页面动作入口实际使用的那几个函数（`sanitizeParsedTorrents` /
 * `ensureTrustedTorrentLink`），不 mock 被测逻辑本身。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// utils.ts 静态导入三个页面组件（SFC 不在 vitest 的转换范围内），只关心 utils 的逻辑，直接替身
vi.mock("@/content-script/app/pages/SocialSitePage.vue", () => ({ default: { name: "SocialSitePage" } }));
vi.mock("@/content-script/app/pages/SiteListPage.vue", () => ({ default: { name: "SiteListPage" } }));
vi.mock("@/content-script/app/pages/SiteDetailPage.vue", () => ({ default: { name: "SiteDetailPage" } }));

// updatePageType / getTrustedLinkHosts 会读 metadata store（内部走 extStorage），这里给一个可控替身
const mocks = vi.hoisted(() => ({
  siteHostMap: {} as Record<string, string>,
}));
vi.mock("@/options/stores/metadata.ts", () => ({
  useMetadataStore: () => ({
    siteHostMap: mocks.siteHostMap,
    getSiteUserConfig: async () => ({}),
  }),
}));

// 内容脚本侧 messages.ts 依赖构建期注入的 __BROWSER__（vite define），vitest 下需自行补上
(globalThis as any).__BROWSER__ = "chrome";

const {
  CUSTOM_DRAG_MIME,
  ensureTrustedTorrentLink,
  getTrustedLinkHosts,
  isTrustedHost,
  isTrustedTorrentLink,
  parseCustomDragPayload,
  resolveDroppedTorrents,
  sanitizeParsedTorrents,
  siteInstance,
} = await import("@/content-script/app/utils.ts");
const { useRuntimeStore } = await import("@/options/stores/runtime.ts");

import type { ITorrent } from "@ptd/site";

const SITE_ID = "testsite";
const SITE_URL = "https://pt.example.com/";
/** rot13("https://old.example.com/")：站点的历史域名（站点定义里就是这种编码） */
const LEGACY_URL_ROT13 = "uggcf://byq.rknzcyr.pbz/";

function makeSiteInstance() {
  return {
    metadata: {
      id: SITE_ID,
      urls: [SITE_URL],
      legacyUrls: [LEGACY_URL_ROT13],
    },
  } as any;
}

function makeTorrent(partial: Partial<ITorrent> = {}): ITorrent {
  return { site: SITE_ID, link: "", title: "t", id: "1", ...partial };
}

/** 用真实 DataTransfer 构造拖拽数据 */
function makeDataTransfer(type: string, data: string): DataTransfer {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData(type, data);
  return dataTransfer;
}

/** content-script overlay 的全部源码：用于确认渲染层没有任何 HTML 逃逸口（v-html） */
function contentScriptSources(): string[] {
  const root = resolve(import.meta.dirname, "../../../src/entries/content-script");
  const sources: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.(ts|vue)$/.test(entry.name)) {
        sources.push(readFileSync(fullPath, "utf8"));
      }
    }
  };

  walk(root);
  return sources;
}

let showSnakebar: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setActivePinia(createPinia());
  showSnakebar = vi.spyOn(useRuntimeStore(), "showSnakebar").mockImplementation(() => {});

  siteInstance.value = makeSiteInstance();
  mocks.siteHostMap = {
    "pt.example.com": SITE_ID,
    // 用户在站点配置里自定义的地址（buildSiteHostMap 会写进 siteHostMap）
    "mirror.example.net": SITE_ID,
    "other.example.org": "othersite",
  };
});

describe("S-2 · 拖拽载荷（页面可在 dragstart 里伪造 text/json+ptd）", () => {
  it("伪造载荷里的危险协议（javascript:/data:/file:）被拒绝，且给出提示", () => {
    for (const link of [
      "javascript:alert(document.cookie)",
      "data:text/html,<script>x</script>",
      "file:///etc/passwd",
    ]) {
      showSnakebar.mockClear();
      const dataTransfer = makeDataTransfer(CUSTOM_DRAG_MIME, JSON.stringify([{ link, site: "evil", id: "1" }]));

      const result = resolveDroppedTorrents(dataTransfer, SITE_ID);

      expect(result.torrents, link).toEqual([]);
      expect(result.rejectedCount, link).toBe(1);
      expect(result.payloadInvalid, link).toBe(false);
      // 不静默丢弃：必须让用户看到「拖拽失灵」之外的原因
      expect(showSnakebar, link).toHaveBeenCalledTimes(1);
      expect(String(showSnakebar.mock.calls[0][0])).toContain("不受支持");
    }
  });

  it("载荷不是数组 / 不是合法 JSON 时整体拒绝并提示", () => {
    for (const payload of ['{"link":"https://evil.tld/x"}', "{oops", '"https://pt.example.com/a.torrent"', "123"]) {
      showSnakebar.mockClear();
      const result = resolveDroppedTorrents(makeDataTransfer(CUSTOM_DRAG_MIME, payload), SITE_ID);

      expect(result.torrents, payload).toEqual([]);
      expect(result.payloadInvalid, payload).toBe(true);
      expect(showSnakebar, payload).toHaveBeenCalledTimes(1);
      expect(String(showSnakebar.mock.calls[0][0])).toContain("不是有效的种子数据");
    }
  });

  it("形状不对的条目被拒绝（字符串条目 / 非对象 / link 非字符串）", () => {
    const payload = JSON.stringify([
      "https://pt.example.com/a.torrent",
      null,
      [1, 2],
      { link: 42 },
      { title: "没有 link" },
      { link: "https://pt.example.com/ok.torrent" },
    ]);

    const result = parseCustomDragPayload(payload, SITE_ID);

    expect(result.torrents).toHaveLength(1);
    expect(result.torrents[0].link).toBe("https://pt.example.com/ok.torrent");
    expect(result.rejectedCount).toBe(5);
    expect(result.payloadInvalid).toBe(false);
  });

  it("忽略载荷里的 site / id，强制使用当前站点并由 link 反推 id", () => {
    const link = "https://pt.example.com/download.php?id=42&passkey=secret";
    const payload = JSON.stringify([{ link, site: "othersite", id: "9999", title: "被页面决定的标题" }]);

    const result = parseCustomDragPayload(payload, SITE_ID);

    expect(result.torrents).toEqual([{ link, site: SITE_ID, id: "42", title: "被页面决定的标题" }]);
  });

  it("合法载荷（真实站点链接、magnet）行为与修复前一致（不误伤）", async () => {
    const siteLink = "https://pt.example.com/download.php?id=7&passkey=abc";
    const magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=some.release";
    const payload = JSON.stringify([
      { link: siteLink, site: SITE_ID, id: "7", title: "A" },
      { link: magnet, site: SITE_ID, id: "", title: "B" },
    ]);

    const result = resolveDroppedTorrents(
      makeDataTransfer(CUSTOM_DRAG_MIME, payload),
      SITE_ID,
      await getTrustedLinkHosts(SITE_ID),
    );

    expect(result.torrents).toHaveLength(2);
    expect(result.rejectedCount).toBe(0);
    expect(result.torrents[0]).toEqual({ link: siteLink, site: SITE_ID, id: "7", title: "A" });
    expect(result.torrents[1]).toEqual({ link: magnet, site: SITE_ID, id: "", title: "B" });
    expect(showSnakebar).not.toHaveBeenCalled();
  });

  it("非自定义 MIME 分支：原有的协议校验保留（http/https/magnet 通过）", async () => {
    const html = [
      '<a href="https://pt.example.com/a.torrent">a</a>',
      '<a href="http://mirror.example.net/b.torrent">b</a>',
      '<a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567">m</a>',
    ].join("");

    const result = resolveDroppedTorrents(
      makeDataTransfer("text/html", html),
      SITE_ID,
      await getTrustedLinkHosts(SITE_ID),
    );

    expect(result.torrents.map((x: ITorrent) => x.link)).toEqual([
      "https://pt.example.com/a.torrent",
      "http://mirror.example.net/b.torrent",
      "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
    ]);
    // site 同样被强制为当前站点（页面无从决定）
    expect(result.torrents.every((x: ITorrent) => x.site === SITE_ID)).toBe(true);
  });

  it("非自定义 MIME 分支：异站 http(s) 链接不能只凭协议白名单进入推送流程", async () => {
    const html = [
      '<a href="https://evil.tld/a.torrent">evil</a>',
      '<a href="https://pt.example.com/a.torrent">ok</a>',
    ].join("");

    const result = resolveDroppedTorrents(
      makeDataTransfer("text/html", html),
      SITE_ID,
      await getTrustedLinkHosts(SITE_ID),
    );

    expect(result.torrents.map((x: ITorrent) => x.link)).toEqual(["https://pt.example.com/a.torrent"]);
    expect(result.rejectedCount).toBe(1);
  });

  it("自定义 MIME 分支：页面伪造的异站链接同样不能进入推送流程", async () => {
    const payload = JSON.stringify([
      { link: "https://evil.tld/a.torrent", site: SITE_ID, id: "1", title: "evil" },
      { link: "https://pt.example.com/a.torrent", site: SITE_ID, id: "2", title: "ok" },
    ]);

    const result = resolveDroppedTorrents(
      makeDataTransfer(CUSTOM_DRAG_MIME, payload),
      SITE_ID,
      await getTrustedLinkHosts(SITE_ID),
    );

    expect(result.torrents.map((x: ITorrent) => x.link)).toEqual(["https://pt.example.com/a.torrent"]);
    expect(result.rejectedCount).toBe(1);
  });

  it("没有 dataTransfer 时返回空结果且不弹提示", () => {
    const result = resolveDroppedTorrents(null, SITE_ID);
    expect(result).toEqual({ torrents: [], rejectedCount: 0, payloadInvalid: false });
    expect(showSnakebar).not.toHaveBeenCalled();
  });

  it("载荷里的 title 只作为纯文本保留（渲染侧转义：content-script 内没有任何 v-html）", () => {
    const title = '<img src=x onerror="alert(1)">';
    const payload = JSON.stringify([{ link: "https://pt.example.com/a.torrent", title }]);

    const result = resolveDroppedTorrents(makeDataTransfer(CUSTOM_DRAG_MIME, payload), SITE_ID);

    // 原样保留为字符串，交给 Vue 的文本插值转义；这里不做任何 HTML 解析
    expect(result.torrents[0].title).toBe(title);
    expect(contentScriptSources().some((source) => source.includes("v-html"))).toBe(false);
  });
});

describe("S-2 · 站点已知 host 集合", () => {
  it("getTrustedLinkHosts 收集 定义 urls + rot13 legacyUrls + siteHostMap 中属于本站点的 host + 当前页面", async () => {
    const hosts = await getTrustedLinkHosts(SITE_ID);

    expect(hosts.has("pt.example.com")).toBe(true); // urls
    expect(hosts.has("old.example.com")).toBe(true); // legacyUrls（rot13 还原）
    expect(hosts.has("mirror.example.net")).toBe(true); // 用户自定义地址
    expect(isTrustedHost(location.host, hosts)).toBe(true); // 当前页面（happy-dom 默认 http://localhost:3000）
    expect(isTrustedHost("localhost", hosts)).toBe(true); // 端口不参与比较
    expect(hosts.has("other.example.org")).toBe(false); // 别的站点的 host 不能混进来
    expect(hosts.has(LEGACY_URL_ROT13)).toBe(false); // 不能把编码后的字符串当成 host
  });

  it("isTrustedHost：同一站点域内的父子域放行，异站与标签欺骗拒绝，端口不参与比较", () => {
    const trusted = ["pt.example.com"];

    expect(isTrustedHost("pt.example.com", trusted)).toBe(true);
    expect(isTrustedHost("PT.EXAMPLE.COM", trusted)).toBe(true);
    expect(isTrustedHost("pt.example.com:8443", trusted)).toBe(true);

    // 站点常把下载放在 CDN / 下载子域上，逐字相等会误伤真实场景
    expect(isTrustedHost("cdn.pt.example.com", trusted)).toBe(true);
    expect(isTrustedHost("example.com", trusted)).toBe(false);
    expect(isTrustedHost("example.com", ["www.example.com"])).toBe(true);
    expect(isTrustedHost("cdn.example.com", ["www.example.com"])).toBe(true);

    expect(isTrustedHost("evil.tld", trusted)).toBe(false);
    expect(isTrustedHost("pt.example.com.evil.tld", trusted)).toBe(false);
    expect(isTrustedHost("evil-pt.example.com", trusted)).toBe(false);
    expect(isTrustedHost("com", trusted)).toBe(false);
  });

  it("isTrustedTorrentLink：协议白名单 + 相对链接/空串语义", () => {
    const trusted = ["pt.example.com"];

    expect(isTrustedTorrentLink("https://pt.example.com/dl?id=1", trusted)).toBe(true);
    expect(isTrustedTorrentLink("magnet:?xt=urn:btih:abc", trusted)).toBe(true);
    // 相对链接只能由站点自身的 base 解析，不构成跨站请求
    expect(isTrustedTorrentLink("download.php?id=1", trusted)).toBe(true);
    expect(isTrustedTorrentLink("/dl/1", trusted)).toBe(true);
    // fixLink 对危险 scheme 返回空串：它不是可请求地址，交由站点层明确失败
    expect(isTrustedTorrentLink("", trusted)).toBe(true);
    expect(isTrustedTorrentLink(undefined, trusted)).toBe(true);

    expect(isTrustedTorrentLink("https://evil.tld/x", trusted)).toBe(false);
    expect(isTrustedTorrentLink("http://evil.tld/x", trusted)).toBe(false);
    // 协议相对链接会指向任意主机
    expect(isTrustedTorrentLink("//evil.tld/x", trusted)).toBe(false);
    expect(isTrustedTorrentLink("javascript:alert(1)", trusted)).toBe(false);
    expect(isTrustedTorrentLink("data:text/html,x", trusted)).toBe(false);
    expect(isTrustedTorrentLink("file:///etc/passwd", trusted)).toBe(false);
    expect(isTrustedTorrentLink({ url: "https://pt.example.com" }, trusted)).toBe(false);
  });
});

describe("S-2 · 页面解析出的链接（下载列里可以是异站 <a href>）", () => {
  it("sanitizeParsedTorrents 剔除异站链接并提示条数，真实链接与 magnet 保留", async () => {
    const trustedHosts = await getTrustedLinkHosts(SITE_ID);
    const torrents = [
      makeTorrent({ link: "https://evil.tld/x", url: "https://evil.tld/t/1" }),
      makeTorrent({ link: "https://pt.example.com/download.php?id=1", url: "https://pt.example.com/details.php?id=1" }),
      makeTorrent({ link: "magnet:?xt=urn:btih:abc", url: "https://pt.example.com/details.php?id=2" }),
      // link 缺失（列表页没有直链）但详情页地址可信：仍要放行，由站点层去补全
      makeTorrent({ link: "", url: "https://pt.example.com/details.php?id=3" }),
    ];

    const allowed = sanitizeParsedTorrents(torrents, trustedHosts);

    expect(allowed).toHaveLength(3);
    expect(allowed.map((x) => x.link)).toEqual([
      "https://pt.example.com/download.php?id=1",
      "magnet:?xt=urn:btih:abc",
      "",
    ]);
    expect(showSnakebar).toHaveBeenCalledTimes(1);
    expect(String(showSnakebar.mock.calls[0][0])).toContain("已忽略 1 条");
  });

  it("url（详情页）被注入异站时同样拒绝：getTorrentDownloadLink 会带着扩展权限去抓它", async () => {
    const trustedHosts = await getTrustedLinkHosts(SITE_ID);
    const torrents = [
      // link 为空时，offscreen 会用 detail.selectors.link 去请求 torrent.url
      makeTorrent({ link: "", url: "https://evil.tld/details.php?id=1" }),
      // link 是合法站点地址，但 url 是异站：仍然拒绝
      makeTorrent({ link: "https://pt.example.com/dl?id=1", url: "https://evil.tld/details.php?id=1" }),
      // 协议相对链接：会解析到任意主机
      makeTorrent({ link: "//evil.tld/x", url: "https://pt.example.com/details.php?id=3" }),
    ];

    expect(sanitizeParsedTorrents(torrents, trustedHosts)).toEqual([]);
    expect(String(showSnakebar.mock.calls[0][0])).toContain("已忽略 3 条");
  });

  it("ensureTrustedTorrentLink 是详情页三个动作的闸门：异站拒绝 + 提示，可信链接放行", async () => {
    const evil = makeTorrent({ link: "https://evil.tld/x", url: "https://evil.tld/t/1" });
    await expect(ensureTrustedTorrentLink(evil, SITE_ID)).resolves.toBe(false);
    expect(String(showSnakebar.mock.calls.at(-1)?.[0])).toContain("不属于该站点");

    showSnakebar.mockClear();
    const ok = makeTorrent({ link: "https://pt.example.com/download.php?id=1", url: SITE_URL });
    await expect(ensureTrustedTorrentLink(ok, SITE_ID)).resolves.toBe(true);
    await expect(ensureTrustedTorrentLink(makeTorrent({ link: "magnet:?xt=urn:btih:abc" }), SITE_ID)).resolves.toBe(
      true,
    );
    expect(showSnakebar).not.toHaveBeenCalled();
  });

  it("详情页链接被 fixLink 拒为空串（危险 scheme）时，空串不会被当成可信下载地址放行", async () => {
    // 站点会返回空串，且 url 是当前页面（可信）→ host 校验无从拒绝，
    // 因此 SiteDetailPage 必须用真值判定（!link）拦下来，而不是 typeof === "undefined"
    const emptyLink = makeTorrent({ link: "", url: "https://pt.example.com/details.php?id=1" });
    await expect(ensureTrustedTorrentLink(emptyLink, SITE_ID)).resolves.toBe(true);
    expect(emptyLink.link).toBe(""); // 交回页面层：!link ⇒ 「无法解析当前页面种子链接」
  });
});
