/**
 * M-14：恢复备份前的版本警示。版本号已从四段（v0.0.7.1962+sha）改为三段（v0.0.10+sha），
 * 旧正则只认四段，于是 compareVersion 恒为 null、「用旧版恢复新版备份」的警示永远不弹。
 */
import { describe, expect, it } from "vitest";

import { compareVersion, extractVersion } from "@/options/views/Settings/SetBackup/utils.ts";

describe("SetBackup 版本比较", () => {
  it("能解析现行三段版本与旧的四段版本", () => {
    expect(extractVersion("chenbinPT (v0.0.10+d8d0628)")).toBe("0.0.10");
    expect(extractVersion("v0.0.10+d8d0628")).toBe("0.0.10");
    expect(extractVersion("chenbinPT (v0.0.7.1962+abc)")).toBe("0.0.7.1962");
    expect(extractVersion("unknown")).toBeNull();
  });

  it("备份来自更新的版本时返回 1（触发警示）", () => {
    expect(compareVersion("v0.0.11+aaa", "v0.0.10+bbb")).toBe(1);
    expect(compareVersion("v0.1.0+aaa", "v0.0.10+bbb")).toBe(1);
  });

  it("同版本 / 更旧版本不警示", () => {
    expect(compareVersion("v0.0.10+aaa", "v0.0.10+bbb")).toBe(0);
    expect(compareVersion("v0.0.9+aaa", "v0.0.10+bbb")).toBe(-1);
    // 四段旧版本 0.0.7.1962 早于三段新版本 0.0.8（这正是改三段时的版本跃迁）
    expect(compareVersion("v0.0.7.1962+old", "v0.0.8+new")).toBe(-1);
  });

  it("任一版本无法解析时返回 null", () => {
    expect(compareVersion(undefined, "v0.0.10+bbb")).toBeNull();
  });
});
