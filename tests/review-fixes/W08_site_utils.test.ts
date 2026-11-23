import { describe, expect, it } from "vitest";

import type { ILevelRequirement, ITorrent, IUserInfo } from "@ptd/site/types.ts";
import { parseValidTimeStringInZone } from "@ptd/site/utils/datetime.ts";
import { GB, MB, parseLocalizedNumber, parseSizeString } from "@ptd/site/utils/filesize.ts";
import { definedFilters } from "@ptd/site/utils/filter.ts";
import { redactSensitive } from "@ptd/site/utils/helper.ts";
import { cfDecodeEmail } from "@ptd/site/utils/html.ts";
import { fixRatio, getNextLevelUnMet } from "@ptd/site/utils/level.ts";
import { normalizeTorrentPromotion } from "@ptd/site/utils/promotion.ts";
import { matchesSelector, selectElements } from "@ptd/site/utils/selector.ts";
import { normalizedTorrentTagMap } from "@ptd/site/utils/tags.ts";
import { buildTrustedHostnames, isHostTrusted } from "@ptd/site/utils/trustedHost.ts";

const parseSize = definedFilters.parseSize as (query: unknown) => number;
const parseNumber = definedFilters.parseNumber as (query: unknown) => number;

function normalizeTag(name: string): { name: string; color?: string } {
  for (const normalized of normalizedTorrentTagMap) {
    if (normalized.from.test(name)) {
      return normalized.to;
    }
  }
  return { name };
}

function makeContainer(html: string): HTMLDivElement {
  document.body.innerHTML = html;
  return document.body as unknown as HTMLDivElement;
}

/* -------------------------------------------------------------------------- */
/*                                   F0099                                    */
/* -------------------------------------------------------------------------- */

describe("F0099: parseLocalizedNumber handles comma+space thousands and 3-decimal European commas", () => {
  it("parses comma+space thousands separators instead of treating them as decimals", () => {
    expect(parseLocalizedNumber("1, 234")).toBe(1234);
    expect(parseLocalizedNumber("1, 234, 567")).toBe(1234567);
    expect(parseLocalizedNumber("-1, 234")).toBe(-1234);
    expect(parseSizeString("1, 234 GB")).toBe(1234 * GB);
    expect(parseSize("Size: 1, 234 GB")).toBe(1234 * GB);
  });

  it("parses European 3-decimal comma numbers without inflating by 1000x", () => {
    expect(parseLocalizedNumber("0,500")).toBe(0.5);
    expect(parseLocalizedNumber("-0,500")).toBe(-0.5);
    expect(parseLocalizedNumber("1000,500")).toBe(1000.5);
    expect(parseLocalizedNumber("1 234,500")).toBe(1234.5);
    expect(parseLocalizedNumber("1\u00a0234,500")).toBe(1234.5);
    expect(parseLocalizedNumber("1\u202f234,500")).toBe(1234.5);
    expect(parseSizeString("0,500 GB")).toBe(0.5 * GB);
    expect(parseSizeString("1 234,500 MB")).toBe(1234.5 * MB);
    expect(parseNumber("0,500")).toBe(0.5);
  });

  it("preserves standard thousands and mixed decimal/thousands separators", () => {
    expect(parseLocalizedNumber("1,024")).toBe(1024);
    expect(parseLocalizedNumber("12,345,678")).toBe(12345678);
    expect(parseLocalizedNumber("1.234,56")).toBe(1234.56);
    expect(parseLocalizedNumber("1, 234.56")).toBe(1234.56);
    expect(parseLocalizedNumber("1. 234. 567")).toBe(1234567);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   F0100                                    */
/* -------------------------------------------------------------------------- */

describe("F0100: definedFilters.parseSize requires trailing non-letter boundary on units", () => {
  it("does not match unit prefixes inside words like 10-bit, 10bit, Blu-ray, or BDRip", () => {
    expect(parseSize("10-bit 4.5 GB")).toBe(4.5 * GB);
    expect(parseSize("1080p 10bit 4.5 GB")).toBe(4.5 * GB);
    expect(parseSize("2024 Blu-ray 4.5 GB")).toBe(4.5 * GB);
    expect(parseSize("Season 1 BDRip 12.5 GB")).toBe(12.5 * GB);
    expect(parseSize("100 MBit 2.5 GB")).toBe(2.5 * GB);
  });

  it("still parses valid units including plural forms and adjacent punctuation", () => {
    expect(parseSize("10 MBs")).toBe(10 * MB);
    expect(parseSize("2 GiBs")).toBe(2 * GB);
    expect(parseSize("10 Bytes")).toBe(10);
    expect(parseSize("10B")).toBe(10);
    expect(parseSize("700 MB (Blu-ray)")).toBe(700 * MB);
  });
});

/* -------------------------------------------------------------------------- */
/*                             F0101 & F0156/H14                              */
/* -------------------------------------------------------------------------- */

describe("F0101: getNextLevelUnMet restricts targets to user groupType", () => {
  const hdspaceLikeLevels: ILevelRequirement[] = [
    { id: 1, name: "Members", privilege: "Base" },
    { id: 4, name: "HD Alien", uploaded: "2TB", ratio: 4.25 },
    { id: 5, name: "HD Internal", privilege: "Internal privilege only" },
    { id: 6, name: "VIP", groupType: "vip", privilege: "VIP" },
    { id: 7, name: "Uploader", groupType: "manager", uploads: 20 },
  ];

  it("does not select VIP or manager levels when skipping description-only user levels", () => {
    const userInfo = { levelId: 4, uploaded: 3 * 1024 ** 4, downloaded: 100 * GB, uploads: 0 } as unknown as IUserInfo;
    expect(getNextLevelUnMet(userInfo, hdspaceLikeLevels)).toEqual({});
  });

  it("still selects the next judgeable user level when one exists", () => {
    const levels: ILevelRequirement[] = [
      ...hdspaceLikeLevels,
      { id: 8, name: "HD Legend", uploaded: "10TB", ratio: 5 },
    ];
    const userInfo = { levelId: 4, uploaded: 3 * 1024 ** 4, downloaded: 100 * GB, uploads: 0 } as unknown as IUserInfo;
    const next = getNextLevelUnMet(userInfo, levels);
    expect(next.level?.id).toBe(8);
    expect(next.level?.name).toBe("HD Legend");
  });
});

describe("F0156/H14: fixRatio coerces string ratios safely so callers always get a number", () => {
  it("coerces numeric strings and localized numeric strings to numbers", () => {
    expect(fixRatio({ ratio: "2.34" as unknown as number })).toBe(2.34);
    expect(typeof fixRatio({ ratio: "2.34" as unknown as number })).toBe("number");
    expect(fixRatio({ ratio: " 1,234.56 " as unknown as number })).toBe(1234.56);
    expect(fixRatio({ ratio: "1,5" as unknown as number })).toBe(1.5);
    expect(fixRatio({ trueRatio: "4.25" as unknown as number }, "trueRatio")).toBe(4.25);
  });

  it("handles sentinel strings (-1, 0 with upload only, infinity symbols) and falls back on empty/invalid strings", () => {
    expect(fixRatio({ ratio: "-1" as unknown as number })).toBe(Infinity);
    expect(fixRatio({ ratio: "0" as unknown as number, uploaded: 100, downloaded: 0 })).toBe(Infinity);
    expect(fixRatio({ ratio: "0" as unknown as number, uploaded: 100, downloaded: 100 })).toBe(0);
    expect(fixRatio({ ratio: "∞" as unknown as number })).toBe(Infinity);
    expect(fixRatio({ ratio: "Inf." as unknown as number })).toBe(Infinity);

    // Empty or non-numeric strings fall back to uploaded / downloaded
    expect(fixRatio({ ratio: "" as unknown as number, uploaded: 20, downloaded: 5 })).toBe(4);
    expect(fixRatio({ ratio: "   " as unknown as number, uploaded: 0, downloaded: 0 })).toBe(-Infinity);
    expect(fixRatio({ ratio: "N/A" as unknown as number, uploaded: 30, downloaded: 10 })).toBe(3);
    expect(fixRatio({ ratio: null as unknown as number, uploaded: 30, downloaded: 10 })).toBe(3);
    expect(fixRatio({ ratio: Number.NaN, uploaded: 30, downloaded: 10 })).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   F0102                                    */
/* -------------------------------------------------------------------------- */

describe("F0102: normalizeTorrentPromotion merges explicit and tag-inferred factors per axis", () => {
  it("preserves upload promotion tag when only downloadVolumeFactor is explicit", () => {
    const torrent = normalizeTorrentPromotion({
      downloadVolumeFactor: 0,
      tags: [{ name: "2xUp" }, { name: "H&R" }],
    } as Partial<ITorrent>);

    expect(torrent.downloadVolumeFactor).toBe(0);
    expect(torrent.uploadVolumeFactor).toBe(2);
    expect(torrent.tags?.map((t) => t.name)).toEqual(["H&R", "2xFree"]);
  });

  it("preserves download promotion tag when only uploadVolumeFactor is explicit", () => {
    const torrent = normalizeTorrentPromotion({
      uploadVolumeFactor: 2,
      tags: [{ name: "Free" }],
    } as Partial<ITorrent>);

    expect(torrent.downloadVolumeFactor).toBe(0);
    expect(torrent.uploadVolumeFactor).toBe(2);
    expect(torrent.tags?.map((t) => t.name)).toEqual(["2xFree"]);
  });

  it("keeps explicit factor precedence on its own axis while filling missing axis from tags", () => {
    const torrent = normalizeTorrentPromotion({
      downloadVolumeFactor: 0.5,
      tags: [{ name: "2xFree" }],
    } as Partial<ITorrent>);

    expect(torrent.downloadVolumeFactor).toBe(0.5);
    expect(torrent.uploadVolumeFactor).toBe(2);
    expect(torrent.tags?.map((t) => t.name)).toEqual(["2x50%"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   F0103                                    */
/* -------------------------------------------------------------------------- */

describe("F0103: cfDecodeEmail skips non-hex byte pairs instead of emitting XOR key character", () => {
  it("skips non-hex pairs after the key rather than appending String.fromCharCode(r)", () => {
    // 0x41 ('A') XOR 0x20 = 0x61 ('a'); "zz" is non-hex and must be skipped, not decoded as 'A'
    expect(cfDecodeEmail("4120zz23")).toBe("ab");
    expect(cfDecodeEmail("41zz")).toBe("");
    expect(cfDecodeEmail("412z23")).toBe("b");
  });

  it("rejects partially non-hex key pairs", () => {
    expect(cfDecodeEmail("4z20")).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/*                                   F0104                                    */
/* -------------------------------------------------------------------------- */

describe("F0104: parseValidTimeStringInZone handles literal Z formats and pure-digit formatString/failure", () => {
  it("does not double-shift UTC timestamps parsed with quoted 'Z' / 'UTC' formats", () => {
    const expected = Date.parse("2024-03-01T10:00:00Z");
    expect(parseValidTimeStringInZone("2024-03-01T10:00:00Z", ["yyyy-MM-dd'T'HH:mm:ss'Z'"], "+0800")).toBe(expected);
    expect(parseValidTimeStringInZone("2024-03-01T10:00:00Z", ["yyyy-MM-dd'T'HH:mm:ss'Z'"], "-0500")).toBe(expected);
    expect(parseValidTimeStringInZone("20240301100000Z", ["yyyyMMddHHmmss'Z'"], "+0800")).toBe(expected);
    expect(parseValidTimeStringInZone("2024-03-01 10:00:00 UTC", ["yyyy-MM-dd HH:mm:ss 'UTC'"], "+0800")).toBe(
      expected,
    );
  });

  it("tries explicit pure-digit formatString before Unix timestamp fallback", () => {
    expect(parseValidTimeStringInZone("20240301123045", ["yyyyMMddHHmmss"], "+0800")).toBe(
      Date.parse("2024-03-01T12:30:45+08:00"),
    );
    expect(parseValidTimeStringInZone("01032024", ["ddMMyyyy"], "+0800")).toBe(Date.parse("2024-03-01T00:00:00+08:00"));
  });

  it("returns original query string on parse failure for ambiguous numeric strings instead of 0", () => {
    expect(parseValidTimeStringInZone("2024", [], "+0800")).toBe("2024");
    expect(parseValidTimeStringInZone("20241301", [], "+0800")).toBe("20241301");
    expect(parseValidTimeStringInZone("2024-13-01", [], "+0800")).toBe("2024-13-01");
  });
});

/* -------------------------------------------------------------------------- */
/*                                   F0105                                    */
/* -------------------------------------------------------------------------- */

describe("F0105: redactSensitive covers rsskey, downloadLinkAppendix, and URL-embedded credentials", () => {
  it("redacts rsskey and downloadLinkAppendix keys", () => {
    const redacted = redactSensitive({
      inputSetting: { rsskey: "my-rss-secret", rss_key: "secret2" },
      downloadLinkAppendix: "&passkey=abc123&https=1",
      normalField: "keep-me",
    });

    expect(redacted).toEqual({
      inputSetting: { rsskey: "***", rss_key: "***" },
      downloadLinkAppendix: "***",
      normalField: "keep-me",
    });
  });

  it("redacts URL userinfo, sensitive query/fragment parameters, and credential-like path segments in strings", () => {
    const redacted = redactSensitive({
      baseURL: "https://alice:s3cr3t@tracker.example:8080/api",
      downloadUrl: "https://tracker.example/download.php?id=42&passkey=deadbeef&rsskey=xyz&downhash=h123",
      relativeUrl: "/api/dl?token=tok123&page=1",
      torrentUrl: "https://r.example/api/v1/torrents/download/123/0a1b2c3d4e5f60718293a4b5c6d7e8f9#section",
      fragmentUrl: "https://site.example/cb#access_token=s3cr3t&state=ok",
      plainUrl: "https://kp.m-team.cc/",
    });

    expect(redacted.baseURL).toBe("https://***@tracker.example:8080/api");
    expect(redacted.downloadUrl).toBe("https://tracker.example/download.php?id=42&passkey=***&rsskey=***&downhash=***");
    expect(redacted.relativeUrl).toBe("/api/dl?token=***&page=1");
    expect(redacted.torrentUrl).toBe("https://r.example/api/v1/torrents/download/123/***#section");
    expect(redacted.fragmentUrl).toBe("https://site.example/cb#access_token=***&state=ok");
    expect(redacted.plainUrl).toBe("https://kp.m-team.cc/");
  });
});

/* -------------------------------------------------------------------------- */
/*                       F0106, F0107, F0108, F0109, F0110, F0111             */
/* -------------------------------------------------------------------------- */

describe("F0106: nativeQuery prefixes :scope to every comma-separated selector group", () => {
  it("supports leading > combinators in 2nd+ groups without throwing SyntaxError", () => {
    makeContainer(`
      <table>
        <tr id="row">
          <td id="c1">1</td>
          <td id="c2">2</td>
          <td id="c3">3</td>
        </tr>
      </table>
    `);
    const row = document.getElementById("row")!;
    const matched = selectElements("> td:nth-child(1), > td:nth-child(3)", row);
    expect(matched.map((el) => el.id)).toEqual(["c1", "c3"]);
  });

  it("maintains :scope isolation on 2nd+ groups so outside ancestors cannot satisfy them", () => {
    makeContainer(`
      <div class="outer">
        <div id="ctx">
          <span id="inside">ok</span>
        </div>
      </div>
    `);
    const ctx = document.getElementById("ctx")!;
    // Without :scope on group 2, `.outer span` would match #inside via ancestor `.outer` outside #ctx
    const matched = selectElements(".nonexistent > b, .outer span", ctx);
    expect(matched).toEqual([]);
  });
});

describe("F0107: evalTokenStages preserves leading combinators on pure positional compounds", () => {
  it("respects leading > on pure positional compound without selecting grandchildren", () => {
    makeContainer(`
      <div id="root">
        <div id="d1"><span id="nested">n</span></div>
        <div id="d2">two</div>
      </div>
    `);
    const root = document.getElementById("root")!;
    expect(selectElements("> :first", root).map((e) => e.id)).toEqual(["d1"]);
    expect(selectElements("> :eq(1)", root).map((e) => e.id)).toEqual(["d2"]);
  });

  it("respects > / + / ~ on pure positional compounds instead of falling back to descendants", () => {
    makeContainer(`
      <table>
        <tr id="r1"><td id="t1"><b id="b1">x</b></td><td id="t2">y</td></tr>
        <tr id="r2"><td id="t3">z</td></tr>
      </table>
      <dl>
        <dt id="dt1"><span id="dt-child">k1</span></dt><dd id="dd1">v1</dd><dd id="dd2">v2</dd>
      </dl>
    `);
    const dt1 = document.getElementById("dt1")!;
    expect(selectElements("tr:first > :eq(1)").map((e) => e.id)).toEqual(["t2"]);
    expect(selectElements("dt:first + :first").map((e) => e.id)).toEqual(["dd1"]);
    expect(selectElements("dt:first ~ :first").map((e) => e.id)).toEqual(["dd1"]);
    expect(selectElements("~ :eq(0)", dt1).map((e) => e.id)).toEqual(["dd1"]);
  });
});

describe("F0108: matchesSelector evaluates non-trailing positional pseudos correctly", () => {
  it("matches elements targeted after a non-trailing positional compound", () => {
    makeContainer(`
      <table>
        <tr id="r1"><td id="c1">a</td><td id="c2">b</td></tr>
        <tr id="r2"><td id="c3">c</td></tr>
      </table>
      <div id="outer"><div id="inner"><span id="s1">hi</span></div></div>
    `);

    expect(matchesSelector(document.getElementById("c1")!, "tr:first td")).toBe(true);
    expect(matchesSelector(document.getElementById("c2")!, "tr:first td")).toBe(true);
    expect(matchesSelector(document.getElementById("c3")!, "tr:first td")).toBe(false);
    expect(matchesSelector(document.getElementById("s1")!, "div:eq(1) > span")).toBe(true);
    expect(matchesSelector(document.getElementById("inner")!, "div:first div")).toBe(true);
  });
});

describe("F0109: collectCandidates includes subsequent siblings for leading + chains with +/~", () => {
  it("matches + ... + ... and multi-stage dt:first + dd:contains(...) ~ dd", () => {
    makeContainer(`
      <table><tr><td id="a">0</td><td id="b">x</td><td id="c">y</td></tr></table>
      <dl id="dl">
        <dt id="dt0">k</dt>
        <dd id="dd1">match-x</dd>
        <dd id="dd2">target-1</dd>
        <dd id="dd3">target-2</dd>
      </dl>
    `);

    const a = document.getElementById("a")!;
    expect(selectElements("+ td:contains('x') + td", a).map((e) => e.id)).toEqual(["c"]);

    const dl = document.getElementById("dl")!;
    expect(selectElements("dt:first + dd:contains('match-x') ~ dd", dl).map((e) => e.id)).toEqual(["dd2", "dd3"]);
  });
});

describe("F0110: notPositionalComplement handles comma lists, descendant rejection, and nested :not()", () => {
  it("excludes all items matched by comma-separated selectors inside :not()", () => {
    makeContainer(`
      <ul>
        <li id="l0">0</li>
        <li id="l1">1</li>
        <li id="l2">2</li>
        <li id="l3">3</li>
      </ul>
    `);

    expect(selectElements("li:not(:first, :last)").map((e) => e.id)).toEqual(["l1", "l2"]);
    expect(selectElements("li:not(:eq(0), :eq(1))").map((e) => e.id)).toEqual(["l2", "l3"]);
  });

  it("handles nested :not(:not(:first)) without falling into gt default branch", () => {
    makeContainer(`<ul><li id="l0">0</li><li id="l1">1</li><li id="l2">2</li></ul>`);
    expect(selectElements("li:not(:not(:first))").map((e) => e.id)).toEqual(["l0"]);
  });

  it("does not mis-apply descendant combinators as same-element compound tests in :not(positional)", () => {
    makeContainer(`<div><span id="s0">0</span><span id="s1">1</span></div>`);
    // Conservative skip on combinator + positional inside :not() does not wrongly drop or corrupt elements
    expect(selectElements("span:not(div :first)").map((e) => e.id)).toEqual(["s0", "s1"]);
  });
});

describe("F0111: scanPseudos preserves CSS escape sequences inside :has() and :not()", () => {
  it("preserves escaped colons and dots in :has() and :not() arguments", () => {
    makeContainer(`
      <div id="d1"><span id="foo:bar">x</span></div>
      <div id="d2"><span id="foo">y</span></div>
      <div id="d3" class="a.b">match</div>
      <div id="d4" class="a b">other</div>
    `);

    expect(selectElements("div:has(#foo\\:bar)").map((e) => e.id)).toEqual(["d1"]);
    expect(selectElements("div:has(.a\\.b)").map((e) => e.id)).toEqual([]);
    expect(selectElements("div:not(.a\\.b:contains('match'))").map((e) => e.id)).toEqual(["d1", "d2", "d4"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                F0112 & F0113                               */
/* -------------------------------------------------------------------------- */

describe("F0112 & F0113: preDefinedTorrentTagMap DoVi regex and case-insensitive RegExp aka entries", () => {
  it("F0112: does not misclassify Dolby Atmos Chinese tags as DoVi while preserving 杜比 / 杜比视界", () => {
    expect(normalizeTag("杜比全景声")).toEqual({ name: "杜比全景声" });
    expect(normalizeTag("杜比全景声(Atmos)")).toEqual({ name: "杜比全景声(Atmos)" });
    expect(normalizeTag("杜比").name).toBe("DoVi");
    expect(normalizeTag("杜比视界").name).toBe("DoVi");
    expect(normalizeTag("杜比视界(DV)").name).toBe("DoVi");
  });

  it("F0113: matches RegExp aka entries case-insensitively", () => {
    expect(normalizeTag("web.dl").name).toBe("WEB-DL");
    expect(normalizeTag("WebDL").name).toBe("WEB-DL");
    expect(normalizeTag("BLURAY").name).toBe("Blu-ray");
    expect(normalizeTag("bluray").name).toBe("Blu-ray");
    expect(normalizeTag("h.265").name).toBe("H265");
    expect(normalizeTag("DolbyVision").name).toBe("DoVi");
    expect(normalizeTag("dolbyvision").name).toBe("DoVi");
  });
});

/* -------------------------------------------------------------------------- */
/*                                   F0114                                    */
/* -------------------------------------------------------------------------- */

describe("F0114: toTrustedHostname parses bare host:port and IPv4/IPv6 host:port consistently", () => {
  it("extracts hostnames from bare host:port, localhost:port, IPv4:port, and IPv6:port", () => {
    const hosts = buildTrustedHostnames(
      ["example.com:8080", "localhost:8080", "127.0.0.1:8080", "[::1]:8080", "www.tracker.test:8443/browse"],
      ["api.example.com:9000"],
    );

    expect(hosts).toEqual(["example.com", "localhost", "127.0.0.1", "[::1]", "tracker.test", "api.example.com"]);
    expect(isHostTrusted("example.com", hosts)).toBe(true);
    expect(isHostTrusted("127.0.0.1", hosts)).toBe(true);
    expect(isHostTrusted("[::1]", hosts)).toBe(true);
    expect(isHostTrusted("tracker.test", hosts)).toBe(true);
  });

  it("rejects non-hierarchical URI schemes like mailto: and javascript:", () => {
    expect(buildTrustedHostnames(["mailto:user@example.com", "javascript:alert(1)"])).toEqual([]);
  });
});
