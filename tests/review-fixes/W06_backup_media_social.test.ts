import axios, { AxiosError } from "axios";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub browser extension globals before dynamically importing modules that pull in @ptd/site/utils/adapter or replaceUnsafeHeader
vi.stubGlobal("__BROWSER__", "chrome");
vi.stubGlobal("__EXT_VERSION__", "v0.0.0");
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  runtime: {
    id: "test",
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    sendMessage: () => Promise.resolve(undefined),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  cookies: { get: () => Promise.resolve(null), set: () => Promise.resolve(), getAll: () => Promise.resolve([]) },
  downloads: { download: () => Promise.resolve(1) },
  tabs: { create: () => Promise.resolve(), query: () => Promise.resolve([]) },
  declarativeNetRequest: {
    updateSessionRules: () => Promise.resolve(),
    RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
    HeaderOperation: { SET: "set", REMOVE: "remove" },
    ResourceType: { XMLHTTPREQUEST: "xmlhttprequest" },
  },
});

const { default: DropBox } = await import("@ptd/backupServer/entity/DropBox.ts");
const { default: S3 } = await import("@ptd/backupServer/entity/S3.ts");
const { default: GoogleDrive } = await import("@ptd/backupServer/entity/GoogleDrive.ts");
const { default: OWSS } = await import("@ptd/backupServer/entity/OWSS.ts");
const { pruneBackupFiles, zipBlobToBackupData } = await import("@ptd/backupServer/utils.ts");
const { default: Emby } = await import("@ptd/mediaServer/entity/emby.ts");
const { default: Jellyfin } = await import("@ptd/mediaServer/entity/jellyfin.ts");
const { default: FnOS } = await import("@ptd/mediaServer/entity/fnos.ts");
const { default: Plex } = await import("@ptd/mediaServer/entity/plex.ts");
const { getResolutionLabel } = await import("@ptd/mediaServer/utils.ts");
const bangumi = await import("@ptd/social/entity/bangumi.ts");
const imdb = await import("@ptd/social/entity/imdb.ts");
const tmdb = await import("@ptd/social/entity/tmdb.ts");
const { getSocialSiteInformation, matchSocialPageUrl } = await import("@ptd/social/index.ts");

import type { IBackupFileInfo, IBackupRetention } from "@ptd/backupServer/type";

const EmbyCtor = Emby as unknown as new (config: any) => any;
const JellyfinCtor = Jellyfin as unknown as new (config: any) => any;
const FnOSCtor = FnOS as unknown as new (config: any) => any;
const PlexCtor = Plex as unknown as new (config: any) => any;

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// BackupServer: DropBox (F0053, F0055)
// ============================================================================
describe("F0053 & F0055: DropBox Content-Type and ASCII-safe Dropbox-API-Arg", () => {
  const createDropBox = () =>
    new (DropBox as any)({
      id: "db-1",
      name: "DropBox",
      type: "DropBox",
      config: { access_token: "test-token" },
    });

  it("sets Content-Type: application/octet-stream and ASCII-escapes non-ASCII filenames in addFile", async () => {
    const client = createDropBox();
    const requestSpy = vi
      .spyOn(axios, "request")
      .mockResolvedValue({ status: 200, data: { is_downloadable: true } } as any);

    const ok = await client.addFile("备份_2026.zip", {
      manifest: { version: 1, encryption: false, time: Date.now(), files: {} },
      files: {},
    });

    expect(ok).toBe(true);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const reqConfig = requestSpy.mock.calls[0][0] as any;
    expect(reqConfig.headers["Content-Type"]).toBe("application/octet-stream");

    const apiArg = reqConfig.headers["Dropbox-API-Arg"] as string;
    expect(/^[\x20-\x7e]+$/.test(apiArg)).toBe(true);
    expect(apiArg).toContain("\\u5907\\u4efd");
    expect(JSON.parse(apiArg)).toEqual({ path: "/备份_2026.zip", mode: "overwrite" });
  });

  it("ASCII-escapes non-ASCII paths in getFile Dropbox-API-Arg header", async () => {
    const client = createDropBox();
    const zipBytes = zipSync({
      "manifest.json": strToU8(JSON.stringify({ version: 1, encryption: false, time: 1, files: {} })),
    });
    const zipBlob = new Blob([zipBytes], { type: "application/zip" });

    const requestSpy = vi.spyOn(axios, "request").mockResolvedValue({ status: 200, data: zipBlob } as any);

    const data = await client.getFile("/我的备份/PTD_中文.zip");
    expect(data.manifest.version).toBe(1);

    const reqConfig = requestSpy.mock.calls[0][0] as any;
    const apiArg = reqConfig.headers["Dropbox-API-Arg"] as string;
    expect(/^[\x20-\x7e]+$/.test(apiArg)).toBe(true);
    expect(JSON.parse(apiArg)).toEqual({ path: "/我的备份/PTD_中文.zip" });
  });
});

// ============================================================================
// BackupServer: S3 (F0054)
// ============================================================================
describe("F0054: S3.keyPrefix and objectUrl strip leading slashes", () => {
  const createS3 = (pathPrefix: string) =>
    new (S3 as any)({
      id: "s3-1",
      name: "S3",
      type: "S3",
      config: {
        endpoint: "https://s3.amazonaws.com",
        region: "us-east-1",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        bucket: "my-bucket",
        pathPrefix,
        forcePathStyle: false,
      },
    });

  it("strips leading slash from pathPrefix '/backups' so list() prefix matches addFile() key", async () => {
    const client = createS3("/backups");
    const requestSpy = vi.spyOn(axios, "request").mockImplementation(async (cfg: any) => {
      if (cfg.method === "PUT") {
        return { status: 200, data: "" } as any;
      }
      return {
        status: 200,
        data: `<?xml version="1.0" encoding="UTF-8"?>
          <ListBucketResult>
            <IsTruncated>false</IsTruncated>
            <Contents>
              <Key>backups/PTD_backup.zip</Key>
              <LastModified>2026-01-01T00:00:00.000Z</LastModified>
              <Size>123</Size>
            </Contents>
          </ListBucketResult>`,
      } as any;
    });

    await client.addFile("PTD_backup.zip", {
      manifest: { version: 1, encryption: false, time: Date.now(), files: {} },
      files: {},
    });
    const list = await client.list();

    const putUrl = new URL((requestSpy.mock.calls[0][0] as any).url);
    const listUrl = new URL((requestSpy.mock.calls[1][0] as any).url);

    expect(putUrl.pathname).toBe("/backups/PTD_backup.zip");
    expect(listUrl.searchParams.get("prefix")).toBe("backups/");
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe("PTD_backup.zip");
  });

  it("treats pathPrefix '/' as empty prefix and strips multiple leading slashes in objectUrl", async () => {
    const client = createS3("/");
    const requestSpy = vi.spyOn(axios, "request").mockResolvedValue({
      status: 200,
      data: `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`,
    } as any);

    await client.list();
    const listUrl = new URL((requestSpy.mock.calls[0][0] as any).url);
    expect(listUrl.searchParams.get("prefix")).toBe("");
    expect((client as any).objectUrl("///nested/file.zip")).toBe("https://my-bucket.s3.amazonaws.com/nested/file.zip");
  });
});

// ============================================================================
// BackupServer: GoogleDrive (F0056, F0057)
// ============================================================================
describe("F0056 & F0057: GoogleDrive trashed folder filter and non-folder/size handling", () => {
  const createDrive = () =>
    new (GoogleDrive as any)({
      id: "gd-1",
      name: "GoogleDrive",
      type: "GoogleDrive",
      config: {
        client_id: "cid",
        client_secret: "csec",
        refresh_token: "rtok",
      },
    });

  it("excludes trashed folders in getParentId and folders in list(), and maps missing/invalid size to 'N/A'", async () => {
    const client = createDrive();
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 200,
      data: {
        access_token: "acc-token",
        expires_in: 3599,
        scope: "https://www.googleapis.com/auth/drive",
        token_type: "Bearer",
      },
    } as any);

    const requestSpy = vi.spyOn(axios, "request").mockImplementation(async (cfg: any) => {
      const q = cfg.params?.q ?? "";
      if (q.includes("'root' in parents")) {
        return {
          status: 200,
          data: { kind: "drive#fileList", files: [{ id: "folder-1", name: "PTD Backup" }] },
        } as any;
      }
      return {
        status: 200,
        data: {
          kind: "drive#fileList",
          files: [
            {
              kind: "drive#file",
              id: "file-1",
              name: "backup-with-size.zip",
              mimeType: "application/zip",
              size: "2048",
              createdTime: "2026-01-02T00:00:00.000Z",
            },
            {
              kind: "drive#file",
              id: "file-2",
              name: "backup-no-size.zip",
              mimeType: "application/octet-stream",
              createdTime: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      } as any;
    });

    const items = await client.list();

    expect(requestSpy).toHaveBeenCalledTimes(2);
    const parentQuery = (requestSpy.mock.calls[0][0] as any).params.q as string;
    const listQuery = (requestSpy.mock.calls[1][0] as any).params.q as string;

    expect(parentQuery).toContain("trashed = false");
    expect(listQuery).toContain("mimeType != 'application/vnd.google-apps.folder'");
    expect(listQuery).toContain("trashed = false");

    expect(items).toHaveLength(2);
    expect(items[0].size).toBe(2048);
    expect(items[1].size).toBe("N/A");
  });
});

// ============================================================================
// BackupServer: OWSS (F0058)
// ============================================================================
describe("F0058: OWSS path validation and URL encoding", () => {
  const createOwss = () =>
    new (OWSS as any)({
      id: "owss-1",
      name: "OWSS",
      type: "OWSS",
      config: { address: "https://owss.example/storage", authCode: "secret-code" },
    });

  it("rejects traversal and path-separator inputs without sending requests", async () => {
    const client = createOwss();
    const requestSpy = vi.spyOn(axios, "request");

    const invalidPaths = ["", ".", "..", "../secret.zip", "sub/file.zip", "sub\\file.zip", "bad\0name.zip"];
    for (const badPath of invalidPaths) {
      await expect(client.getFile(badPath)).rejects.toThrow("invalid file path");
      expect(await client.deleteFile(badPath)).toBe(false);
    }

    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("URL-encodes special characters in single-segment filenames for getFile and deleteFile", async () => {
    const client = createOwss();
    const zipBytes = zipSync({
      "manifest.json": strToU8(JSON.stringify({ version: 1, encryption: false, time: 1, files: {} })),
    });
    const zipBlob = new Blob([zipBytes], { type: "application/zip" });

    const requestSpy = vi.spyOn(axios, "request").mockImplementation(async (cfg: any) => {
      if (String(cfg.url).startsWith("/get/")) {
        return { status: 200, data: zipBlob } as any;
      }
      return { status: 200, data: { data: true } } as any;
    });

    await client.getFile("backup#1?v=2.zip");
    const deleted = await client.deleteFile("backup#1?v=2.zip");

    expect(deleted).toBe(true);
    expect((requestSpy.mock.calls[0][0] as any).url).toBe("/get/backup%231%3Fv%3D2.zip");
    expect((requestSpy.mock.calls[1][0] as any).url).toBe("/delete/backup%231%3Fv%3D2.zip");
  });
});

// ============================================================================
// BackupServer: utils.ts (F0059 & F0364 / H60)
// ============================================================================
describe("F0059 & F0364/H60: prototype-safe zip extraction and count-retention NaN/future quota", () => {
  it("F0059: does not leak Object.prototype properties when manifest references 'toString' or 'constructor'", async () => {
    const zipBytes = zipSync({
      "manifest.json": strToU8(
        JSON.stringify({
          version: 1,
          encryption: false,
          time: 1700000000000,
          files: {
            toString: { name: "toString", hash: "00" },
            constructor: { name: "constructor", hash: "00" },
          },
        }),
      ),
    });

    const data = await zipBlobToBackupData(new Blob([zipBytes], { type: "application/zip" }));
    expect(Object.hasOwn(data, "toString")).toBe(false);
    expect(Object.hasOwn(data, "constructor")).toBe(false);
  });

  it("F0364/H60: unparseable (NaN) and future-timestamped entries do not consume maxCount quota", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = 1_700_000_000_000;
    const mkFile = (filename: string, time: number): IBackupFileInfo => ({
      filename,
      path: filename,
      time,
      size: 1,
    });
    const retention: IBackupRetention = { count: { enabled: true, maxCount: 2 } };

    // NaN at index 0 must not consume one of the 2 maxCount slots
    const [del1, kept1] = pruneBackupFiles(
      [
        mkFile("bad.zip", Number.NaN),
        mkFile("new.zip", NOW - DAY),
        mkFile("mid.zip", NOW - 2 * DAY),
        mkFile("old.zip", NOW - 3 * DAY),
      ],
      retention,
      NOW,
    );
    expect(del1.map((f) => f.filename)).toEqual(["old.zip"]);
    expect(kept1.map((f) => f.filename).sort()).toEqual(["bad.zip", "mid.zip", "new.zip"]);

    // NaN in the middle must also not evict mid.zip
    const [del2, kept2] = pruneBackupFiles(
      [
        mkFile("new.zip", NOW - DAY),
        mkFile("bad.zip", Number.NaN),
        mkFile("mid.zip", NOW - 2 * DAY),
        mkFile("old.zip", NOW - 3 * DAY),
      ],
      retention,
      NOW,
    );
    expect(del2.map((f) => f.filename)).toEqual(["old.zip"]);
    expect(kept2.map((f) => f.filename).sort()).toEqual(["bad.zip", "mid.zip", "new.zip"]);

    // Future-timestamped entry must also not consume maxCount slots
    const [del3, kept3] = pruneBackupFiles(
      [
        mkFile("future.zip", NOW + DAY),
        mkFile("new.zip", NOW - DAY),
        mkFile("mid.zip", NOW - 2 * DAY),
        mkFile("old.zip", NOW - 3 * DAY),
      ],
      retention,
      NOW,
    );
    expect(del3.map((f) => f.filename)).toEqual(["old.zip"]);
    expect(kept3.map((f) => f.filename).sort()).toEqual(["future.zip", "mid.zip", "new.zip"]);
  });
});

// ============================================================================
// MediaServer: Plex (F0060)
// ============================================================================
describe("F0060: Plex populates mediaInfo.video from Media[0] when Part.Stream is omitted", () => {
  const plexConfig = () => ({
    id: "plex-1",
    type: "plex",
    name: "Plex",
    address: "https://plex.example",
    auth: { apikey: "plex-token" },
    timeout: 5000,
  });

  it("populates video resolution/codec/dimensions/bitrate in search and getLibraryOverview", async () => {
    const client = new PlexCtor(plexConfig());
    const metadataItem = {
      ratingKey: "1001",
      key: "/library/metadata/1001",
      type: "movie",
      title: "Dune",
      year: 2021,
      Media: [
        {
          bitrate: 24000,
          width: 3840,
          height: 1600,
          videoCodec: "hevc",
          videoResolution: "4k",
          container: "mkv",
          Part: [{ file: "/movies/Dune.mkv", size: 10_000_000_000 }],
        },
      ],
    };

    (client as any).getServerIdentity = vi.fn().mockResolvedValue("machine-1");
    (client as any).getPoster = vi.fn().mockResolvedValue("");
    (client as any).request = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/library/sections") {
        return { status: 200, data: { MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } } };
      }
      if (url === "/library/sections/1/all") {
        return { status: 200, data: { MediaContainer: { size: 1, totalSize: 1, Metadata: [metadataItem] } } };
      }
      return { status: 200, data: { MediaContainer: { Metadata: [metadataItem] } } };
    });

    const searchRes = await client.getSearchResult("Dune");
    expect(searchRes.items).toHaveLength(1);
    expect(searchRes.items[0].mediaInfo?.video).toEqual(
      expect.objectContaining({
        codec: "hevc",
        resolution: "4K",
        width: 3840,
        height: 1600,
        bitrate: 24_000_000,
      }),
    );

    const overview = await client.getLibraryOverview();
    expect(overview?.byResolution).toEqual([{ key: "4K", count: 1, size: 10_000_000_000 }]);
    expect(overview?.byCodec).toEqual([{ key: "hevc", count: 1, size: 10_000_000_000 }]);
  });
});

// ============================================================================
// MediaServer: Emby & Jellyfin (F0061, F0067)
// ============================================================================
describe("F0061 & F0067: MediaBrowser detailExtraFields and overviewFields include base metadata and Path", () => {
  it("F0061: Emby (without userId) and Jellyfin request full base metadata fields in getItemDetail", async () => {
    const emby = new EmbyCtor({
      id: "emby-1",
      type: "emby",
      name: "Emby",
      address: "https://emby.example",
      auth: { apikey: "emby-key" },
      timeout: 5000,
    });
    const jellyfin = new JellyfinCtor({
      id: "jf-1",
      type: "jellyfin",
      name: "Jellyfin",
      address: "https://jf.example",
      auth: { apikey: "jf-key" },
      timeout: 5000,
    });

    const embyReq = vi
      .fn()
      .mockResolvedValue({ status: 200, data: { Items: [{ Id: "1", Name: "Matrix", Type: "Movie" }] } });
    const jfReq = vi
      .fn()
      .mockResolvedValue({ status: 200, data: { Items: [{ Id: "2", Name: "Matrix", Type: "Movie" }] } });
    (emby as any).request = embyReq;
    (jellyfin as any).request = jfReq;

    await emby.getItemDetail("1");
    await jellyfin.getItemDetail("2");

    for (const reqSpy of [embyReq, jfReq]) {
      const params = reqSpy.mock.calls[0][1].params;
      const fields = String(params.Fields ?? params.fields).split(",");
      expect(fields).toEqual(
        expect.arrayContaining([
          "Overview",
          "Path",
          "Genres",
          "DateCreated",
          "ExternalUrls",
          "CommunityRating",
          "Status",
          "People",
          "MediaStreams",
          "MediaSources",
        ]),
      );
      expect(fields).not.toContain("BasicSyncInfo");
    }
  });

  it("F0067: getLibraryOverview requests Path so Series without MediaSources are grouped by rootPath", async () => {
    const emby = new EmbyCtor({
      id: "emby-2",
      type: "emby",
      name: "Emby",
      address: "https://emby.example",
      auth: { apikey: "emby-key", userId: "u1" },
      timeout: 5000,
    });

    const reqSpy = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        TotalRecordCount: 1,
        Items: [{ Id: "s-1", Name: "Breaking Bad", Type: "Series", Path: "/media/tv/Breaking Bad" }],
      },
    });
    (emby as any).request = reqSpy;

    const overview = await emby.getLibraryOverview();
    expect(String(reqSpy.mock.calls[0][1].params.Fields).split(",")).toContain("Path");
    expect(overview?.byRootPath).toEqual([{ key: "/media/tv", count: 1, size: 0 }]);
  });
});

// ============================================================================
// MediaServer: FnOS (F0062, F0064, F0065, F0066)
// ============================================================================
describe("F0062, F0064, F0065, F0066: FnOS URL, filtering, session isolation, and login failure propagation", () => {
  const fnosConfig = (overrides: Record<string, any> = {}) => ({
    id: "fnos-1",
    type: "fnos",
    name: "fnOS",
    address: "https://fnos.example",
    auth: { username: "alice", password: "secret-password-1", accessCode: "", parentId: "" },
    timeout: 5000,
    ...overrides,
  });

  beforeEach(() => {
    (FnOS as any).sessionCache.clear();
    (FnOS as any).posterUrlCache.clear();
    (FnOS as any).posterUrlCacheBytes = 0;
    (FnOS as any).accessCodeGrants.clear();
  });

  it("F0066: normalizes origin by stripping /v, /emby, paths, and hash fragments", () => {
    const client1 = new FnOSCtor(fnosConfig({ address: "http://nas.local:5666/v#/home" }));
    const client2 = new FnOSCtor(fnosConfig({ address: "https://nas.local/emby/#/login" }));
    const client3 = new FnOSCtor(fnosConfig({ address: "192.168.1.2:5666/v" }));

    expect((client1 as any).origin).toBe("http://nas.local:5666");
    expect((client2 as any).origin).toBe("https://nas.local");
    expect((client3 as any).origin).toBe("http://192.168.1.2:5666");
  });

  it("F0062: queries native /v/api/v1/item/list with Movie/TV/Video filter on empty-keyword search", async () => {
    const client = new FnOSCtor(fnosConfig());
    vi.spyOn(client as any, "login").mockResolvedValue({ token: "native-tok" });

    const requestSpy = vi.spyOn(axios, "request").mockImplementation(async () => {
      return { status: 200, data: { code: 0, data: { list: [], total: 0 } } } as any;
    });

    await client.getSearchResult("");
    const itemsCall = requestSpy.mock.calls.find(([cfg]: any) => String(cfg.url).includes("/v/api/v1/item/list"));
    expect(itemsCall).toBeDefined();
    const sentBody = JSON.parse((itemsCall![0] as any).data);
    expect(sentBody.tags.type).toEqual(["Movie", "TV", "Video"]);
    expect(sentBody.nonce).toMatch(/^\d{6}$/);
  });

  it("F0065: does not mutate config.auth and isolates sessions by password/accessCode", async () => {
    const cfg1 = fnosConfig();
    const client1 = new FnOSCtor(cfg1);
    const client2 = new FnOSCtor(
      fnosConfig({
        auth: {
          username: "alice",
          password: "different-password-2",
          accessCode: "",
          parentId: "",
        },
      }),
    );

    let authCalls = 0;
    vi.spyOn(axios, "request").mockImplementation(async (cfg: any) => {
      if (String(cfg.url).includes("/v/api/v2/user/loginByPassword")) {
        authCalls++;
        return { status: 200, data: { code: 0, data: { token: `token-${authCalls}` } } } as any;
      }
      if (String(cfg.url).includes("/v/api/v1/user/info")) {
        return { status: 200, data: { code: 0, data: { guid: `user-${authCalls}` } } } as any;
      }
      throw new Error(`unexpected request: ${cfg.url}`);
    });

    const s1 = await (client1 as any).login();
    const s2 = await (client2 as any).login();

    expect(authCalls).toBe(2);
    expect(s1.token).toBe("token-1");
    expect(s2.token).toBe("token-2");
    expect((cfg1.auth as any).token).toBeUndefined();
  });

  it("F0064: concurrent login(true) callers propagate auth failure instead of returning stale expired token", async () => {
    const client = new FnOSCtor(fnosConfig());
    const sessionKey = (client as any).cacheKey;
    (FnOS as any).sessionCache.set(sessionKey, { token: "expired-token" });

    let rejectAuth!: (err: Error) => void;
    const authSpy = vi.spyOn(axios, "request").mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectAuth = reject;
        }) as any,
    );

    const p1 = (client as any).login(true);
    const p2 = (client as any).login(true);
    await Promise.resolve();
    rejectAuth(new Error("Invalid credentials"));

    await expect(p1).rejects.toThrow("Invalid credentials");
    await expect(p2).rejects.toThrow("Invalid credentials");
    expect(authSpy).toHaveBeenCalledTimes(1);
    expect((FnOS as any).sessionCache.has(sessionKey)).toBe(false);
  });

  it("supports accessCode gateway verification, invalid sign retry, and native ping", async () => {
    const client = new FnOSCtor(
      fnosConfig({
        auth: { username: "alice", password: "secret-password-1", accessCode: "my-code", parentId: "" },
      }),
    );

    let versionAttempts = 0;
    const seenUrls: string[] = [];
    vi.spyOn(axios, "request").mockImplementation(async (cfg: any) => {
      seenUrls.push(String(cfg.url));
      if (cfg.url === "/access_code_verify") {
        expect(cfg.headers["x-access-source"]).toBe("web");
        expect(cfg.headers["x-access-code"]).toBe(btoa("my-code"));
        return { status: 200, data: {} } as any;
      }
      if (cfg.url === "/v/api/v1/sys/version") {
        versionAttempts += 1;
        if (versionAttempts === 1) {
          return { status: 200, data: { code: 5000, msg: "invalid sign", data: null } } as any;
        }
        return { status: 200, data: { code: 0, data: { version: "1.0.0" } } } as any;
      }
      if (cfg.url === "/v/api/v2/user/loginByPassword") {
        const body = JSON.parse(cfg.data);
        // Password must be SHA-256 hex digest, not plaintext
        expect(body.password).toMatch(/^[0-9a-f]{64}$/);
        expect(body.password).not.toBe("secret-password-1");
        return { status: 200, data: { code: 0, data: { token: "tok-1" } } } as any;
      }
      if (cfg.url === "/v/api/v1/user/info") {
        return { status: 200, data: { code: 0, data: { guid: "u-guid" } } } as any;
      }
      throw new Error(`unexpected request: ${cfg.url}`);
    });

    await expect(client.ping()).resolves.toBe(true);
    expect(versionAttempts).toBe(2);
    // Access code gateway verified only once across multiple requests
    expect(seenUrls.filter((u) => u === "/access_code_verify")).toHaveLength(1);
  });
});

// ============================================================================
// MediaServer: utils.ts (F0063)
// ============================================================================
describe("F0063: getResolutionLabel handles ultrawide and single-dimension inputs", () => {
  it("classifies cropped ultrawide, standard, single-dimension, and SD resolutions accurately", () => {
    expect(getResolutionLabel(1920, 800)).toBe("1080p");
    expect(getResolutionLabel(3840, 1600)).toBe("4K");
    expect(getResolutionLabel(1280, 536)).toBe("720p");
    expect(getResolutionLabel(2560, 1080)).toBe("1440p");
    expect(getResolutionLabel(7680, 3200)).toBe("8K");
    expect(getResolutionLabel(1920, undefined)).toBe("1080p");
    expect(getResolutionLabel(undefined, 1080)).toBe("1080p");
    expect(getResolutionLabel(848, 464)).toBe("464p");
    expect(getResolutionLabel(undefined, undefined)).toBeUndefined();
  });
});

// ============================================================================
// Social: TMDb (F0068, F0074)
// ============================================================================
describe("F0068 & F0074: TMDb /seasons + trailing slash + hash parsing and fetchInformation optimization", () => {
  it("F0074: parses and matches /tv/<id>/seasons, trailing slashes, and #fragments", () => {
    expect(tmdb.parse("https://www.themoviedb.org/tv/1399-game-of-thrones/seasons")).toBe("tv/1399/seasons");
    expect(tmdb.parse("https://www.themoviedb.org/tv/1399/seasons/")).toBe("tv/1399/seasons");
    expect(tmdb.parse("https://www.themoviedb.org/movie/550-fight-club/#cast")).toBe("movie/550");
    expect(tmdb.getBaseId("https://www.themoviedb.org/tv/1399/seasons#top")).toBe("tv/1399");
    expect(matchSocialPageUrl("https://www.themoviedb.org/tv/1399/seasons")).toBe("tmdb");
    expect(matchSocialPageUrl("https://www.themoviedb.org/movie/550/")).toBe("tmdb");
  });

  it("F0068: fetchInformation skips authenticated /edit external_ids endpoint and passes timeout to axios", async () => {
    const parser = new DOMParser();
    const movieDoc = parser.parseFromString(
      `<!DOCTYPE html><html><head>
        <meta property="og:title" content="Fight Club" />
        <script type="application/ld+json">{"name":"Fight Club","aggregateRating":{"ratingValue":"8.4","ratingCount":"25000"}}</script>
      </head><body></body></html>`,
      "text/html",
    );
    Object.defineProperty(movieDoc, "URL", { value: "https://www.themoviedb.org/movie/550" });

    const getSpy = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data: movieDoc } as any);

    const info = await tmdb.fetchInformation("movie/550", { timeout: 3210 });
    expect(info.title).toContain("Fight Club");
    expect(info.ratingScore).toBe(8.4);
    expect(info.ratingCount).toBe(25000);

    expect(getSpy).toHaveBeenCalledTimes(1);
    const [url, cfg] = getSpy.mock.calls[0] as [string, any];
    expect(url).toBe("https://www.themoviedb.org/movie/550");
    expect(url).not.toContain("external_ids");
    expect(cfg.timeout).toBe(3210);
  });
});

// ============================================================================
// Social: Bangumi (F0069, F0070, F0071)
// ============================================================================
describe("F0069, F0070, F0071: Bangumi rating field, optional infobox, and safe error logging", () => {
  it("F0069 & F0070: reads data.rating and handles missing/null infobox without discarding metadata", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: 12345,
        name: "Steins;Gate",
        name_cn: "命运石之门",
        images: { common: "https://lain.bgm.tv/pic/cover/c/test.jpg" },
        infobox: null,
        rating: { rank: 1, total: 25000, score: 8.8, count: {} },
      },
    } as any);

    const info = await bangumi.fetchInformation("12345");
    expect(info.title).toBe("命运石之门 / Steins;Gate");
    expect(info.poster).toBe("https://lain.bgm.tv/pic/cover/c/test.jpg");
    expect(info.ratingScore).toBe(8.8);
    expect(info.ratingCount).toBe(25000);
  });

  it("F0071: does not log raw AxiosError or Authorization Bearer apikey in console.warn", async () => {
    const secretKey = "bgm-super-secret-apikey-xyz";
    const err = new AxiosError(
      "Request failed with status code 401",
      "ERR_BAD_REQUEST",
      {
        headers: { Authorization: `Bearer ${secretKey}` } as any,
      } as any,
      undefined,
      {
        status: 401,
        statusText: "Unauthorized",
        headers: {},
        config: { headers: { Authorization: `Bearer ${secretKey}` } } as any,
        data: {},
      },
    );

    vi.spyOn(axios, "get").mockRejectedValue(err);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await bangumi.fetchInformation("99999", { socialSite: { bangumi: { apikey: secretKey } } as any });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedArgs = warnSpy.mock.calls[0];
    expect(loggedArgs.some((arg) => arg === err)).toBe(false);
    expect(JSON.stringify(loggedArgs)).not.toContain(secretKey);
  });
});

// ============================================================================
// Social: index.ts (F0072, F0073)
// ============================================================================
describe("F0072 & F0073: PtGen payload validation and ID normalization + URL encoding", () => {
  it("F0072: rejects HTTP 200 HTML/array/empty PtGen responses so healthy endpoint or built-in fallback wins", async () => {
    const badEndpoint = "https://bad-ptgen.example/<site>/<sid>.json";
    vi.spyOn(axios, "get").mockImplementation(async (url: string) => {
      if (url.includes("bad-ptgen.example")) {
        return { status: 200, data: "<html>Error Page</html>" } as any;
      }
      if (url.includes("ourbits.github.io")) {
        return { status: 200, data: [] } as any;
      }
      if (url.includes("cdn.ourhelp.club")) {
        return { status: 200, data: {} } as any;
      }
      if (url.includes("api.ourhelp.club")) {
        return {
          status: 200,
          data: { sid: "tt0133093", name: "The Matrix", imdb_rating_average: "8.7", imdb_votes: "2,000,000" },
        } as any;
      }
      return Promise.reject(new Error("unexpected url"));
    });

    const info = await getSocialSiteInformation("imdb", "tt0133093", {
      preferPtGen: true,
      ptGenEndpoint: badEndpoint,
      force: true,
    });

    expect(info?.title).toBe("The Matrix");
    expect(info?.ratingScore).toBe(8.7);
    expect(info?.ratingCount).toBe(2000000);
  });

  it("F0073: normalizes URL input via socialModule.parse, shares cache key, and URL-encodes <sid>", async () => {
    const customEndpoint = "https://ptgen-norm.example/<site>/<sid>.json";
    const requested: string[] = [];

    vi.spyOn(axios, "get").mockImplementation(async (url: string) => {
      requested.push(url);
      if (url.includes("ptgen-norm.example")) {
        return {
          status: 200,
          data: { sid: "tt0111161", name: "The Shawshank Redemption", imdb_rating_average: 9.3, imdb_votes: 2800000 },
        } as any;
      }
      return Promise.reject(new Error("built-in disabled"));
    });

    const first = await getSocialSiteInformation("imdb", "https://www.imdb.com/title/tt0111161/", {
      preferPtGen: true,
      ptGenEndpoint: customEndpoint,
    });
    expect(first?.id).toBe("tt0111161");
    expect(requested.filter((u) => u.includes("ptgen-norm.example"))).toEqual([
      "https://ptgen-norm.example/imdb/tt0111161.json",
    ]);

    // Subsequent call with canonical ID should hit the exact same cache entry (no new network calls)
    requested.length = 0;
    const second = await getSocialSiteInformation("imdb", "tt0111161", {
      preferPtGen: true,
      ptGenEndpoint: customEndpoint,
    });
    expect(requested).toEqual([]);
    expect(second?.title).toBe("The Shawshank Redemption");
  });
});

// ============================================================================
// Social: IMDb (F0075, F0076)
// ============================================================================
describe("F0075 & F0076: IMDb numeric coercion in transformPtGen and anchored parse()", () => {
  it("F0075: coerces string ratings and comma-separated vote counts to finite numbers", () => {
    const parsed = imdb.transformPtGen({
      sid: "tt0111161",
      name: "The Shawshank Redemption",
      aka: [],
      poster: "",
      imdb_rating_average: "9.3",
      imdb_votes: "2,845,123",
    } as any);

    expect(parsed.ratingScore).toBe(9.3);
    expect(parsed.ratingCount).toBe(2845123);

    const invalid = imdb.transformPtGen({
      sid: "tt0111161",
      name: "Unknown",
      aka: [],
      poster: "",
      imdb_rating_average: "N/A",
      imdb_votes: "",
    } as any);

    expect(invalid.ratingScore).toBe(0);
    expect(invalid.ratingCount).toBe(0);
  });

  it("F0076: anchors parse() so non-ID strings with trailing characters do not lose 'tt' prefix", () => {
    expect(imdb.parse("tt1234567foo")).toBe("tt1234567foo");
    expect(imdb.parse("12345")).toBe("tt0012345");
    expect(imdb.parse("tt0111161")).toBe("tt0111161");
    expect(imdb.parse("https://www.imdb.com/title/tt0111161/")).toBe("tt0111161");
  });
});
