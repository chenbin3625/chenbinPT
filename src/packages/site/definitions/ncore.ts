/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/ncore.yml
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/ncore.json
 */
import type { ISiteMetadata } from "../types";
import { parseTimeToLiveToDate } from "../utils/datetime.ts";

export const siteMetadata: ISiteMetadata = {
  id: "ncore",
  version: 1,
  name: "nCore",
  tags: ["匈牙利"],
  collaborator: ["haowenwu"],
  type: "private",
  urls: ["uggcf://apber.ceb/"],

  userInfo: {
    pickLast: ["id"],

    process: [
      {
        requestConfig: { url: "/profile.php" },
        selectors: {
          id: {
            selector: "input[data-uid]",
            attr: "data-uid",
          },
          name: {
            selector: "#profil_nev > span",
          },
          levelName: {
            selector: "#profil_rang > nobr",
            filters: [{ name: "replace", args: [/[()]/g, ""] }], // D-36 同型：原先传的是字面字符串 "/()/"
          },
          joinTime: {
            selector: ["div.userbox_tartalom_mini:nth-child(2) > div:nth-child(2) span"],
            attr: "title",
            filters: [{ name: "parseTime" }],
          },
          lastAccessAt: {
            selector: ["#profil_left .userbox_tartalom_mini > div:nth-child(4) span"],
            filters: [
              (query: string) => {
                const text = String(query).trim();
                if (/épp itt van/i.test(text)) return Date.now();
                const normalized = text
                  .replace(/(\d+)\s*éve?/gi, "$1 years")
                  // D-20：「X hónapja」（X 个月前）原先没有归一化，parseTimeToLiveToDate 会原样返回匈牙利文本
                  .replace(/(\d+)\s*hónapja?/gi, "$1 months")
                  .replace(/(\d+)\s*hete?/gi, "$1 weeks")
                  .replace(/(\d+)\s*napja?/gi, "$1 days")
                  .replace(/(\d+)\s*órája?/gi, "$1 hours")
                  .replace(/(\d+)\s*perce?/gi, "$1 minutes");
                return parseTimeToLiveToDate(normalized);
              },
            ],
          },
          uploaded: {
            selector: ["div.userbox_tartalom_mini:nth-child(2) > div:nth-child(8) span"],
            filters: [{ name: "parseSize" }],
          },
          // L7（延期）：本站缺少 downloaded（进而是 IUserInfo.ratio）。ncore 资料页的下载量行
          // 大概是 uploaded(8)/bonus(10) 之间的 nth-child(9)，但仓库与上游（PT-Plugin-Plus / pt_mate /
          // pre-dessert-sites）都没有该字段的真实选择器证据，按 brief 不猜 nth-child 选择器。
          // 待抓取一次已登录的 /profile.php 后，在同一 userbox 内补 downloaded（parseSize）
          // 与 ratio 选择器；在此之前分享率由 UI 侧兜底显示。
          bonus: {
            selector: ["div.userbox_tartalom_mini:nth-child(2) > div:nth-child(10)"],
            filters: [{ name: "parseNumber" }],
          },
        },
      },
    ],
  },

  levelRequirements: [
    {
      id: 1,
      name: "Felhasználó",
    },
    {
      id: 2,
      name: "Tag",
      interval: "P26W",
      uploaded: "250GB",
    },
    {
      id: 3,
      name: "Elite",
      interval: "P52W",
      uploaded: "1TB",
    },
    {
      id: 4,
      name: "Legend",
      interval: "P52W",
      uploaded: "1TB",
    },
    // L7：原先这里还有一条 { id: 5, name: "VAGY", uploaded: "10TB" }。`VAGY` 是匈牙利语的「或」，
    // 站点规则写作「… VAGY 10TB」（二者满足其一），它不是等级：原先会让等级面板出现假等级，
    // 且 getNextLevelUnMet 把「Legend → VAGY(10TB)」当成升级路径。该条目的 10TB 门槛与 Legend 的
    // 1TB 无法用 alternative 表达为更严格条件（10TB 蕴含 1TB，合并后是空操作），故直接删除。
    // 待用站点规则页核对 Legend 的真实组合门槛后再补 alternative。
  ],
};
