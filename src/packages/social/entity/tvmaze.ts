import axios from "axios";
import {
  IFetchSocialSiteInformationConfig,
  ISocialInformation,
  ISocialSitePageInformation,
  TSupportSocialSitePageParserMatches,
} from "../types";
import { commonParseFactory } from "../utils.ts";

const tvmazeUrlPattern = /^(?:https?:\/\/)?(?:www\.)?tvmaze\.com\/shows\/(\d+)(?:\/[^\/]+)?\/?$/;

export function build(id: string): string {
  return `https://www.tvmaze.com/shows/${id}`;
}

export const parse = commonParseFactory([tvmazeUrlPattern]);

export const pageParserMatches: TSupportSocialSitePageParserMatches = [
  [
    tvmazeUrlPattern,
    (doc: Document): ISocialSitePageInformation => {
      const titles = [] as string[];
      const showName = doc.querySelector("h1.show-for-medium");
      if (showName) {
        titles.push(showName.textContent.trim());
      }
      return {
        site: "tvmaze",
        id: parse(doc.URL),
        titles,
      };
    },
  ],
];

interface ITVMazeApiResp {
  id: number;
  url: string;
  name: string;
  type: string;
  language: string;
  premiered: string | null;
  ended: string | null;
  rating: {
    average: number | null;
  };
  image: {
    medium: string | null;
    original: string | null;
  };
  externals: {
    tvrage: number | null;
    thetvdb: number | null;
    imdb: string | null;
  };
}

export async function fetchInformation(
  id: string,
  config: IFetchSocialSiteInformationConfig = {},
): Promise<ISocialInformation> {
  const realId = parse(String(id));
  const resDict = {
    site: "tvmaze",
    id: realId,
    title: "",
    poster: "",
    ratingScore: 0,
    // ratingCount: 0, // 网页存在该信息，但 API 未提供
    createAt: 0,
  } as ISocialInformation;

  try {
    // SERVERSSOCIAL-7：parse 的作用就是把「https://www.tvmaze.com/shows/1234/xxx」这类输入归一化成
    // 数字 id；旧实现只把 realId 写进 resDict.id，请求仍用未归一化的原始 id，
    // 拼出 /shows/https://… 必然 404 后静默返回空信息。与其余 5 个同族实现一致使用 realId。
    const { data } = await axios.get<ITVMazeApiResp>(`https://api.tvmaze.com/shows/${realId}`, {
      timeout: config.timeout ?? 10e3,
      responseType: "json",
    });

    resDict.title = data.name;
    resDict.poster = data.image.medium ?? data.image.original ?? "";
    resDict.ratingScore = data.rating.average ?? 0;
  } catch (error) {
    console.warn(error);
  } finally {
    resDict.createAt = +Date.now();
  }

  return resDict;
}
