/**
 * 我的下载器：按种子 tracker 地址识别所属站点（移植自上游 0538dcf9）。
 *
 * - 判定规则：私有站点 → site；仅匹配公开站点 / 客户端标为公开 → public；无 tracker / 未匹配 → unmatched；
 *   tracker 子域名与端口按「各级父域名」回退匹配；
 * - 列表已带 trackerUrls 时不再向下载器请求，缺失时才按需请求且结果缓存；
 * - fork 的种子列表是 shallowRef + markRaw，结果写入响应式缓存而非种子对象：
 *   单元格在判定完成后能自动从加载态切到结果；站点映射重建后缓存失效重新判定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

const storeState = vi.hoisted(() => ({
  siteHostMap: {} as Record<string, string>,
  siteTypes: {} as Record<string, "private" | "public">,
}));
vi.mock("@/options/stores/metadata.ts", () => {
  const store = {
    get siteHostMap() {
      return storeState.siteHostMap;
    },
    get getAddedSiteIds() {
      return Object.values(storeState.siteHostMap);
    },
    getSiteMetadata: vi.fn(async (siteId: string) => ({ id: siteId, type: storeState.siteTypes[siteId] })),
    buildSiteMapCache: vi.fn(async () => undefined),
  };
  return { useMetadataStore: () => store };
});

/** 站点图标 / 名称组件会去读真实的 metadata store，这里只关心选了哪个站点 */
vi.mock("@/options/components/SiteFavicon/Index.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { siteId: String, size: Number },
      setup: (props) => () => h("i", { class: "site-favicon-stub", "data-site": props.siteId }),
    }),
  };
});
vi.mock("@/options/components/SiteName.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { siteId: String },
      setup: (props) => () => h("span", { class: "site-name-stub" }, props.siteId),
    }),
  };
});

import { mountOptionsView } from "../../helpers/optionsView.ts";
import {
  annotateTorrentSites,
  getCachedTorrentSiteMatch,
  getHostCandidates,
  getTorrentSiteMatch,
  resetTorrentSiteCaches,
} from "@/options/views/Overview/MyClient/torrentSite.ts";
import TorrentSiteTd from "@/options/views/Overview/MyClient/TorrentSiteTd.vue";

function torrent(overrides: Record<string, any> = {}) {
  return {
    id: overrides.infoHash ?? "hash-1",
    infoHash: "hash-1",
    clientId: "qb",
    name: "Torrent",
    ...overrides,
  } as any;
}

beforeEach(() => {
  resetTorrentSiteCaches();
  sendMessageMock.mockReset();
  storeState.siteHostMap = {
    "pt.example.com": "examplept",
    "tracker.u2.example": "u2",
    "open.example.org": "openbt",
  };
  storeState.siteTypes = { examplept: "private", u2: "private", openbt: "public" };
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("getHostCandidates", () => {
  it("逐级回退到父域名但不含顶级域名，端口同时保留带端口与不带端口两种形式", () => {
    expect(getHostCandidates("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com"]);
    expect(getHostCandidates("tracker.example.com:8443")).toEqual([
      "tracker.example.com",
      "tracker.example.com:8443",
      "example.com",
      "example.com:8443",
    ]);
    expect(getHostCandidates("localhost")).toEqual([]);
  });
});

describe("getTorrentSiteMatch", () => {
  it("tracker 子域名匹配到私有站点 → site，且列表已带 trackerUrls 时不请求下载器", async () => {
    const match = await getTorrentSiteMatch(
      torrent({ trackerUrls: ["https://tracker.pt.example.com/announce.php?passkey=x"] }),
    );
    expect(match).toEqual({ type: "site", siteId: "examplept" });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("tracker 仅匹配公开站点 → public；客户端标为公开 → public 且不请求 tracker", async () => {
    await expect(
      getTorrentSiteMatch(torrent({ infoHash: "h-pub", trackerUrls: ["udp://open.example.org:6969/announce"] })),
    ).resolves.toEqual({ type: "public" });

    await expect(getTorrentSiteMatch(torrent({ infoHash: "h-flag", isPrivate: false }))).resolves.toEqual({
      type: "public",
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("无 trackerUrls 时按需请求 getClientTorrentTrackers，结果缓存，未匹配 → unmatched", async () => {
    sendMessageMock.mockResolvedValue(["https://unknown.example.net/announce"]);
    const item = torrent({ infoHash: "h-req" });

    await expect(getTorrentSiteMatch(item)).resolves.toEqual({ type: "unmatched" });
    await expect(getTorrentSiteMatch(item)).resolves.toEqual({ type: "unmatched" });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith("getClientTorrentTrackers", { downloaderId: "qb", torrent: item });
  });

  it("站点映射重建（引用变化）后缓存失效并重新判定", async () => {
    const item = torrent({ infoHash: "h-rebuild", trackerUrls: ["https://tracker.new.example/announce"] });
    await expect(getTorrentSiteMatch(item)).resolves.toEqual({ type: "unmatched" });

    storeState.siteHostMap = { ...storeState.siteHostMap, "new.example": "newpt" };
    storeState.siteTypes.newpt = "private";

    await expect(getTorrentSiteMatch(item)).resolves.toEqual({ type: "site", siteId: "newpt" });
  });
});

describe("annotateTorrentSites + TorrentSiteTd", () => {
  it("单元格先显示加载态，判定完成后自动切换为站点（结果不写回种子对象）", async () => {
    const item = Object.freeze(torrent({ infoHash: "h-cell", trackerUrls: ["https://pt.example.com/announce"] }));
    const view = mountOptionsView(TorrentSiteTd, { props: { item } });

    expect(view.$(".ant-spin")).not.toBeNull();
    expect(getCachedTorrentSiteMatch(item)).toBeUndefined();

    await annotateTorrentSites([item]);
    await view.settle(0);

    expect(view.$(".ant-spin")).toBeNull();
    expect(view.$(".site-favicon-stub")?.getAttribute("data-site")).toBe("examplept");
    expect(view.text()).toContain("examplept");
    view.unmount();
  });

  it("公开与未匹配分别展示对应文案；重复 annotate 已判定的种子不会再请求下载器", async () => {
    sendMessageMock.mockResolvedValue([]);
    const publicItem = torrent({ infoHash: "h-a", isPrivate: false });
    const unmatchedItem = torrent({ infoHash: "h-b" });

    await annotateTorrentSites([publicItem, unmatchedItem]);
    await annotateTorrentSites([publicItem, unmatchedItem]);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    const publicView = mountOptionsView(TorrentSiteTd, { props: { item: publicItem } });
    const unmatchedView = mountOptionsView(TorrentSiteTd, { props: { item: unmatchedItem } });
    expect(publicView.text()).toContain("公网种子");
    expect(unmatchedView.text()).toContain("未匹配");
    publicView.unmount();
    unmatchedView.unmount();
  });

  it("空结果不会抛出（fire-and-forget 调用不能产生未处理的 rejection）", async () => {
    await expect(annotateTorrentSites(undefined)).resolves.toBeUndefined();
    await expect(annotateTorrentSites(null)).resolves.toBeUndefined();
  });
});
