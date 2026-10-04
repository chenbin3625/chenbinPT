import { describe, expect, it } from "vitest";

import { getBackupHistoryErrorReason } from "@/options/views/Settings/SetBackup/utils.ts";

describe("备份历史：加载失败错误文案", () => {
  it("Axios 401 必须明确提示认证失败", () => {
    const error = Object.assign(new Error("Request failed with status code 401"), {
      isAxiosError: true,
      response: { status: 401 },
    });

    expect(getBackupHistoryErrorReason(error)).toBe("401 Unauthorized");
  });

  it("普通 Error 使用自身 message，方便定位具体原因", () => {
    expect(getBackupHistoryErrorReason(new Error("network down"))).toBe("network down");
  });

  it("非 Error 异常转为字符串，不应丢失信息", () => {
    expect(getBackupHistoryErrorReason("permission denied")).toBe("permission denied");
  });
});
