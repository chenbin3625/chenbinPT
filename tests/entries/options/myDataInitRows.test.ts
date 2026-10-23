import { describe, expect, it, vi } from "vitest";
import { prepareOptionsPinia } from "../../helpers/optionsView.ts";

const loadMetadata = vi.hoisted(() => vi.fn());
vi.mock("@/options/views/Overview/MyData/utils/siteMetadata.ts", () => ({
  loadAllAddedSiteMetadata: loadMetadata,
}));
vi.mock("@/options/views/Overview/MyData/utils/format.ts", () => ({
  fixUserInfo: (info: unknown) => info,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

const siteMeta = (id: string) => ({
  id,
  type: "private",
  combinedSiteName: id,
  isDead: false,
  isOffline: false,
});

describe("MyData initTableData", () => {
  it("重建时移除旧行，并忽略迟到的旧轮次", async () => {
    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const { initTableData, perSiteLastUserData, isTableDataLoading } =
      await import("@/options/views/Overview/MyData/utils/lastUserData.ts");
    const meta = useMetadataStore(pinia);
    const old = deferred<Record<string, any>>();
    loadMetadata
      .mockReset()
      .mockReturnValueOnce(old.promise)
      .mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, siteMeta(id)])));
    perSiteLastUserData.value = { removed: { site: "removed" } as any };
    meta.sites = { a: { id: "a" } as any };
    const first = initTableData();
    await vi.waitFor(() => expect(loadMetadata).toHaveBeenCalledTimes(1));
    meta.sites = { b: { id: "b" } as any };
    const second = initTableData();
    await second;
    expect(Object.keys(perSiteLastUserData.value)).toEqual(["b"]);
    old.resolve({ a: siteMeta("a") });
    await first;
    expect(Object.keys(perSiteLastUserData.value)).toEqual(["b"]);
    expect(isTableDataLoading.value).toBe(false);

    meta.sites = {};
    await initTableData();
    expect(perSiteLastUserData.value).toEqual({});
  });
});
