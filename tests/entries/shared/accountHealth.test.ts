import { describe, expect, it } from "vitest";
import { EResultParseStatus } from "@ptd/site/types/base.ts";

import { computeSiteInactivityInfo, evaluateAccountHealthDiff, normalizeTimestampMs } from "@/shared/accountHealth.ts";
import type { IAlertConfig } from "@/shared/types/storages/config.ts";

const baseAlertsConfig: IAlertConfig = {
  enabled: true,
  notifyUnreadMessage: true,
  notifyHnRWarning: true,
  notifyNeedLogin: true,
  notifyLowRatio: true,
  lowRatioThreshold: 1.0,
  notifyLevelUp: true,
  notifyInactivity: true,
  defaultSiteMaxInactiveDays: 30,
  inactivityWarningDays: 7,
  webhook: {
    type: "none",
    url: "",
  },
};

describe("accountHealth helpers", () => {
  it("normalizes second and millisecond timestamps safely", () => {
    expect(normalizeTimestampMs(1700000000)).toBe(1700000000 * 1000);
    expect(normalizeTimestampMs(1700000000000)).toBe(1700000000000);
    expect(normalizeTimestampMs(0)).toBeNull();
    expect(normalizeTimestampMs(-5)).toBeNull();
    expect(normalizeTimestampMs(undefined)).toBeNull();
  });

  it("computes inactivity countdown and status tiers accurately", () => {
    const now = Date.UTC(2026, 5, 1);
    const dayMs = 24 * 60 * 60 * 1000;

    const okInfo = computeSiteInactivityInfo({ lastAccessAt: now - 10 * dayMs }, 30, 7, now);
    expect(okInfo).toMatchObject({ inactiveDays: 10, maxInactiveDays: 30, remainingDays: 20, status: "ok" });

    const warnInfo = computeSiteInactivityInfo({ lastAccessAt: now - 25 * dayMs }, 30, 7, now);
    expect(warnInfo).toMatchObject({ inactiveDays: 25, remainingDays: 5, status: "warning" });

    const dangerInfo = computeSiteInactivityInfo({ lastAccessAt: now - 28 * dayMs }, 30, 7, now);
    expect(dangerInfo).toMatchObject({ inactiveDays: 28, remainingDays: 2, status: "danger" });

    const expiredInfo = computeSiteInactivityInfo({ lastAccessAt: now - 35 * dayMs }, 30, 7, now);
    expect(expiredInfo).toMatchObject({ inactiveDays: 35, remainingDays: -5, status: "danger" });

    expect(computeSiteInactivityInfo({}, 30, 7, now)).toBeNull();
    expect(computeSiteInactivityInfo({ lastAccessAt: now }, 0, 7, now)).toBeNull();
  });

  it("returns empty alerts when master switch is disabled", () => {
    const alerts = evaluateAccountHealthDiff({
      siteId: "demo",
      siteName: "Demo",
      current: { status: EResultParseStatus.needLogin },
      alertsConfig: { ...baseAlertsConfig, enabled: false },
    });
    expect(alerts).toEqual([]);
  });

  it("detects unread PMs, H&R increase, low ratio (excluding -1), level change, and inactivity", () => {
    const now = Date.UTC(2026, 5, 1);
    const dayMs = 24 * 60 * 60 * 1000;

    const alerts = evaluateAccountHealthDiff({
      siteId: "demo",
      siteName: "DemoSite",
      previous: {
        status: EResultParseStatus.success,
        messageCount: 1,
        hnrUnsatisfied: 0,
        hnrPreWarning: 0,
        levelName: "User",
      },
      current: {
        status: EResultParseStatus.success,
        messageCount: 3,
        hnrUnsatisfied: 1,
        hnrPreWarning: 2,
        ratio: 0.72,
        downloaded: 1024 ** 3,
        levelName: "Power User",
        lastAccessAt: now - 26 * dayMs,
      },
      alertsConfig: baseAlertsConfig,
      now,
    });

    expect(alerts.map((a) => a.kind)).toEqual(["unreadMessage", "hnrWarning", "lowRatio", "levelUp", "inactivity"]);

    // ratio = -1 (infinite) must NOT trigger lowRatio alert
    const infiniteRatioAlerts = evaluateAccountHealthDiff({
      siteId: "demo",
      siteName: "DemoSite",
      current: {
        status: EResultParseStatus.success,
        ratio: -1,
        downloaded: 0,
      },
      alertsConfig: baseAlertsConfig,
      now,
    });
    expect(infiniteRatioAlerts.some((a) => a.kind === "lowRatio")).toBe(false);
  });

  it("emits needLogin alert and stops further diff checks", () => {
    const alerts = evaluateAccountHealthDiff({
      siteId: "demo",
      siteName: "DemoSite",
      current: {
        status: EResultParseStatus.needLogin,
        messageCount: 5,
      },
      alertsConfig: baseAlertsConfig,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("needLogin");
  });
});
