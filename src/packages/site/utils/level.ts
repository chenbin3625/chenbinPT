// noinspection ES6PreferShortImport

import { intersection, isEqual } from "es-toolkit";
import { includes, isEmpty, set } from "es-toolkit/compat";
import { intervalToDuration } from "date-fns";

import type { IImplicitUserInfo, ILevelRequirement, IUserInfo, TLevelGroupType, TLevelId } from "../types";
import { parseSizeString } from "./filesize";
// P1-4：拆成「值导入 + 类型导入」两条，类型边不再与运行时边混在一起
import { convertIsoDurationToDate } from "./datetime";
import type { isoDuration } from "./datetime";

export const MinVipLevelId = 100;
export const MinManagerLevelId = 200;

export function cleanLevelName(levelName: string): string {
  return levelName.replace(/[\s _]+/g, "").toLowerCase();
}

const ratioCountMap = {
  ratio: ["uploaded", "downloaded"],
  trueRatio: ["trueUploaded", "trueDownloaded"],
} as const;

export function fixRatio(userInfo: Partial<IUserInfo>, ratioKey: "ratio" | "trueRatio" = "ratio"): number {
  let ratio = -1;
  if (typeof userInfo[ratioKey] === "undefined") {
    const [uploadedKey, downloadedKey] = ratioCountMap[ratioKey];
    const { [uploadedKey]: uploaded = 0, [downloadedKey]: downloaded = 0 } = userInfo;

    if (downloaded == 0 && uploaded == 0) {
      return -Infinity;
    } else if (downloaded == 0 && uploaded > 0) {
      ratio = Infinity; // 没有下载量时设置分享率为无限
    } else if (downloaded > 0) {
      ratio = uploaded / downloaded;
    }
  } else {
    ratio = userInfo[ratioKey];
  }
  return ratio;
}

export function guessUserLevelGroupType(levelName: string): TLevelGroupType {
  let userLevel = levelName.toLowerCase();
  let specialNames: Record<"manager" | "vip", string[]> = {
    manager: [
      ["retiree", "养老", "退休"],
      ["uploader", "发布", "发种", "上传", "种子"],
      ["helper", "assistant", "助手", "助理"],
      ["seeder", "保种"],
      ["transferrer", "转载"],
      ["forum", "版主"],
      ["moderator", "admin", "管理"],
      ["sys", "coder", "开发"],
      ["staff", "主管"],
    ].flat(),
    vip: ["vip", "贵宾", "honor", "荣誉"],
  };
  let res = "user";
  for (const [k, levelNames] of Object.entries(specialNames)) {
    if (levelNames.some((n: string) => includes(userLevel, n))) {
      res = k;
      break;
    }
  }
  return res as TLevelGroupType;
}

export function levelRequirementUnMet(
  userInfo: IUserInfo,
  levelRequirement: ILevelRequirement | IImplicitUserInfo,
): Partial<Omit<ILevelRequirement, "id" | "name" | "groupType" | "privilege">> {
  const unmetRequirement: Partial<Omit<ILevelRequirement, "id" | "name" | "groupType" | "privilege">> = {};

  // 如果未定义站点等级要求，直接返回
  if (!levelRequirement) {
    return unmetRequirement;
  }

  const currentTime = +new Date();
  const levelRequirementKeys: (keyof ILevelRequirement)[] = Object.keys(levelRequirement);

  // 比较加入时间
  if (levelRequirement.interval) {
    const baseTimeInfo = userInfo.joinTime ?? currentTime;
    const passTime = convertIsoDurationToDate(levelRequirement.interval, baseTimeInfo);
    if (passTime > currentTime) {
      // 计算通过时间与当前时间的时间差
      const leftDuration = intervalToDuration({ start: currentTime, end: passTime });
      let interval = "P";
      if (leftDuration.years) interval += `${leftDuration.years}Y`;
      if (leftDuration.months) interval += `${leftDuration.months}M`;
      if (leftDuration.days) interval += `${leftDuration.days}D`;
      unmetRequirement.interval = interval; // 只保留日期部分
      unmetRequirement.passTime = +passTime; // 附带绝对达标时间，供前端渲染日期时直接使用（#1140）
    }
  }

  // 比较 totalTraffic, downloaded, trueDownloaded, uploaded, trueUploaded, seedingSize 等体积类字段需求
  for (const currentSizeElement of intersection(
    ["totalTraffic", "downloaded", "trueDownloaded", "uploaded", "trueUploaded", "seedingSize", "specialSeedingSize"],
    levelRequirementKeys,
  )) {
    let currentSizeRequirement = levelRequirement[currentSizeElement];

    // noinspection SuspiciousTypeOfGuard
    if (typeof currentSizeRequirement === "string") {
      currentSizeRequirement = parseSizeString(currentSizeRequirement);
    }

    const baseSizeInfo = userInfo[currentSizeElement] ?? 0;
    if (baseSizeInfo < currentSizeRequirement) {
      unmetRequirement[currentSizeElement] = currentSizeRequirement - baseSizeInfo;
    }
  }

  for (const ratioKey of intersection(["ratio", "trueRatio"], levelRequirementKeys) as ("ratio" | "trueRatio")[]) {
    // 计算并设置 ratio 或 trueRatio
    userInfo[ratioKey] = fixRatio(userInfo, ratioKey);

    const requireRatio = levelRequirement[ratioKey];

    let minRequireRatio: number | undefined;
    let maxRequireRatio: number | undefined;

    // [number, number]，分享率限制模式
    if (Array.isArray(requireRatio) && requireRatio.length === 2 && requireRatio.every((x) => typeof x === "number")) {
      [minRequireRatio, maxRequireRatio] = requireRatio.sort((a, b) => a - b);
      // number 格式 直接赋值
    } else if (typeof requireRatio === "number") {
      minRequireRatio = requireRatio;
    } else {
      // string格式输入的容错处理
      minRequireRatio = parseFloat(String(requireRatio));
    }

    const [uploadedKey, downloadedKey] = ratioCountMap[ratioKey];

    // 获取当前数值
    const {
      [uploadedKey]: baseUploaded = 0,
      [downloadedKey]: baseDownloaded = 0,
      [ratioKey]: baseRatio = -1,
    } = userInfo;

    const requiredDownloaded =
      typeof levelRequirement[downloadedKey] === "string"
        ? parseSizeString(levelRequirement[downloadedKey])
        : (levelRequirement[downloadedKey] ?? 0);

    const requiredUploaded =
      typeof levelRequirement[uploadedKey] === "string"
        ? parseSizeString(levelRequirement[uploadedKey])
        : (levelRequirement[uploadedKey] ?? 0);

    // 检查最小 ratio 限制
    if (minRequireRatio) {
      if (baseRatio < minRequireRatio) {
        unmetRequirement[ratioKey] = minRequireRatio;
      }

      // 只有上传和ratio要求，没有下载要求的情况
      if (requiredUploaded > 0 && requiredDownloaded === 0) {
        // 计算满足ratio要求所允许的最大下载量
        const maxAllowedDownload = requiredUploaded / minRequireRatio;

        // 如果当前下载量已经超过这个允许值，那么需要增加上传量
        // 只有真的缺上传时才登记：原先在上传已足够时也会写入 `uploaded: 0`（max(0, 负数)），
        // 而一个值为 0 的未满足项同样让 isLevelRequirementMet 判为未达标 —— 下载量大的用户因此被整体低判
        if (baseDownloaded > maxAllowedDownload) {
          const neededUpload = baseDownloaded * minRequireRatio;
          if (neededUpload > baseUploaded) {
            set(
              unmetRequirement,
              uploadedKey,
              Math.max(unmetRequirement[uploadedKey] || 0, neededUpload - baseUploaded),
            );
          }
        }
      } else {
        // 使用当前下载量和要求下载量中的较大值作为基准
        const targetDownload = Math.max(baseDownloaded, requiredDownloaded);
        const neededUpload = targetDownload * minRequireRatio;

        // 即使上传量已经超过了基本上传要求，也可能因为下载量大而导致 ratio 不足
        // 此时需要额外上传以满足 ratio 要求
        if (baseUploaded < neededUpload) {
          set(unmetRequirement, uploadedKey, Math.max(unmetRequirement[uploadedKey] || 0, neededUpload - baseUploaded));
        }
      }
    }

    // 检查最大 ratio 限制
    if (maxRequireRatio) {
      if (baseRatio > maxRequireRatio) {
        unmetRequirement[ratioKey] = maxRequireRatio;
      }

      const neededDownload = baseUploaded / maxRequireRatio;

      if (baseDownloaded < neededDownload) {
        set(
          unmetRequirement,
          downloadedKey,
          Math.max(unmetRequirement[downloadedKey] || 0, neededDownload - baseDownloaded),
        );
      }
    }
  }

  // 比较 seedingTime, averageSeedingTime 等时间长度类字段需求
  for (const currentDurationElement of intersection(["seedingTime", "averageSeedingTime"], levelRequirementKeys)) {
    let currentDurationRequirement = levelRequirement[currentDurationElement];

    if (typeof currentDurationRequirement === "string") {
      // 将 isoDuration 转为 秒！！！
      currentDurationRequirement =
        (convertIsoDurationToDate(currentDurationRequirement as isoDuration, currentTime) - currentTime) / 1e3;
    }

    const baseDurationInfo = userInfo[currentDurationElement] ?? 0;
    if (baseDurationInfo < currentDurationRequirement) {
      unmetRequirement[currentDurationElement] = currentDurationRequirement - baseDurationInfo;
    }
  }

  // 比较 bonus, bonusPerHour, seedingBonus, uploads, leeching, snatches, posts 等应该大于的字段
  // L-18：percentile（站内排名百分位，secretcinema 从 user.php 的 "Overall rank" 取到）同样是「应当大于等于」，
  // 不在列表里时 `percentile: 50/70/90` 门槛会被静默忽略，用户可能被误判为已达标
  for (const currentGtElement of intersection(
    [
      "bonus",
      "bonusPerHour",
      "seedingBonus",
      "uploads",
      "leeching",
      "snatches",
      "posts",
      "perfectFlacs",
      "groups",
      "percentile",
      // D-23 / D-24：anthelion 的 adoptions、alpharatio 的 donation 都已采集到用户信息里，但不在此列表时
      // alternative 分支恒判满足（anthelion 0 发布量也能升级）、捐款门槛被丢弃（alpharatio 判级偏松）
      "adoptions",
      "donation",
    ],
    levelRequirementKeys,
  )) {
    let currentGtRequirement = levelRequirement[currentGtElement];
    const baseGtInfo = userInfo[currentGtElement] ?? 0;

    if (baseGtInfo < currentGtRequirement) {
      unmetRequirement[currentGtElement] = currentGtRequirement - baseGtInfo;
    }
  }

  // 额外计算 增加到达下一级魔力所需时间 （#7）
  for (const bonusKey of ["bonus", "seedingBonus"] as const) {
    const perHourValue = userInfo[`${bonusKey}PerHour`] ?? userInfo.bonusPerHour ?? 0; // issue#681
    if (unmetRequirement[bonusKey] && levelRequirement[bonusKey] && perHourValue > 0) {
      // 如果未满足 bonus 条件，且获取到了 bonusPerHour
      const currentBonus = userInfo[bonusKey] ?? 0;
      const leftBonus = levelRequirement[bonusKey] - currentBonus; // Fixed by #676
      if (leftBonus > 0) {
        const leftTime = leftBonus / parseFloat(perHourValue);
        unmetRequirement[`${bonusKey}NeededInterval`] = `${Math.floor(leftTime)}H`;
      }
    }
  }

  // 比较 hnrUnsatisfied 等应该小于等于的字段
  for (const currentLtElement of intersection(["hnrUnsatisfied"], levelRequirementKeys)) {
    let currentLtRequirement = levelRequirement[currentLtElement];
    const baseLtInfo = userInfo[currentLtElement] ?? 0;

    if (baseLtInfo > currentLtRequirement) {
      unmetRequirement[currentLtElement] = baseLtInfo - currentLtRequirement;
    }
  }

  // 比较可选项，可选项中只要有一个满足即可
  if (levelRequirement.alternative) {
    let alternativeUnMet = [];

    for (const alternative of levelRequirement.alternative) {
      alternativeUnMet.push(levelRequirementUnMet(userInfo, alternative));
    }

    alternativeUnMet = alternativeUnMet.filter((x) => !isEmpty(x));

    // 如果有至少一个满足则返回 false
    if (alternativeUnMet.length == levelRequirement.alternative.length) {
      unmetRequirement.alternative = alternativeUnMet;
    }
  }

  return unmetRequirement;
}

export function isLevelRequirementMet(userInfo: IUserInfo, levelRequirement: ILevelRequirement): boolean {
  return isEmpty(levelRequirementUnMet(userInfo, levelRequirement));
}

/** 只用于说明、不参与判级的字段：只有这些键的等级没有门槛，不能算「已满足」（DEFS1-1：desigaane 5/6/7 级） */
const levelDescriptionKeys: string[] = ["id", "name", "nameAka", "groupType", "privilege", "isKept"];

/**
 * 提取等级的「判级键」（真正决定该等级能否被满足的键）。
 * 取「除说明性字段外都算判级键」的保守定义：引擎尚未求值的键同样意味着该等级不可判定，跳过比当作已满足安全；
 * 值为 undefined 的键也不计入，否则 `uploaded: undefined` 会被 levelRequirementUnMet 当作已满足而白送一级。
 */
export function getJudgeableLevelRequirement(levelRequirement: ILevelRequirement): Partial<ILevelRequirement> {
  return Object.fromEntries(
    Object.entries(levelRequirement).filter(
      ([key, value]) => !levelDescriptionKeys.includes(key) && typeof value !== "undefined",
    ),
  );
}

/** 该等级是否存在可判定的门槛（无门槛等级不参与回落判级，也不作为「下一级」目标） */
export function hasJudgeableRequirement(levelRequirement: ILevelRequirement): boolean {
  return !isEmpty(getJudgeableLevelRequirement(levelRequirement));
}

/**
 * 该等级是否为「入口级」门槛 —— 零统计用户（无上传/下载/做种/发布/时间……）也能满足。
 * DEFS1-6 收口：像 midnightscene 的 `{ratio:0}` 这种门槛，Leech(id0) 与 User(id1) 判级键完全相同，
 * 但它对任何人都成立（分享率 0 是 `if (minRequireRatio)` 的假值分支，恒不判未满足），
 * 若按「第一次出现」去重就会把新/小用户固定判成 Leech(0)。
 * 注意：引擎求 ratio 时会把结果写回 userInfo，所以这里必须传一份新的空画像，不能复用同一对象。
 */
function isZeroStatSatisfiable(levelRequirement: ILevelRequirement): boolean {
  return isLevelRequirementMet({} as IUserInfo, levelRequirement);
}

export function getMaxUserLevelId(levelRequirements: ILevelRequirement[]): TLevelId {
  return levelRequirements
    .map((x) => ({ ...x, groupType: x.groupType ?? "user" }))
    .filter((x) => x.groupType === "user")
    .reduce((max, current) => (current.id > max ? current.id : max), 0);
}

export function getNextLevelUnMet(
  userInfo: IUserInfo,
  levelRequirements: ILevelRequirement[],
): Partial<IImplicitUserInfo & { level?: ILevelRequirement }> {
  let nextLevelUnMet: Partial<IImplicitUserInfo> = {};

  const currentLevelId = userInfo.levelId ?? -1;
  if (currentLevelId < getMaxUserLevelId(levelRequirements)) {
    const currentLevelRequirement = levelRequirements.find((level) => level.id === currentLevelId);
    const currentJudgeableRequirement = currentLevelRequirement
      ? getJudgeableLevelRequirement(currentLevelRequirement)
      : undefined;

    // DEFS1-1/DEFS1-6：无门槛的等级没有任何「待满足条件」，与当前等级门槛逐字相同的等级也不是真实目标，
    // 二者都会让「距下一级」面板显示一个空目标（desigaane 的 Torrent Master、dicmusic 的 Elite TM +）——
    // 这里跳过它们，找不到真实下一级时返回空对象（面板显示「已无可判定目标」而不是「无待满足条件」）
    const nextLevelRequirement = levelRequirements.find((level) => {
      if (level.id <= currentLevelId) {
        return false;
      }

      const judgeableRequirement = getJudgeableLevelRequirement(level);
      if (isEmpty(judgeableRequirement)) {
        return false;
      }

      return !currentJudgeableRequirement || !isEqual(currentJudgeableRequirement, judgeableRequirement);
    });

    if (nextLevelRequirement) {
      nextLevelUnMet = { ...levelRequirementUnMet(userInfo, nextLevelRequirement), level: nextLevelRequirement };
    }
  }

  return nextLevelUnMet;
}

export function guessUserLevelId(userInfo: IUserInfo, levelRequirements: ILevelRequirement[]): TLevelId {
  // 首先尝试 levelName 的直接匹配，站点levelRequirements中配置的 name 一定要等于或包含 获取到的 levelName 中才会匹配成功
  let level = levelRequirements.find((level) => {
    const cleanedUserLevelName = cleanLevelName(userInfo.levelName!);
    return [level.name, ...(level.nameAka ?? [])]
      .map(cleanLevelName)
      .some((name) => name.includes(cleanedUserLevelName));
  });
  if (level) {
    return level.id;
  }

  // 再尝试判断 groupType
  let groupType = guessUserLevelGroupType(userInfo.levelName!);
  if (groupType !== "user") {
    level = levelRequirements.find((level) => level.groupType === groupType);
    if (level) {
      return level.id;
    } else {
      // 如果没有找到，这个人也应该是 vip 或者 manager，则返回一个默认值
      return groupType == "vip" ? MinVipLevelId : MinManagerLevelId;
    }
  }

  // 如果还是没有找到，说明应当是 user 类别的某一个，则尝试通过 userInfo 和 levelRequirements 的具体项匹配
  // DEFS1-1/1-3/1-6：回落阶梯只走「有可判定门槛」的 user 等级，并取所有门槛都满足的最高等级 ——
  //  • 只有 name/privilege 的占位等级（desigaane 5/6/7 级）不能算已满足，否则用户会被一路抬到没有门槛的顶级；
  //  • 判级键与前面等级逐字相同的重复等级（dicmusic id7/id8）只按第一次出现计入，较低的一级仍可被判定；
  //  • 「遇到首个未满足就取前一项」在阶梯中间插有特殊等级（darkpeers 的 Seeder 等）时会判低一级。
  let testLevel = -1;
  const seenJudgeableRequirements: Partial<ILevelRequirement>[] = [];
  for (const levelRequirement of levelRequirements ?? []) {
    if ((levelRequirement.groupType ?? "user") !== "user") {
      continue;
    }

    const judgeableRequirement = getJudgeableLevelRequirement(levelRequirement);
    if (isEmpty(judgeableRequirement)) {
      continue;
    }

    // DEFS1-6 去重只对「非入口级」门槛生效：midnightscene 的 Leech(0)/User(1) 判级键同为 {ratio:0}，
    // 零统计用户也满足，属入口级的多个档次，去重会跳过较高的 id1 而把新/小用户判成 Leech(0)（分享率降级等级）；
    // 只有 dicmusic id7/id8 那种需要累积上传/时间/完美 FLAC 的门槛才去重，满足后仍返回较低的一级。
    if (!isZeroStatSatisfiable(levelRequirement)) {
      if (seenJudgeableRequirements.some((seen) => isEqual(seen, judgeableRequirement))) {
        continue;
      }
      seenJudgeableRequirements.push(judgeableRequirement);
    }

    if (isLevelRequirementMet(userInfo, levelRequirement) && levelRequirement.id > testLevel) {
      testLevel = levelRequirement.id;
    }
  }

  if (testLevel === -1) {
    // 一个可判定门槛都没被满足时退回原走位（首个未满足 user 等级前最近的那一级）：
    // 首个等级就带门槛的站点（部分 NPHP 从 PU 开始定义）仍返回 -1「未知等级」，不冒认成该级
    return getLevelIdBeforeFirstUnmet(userInfo, levelRequirements);
  }

  return testLevel;
}

/** 原走位兜底：首个带门槛且未满足的 user 等级之前最近的一级；前面没有 user 等级（如部分 NPHP 从 PU 开始定义）则 -1 */
function getLevelIdBeforeFirstUnmet(userInfo: IUserInfo, levelRequirements: ILevelRequirement[]): TLevelId {
  let testLevel = -1;
  for (const levelRequirement of levelRequirements ?? []) {
    if ((levelRequirement.groupType ?? "user") !== "user") {
      continue;
    }

    if (hasJudgeableRequirement(levelRequirement) && !isLevelRequirementMet(userInfo, levelRequirement)) {
      return testLevel;
    }

    // 无门槛等级只能作为「上一级」的候选（品牌新用户的默认等级即这类）
    testLevel = levelRequirement.id;
  }

  // 整条阶梯都没有可判定门槛（或都被满足）时取最高 user 等级，与原走位一致
  return getMaxUserLevelId(levelRequirements);
}
