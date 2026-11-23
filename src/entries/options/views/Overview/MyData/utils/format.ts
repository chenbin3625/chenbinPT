import { isValid } from "date-fns";

import { fixRatio, IUserInfo } from "@ptd/site";
import { deepToRaw } from "@/options/utils.ts";

export function fixUserInfo<T extends IUserInfo = IUserInfo>(userInfo: Partial<T>): Required<T> {
  userInfo = deepToRaw(userInfo);
  userInfo.ratio = fixRatio(userInfo);
  userInfo.trueRatio = fixRatio(userInfo, "trueRatio");
  userInfo.messageCount ??= 0;

  if (typeof userInfo.joinTime !== "number") {
    if (isValid(new Date(userInfo.joinTime!))) {
      userInfo.joinTime = new Date(userInfo.joinTime!).getTime();
    }
  }

  return userInfo as Required<T>;
}

export function realFormatRatio(ratio: number | string | null | undefined): string | "∞" | "" {
  if (ratio === null || ratio === undefined) {
    return "-";
  }

  let numericRatio: number;
  if (typeof ratio === "number") {
    numericRatio = ratio;
  } else if (typeof ratio === "string") {
    const trimmed = ratio.trim();
    if (!trimmed) {
      return "-";
    }
    if (/^(?:∞|inf(?:inity)?\.?)$/i.test(trimmed)) {
      return "∞";
    }
    numericRatio = Number(trimmed);
  } else {
    return "-";
  }

  if (Number.isNaN(numericRatio) || numericRatio === -Infinity) {
    return "-";
  }

  if (numericRatio > 10000 || numericRatio === -1 || numericRatio === Infinity) {
    return "∞";
  }

  if (!Number.isFinite(numericRatio)) {
    return "-";
  }

  return numericRatio.toFixed(2);
}

export function formatRatio(
  userInfo: Partial<IUserInfo>,
  ratioKey: "ratio" | "trueRatio" = "ratio",
): string | "∞" | "" {
  const ratio = userInfo?.[ratioKey] as string | number | null | undefined;
  return realFormatRatio(ratio);
}
