import { describe, expect, it } from "vitest";

import { decryptData, getBackupWarnings, setBackupWarnings, validateBackupPayload } from "@ptd/backupServer/utils.ts";
import type { IBackupData } from "@ptd/backupServer";

/**
 * 备份文件是**不可信输入**（用户可能恢复他人分享的 zip）。
 *
 * 见审查报告 S-1：恢复流程原先不校验备份内容，因此一份恶意 zip 可以植入一条指向攻击者
 * WebDAV/S3/Gist 的 `metadata.backupServers` 记录（并带 `enabled: true` + `backupInterval`
 * + 攻击者挑选的 `backupFields`），随后自动备份会把本机的站点 passkey、会话 Cookie、
 * 下载器凭据**自动上传**到该端点。
 *
 * 本文件覆盖其中的**解析侧**防线：
 *  1. `decryptData` 在 JSON 边界剥离 `__proto__`（否则 `{...obj}` 展开会把键写到 Object.prototype）；
 *  2. `validateBackupPayload` 做结构校验，形状不符的条目会被丢弃并记录原因，
 *     而不是静默写进 chrome.storage；
 *  3. 合法备份**不被误拒**（否则等于静默丢用户数据）；
 *  4. 警告用非枚举属性携带，避免被 `backupDataToJSZipBlob` 的 `Object.entries` 写回下一个备份。
 *
 * 「backupServers 默认不恢复」的**策略**部分在 offscreen 侧依据
 * `IRestoreOptions.restoreBackupServers` 执行，不在本文件的覆盖范围内。
 */
describe("备份解析：不可信输入的防线（S-1）", () => {
  describe("JSON 边界剥离 __proto__", () => {
    it("顶层 __proto__ 不会成为自有属性，也不会污染 Object.prototype", () => {
      const parsed = decryptData<Record<string, unknown>>('{"ok":1,"__proto__":{"polluted":"yes"}}');

      expect(parsed.ok).toBe(1);
      expect(Object.hasOwn(parsed, "__proto__")).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((parsed as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("嵌套层的 __proto__ 同样被剥离", () => {
      decryptData('{"a":{"__proto__":{"deepPolluted":"yes"}}}');
      expect(({} as Record<string, unknown>).deepPolluted).toBeUndefined();
    });

    it("正常 JSON 不受影响", () => {
      expect(decryptData('{"a":{"b":[1,2,3]}}')).toEqual({ a: { b: [1, 2, 3] } });
    });
  });

  describe("结构校验：拒绝形状不符的条目", () => {
    it("metadata 本身不是对象 → 拒", () => {
      expect(validateBackupPayload("metadata", [])).not.toBeNull();
      expect(validateBackupPayload("metadata", "oops")).not.toBeNull();
      expect(validateBackupPayload("metadata", null)).not.toBeNull();
    });

    it("metadata.sites 不是对象 → 拒", () => {
      expect(validateBackupPayload("metadata", { sites: "oops" })).not.toBeNull();
    });

    it("backupServers 的形状问题逐项被拦下", () => {
      // 条目不是对象
      expect(validateBackupPayload("metadata", { backupServers: { evil: "not-an-object" } })).not.toBeNull();
      // 缺少 type —— 决定「用哪个客户端实现」的字段
      expect(validateBackupPayload("metadata", { backupServers: { evil: { config: {} } } })).not.toBeNull();
      // config 不是对象 —— 凭据就在这里
      expect(
        validateBackupPayload("metadata", { backupServers: { evil: { type: "WebDAV", config: "x" } } }),
      ).not.toBeNull();
    });

    it("其余 storage 表的形状", () => {
      expect(validateBackupPayload("config", [])).not.toBeNull();
      expect(validateBackupPayload("userInfo", "x")).not.toBeNull();
      expect(validateBackupPayload("searchResultSnapshot", 1)).not.toBeNull();
      expect(validateBackupPayload("keepUploadTask", null)).not.toBeNull();
      expect(validateBackupPayload("cookies", [])).not.toBeNull();
      expect(validateBackupPayload("downloadHistory", {})).not.toBeNull();
    });

    it("未知字段不判断形状（保持前向兼容）", () => {
      expect(validateBackupPayload("someFutureField", "anything")).toBeNull();
    });
  });

  describe("结构校验：不能误拒合法备份", () => {
    const validMetadata = {
      sites: { mteam: { isOffline: false } },
      solutions: {},
      snapshots: {},
      downloaders: {},
      mediaServers: {},
      backupServers: {
        abc: {
          id: "abc",
          type: "WebDAV",
          enabled: true,
          backupFields: ["config"],
          config: { address: "https://example.test/dav", loginName: "u", loginPwd: "p" },
        },
      },
    };

    it("完整 metadata 通过", () => {
      expect(validateBackupPayload("metadata", validMetadata)).toBeNull();
    });

    it("只含部分容器字段也通过（老备份/裁剪过的备份）", () => {
      expect(validateBackupPayload("metadata", { sites: {} })).toBeNull();
      expect(validateBackupPayload("metadata", {})).toBeNull();
    });

    it("合法类型全部通过", () => {
      expect(validateBackupPayload("config", {})).toBeNull();
      expect(validateBackupPayload("userInfo", { mteam: { "2026-01-01": {} } })).toBeNull();
      expect(validateBackupPayload("searchResultSnapshot", {})).toBeNull();
      expect(validateBackupPayload("keepUploadTask", {})).toBeNull();
      expect(validateBackupPayload("cookies", { "a.test": [] })).toBeNull();
      expect(validateBackupPayload("downloadHistory", [])).toBeNull();
    });
  });

  describe("警告的携带方式", () => {
    it("用非枚举属性，避免被 backupDataToJSZipBlob 的 Object.entries 写回下一个备份", () => {
      const data: IBackupData = { config: {} };
      setBackupWarnings(data, ["metadata：形状不符，已跳过该条目"]);

      // 可读
      expect(getBackupWarnings(data)).toEqual(["metadata：形状不符，已跳过该条目"]);
      // 但不可枚举 —— backupDataToJSZipBlob 遍历 Object.entries(data) 生成 zip 条目，
      // 若它是普通字段就会被写成 __backupWarnings.json 带进下一个备份。
      expect(Object.keys(data)).not.toContain("__backupWarnings");
      expect(Object.entries(data).map(([k]) => k)).toEqual(["config"]);
    });

    it("未设置时返回空数组", () => {
      expect(getBackupWarnings({})).toEqual([]);
    });
  });
});
