/**
 * 上游 d7806a79：各站 officialGroupPattern 按 ccf-2012/torsummary 的 groups 列表补齐，
 * 统一写成 `[@-]\s?(...)\b`。这里用真实格式的标题验证：
 * - `-组名` 与 `@站名` 两种署名都能命中（原 `-(hds|.*@HDSky)` 把 @ 分支绑在连字符上）；
 * - 结尾的 `\b` 挡住前缀碰撞（如 `-HDSpace` 不算 HDSky 的 `HDS`）；
 * - 搜索热路径（offscreen/utils/search.ts）会去掉 g/y 后复用正则，这里同样逐个 `.test()`。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

const cases: Record<string, { hit: string[]; miss: string[] }> = {
  hdsky: {
    hit: ["Movie.2024.1080p.BluRay.x264-HDS", "Show.S01.2160p.WEB-DL.H265-HDSWEB", "Movie 2024 1080p@HDSky"],
    miss: ["Movie.2024.1080p.BluRay.x264-HDSpace", "Movie.2024.1080p.BluRay.x264-FRDS"],
  },
  audiences: {
    hit: ["Movie.2024.1080p.WEB-DL.H264-ADWeb", "Album.2024.FLAC-ADMusic", "Movie.2024@Audies"],
    miss: ["Movie.2024.1080p.WEB-DL.H264-ADEPT"],
  },
  ourbits: {
    hit: ["Movie.2024.1080p.BluRay.x264-Ao", "Show.S01.1080p.WEB-DL-OurTV", "Movie.2024.1080p-iLoveHD"],
    miss: ["Movie.2024.1080p.BluRay.x264-Aoki"],
  },
  chdbits: {
    hit: ["Movie.2024.1080p.BluRay.x264-CHD", "Show.S01.1080p.WEB-DL-CHDWEB", "Movie.2024-StBOX"],
    miss: ["Movie.2024.1080p.BluRay.x264-CHDragon"],
  },
  springsunday: {
    hit: ["Movie.2024.1080p.BluRay.x265.10bit-CMCT", "Show.S01.1080p-CMCTV", "Movie.2024-Oldboys"],
    miss: ["Movie.2024.1080p.BluRay-CMCTS"],
  },
  tlfbits: {
    hit: ["Movie.2024.720p.BluRay.x264-MiniHD-TLF", "Movie.2024.DVDRip-iNT-TLF", "Movie.2024-TLF"],
    miss: ["Movie.2024.1080p-TLFX"],
  },
  totheglory: {
    hit: ["Movie.2024.1080p.BluRay.x264-WiKi", "Movie.2024.1080p-TTG", "Movie.2024@TTG"],
    miss: ["Movie.2024.1080p-WiKiPedia"],
  },
  btschool: {
    hit: ["Movie.2024.1080p.BluRay.x264-BtsHD", "Show.S01.1080p.WEB-DL-BtsTV", "Movie.2024-Zone"],
    miss: ["Movie.2024.1080p-ZoneX"],
  },
};

describe("officialGroupPattern（上游 d7806a79，对照 torsummary）", () => {
  for (const [siteId, { hit, miss }] of Object.entries(cases)) {
    it(`${siteId}：官组署名命中，前缀碰撞不命中`, async () => {
      const { siteMetadata } = await import(`@ptd/site/definitions/${siteId}.ts`);
      const patterns = (siteMetadata.officialGroupPattern ?? []) as RegExp[];
      expect(patterns.length, siteId).toBeGreaterThan(0);
      const matches = (title: string) => patterns.some((pattern) => pattern.test(title));

      for (const title of hit) expect(matches(title), title).toBe(true);
      for (const title of miss) expect(matches(title), title).toBe(false);
    });
  }
});
