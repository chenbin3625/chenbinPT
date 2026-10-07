/**
 * M-18：媒体服务器地址规范化。用户常直接从浏览器地址栏复制地址（带 /web/ 前端路由），
 * 也会只填到 /emby（不带尾斜杠）。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

import Emby from "@ptd/mediaServer/entity/emby.ts";
import Jellyfin from "@ptd/mediaServer/entity/jellyfin.ts";
import Plex from "@ptd/mediaServer/entity/plex.ts";

const config = (address: string) => ({ id: "m", name: "m", address, auth: { apikey: "k" } }) as any;

describe("Jellyfin baseUrl", () => {
  it.each([
    ["http://127.0.0.1:8096/web/#/home.html", "http://127.0.0.1:8096/"],
    ["http://127.0.0.1:8096/web/index.html#!/home", "http://127.0.0.1:8096/"],
    ["http://127.0.0.1:8096/web/", "http://127.0.0.1:8096/"],
    ["http://127.0.0.1:8096", "http://127.0.0.1:8096/"],
    ["https://media.example/jellyfin/web/#/home.html", "https://media.example/jellyfin/"],
  ])("%s → %s", (address, expected) => {
    expect(new (Jellyfin as any)(config(address)).baseUrl).toBe(expected);
  });
});

describe("Emby apiBaseUrl / webBaseUrl", () => {
  it.each([
    ["http://127.0.0.1:8096/emby", "http://127.0.0.1:8096/emby/"],
    ["http://127.0.0.1:8096/emby/", "http://127.0.0.1:8096/emby/"],
    ["http://127.0.0.1:8096/web/index.html#!/home", "http://127.0.0.1:8096/emby/"],
    ["http://127.0.0.1:8096", "http://127.0.0.1:8096/emby/"],
  ])("%s → %s", (address, expected) => {
    const emby = new (Emby as any)(config(address));
    expect(emby.apiBaseUrl).toBe(expected);
    expect(emby.webBaseUrl).toBe(expected.replace(/emby\/$/, "web/index.html"));
  });
});

/**
 * SERVERSSOCIAL-4（M-18 同根因）：Plex 的旧实现只在地址含 `/web/index.html` 时用
 * `/\web\/index.html#.+/` 剥离，且要求 `#` 后至少一个字符：
 * - `http://ip:32400/web` → apiBaseUrl 原样（/identity 打到 /web/identity → 404）
 * - `http://ip:32400/web/index.html`（无 hash）→ webBaseUrl 变成 `…/web/index.html/web/index.html`
 */
describe("Plex apiBaseUrl / webBaseUrl", () => {
  it.each([
    ["http://10.0.0.5:32400", "http://10.0.0.5:32400"],
    ["http://10.0.0.5:32400/", "http://10.0.0.5:32400"],
    ["http://10.0.0.5:32400/web", "http://10.0.0.5:32400"],
    ["http://10.0.0.5:32400/web/", "http://10.0.0.5:32400"],
    ["http://10.0.0.5:32400/web/index.html", "http://10.0.0.5:32400"],
    ["http://10.0.0.5:32400/web/index.html#!/home", "http://10.0.0.5:32400"],
    ["http://10.0.0.5:32400/web/#/home.html", "http://10.0.0.5:32400"],
    ["https://media.example/plex/web/index.html#!/home", "https://media.example/plex"],
    ["  http://10.0.0.5:32400/web  ", "http://10.0.0.5:32400"],
  ])("%s → %s", (address, expected) => {
    const plex = new (Plex as any)(config(address));
    expect(plex.apiBaseUrl).toBe(expected);
    expect(plex.webBaseUrl).toBe(`${expected}/web/index.html`);
  });
});
