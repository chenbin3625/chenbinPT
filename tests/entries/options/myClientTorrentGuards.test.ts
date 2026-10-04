/**
 * MyClient 的「种子身份」相关缺陷回归测试。
 *
 * B-29：表格行 key 只用 record.id，而数据源是多个下载器的种子合并（qBittorrent 的 id 就是 info hash），
 *       同一个种子存在于两个下载器时行 key 撞键，antd 的 key→record 反查会把另一个下载器的种子
 *       放进 tableSelected，「删除并删除数据」等操作会打到用户没有选择的客户端。
 * B-30：TorrentDetailDialog 是复用实例，关闭时清空数据但无法取消在途请求；迟到的响应会把
 *       上一个种子的数据与「已加载」标记留给下一个种子（removeTracker / updateFilePriority 打错目标）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";

import { createTorrentLoadGuard, torrentKey } from "@/options/views/Overview/MyClient/utils.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

const repoRoot = resolve(import.meta.dirname, "../../..");
const readSource = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

const MY_CLIENT_INDEX = "src/entries/options/views/Overview/MyClient/Index.vue";
const TORRENT_DETAIL_DIALOG = "src/entries/options/views/Overview/MyClient/TorrentDetailDialog.vue";

/** 造一个只带 identity 字段的种子（torrentKey 只用到 clientId / id） */
const torrentOf = (clientId: string, id: string) => ({ clientId, id }) as any;

const SAME_HASH = "0123456789abcdef0123456789abcdef01234567";

describe("B-29：表格行 key 必须带下载器 ID", () => {
  it("同一个种子在两个下载器上产生两个唯一 key，按 key 反查得到所在一行的 clientId", () => {
    const rows = [torrentOf("qb-1", SAME_HASH), torrentOf("tr-2", SAME_HASH)];
    const keys = rows.map(torrentKey);

    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);

    // 复刻 antd 的 key → record 反查（es/table/hooks/useLazyKVMap.js + useSelection.js）
    const keyMap = new Map(rows.map((row) => [torrentKey(row), row]));
    expect(keyMap.get(keys[0])!.clientId).toBe("qb-1");
    expect(keyMap.get(keys[1])!.clientId).toBe("tr-2");
  });

  it("对照：修复前只用 id 会撞键，第一行的 key 反查到的是第二个下载器的种子", () => {
    const rows = [torrentOf("qb-1", SAME_HASH), torrentOf("tr-2", SAME_HASH)];
    const buggyKeyMap = new Map(rows.map((row) => [row.id, row]));

    expect(buggyKeyMap.size).toBe(1); // 只保留最后一个 → 勾选第一行也会拿到 tr-2 的种子
    expect(buggyKeyMap.get(rows[0].id)!.clientId).toBe("tr-2");
  });

  it("表格的 row-key 与 selectedRowKeys 都使用 torrentKey 复合键", () => {
    const source = readSource(MY_CLIENT_INDEX);

    expect(source).toMatch(/:row-key="torrentKey"/);
    expect(source).toMatch(/:row-selection="\{ selectedRowKeys: tableSelected\.map\(torrentKey\)/);
    expect(source).not.toMatch(/:row-key="\(record: any\) => record\.id"/);
  });
});

describe("B-30：复用弹窗丢弃「迟到响应」", () => {
  it("请求在 resetDialog 之后才 resolve：不写入数据、也不把已加载状态置回 true", async () => {
    const dialogOpen = ref(true);
    const current = ref<any>(torrentOf("qb-1", "aaa"));
    const guard = createTorrentLoadGuard(
      () => dialogOpen.value,
      () => current.value,
    );

    let resolveRequest!: (value: string[]) => void;
    const pending = new Promise<string[]>((resolve) => (resolveRequest = resolve));

    // 打开种子 A，发起 trackers 请求
    const requestKey = guard.begin();
    expect(requestKey).toBe("qb-1:aaa");
    expect(guard.isStale(requestKey)).toBe(false);

    // 关闭弹窗（antd afterClose → resetDialog：清空数据 + 复位已加载标记）
    dialogOpen.value = false;
    let written: string[] = [];
    guard.reset();

    // 响应此刻才到达
    resolveRequest(["http://tracker-a.example/announce"]);
    const trackerList = await pending;
    const committed = guard.commit(requestKey, () => (written = trackerList));

    expect(committed).toBe(false);
    expect(written).toEqual([]); // 没有写入数据
    expect(guard.isLoaded.value).toBe(false); // 没有把 *Loaded 置回 true
  });

  it("弹窗已复用给种子 B：A 的迟到响应被丢弃，B 自己的响应正常写入并标记已加载", async () => {
    const dialogOpen = ref(true);
    const current = ref<any>(torrentOf("qb-1", "aaa"));
    const guard = createTorrentLoadGuard(
      () => dialogOpen.value,
      () => current.value,
    );

    // A 的请求在途
    const requestKeyOfA = guard.begin();
    expect(requestKeyOfA).toBe("qb-1:aaa");

    // 关闭 A、打开 B（弹窗复用）
    dialogOpen.value = false;
    guard.reset();
    current.value = torrentOf("tr-2", "bbb");
    dialogOpen.value = true;

    expect(guard.isLoaded.value).toBe(false); // B 不会因 A 的陈旧标记而跳过加载

    let trackers = ["http://tracker-a.example/announce"];
    // A 的响应迟到：必须被丢弃，否则 Tracker 页签会在 B 名下显示 A 的 tracker（removeTracker 会打错目标）
    expect(guard.commit(requestKeyOfA, () => (trackers = ["http://tracker-a.example/announce"]))).toBe(false);
    expect(trackers).toEqual(["http://tracker-a.example/announce"]);

    // B 自己的响应
    const requestKeyOfB = guard.begin();
    expect(requestKeyOfB).toBe("tr-2:bbb");
    expect(guard.commit(requestKeyOfB, () => (trackers = ["http://tracker-b.example/announce"]))).toBe(true);
    expect(trackers).toEqual(["http://tracker-b.example/announce"]);
    expect(guard.isLoaded.value).toBe(true);

    // B 已加载后再打开 Tracker 页签不需要重复请求（保持原有的「只加载一次」语义）
    expect(guard.isStale(requestKeyOfB)).toBe(false);
  });

  it("失败分支不标记已加载：下一次打开仍会重试", () => {
    const dialogOpen = ref(true);
    const current = ref<any>(torrentOf("qb-1", "aaa"));
    const guard = createTorrentLoadGuard(
      () => dialogOpen.value,
      () => current.value,
    );

    const requestKey = guard.begin();
    expect(guard.commit(requestKey, () => undefined, false)).toBe(true);
    expect(guard.isLoaded.value).toBe(false);
  });

  it("TorrentDetailDialog 的写回全部经过 guard.commit，并在 resetDialog 中 reset", () => {
    const source = readSource(TORRENT_DETAIL_DIALOG);

    // files / peers / trackers 三个页签都接了守卫
    expect(source).toMatch(/filesGuard\.commit\(requestKey/);
    expect(source).toMatch(/peersGuard\.commit\(requestKey/);
    expect(source).toMatch(/trackersGuard\.commit\(requestKey/);
    expect(source.match(/Guard\.commit\(requestKey/g)?.length).toBeGreaterThanOrEqual(6);

    // 守卫在 resetDialog（弹窗 after-close）中复位，同时复位 loading
    expect(source).toMatch(/function resetDialog\(\)[\s\S]*filesGuard\.reset\(\);/);
    expect(source).toMatch(/filesGuard\.reset\(\);[\s\S]*peersGuard\.reset\(\);/);
    expect(source).toMatch(/peersGuard\.reset\(\);[\s\S]*trackersGuard\.reset\(\);/);
    expect(source).toMatch(/filesLoading\.value = false;[\s\S]*filesGuard\.reset\(\);/);

    // 不再使用任何会「被迟到响应重新武装」的裸 *Loaded ref
    expect(source).not.toMatch(/filesLoaded\s*=\s*ref\(/);
    expect(source).not.toMatch(/peersLoaded\s*=\s*ref\(/);
    expect(source).not.toMatch(/trackersLoaded\s*=\s*ref\(/);
    expect(source).not.toMatch(/\*Loaded/);

    // 弹窗的关闭初始化仍走 after-close（不要改成别的生命周期）
    expect(source).toMatch(/:after-close="resetDialog"/);
  });
});
