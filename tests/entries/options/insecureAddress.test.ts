/**
 * 非 HTTPS 服务器地址判定（缺陷清单 M-10）单元测试。
 *
 * 判定只驱动设置页的安全警告（不做静默拦截），因此这里同时覆盖两类「不能误报」的输入：
 * 空值、以及用户还没填完 / 无法解析的形态 —— 这些应交给表单的 url 规则提示，而不是弹安全警告。
 */
import { describe, expect, it } from "vitest";

import { isInsecureAddress } from "@/options/utils.ts";

describe("isInsecureAddress：明文传输风险判定", () => {
  it("http:// 与 ws:// 判定为不安全", () => {
    expect(isInsecureAddress("http://emby.example.com:8096")).toBe(true);
    expect(isInsecureAddress("http://127.0.0.1:6800/jsonrpc")).toBe(true);
    expect(isInsecureAddress("ws://127.0.0.1:6800/jsonrpc")).toBe(true);
    expect(isInsecureAddress("HTTP://Emby.Example.com")).toBe(true); // 协议大小写不敏感
  });

  it("https:// 与 wss:// 判定为安全", () => {
    expect(isInsecureAddress("https://emby.example.com")).toBe(false);
    expect(isInsecureAddress("wss://emby.example.com/jsonrpc")).toBe(false);
  });

  it("空值与未填完的地址不误报（交给表单 url 规则）", () => {
    expect(isInsecureAddress(undefined)).toBe(false);
    expect(isInsecureAddress(null)).toBe(false);
    expect(isInsecureAddress("")).toBe(false);
    expect(isInsecureAddress("emby.example.com")).toBe(false);
    expect(isInsecureAddress("http:/")).toBe(false);
    expect(isInsecureAddress("http://")).toBe(false);
  });
});
