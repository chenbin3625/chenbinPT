/**
 * 辅种任务表格与其它列表页对齐（移植自上游 396b9925）。
 *
 * - 排序 / 分页走共享的 tableBehavior：默认每页 10 条、按创建时间倒序；改动后写回 configStore；
 *   「种子数」列按 items.length 排序；
 * - 工具条用共享的 NavButton，操作列是紧凑的 `.table-action` 按钮组；
 * - 斑马纹只按数据行计数：展开某一行（插入展开行）后，其后的隔行底色不应错位。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadOptionsStyles, mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

function makeTask(id: string, itemCount: number, time: number) {
  return {
    id,
    time,
    title: `task-${id}`,
    size: 1024,
    downloadOptions: { downloaderId: "d1", clientName: "QB", savePath: "/downloads" },
    items: Array.from({ length: itemCount }, (_, index) => ({
      site: "s1",
      title: `${id}-item-${index}`,
      link: `https://example.com/${id}/detail-${index}`,
      url: `https://example.com/${id}/download-${index}`,
      size: 1024,
    })),
  };
}

async function mountTable(tasks: ReturnType<typeof makeTask>[], configure?: (configStore: any) => void) {
  const pinia = prepareOptionsPinia();
  const { useConfigStore } = await import("@/options/stores/config.ts");
  const configStore = useConfigStore(pinia);
  // 测试 pinia 没有装持久化插件；updateTableBehavior 会在 saveTableBehavior 开启时调用 $save
  (configStore as any).$save = vi.fn(async () => {});
  configure?.(configStore);

  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async (type: string) => (type === "getKeepUploadTasks" ? tasks : undefined));

  const { default: KeepUploadTask } = await import("@/options/views/Overview/KeepUploadTask/Index.vue");
  const view = mountOptionsView(KeepUploadTask, { pinia });
  await view.settle(120);
  return { view, configStore };
}

const rowTitles = (view: { $$: (selector: string) => HTMLElement[] }) =>
  view.$$(".ant-table-tbody > tr.ant-table-row").map((row) => row.querySelector("a")?.textContent?.trim());

afterEach(() => {
  document.body.innerHTML = "";
});

describe("辅种任务表格：排序 / 分页", () => {
  it("默认按创建时间倒序、每页 10 条", async () => {
    const tasks = Array.from({ length: 12 }, (_, index) => makeTask(`t${index}`, 1, 1000 + index));
    const { view, configStore } = await mountTable(tasks);

    expect(configStore.tableBehavior.KeepUploadTask).toEqual({
      itemsPerPage: 10,
      sortBy: [{ key: "time", order: "desc" }],
    });
    const titles = rowTitles(view);
    expect(titles).toHaveLength(10);
    expect(titles[0]).toBe("task-t11");
    expect(titles[9]).toBe("task-t2");
    view.unmount();
  });

  it("点击「种子数」表头按 items.length 排序，并把排序写回 tableBehavior", async () => {
    const tasks = [makeTask("a", 3, 3), makeTask("b", 1, 2), makeTask("c", 2, 1)];
    const { view, configStore } = await mountTable(tasks);

    const countHeader = view
      .$$(".ant-table-thead th")
      .find((th) => th.textContent?.includes("种子数") || th.textContent?.includes("Torrents"))!;
    expect(countHeader, "应有「种子数」列").toBeDefined();
    countHeader.click();
    await view.settle(40);

    expect(configStore.tableBehavior.KeepUploadTask.sortBy).toEqual([{ key: "count", order: "asc" }]);
    expect(rowTitles(view)).toEqual(["task-b", "task-c", "task-a"]);
    view.unmount();
  });
});

describe("辅种任务表格：共享组件", () => {
  it("工具条使用 NavButton，操作列是紧凑的 .table-action 按钮组", async () => {
    const { view } = await mountTable([makeTask("a", 2, 1)]);

    const toolbar = view.$(".page-toolbar");
    expect(toolbar, "应使用共享的 page-toolbar 工具条").not.toBeNull();
    expect(toolbar!.querySelectorAll("button").length).toBe(2);

    const actionGroup = view.$(".ant-table-tbody .table-action");
    expect(actionGroup, "操作列应为 .table-action 按钮组").not.toBeNull();
    const actionButtons = Array.from(actionGroup!.querySelectorAll("button"));
    expect(actionButtons).toHaveLength(5);
    expect(actionButtons.every((button) => button.classList.contains("ant-btn-sm"))).toBe(true);
    view.unmount();
  });
});

describe("斑马纹只按数据行计数", () => {
  it("展开第 1 行后，第 2 / 4 条数据行仍带底色，第 1 / 3 条不带", async () => {
    loadOptionsStyles();
    const tasks = [makeTask("a", 2, 4), makeTask("b", 2, 3), makeTask("c", 2, 2), makeTask("d", 2, 1)];
    const { view } = await mountTable(tasks);

    view.$<HTMLElement>(".ant-table-tbody > tr.ant-table-row .ant-table-row-expand-icon")!.click();
    await view.settle(40);
    expect(view.$$(".ant-table-tbody > tr.ant-table-expanded-row").length, "第 1 行应已展开").toBe(1);

    const striped = view
      .$$(".ant-table-tbody > tr.ant-table-row")
      .map(
        (row) =>
          getComputedStyle(row).backgroundColor !== "" && getComputedStyle(row).backgroundColor !== "transparent",
      );
    expect(striped).toEqual([false, true, false, true]);
    view.unmount();
  });
});
