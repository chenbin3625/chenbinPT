import { isValid } from "date-fns";
import { extStorage } from "@/storage.ts";
import type { TUserInfoStorageSchema, IStoredUserInfo } from "@/shared/types.ts";

import { enqueueWrite, invalidateStorageReadCache, logBackgroundError } from "./base.ts";

/** 只有对象才能逐字段修复；数组/null/标量都属于坏数据（见 BACKGROUNDSHARED-6） */
function isRepairableRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

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
    if (isNaN(seedingNum)) {
      // DEFS2-12：站点取不到做种数时过滤器返回 undefined，经 getFieldData 的 `query ??= ""` 回落成空串落库；
      // 旧实现把 NaN 写回 0，等于每次 onInstalled 都把「没取到」重新塌回静默的 0 个做种。
      // 这里改为删掉该字段，保持「无值」，与 DEFS2-12 的「取不到就留空」一致。
      delete fixed.seeding;
    } else {
      fixed.seeding = seedingNum;
    }
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
      /** 无法修复的条目数（null / 非对象）：不能影响其余条目的修复，也不能静默 */
      let skippedCount = 0;
      const fixedUserInfoData = {} as TUserInfoStorageSchema;

      for (const [siteId, siteUserInfo] of Object.entries(userInfoStore)) {
        // BACKGROUNDSHARED-6：以前这里直接 `Object.entries(siteUserInfo)`，siteUserInfo 为 null/标量时抛 TypeError；
        // 整轮共用一个 try 且只在循环结束后落盘，于是「修补坏数据」的职责本身被一条坏数据击穿、
        // 所有站点所有日期的修复全部作废，且只有 SW 控制台可见。
        // 现在逐层做形状守卫：不可修复的条目原样保留（丢弃等于静默删用户历史），只记录日志。
        if (!isRepairableRecord(siteUserInfo)) {
          skippedCount += 1;
          fixedUserInfoData[siteId] = siteUserInfo as unknown as TUserInfoStorageSchema[string];
          continue;
        }

        fixedUserInfoData[siteId] = {};
        for (const [date, userInfo] of Object.entries(siteUserInfo)) {
          if (!isRepairableRecord(userInfo)) {
            skippedCount += 1;
            fixedUserInfoData[siteId][date] = userInfo as unknown as IStoredUserInfo;
            continue;
          }

          const result = fixStoredUserInfo(userInfo as Partial<IStoredUserInfo>);

          // 检查是否有变化
          if (result.hasChanges) {
            hasChanges = true;
          }

          fixedUserInfoData[siteId][date] = result.fixed;
        }
      }

      // 跳过不等于静默：本仓库统一走 logBackgroundError（会转发到 options 的日志通道）
      if (skippedCount > 0) {
        logBackgroundError(
          `fixAllStoredUserInfo skipped ${skippedCount} unrepairable user info entr${skippedCount === 1 ? "y" : "ies"}`,
        );
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
    // 不再只写 SW 控制台：读/写存储的失败必须能被用户看到
    logBackgroundError("Error fixing user info data", error);
  }
}
