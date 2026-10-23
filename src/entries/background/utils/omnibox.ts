import { stringify } from "urlencode";

import type { IMetadataPiniaStorageSchema } from "@/shared/types.ts";
import { getExtStoragePathCached, openOptionsPage } from "@/background/utils/base.ts";

const splitString = " → ";

interface ISearchSolution {
  name: string;
  value: string;
}

const allSolution = {
  name: chrome.i18n.getMessage("searchPlanAll"),
  value: "all",
};

async function getSearchSolution(getAll = false) {
  // 只取需要的两个字段（走 SW 读缓存），避免每次输入都反序列化整份 metadata（见 docs/performance-audit.md P0-2）
  const solutions =
    ((await getExtStoragePathCached("metadata", ["solutions"], {})) as IMetadataPiniaStorageSchema["solutions"]) ?? {};
  const defaultSolutionId =
    ((await getExtStoragePathCached("metadata", ["defaultSolutionId"], "default")) as string) ?? "default";

  let solutionsList: ISearchSolution[] = Object.values(solutions)
    .filter((x) => !!x.enabled) // 过滤掉未启用的搜索方案
    .sort((a, b) => b.sort - a.sort) // 按照 sort 降序排序
    .map((x) => ({
      name: x.name,
      value: x.id,
    }));

  if (getAll || defaultSolutionId !== "default") {
    solutionsList = [allSolution, ...solutionsList];
  }

  if (!getAll) {
    solutionsList = solutionsList.slice(0, 5); // 只显示前 5 个搜索方案
  }

  return solutionsList;
}

chrome.omnibox?.onInputChanged.addListener(async (text, suggest) => {
  if (!text) return;

  const solutions = await getSearchSolution();
  let result: chrome.omnibox.SuggestResult[] = solutions.map((x) => ({
    content: `${x.name}${splitString}${text}`,
    description: chrome.i18n.getMessage("omniboxSearch", [x.name, text]),
  }));

  suggest(result);
});

/**
 * 解析地址栏输入（N4）。
 *
 * 建议项的 content 形如 `<方案名> → <搜索词>`，而搜索词本身可能包含 `" → "`（例如从别处复制带箭头的标题）。
 * 旧实现用 `text.split(splitString)` 后解构 `[solutionName, key]`，多于两段时只取前两段，
 * 箭头之后的真实搜索词被静默丢弃。这里只按**第一处**分隔符切分。
 */
export function splitOmniboxInput(text: string): { solutionName?: string; key: string } {
  const index = text.indexOf(splitString);
  if (index === -1) {
    return { key: text };
  }
  return {
    solutionName: text.slice(0, index),
    key: text.slice(index + splitString.length),
  };
}

// 当用户接收关键字建议时触发
chrome.omnibox?.onInputEntered.addListener(async (text) => {
  let solutionName = "";
  let solutionId = "default";
  let key = "";

  if (text.indexOf(splitString) != -1) {
    const solutions = await getSearchSolution(true);
    const parsed = splitOmniboxInput(text);
    solutionName = parsed.solutionName ?? "";
    key = parsed.key;

    let solution = solutions.find((item: ISearchSolution) => {
      return item.name == solutionName;
    });
    if (solution) {
      solutionId = solution.value;
    }
  } else {
    key = text;
  }

  // 按关键字进行搜索
  openOptionsPage({ path: "/search-entity", query: { search: key, plan: solutionId, flush: 1 } });
});
