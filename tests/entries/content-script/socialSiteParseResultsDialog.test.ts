/**
 * content-script/app/components/SocialSiteParseResultsDialog.vue
 *
 * 真实挂载对话框（antd 弹层会 Teleport 到 body）。为避开 antd 列表/折叠的复杂渲染，
 * 把 ParseResultListItem 换成捕获 props 的 stub：本文件断言的是父组件「传给每一行的内容」
 * 与「空状态 / 折叠标题」这些用户可见结果。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountOptionsView } from "../../helpers/optionsView.ts";

const parseRows = vi.hoisted(() => [] as Array<Record<string, any>>);
const metadataState = vi.hoisted(() => ({
  ready: true,
  defaultSolutionId: "default",
  solutions: [] as Array<Record<string, any>>,
}));

vi.mock("@/content-script/app/components/ParseResultListItem.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "ParseResultListItemStub",
      props: {
        title: { type: String, default: "" },
        tagText: { type: String, default: "" },
        tagColor: { type: String, default: undefined },
        keyword: { type: String, default: "" },
        searchPlan: { type: String, default: "default" },
        searchPlans: { type: Array, default: () => [] },
      },
      setup(props) {
        parseRows.push({
          title: props.title,
          tagText: props.tagText,
          keyword: props.keyword,
          searchPlan: props.searchPlan,
          searchPlans: (props.searchPlans as Array<{ id: string }>).map((plan) => plan.id),
        });
        return () => h("div", { class: "stub-parse-row" }, `${props.title} [${props.tagText}]`);
      },
    }),
  };
});

vi.mock("@/options/stores/metadata.ts", () => ({
  useMetadataStore: () => ({
    get $ready() {
      return metadataState.ready;
    },
    get getSearchSolutions() {
      return metadataState.solutions;
    },
    get defaultSolutionId() {
      return metadataState.defaultSolutionId;
    },
  }),
}));

type ParseResult = {
  site: string;
  id: string;
  titles: string[];
  external_ids?: Record<string, string>;
  pageCategory?: "season_list" | "season_detail";
  seriesTitle?: string;
  entryTitle?: string;
};

const t = (await import("@/options/plugins/i18n.ts")).i18nInstance.global.t;

async function mountDialog(parseResults: ParseResult[], socialSite: string) {
  const { default: Dialog } = await import("@/content-script/app/components/SocialSiteParseResultsDialog.vue");
  const view = mountOptionsView(Dialog, {
    props: { modelValue: true, parseResults, searchPlan: "default" },
    plugins: [
      {
        install(app) {
          app.provide("ptd_data", { socialSite });
        },
      },
    ],
  });
  await view.settle(80);
  return view;
}

beforeEach(() => {
  document.body.innerHTML = "";
  parseRows.length = 0;
  metadataState.ready = true;
  metadataState.defaultSolutionId = "default";
  metadataState.solutions = [];
});

describe("SocialSiteParseResultsDialog", () => {
  it("parseResults 为空时显示空状态占位", async () => {
    const view = await mountDialog([], "tmdb");
    try {
      expect(document.body.textContent).toContain(t("contentScript.parseResultEmpty"));
      expect(parseRows).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });

  it("非 tmdb 页面渲染 site id、external_ids 与全部标题", async () => {
    const view = await mountDialog(
      [
        {
          site: "imdb",
          id: "tt0111161",
          titles: ["The Shawshank Redemption", "Shawshank"],
          external_ids: { tmdb: "278" },
        },
      ],
      "imdb",
    );
    try {
      const keywords = parseRows.map((row) => row.keyword);
      expect(keywords).toContain("imdb|tt0111161");
      expect(keywords).toContain("tmdb|278");
      expect(keywords).toContain("The Shawshank Redemption");
      expect(keywords).toContain("Shawshank");

      const text = document.body.textContent ?? "";
      expect(text).toContain("imdb: tt0111161");
      expect(text).toContain("tmdb: 278");
      expect(text).toContain("The Shawshank Redemption");
      // 非 tmdb 的 season_list 不应折叠标题
      expect(document.querySelector(".ant-collapse")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("tmdb + season_list：折叠标题按 entryTitle/默认单季生成，只有首行展示 id / 外部 id / 系列名", async () => {
    const view = await mountDialog(
      [
        {
          site: "tmdb",
          id: "100",
          titles: ["Season 1", "Season 2"],
          external_ids: { imdb: "tt9" },
          pageCategory: "season_list",
          entryTitle: "My Show",
          seriesTitle: "Series Root",
        },
        {
          site: "tmdb",
          id: "200",
          titles: ["Season 3"],
          external_ids: { imdb: "tt10" },
          pageCategory: "season_list",
        },
      ],
      "tmdb",
    );
    try {
      const keywords = parseRows.map((row) => row.keyword);
      // 首行的 site id / 外部 id / 系列名
      expect(keywords).toContain("tmdb|100");
      expect(keywords).toContain("imdb|tt9");
      expect(keywords).toContain("Series Root");
      // 第二行不再重复展示这些行
      expect(keywords).not.toContain("tmdb|200");
      expect(keywords).not.toContain("imdb|tt10");

      const headers = Array.from(document.querySelectorAll(".ant-collapse-header")).map((element) =>
        element.textContent?.trim(),
      );
      expect(headers).toContain(
        `${t("contentScript.SocialSiteParseResultsDialog.searchEntryTitle", { title: "My Show" })} (2)`,
      );
      expect(headers).toContain(
        `${t("contentScript.SocialSiteParseResultsDialog.searchEntryTitle", { title: t("contentScript.SocialSiteParseResultsDialog.defaultSeasonTitle") })} (1)`,
      );
    } finally {
      view.unmount();
    }
  });

  it("tmdb 的非 season_list 页面不折叠，标题逐条渲染", async () => {
    const view = await mountDialog(
      [
        {
          site: "tmdb",
          id: "300",
          titles: ["Movie Title"],
          pageCategory: "season_detail",
        },
      ],
      "tmdb",
    );
    try {
      expect(document.querySelector(".ant-collapse")).toBeNull();
      expect(parseRows.map((row) => row.keyword)).toContain("Movie Title");
    } finally {
      view.unmount();
    }
  });

  it("只有存在启用的自定义搜索方案时才把方案菜单传给每一行", async () => {
    metadataState.solutions = [
      { id: "p2", name: "Plan 2", enabled: true, sort: 2 },
      { id: "p1", name: "Plan 1", enabled: true, sort: 1 },
      { id: "p3", name: "Plan 3", enabled: false, sort: 3 },
    ];
    const view = await mountDialog([{ site: "imdb", id: "1", titles: ["T"] }], "imdb");
    try {
      expect(parseRows.length).toBeGreaterThan(0);
      for (const row of parseRows) {
        expect(row.searchPlans).toEqual(["default", "p2", "p1"]);
      }
    } finally {
      view.unmount();
    }
  });

  it("没有启用的自定义方案（或 store 尚未就绪）时传空方案列表", async () => {
    metadataState.solutions = [{ id: "p1", name: "Plan 1", enabled: false, sort: 1 }];
    const first = await mountDialog([{ site: "imdb", id: "1", titles: ["T"] }], "imdb");
    try {
      expect(parseRows.length).toBeGreaterThan(0);
      for (const row of parseRows) {
        expect(row.searchPlans).toEqual([]);
      }
    } finally {
      first.unmount();
    }

    parseRows.length = 0;
    metadataState.solutions = [{ id: "p1", name: "Plan 1", enabled: true, sort: 1 }];
    metadataState.ready = false;
    const second = await mountDialog([{ site: "imdb", id: "1", titles: ["T"] }], "imdb");
    try {
      expect(parseRows.length).toBeGreaterThan(0);
      for (const row of parseRows) {
        expect(row.searchPlans).toEqual([]);
      }
    } finally {
      second.unmount();
    }
  });
});
