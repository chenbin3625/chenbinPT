import { isValid } from "date-fns";
import { extStorage } from "@/storage.ts";
import type { TUserInfoStorageSchema, IStoredUserInfo } from "@/shared/types.ts";

import { enqueueWrite, invalidateStorageReadCache } from "./base.ts";

// 修复用户信息中的坏数据
function fixStoredUserInfo(userInfo: Partial<IStoredUserInfo>): { fixed: IStoredUserInfo; hasChanges: boolean } {
  const fixed = { ...userInfo } as IStoredUserInfo;
  let hasChanges = false;

  // 修复 ratio 和 trueRatio，如果是字符串则尝试转换为数字
  // noinspection SuspiciousTypeOfGuard
  if (typeof userInfo.ratio === "string") {
    const ratioNum = parseFloat(userInfo.ratio);
    if (!isNaN(ratioNum)) {
      fixed.ratio = Math.round(ratioNum * 100) / 100;
      hasChanges = true;
    }
  }

  // noinspection SuspiciousTypeOfGuard
  if (typeof userInfo.trueRatio === "string") {
    const trueRatioNum = parseFloat(userInfo.trueRatio);
    if (!isNaN(trueRatioNum)) {
      fixed.trueRatio = Math.round(trueRatioNum * 100) / 100;
      hasChanges = true;
    }
  }

  // 修复 seeding，如果是字符串则尝试转换为数字
  // noinspection SuspiciousTypeOfGuard
  if (typeof userInfo.seeding === "string") {
    const seedingNum = parseInt(userInfo.seeding);
    fixed.seeding = isNaN(seedingNum) ? 0 : seedingNum;
    hasChanges = true;
  }

  // 修复 joinTime
  // noinspection SuspiciousTypeOfGuard
  if (typeof userInfo.joinTime === "string") {
    let joinTime = new Date(userInfo.joinTime);
    if (isValid(joinTime)) {
      fixed.joinTime = +joinTime;
      hasChanges = true;
    }
  }

  return { fixed, hasChanges };
}

/**
 * 修复所有存储的用户信息数据。
 *
 * 整个「读 → 修复 → 写」都在 SW 的串行写链里完成（见 B-18）：
 * 早期实现直接 `extStorage.setItem("userInfo", …)`，既绕过 writeChain、也不同步失效读缓存，
 * 而它与 `onInstalled` 同批注册的定时任务（`alarms.ts` 的自动刷新、自动备份）在同一个 SW 启动里并发执行，
 * 于是修复写与 `patchExtStoragePathLocal("userInfo", …)` 互相整份覆盖；
 * 且 `setItem` 到 `onChanged` 到达的窗口里，其它读路径还会拿到修复前的旧对象。
 * 修复本身是幂等的，所以把它放进写链、并在写入成功后更新读缓存即可同时消除这两个窗口。
 */
export async function fixAllStoredUserInfo(): Promise<void> {
  try {
    await enqueueWrite(async () => {
      const userInfoStore = ((await extStorage.getItem("userInfo")) ?? {}) as TUserInfoStorageSchema;

      let hasChanges = false;
      const fixedUserInfoData = {} as TUserInfoStorageSchema;

      for (const [siteId, siteUserInfo] of Object.entries(userInfoStore)) {
        fixedUserInfoData[siteId] = {};
        for (const [date, userInfo] of Object.entries(siteUserInfo)) {
          const result = fixStoredUserInfo(userInfo);

          // 检查是否有变化
          if (result.hasChanges) {
            hasChanges = true;
          }

          fixedUserInfoData[siteId][date] = result.fixed;
        }
      }

      // 只有当有变化时才更新存储
      if (hasChanges) {
        await extStorage.setItem("userInfo", fixedUserInfoData);
        // 同步更新读缓存：否则在 onChanged 到达前，SW 内的读路径仍会拿到修复前的旧对象
        invalidateStorageReadCache("userInfo");
        console.debug("[PTD] Fixed corrupted user info data");
      }
    });
  } catch (error) {
    console.error("[PTD] Error fixing user info data:", error);
  }
}
