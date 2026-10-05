import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";

vi.hoisted(() => {
  (globalThis as any).__BROWSER__ = "chrome";
});

import { createTorrentLoadGuard, finishTorrentLoad } from "@/options/views/Overview/MyClient/utils.ts";

describe("TorrentDetailDialog loading guard", () => {
  it("迟到的旧请求不能关闭新种子的 loading 状态", () => {
    const open = ref(true);
    const currentTorrent = ref<any>({ clientId: "client-a", id: "torrent-a" });
    const guard = createTorrentLoadGuard(
      () => open.value,
      () => currentTorrent.value,
    );
    const oldRequestKey = guard.begin();
    let loading = true;

    currentTorrent.value = { clientId: "client-b", id: "torrent-b" };
    finishTorrentLoad(guard, oldRequestKey, () => {
      loading = false;
    });

    expect(loading).toBe(true);
  });
});
