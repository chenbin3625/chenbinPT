import {
  ETorrentStatus,
  NoUserInputError,
  type IAdvancedSearchRequestConfig,
  type ISearchInput,
  type ISiteMetadata,
  type ITorrent,
  type ITorrentTag,
} from "../types";
import Unit3D, { SchemaMetadata } from "../schemas/Unit3D.ts";
import { get, set } from "es-toolkit/compat";
import type { AxiosRequestConfig, AxiosResponse } from "axios";

const categoryMap: Record<number, string> = {
  1: "Movie",
  2: "TV",
};

const typeMap: Record<number, string> = {
  1: "DISC",
  2: "REMUX",
  3: "WEB",
  15: "ENCODE",
};

const resolutionMap: Record<number, string> = {
  1: "4320p",
  2: "2160p",
  3: "1080p",
  4: "1080i",
  5: "720p",
  6: "576p",
  7: "576i",
  11: "540p",
  8: "480p",
  9: "480i",
  10: "Other",
};

function getHunoApiValue(row: object, paths: string[], fallback: unknown = ""): unknown {
  for (const path of paths) {
    const value = get(row, path);
    if (value && typeof value !== "object") {
      return value;
    }
  }

  return fallback;
}

function getHunoApiSubTitle(row: object): string {
  const values = [
    getHunoApiValue(row, ["release_year", "attributes.release_year"]),
    getHunoApiValue(row, ["resolution.name", "resolution", "attributes.resolution.name", "attributes.resolution"]),
    getHunoApiValue(row, ["type.name", "type", "attributes.type.name", "attributes.type"]),
    getHunoApiValue(row, ["video_codec.name", "video_codec", "attributes.video_codec.name", "attributes.video_codec"]),
    getHunoApiValue(row, ["source_type.name", "source_type", "attributes.source_type.name", "attributes.source_type"]),
  ];

  return values.filter(Boolean).map(String).join(" / ");
}

function getHunoApiTagText(row: object, paths: string[]): string {
  const values = paths.map((path) => get(row, path)).filter((value) => value !== undefined && value !== null);

  return values
    .flatMap((value) => {
      if (Array.isArray(value)) {
        return value.map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item)));
      }

      return typeof value === "object" ? JSON.stringify(value) : String(value);
    })
    .join(" ");
}

function collectHunoApiFields(value: unknown, path: string = ""): Array<{ path: string; value: string }> {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectHunoApiFields(item, `${path}.${index}`));
  }

  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      collectHunoApiFields(child, path ? `${path}.${key}` : key),
    );
  }

  return [{ path, value: String(value) }];
}

function isHunoTruthyFreeValue(value: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue || ["false", "0", "no", "none", "null", "undefined", "n/a"].includes(normalizedValue)) {
    return false;
  }

  return (
    /^(true|1|yes|free|freeleech|100|100\.0|100%)$/.test(normalizedValue) ||
    /100%\s*free|freeleech/.test(normalizedValue)
  );
}

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,

  version: 2,
  id: "huno",
  name: "HUNO",
  description: "HAWKE-UNO IS A HAWKE-ONE SERVICE POWERED BY UNIT3D.",
  tags: ["影视", "综合"],

  type: "private",
  schema: "Unit3D",

  urls: ["uggcf://unjxr.hab/"],

  collaborator: ["fzlins", "hui-shao"],

  userInputSettingMeta: [
    {
      name: "token",
      label: "Token",
      hint: "在 /users/用户名/hub/settings/security 获取 API Token 并填入此处",
      required: true,
    },
  ],

  category: [
    {
      name: "分类",
      key: "categories",
      keyPath: "params",
      options: Object.entries(categoryMap).map(([value, name]) => ({ name, value: Number(value) })),
      cross: { mode: "brackets" }, // 注：站点构造为 &categories[0]=1&categories[1]=2
    },
    {
      name: "编码",
      key: "types",
      keyPath: "params",
      options: Object.entries(typeMap).map(([value, name]) => ({ name, value: Number(value) })),
      cross: { mode: "brackets" },
    },
    {
      name: "分辨率",
      key: "resolutions",
      keyPath: "params",
      options: Object.entries(resolutionMap).map(([value, name]) => ({ name, value: Number(value) })),
      cross: { mode: "brackets" },
    },
    {
      name: "促销状态",
      key: "free", // 并不是真实的 key
      keyPath: "params",
      options: [
        { name: "免费", value: 1 }, // 不是真实 value，仅用于区分，在后续的 generateRequestConfig 处理
        { name: "非免费", value: 2 },
      ],
      cross: { mode: "custom" },
      generateRequestConfig: (selectedOptions) => {
        const ret = { requestConfig: { params: {} } };
        (selectedOptions as number[]).forEach((value) => {
          if (value == 1) set(ret.requestConfig.params, "free", true);
          else if (value == 2) set(ret.requestConfig.params, "notFree", true);
        });
        return ret as IAdvancedSearchRequestConfig;
      },
    },
  ],

  search: {
    ...SchemaMetadata.search,
    keywordPath: "params.name",
    requestConfig: {
      url: "/api/torrents/filter",
      responseType: "json",
      params: {
        perPage: 100,
      },
    },
    advanceKeywordParams: {
      imdb: {
        requestConfigTransformer: ({ requestConfig: config }) => {
          if (config?.params?.name) {
            config.params.imdbId = config.params.name;
            delete config.params.name;
          }
          return config!;
        },
      },
    },
    skipNonLatinCharacters: true,
    selectors: {
      rows: { selector: ["data.data", "data", "torrents.data", "torrents"] },
      id: {
        selector: ["id", "attributes.id"],
      },
      title: {
        selector: ["name", "attributes.name"],
      },
      subTitle: {
        selector: ":self",
        filters: [getHunoApiSubTitle],
      },
      url: {
        selector: ":self",
        filters: [(row: object) => `/torrents/${getHunoApiValue(row, ["id", "attributes.id"])}`],
      },
      link: {
        selector: ["download_link", "attributes.download_link"],
      },
      category: {
        selector: ":self",
        filters: [(row: object) => getHunoApiValue(row, ["category.name", "attributes.category.name"], "All")],
      },
      size: { selector: ["size", "attributes.size"] },
      // D-19：与同引擎的 concertos 一致先 parseTime —— 字符串时间直接交给 parseTimeWithZone 会按宿主时区解释
      time: {
        selector: ["created_at", "attributes.created_at", "bumped_at", "attributes.bumped_at"],
        filters: [{ name: "parseTime" }],
      },
      author: {
        selector: ["uploader.username", "uploader.name", "attributes.uploader.username", "attributes.uploader.name"],
      },
      seeders: {
        selector: ["seeders", "attributes.seeders"],
      },
      leechers: {
        selector: ["leechers", "attributes.leechers"],
      },
      completed: { selector: ["times_completed", "attributes.times_completed", "completed", "attributes.completed"] },
      comments: { text: 0 }, // not provided

      // DEFS2-4：搜索走 /api/torrents/filter（responseType json），行是普通对象，
      // getFieldData 只在 element instanceof Node 时求值 case → 原先这里的 DOM selector + case 永不生效，
      // 状态/进度只能保持引擎缺省值（UNIT3D 的 TorrentResource 不含账号维度的做种/进度字段，无法从载荷推算）。
      status: {
        text: ETorrentStatus.unknown,
      },
      // 站点似乎不提供 progress
      progress: {
        text: 0,
      },

      // DEFS2-2 收尾：这块 DOM selector 对本站 JSON 行（responseType: json）本就不生效，故整体保持注释（DEFS2-4）。
      // 原数组里的 { name: "H&R", selector: "*", color: "red" } 是上游 fb79a2a7「add default H&R tags with
      // red color for global sites」(PR #336) 给全站 H&R 站点加的默认标签，整块注释后 H&R 实际丢失；且 JSON 行
      // 无法被 selector "*" 命中（AbstractBittorrentSite 对对象行走 get(row, "*")，恒为 undefined），
      // 因此 H&R 已改到本类 parseTorrentRowForTags 末尾无条件补上（见该方法内 H&R 注释）。
      // tags: [ // todo
      //   { name: "Free", selector: "i.far.fa-gift", color: "#c149ab" },
      //   { name: "Pack", selector: "i.far.fa-folder-heart", color: "#e3747a" },
      //   { name: "Plex", selector: "i.far.fa-play", color: "#f39c12" },
      //   { name: "Internal", selector: "i.far.fa-bolt", color: "#b793f0" },
      //   { name: "Worthy", selector: "i.far.fa-medal", color: "#00c07f" },
      //   { name: "Sticky", selector: "i.far.fa-thumbtack", color: "#d32f2f" },
      // ],
    },
  },

  noLoginAssert: {
    ...SchemaMetadata.noLoginAssert,
    urlPatterns: [/doLogin|login|verify|checkpoint|returnto|twofactor/gi],
  },

  userInfo: {
    pickLast: ["name", "id"],
    selectors: {
      ...SchemaMetadata.userInfo!.selectors,
      // page '/api/profile'
      name: { selector: "data.username" },
      levelName: { selector: "data.group" },
      joinTime: {
        selector: "data.member_since",
        filters: [{ name: "parseTime" }],
      },
      uploaded: { selector: "data.uploaded" },
      downloaded: { selector: "data.downloaded" },
      bonus: { selector: "data.hunos" },
      seeding: { selector: "data.active_seeds" },
      leeching: { selector: "data.active_leeches" },
      hnrUnsatisfied: { selector: "data.hit_and_runs" },
      // hnrPreWarning: { // todo, not provided by site?
      //   // 考核中的 HR
      //   selector: ["div[view='unsatisfieds'] tbody"],
      //   elementProcess: (element: Element) => {
      //     const length = element.querySelectorAll("tr.userFiltered[hr='0'][immune='0']").length;
      //     return length > 0 ? length : 0;
      //   },
      // },

      // page '/'
      id: {
        selector: ["span.deep-space-user-card__user-id"],
        filters: [
          (query: string) => {
            const queryMatch = query.match(/\d+/);
            return queryMatch ? parseInt(queryMatch[0], 10) : 0;
          },
        ],
      },
      uploads: {
        selector: ["div.ds-user-stats span[title*='Uploads']"],
        filters: [{ name: "split", args: ["/", 0] }, { name: "trim" }, { name: "parseNumber" }],
      },
      seedingSize: {
        selector: ["div.ds-user-stats span[title*='Seeding Size']"],
        filters: [{ name: "parseSize" }],
      },
      messageCount: {
        text: 0,
        selector: ["div.ds-user-stats a[href*='/hub/messages'] > span.ds-count"],
        elementProcess: (element: Element) => {
          const icon = element.querySelector("i");
          if (!icon) {
            return 0;
          }

          const squareClass = Array.from(icon.classList).find((cls) => /^fa-square-\d+$/.test(cls));
          if (!squareClass) {
            return 11;
          }

          return parseInt(squareClass.replace("fa-square-", ""), 10) || 11;
        },
      },

      // page '/users/$name$/hub/hunos'
      bonusPerHour: {
        selector: ["table.deep-space-similar-table > tfoot td.tw-font-bold[style*=color]"],
        filters: [{ name: "parseNumber" }],
      },
    },
    process: [
      {
        requestConfig: { url: "/api/profile", method: "GET", responseType: "json" },
        fields: [
          "name",
          "levelName",
          "joinTime",
          "uploaded",
          "downloaded",
          "bonus",
          "seeding",
          "leeching",
          "hnrUnsatisfied",
        ],
      },
      {
        requestConfig: { url: "/", method: "GET", responseType: "document" },
        fields: ["id", "uploads", "seedingSize", "messageCount"],
      },
      {
        requestConfig: { url: "/users/$name$/hub/hunos", responseType: "document" },
        assertion: { name: "url" },
        fields: ["bonusPerHour"],
      },
    ],
  },

  levelRequirements: [
    {
      id: 1,
      name: "Silent Sisters",
      privilege: "Can download",
    },
    {
      id: 2,
      name: "Iron Fleet",
      privilege: "Can upload; Can request",
    },
    {
      id: 3,
      name: "White Walkers",
      privilege: "RSS; IRC Server; IRC Announce; Upload API; Can apply for hawke-one Discord access",
    },
    {
      id: 4,
      name: "Dothraki",
      privilege: "Listed uploads; HnR immunity",
    },
    {
      id: 5,
      name: "Unsullied",
      privilege:
        "Can invite; Can see peers; Trusted uploader; Worthy; hawke-one Discord invite; Unsullied on hawke-one Discord with added perks",
    },
    {
      id: 6,
      name: "Targaryen",
      privilege: "Internal; Custom branding; Targaryen on hawke-one Discord with added perks",
    },
  ],
};

/** 行内文本判定的正则常量：提到模块级，避免每个种子行重复构造（见 docs/performance-audit.md P1-15） */
const HUNO_SUBTITLE_FIELD_PATH_RE = /sub(title)?|caption/i;
const HUNO_AUDIO_FIELD_PATH_RE = /audio|dub|language|media_language/i;
const HUNO_FREE_FIELD_PATH_RE = /free|freeleech|discount|promo|promotion/i;
const HUNO_CHINESE_LANGUAGE_RE = /Chinese|Mandarin|Cantonese|中文|中字|简体|繁体|国语|国配|粤语|粤配/i;
const HUNO_CHINESE_SUB_TITLE_RE = /中字|中文|简体|繁体|CHS|CHT|CHN|Chinese\s*Sub/i;
const HUNO_SUBBED_RE = /SUBBED/i;
const HUNO_SUB_FIELD_RE = /sub(title)?|caption/i;
const HUNO_MANDARIN_RE = /Mandarin|Chinese|国语|国配|普通话|中配/i;
const HUNO_CANTONESE_RE = /Cantonese|粤语|粤配/i;
const HUNO_CHINESE_SHORT_RE = /Chinese|Mandarin|Cantonese|中文|中字|简体|繁体/i;
const HUNO_DUBBED_RE = /DUBBED/i;

export default class Huno extends Unit3D {
  protected override parseTorrentRowForTags(
    torrent: Partial<ITorrent>,
    row: object,
    searchConfig: ISearchInput,
  ): Partial<ITorrent> {
    const extendTorrent = super.parseTorrentRowForTags(torrent, row, searchConfig);
    const tags: ITorrentTag[] = extendTorrent.tags || [];

    const addTag = (tag: ITorrentTag) => {
      if (!tags.some((existsTag) => existsTag.name === tag.name)) {
        tags.push(tag);
      }
    };

    const titleText = getHunoApiTagText(row, ["name", "attributes.name"]);
    const rowFields = collectHunoApiFields(row);
    const rowText = rowFields.map(({ path, value }) => `${path}:${value}`).join(" ");
    const releaseTagText = getHunoApiTagText(row, [
      "release_tag",
      "release_tag.name",
      "release_tag.abbreviation",
      "attributes.release_tag",
      "attributes.release_tag.name",
      "attributes.release_tag.abbreviation",
    ]);
    const mediaLanguageText = getHunoApiTagText(row, [
      "media_language",
      "media_language.name",
      "media_language.abbreviation",
      "attributes.media_language",
      "attributes.media_language.name",
      "attributes.media_language.abbreviation",
    ]);
    const audioText = getHunoApiTagText(row, [
      "audio",
      "audios",
      "audio_language",
      "audio_languages",
      "attributes.audio",
      "attributes.audios",
      "attributes.audio_language",
      "attributes.audio_languages",
    ]);
    const subtitleText = getHunoApiTagText(row, [
      "subtitle",
      "subtitles",
      "subtitle_language",
      "subtitle_languages",
      "attributes.subtitle",
      "attributes.subtitles",
      "attributes.subtitle_language",
      "attributes.subtitle_languages",
    ]);

    // 单次遍历完成「字幕字段文本 / 音频字段文本 / 免费判定」，
    // 替代原先 3 次独立的 filter + map（每行都会遍历整个 rowFields 数组）
    const subtitleFieldValues: string[] = [];
    const audioFieldValues: string[] = [];
    let isFree = false;
    for (const { path, value } of rowFields) {
      if (HUNO_SUBTITLE_FIELD_PATH_RE.test(path)) {
        subtitleFieldValues.push(value);
      }
      if (HUNO_AUDIO_FIELD_PATH_RE.test(path)) {
        audioFieldValues.push(value);
      }
      if (!isFree && HUNO_FREE_FIELD_PATH_RE.test(path) && isHunoTruthyFreeValue(value)) {
        isFree = true;
      }
    }
    const subtitleFieldText = subtitleFieldValues.join(" ");
    const audioFieldText = audioFieldValues.join(" ");
    const combinedText = [
      titleText,
      releaseTagText,
      mediaLanguageText,
      audioText,
      subtitleText,
      subtitleFieldText,
      audioFieldText,
    ].join(" ");
    if (
      HUNO_CHINESE_LANGUAGE_RE.test(subtitleText) ||
      HUNO_CHINESE_LANGUAGE_RE.test(subtitleFieldText) ||
      HUNO_CHINESE_SUB_TITLE_RE.test(titleText) ||
      (HUNO_SUBBED_RE.test(releaseTagText) && HUNO_CHINESE_LANGUAGE_RE.test(rowText)) ||
      (HUNO_SUB_FIELD_RE.test(rowText) && HUNO_CHINESE_LANGUAGE_RE.test(rowText))
    ) {
      addTag({ name: "中字" });
    }

    if (HUNO_MANDARIN_RE.test([mediaLanguageText, audioText, titleText].join(" "))) {
      addTag({ name: "国语" });
    }

    if (HUNO_CANTONESE_RE.test([mediaLanguageText, audioText, titleText].join(" "))) {
      addTag({ name: "粤语" });
    }

    if (
      HUNO_CHINESE_SHORT_RE.test(subtitleFieldText) ||
      (HUNO_SUBBED_RE.test(releaseTagText) && HUNO_CHINESE_SHORT_RE.test(rowText))
    ) {
      addTag({ name: "中字" });
    }

    if (
      HUNO_MANDARIN_RE.test(audioFieldText) ||
      (HUNO_DUBBED_RE.test(releaseTagText) && HUNO_MANDARIN_RE.test(rowText))
    ) {
      addTag({ name: "国语" });
    }

    if (HUNO_CANTONESE_RE.test(audioFieldText)) {
      addTag({ name: "粤语" });
    }

    if (isFree) {
      addTag({ name: "Free" });
    }

    // DEFS2-2 收尾（统一判据：站点是否全站 H&R）：本站属上游 fb79a2a7「feat: add default H&R tags with red
    // color for global sites」(PR #336) 明确列出的全站 H&R 站点——站点规则对**全部**下载都规定 H&R 义务，
    // 故对每一行无条件贴 H&R（与 beyondhd/torrentleech 的恒真语义一致，属刻意设计）。
    // 这里不能用恒真 selector:"*"：本站搜索走 /api/torrents/filter（JSON），行是普通对象，
    // AbstractBittorrentSite 对对象行走 get(row, "*") 恒为 undefined，配置层恒真标签永远不会命中。
    addTag({ name: "H&R", color: "red" });

    extendTorrent.tags = tags;
    return extendTorrent;
  }

  public override async request<T>(
    axiosConfig: AxiosRequestConfig,
    checkLogin: boolean = true,
  ): Promise<AxiosResponse<T>> {
    const token = this.userConfig.inputSetting?.token;
    if (!token) {
      throw new NoUserInputError("Token"); // 未填写 Token 时直接拦截，避免请求被误判为需要登录
    }

    // add token to headers
    axiosConfig.headers = {
      ...(axiosConfig.headers ?? {}),
      "X-Api-Token": token,
      origin: this.url,
    };

    return super.request<T>(axiosConfig, checkLogin);
  }
}
