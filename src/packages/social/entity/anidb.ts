import axios from "axios";

/**
 * AniDB 的 HTTP API 是明文协议，且官方要求两次请求间隔至少 2 秒，超速会被临时封禁。
 * 多个条目并发解析时必须串行化 + 限速，而不是让 axios 直接并发打出。
 */
const ANIDB_MIN_REQUEST_INTERVAL = 2000;
let anidbRequestChain: Promise<unknown> = Promise.resolve();
let anidbLastRequestAt = 0;

function requestWithAniDbRateLimit<T>(task: () => Promise<T>): Promise<T> {
  const next = anidbRequestChain.then(async () => {
    const wait = Math.max(0, anidbLastRequestAt + ANIDB_MIN_REQUEST_INTERVAL - Date.now());
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    try {
      return await task();
    } finally {
      anidbLastRequestAt = Date.now();
    }
  });
  anidbRequestChain = next.catch(() => undefined);
  return next;
}
import { selectElements } from "../../site/utils/selector";
import { uniq } from "es-toolkit";

import { commonParseFactory, normalizeSocialPosterUrl } from "../utils";
import {
  IFetchSocialSiteInformationConfig,
  ISocialInformation,
  ISocialSitePageInformation,
  TSupportSocialSitePageParserMatches,
} from "../types";

const anidbUrlPattern = /(?:https?:\/\/)?(?:[\w-]+\.)?anidb\.net\/(?:a|anime\/)(\d+)/;

export function build(id: string): string {
  return `https://anidb.net/anime/${id}`;
}

export const parse = commonParseFactory([anidbUrlPattern]);

function pageParser$1(doc: Document): ISocialSitePageInformation {
  return {
    site: "anidb",
    id: parse(doc.URL),
    titles: uniq(
      selectElements("div.titles span[itemprop], label[itemprop]", doc)
        .map((x) => x.textContent)
        .filter(Boolean),
    ) as string[],
  };
}

export const pageParserMatches: TSupportSocialSitePageParserMatches = [[anidbUrlPattern, pageParser$1]];

export async function fetchInformation(
  id: string,
  config: IFetchSocialSiteInformationConfig = {},
): Promise<ISocialInformation> {
  const realId = parse(String(id));
  const resDict = {
    site: "anidb",
    id: realId,
    title: "",
    poster: "",
    ratingScore: 0,
    ratingCount: 0,
    createAt: 0,
  } as ISocialInformation;

  try {
    // 如果提供了 anidb 的 client 信息，则优先使用 anidb 的 API 获取信息
    if (config.socialSite?.anidb?.client) {
      // 我们默认 client 为 a-zA-Z 组成的字符串， clientver 默认为 1，如果 client 中包含了 /，则依次表示 client 和 clientver
      let client = config.socialSite.anidb.client;
      let clientver = 1;
      if (client.includes("/")) {
        const [clientName, clientVersion] = client.split("/");
        client = clientName;
        clientver = parseInt(clientVersion, 10);
      }

      const apiReq = await requestWithAniDbRateLimit(() =>
        axios.get("http://api.anidb.net:9001/httpapi", {
          params: { request: "anime", client, clientver, protover: 1, aid: realId },
          timeout: config.timeout ?? 10e3,
          responseType: "document",
        }),
      );
      resDict.title = uniq(
        selectElements("titles > title", apiReq.data)
          .map((x) => x.textContent)
          .filter(Boolean),
      ).join(" / ");
      const poster = selectElements("picture", apiReq.data)[0]?.textContent;
      if (poster) {
        resDict.poster = normalizeSocialPosterUrl("https://cdn.anidb.net/images/main/" + poster) ?? "";
      }
      const ratingAnother = selectElements("ratings permanent, temporary", apiReq.data)?.[0];
      if (ratingAnother) {
        resDict.ratingScore = parseFloat(ratingAnother.textContent ?? "0");
        resDict.ratingCount = parseInt(ratingAnother.getAttribute("count") ?? "0", 10);
      }
    } else {
      const htmlReq = await requestWithAniDbRateLimit(() =>
        axios.get(build(realId), { timeout: config.timeout ?? 10e3, responseType: "document" }),
      );

      resDict.title = pageParser$1(htmlReq.data).titles.join(" / ");
      resDict.poster =
        normalizeSocialPosterUrl(
          selectElements("meta[property='og:image'][content]", htmlReq.data)?.[0]?.getAttribute("content"),
        ) ?? "";
      resDict.ratingScore = parseFloat(
        selectElements('span[itemprop="ratingValue"]', htmlReq.data)?.[0]?.textContent ?? "0",
      );
      resDict.ratingCount = parseInt(
        selectElements('span[itemprop="ratingCount"]', htmlReq.data)?.[0]?.getAttribute("content") ?? "0",
        10,
      );
    }
  } catch (error) {
    console.warn(error);
  } finally {
    resDict.createAt = +Date.now();
  }

  return resDict;
}
