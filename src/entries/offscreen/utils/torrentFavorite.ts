/**
 * 种子收藏处理函数（ #708 ）
 *
 * 与上游的差异（安全收紧）：上游把 get / create / delete 三条消息都开放给内容脚本。fork 的内容脚本运行在
 * 任意站点页面里，按「发送方页面 ↔ 站点」绑定授权（见 ./sender.ts），而收藏里保存的 ITorrent.link / url
 * 可能内嵌站点 passkey，所以：
 *   - getTorrentFavorites（整表，含链接）/ deleteTorrentFavorites 只对扩展页开放；
 *   - 内容脚本只能 createTorrentFavorites（每个 torrent.site 都必须与发送页面绑定），
 *     以及用 getTorrentFavoriteStatus 查询「这些种子是否已收藏」（只回 key / 分类 / 备注，不含链接）。
 */

import type { ITorrent } from "@ptd/site";

import { onMessage, sendMessage } from "@/messages.ts";
import {
  buildTorrentFavorite,
  getTorrentFavoriteKey,
  isTorrentFavoriteItem,
  normalizeFavCategories,
  type ITorrentFavoriteItem,
  type ITorrentFavoriteStatus,
  type TTorrentFavoriteKey,
  type TTorrentFavoriteStorageSchema,
} from "@/shared/types.ts";

import { getSiteInstance } from "./site.ts";
import { assertSenderMatchesSite, isTrustedExtensionContext } from "./sender.ts";

const STORAGE_KEY = "torrentFavorite" as const;

/** 会沿原型链写穿的 key（收藏表是普通对象，这些 key 不能作为属性名写入） */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 内容脚本一次最多收藏的种子数（一页种子列表远小于此；防止页面塞入超大批量） */
const MAX_CONTENT_SCRIPT_BATCH = 500;

/**
 * 所有改写收藏表的操作（create / delete / replace）都按一条链串行执行：
 * 收藏表以单 key 整表存储，「读 → 改 → 写」并发时后写的会覆盖先写的（与 keepUploadTask 的 B1-6 同理）。
 */
let mutationChain: Promise<unknown> = Promise.resolve();
function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const next = mutationChain.then(task, task);
  mutationChain = next.catch(() => undefined);
  return next;
}

async function getStoredFavorites(): Promise<TTorrentFavoriteStorageSchema> {
  const stored = (await sendMessage("getExtStorage", STORAGE_KEY)) as TTorrentFavoriteStorageSchema | null;
  // 拷到无原型对象上再改，`favorites[key] = ...` 不会因为异常 key 写到原型上
  return Object.assign(Object.create(null), stored ?? {});
}

async function writeFavorites(favorites: TTorrentFavoriteStorageSchema): Promise<void> {
  await sendMessage("setExtStorage", { key: STORAGE_KEY, value: { ...favorites } });
}

/**
 * 非扩展页发送方（内容脚本 / 外部扩展）只能操作「自己所在站点」的种子：
 * 每个出现的站点都要通过 assertSenderMatchesSite，任一不匹配则整批拒绝。
 */
async function assertSenderOwnsTorrentSites(
  torrents: ReadonlyArray<Pick<ITorrent, "site">>,
  sender: chrome.runtime.MessageSender | undefined,
): Promise<void> {
  if (isTrustedExtensionContext(sender)) return;
  const siteIds = new Set(torrents.map((torrent) => torrent?.site));
  for (const siteId of siteIds) {
    if (typeof siteId !== "string" || siteId.length === 0) {
      throw new Error("Permission denied: content script must supply the torrent site");
    }
    const siteInstance = await getSiteInstance<"public">(siteId);
    assertSenderMatchesSite(siteInstance, sender);
  }
}

/** 内容脚本传入的种子只保留 ITorrent 声明过的字段（页面可以往对象里塞任意内容） */
const CONTENT_SCRIPT_TORRENT_FIELDS = [
  "site",
  "id",
  "title",
  "subTitle",
  "url",
  "link",
  "time",
  "size",
  "author",
  "seeders",
  "leechers",
  "completed",
  "comments",
  "category",
  "tags",
  "progress",
  "status",
] as const;

function projectContentScriptTorrent(torrent: ITorrent): ITorrent {
  const source = torrent as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of CONTENT_SCRIPT_TORRENT_FIELDS) {
    if (Object.hasOwn(source, field)) projected[field] = source[field];
  }
  for (const [field, value] of Object.entries(source)) {
    if (field.startsWith("ext_") && (typeof value === "string" || typeof value === "number" || value === null)) {
      projected[field] = value;
    }
  }
  return projected as unknown as ITorrent;
}

function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * 获取所有种子收藏（按收藏时间倒序，最新收藏的在前）
 */
export async function getTorrentFavorites(): Promise<ITorrentFavoriteItem[]> {
  const favorites = await getStoredFavorites();
  // 防御性过滤：旧版本/被篡改的备份可能留下 null 或形状错误的条目，
  // 直接排序会抛 TypeError 并让收藏页永久加载失败。
  return Object.values(favorites)
    .filter(isTorrentFavoriteItem)
    .sort((a, b) => b.createdAt - a.createdAt);
}

onMessage("getTorrentFavorites", getTorrentFavorites);

/**
 * 查询一批种子的收藏状态，供收藏对话框回填分类 / 备注、提示「已收藏」。
 *
 * 只返回这些种子对应的 key / 分类 / 备注，以及全部已有分类名（作为输入建议），不返回任何链接；
 * 内容脚本调用时同样要求每个 torrent.site 与发送页面绑定。
 */
export async function getTorrentFavoriteStatus(
  torrents: ReadonlyArray<Pick<ITorrent, "site" | "id" | "link" | "url">>,
): Promise<ITorrentFavoriteStatus> {
  const favorites = await getStoredFavorites();
  const keys = new Set(torrents.map((torrent) => getTorrentFavoriteKey(torrent)));
  const validFavorites = Object.values(favorites).filter(isTorrentFavoriteItem);
  return {
    favorites: [...keys]
      .filter((key) => Object.hasOwn(favorites, key) && isTorrentFavoriteItem(favorites[key]))
      .map((key) => {
        const favorite = favorites[key];
        return {
          key,
          favCategories: Array.isArray(favorite.favCategories)
            ? favorite.favCategories.filter((category): category is string => typeof category === "string")
            : undefined,
          comment: typeof favorite.comment === "string" ? favorite.comment : undefined,
        };
      }),
    favCategories: [
      ...new Set(
        validFavorites.flatMap((favorite) =>
          Array.isArray(favorite.favCategories)
            ? favorite.favCategories.filter((category): category is string => typeof category === "string")
            : [],
        ),
      ),
    ],
  };
}

onMessage("getTorrentFavoriteStatus", async ({ data, sender }) => {
  const torrents = Array.isArray(data?.torrents) ? data.torrents : [];
  await assertSenderOwnsTorrentSites(torrents, sender);
  return await getTorrentFavoriteStatus(torrents);
});

/**
 * 批量添加种子收藏
 *
 * 同一种子重复收藏时视为更新其分类与备注（保留原收藏时间）；
 * `favCategories` / `comment` 传入空值表示清空，缺省（undefined）表示保持原值。
 */
export async function createTorrentFavorites(data: {
  torrents: ITorrent[];
  favCategories?: string[];
  comment?: string;
}): Promise<number> {
  return await enqueueMutation(async () => {
    const favorites = await getStoredFavorites();
    const now = Date.now();
    const options = {
      favCategories: data.favCategories === undefined ? undefined : normalizeFavCategories(data.favCategories),
      comment: data.comment,
    };

    let count = 0;
    for (const torrent of data.torrents) {
      const key = getTorrentFavoriteKey(torrent);
      if (UNSAFE_KEYS.has(key)) continue;
      const existing = isTorrentFavoriteItem(favorites[key]) ? favorites[key] : undefined;
      favorites[key] = buildTorrentFavorite(torrent, existing, options, now);
      count++;
    }

    await writeFavorites(favorites);
    return count;
  });
}

onMessage("createTorrentFavorites", async ({ data, sender }) => {
  const torrents = Array.isArray(data?.torrents) ? data.torrents : [];
  const fromUntrustedSender = !isTrustedExtensionContext(sender);
  if (fromUntrustedSender && torrents.length > MAX_CONTENT_SCRIPT_BATCH) {
    throw new Error(`Permission denied: content script can favorite at most ${MAX_CONTENT_SCRIPT_BATCH} torrents`);
  }
  await assertSenderOwnsTorrentSites(torrents, sender);

  return await createTorrentFavorites({
    torrents: fromUntrustedSender ? torrents.map(projectContentScriptTorrent) : torrents,
    favCategories: toStringArray(data?.favCategories),
    comment: typeof data?.comment === "string" ? data.comment : undefined,
  });
});

/**
 * 批量删除种子收藏（仅扩展页，见 messages.ts 的 extensionPageOnlyMessages）
 */
export async function deleteTorrentFavorites(keys: TTorrentFavoriteKey[]): Promise<void> {
  await enqueueMutation(async () => {
    const favorites = await getStoredFavorites();
    for (const key of keys) {
      delete favorites[key];
    }
    await writeFavorites(favorites);
  });
}

onMessage("deleteTorrentFavorites", async ({ data: keys }) => {
  await deleteTorrentFavorites(Array.isArray(keys) ? keys : []);
});

/**
 * 整表替换种子收藏（备份恢复 / 恢复失败回滚），与 create / delete 走同一条串行链
 */
export async function replaceTorrentFavorites(favorites: TTorrentFavoriteStorageSchema): Promise<void> {
  await enqueueMutation(async () => {
    // 恢复路径已在 backupServer/utils.ts 做过结构校验；这里再过滤一次，保证无论调用方是谁
    // 都不会把 null / 非对象条目写进收藏表（读取侧同样有兜底）。
    const safeFavorites: TTorrentFavoriteStorageSchema = Object.create(null);
    for (const [key, value] of Object.entries(favorites ?? {})) {
      if (isTorrentFavoriteItem(value)) {
        safeFavorites[key] = value;
      }
    }
    await writeFavorites(safeFavorites);
  });
}
