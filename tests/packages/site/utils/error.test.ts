import { describe, expect, it } from "vitest";

import {
  CFBlockedError,
  EResultParseStatus,
  NeedLoginError,
  NoTorrentsError,
  NoUserInputError,
} from "@ptd/site/types/base.ts";
import {
  NetworkError,
  ServerError,
  classifySiteError,
  isNetworkLikeError,
  siteErrorLogData,
  siteErrorMessage,
} from "@ptd/site/utils/error.ts";

describe("NetworkError / ServerError", () => {
  it("保留既有 message 格式，便于历史代码按前缀识别", () => {
    const network = new NetworkError("Network Error: timeout of 10000ms exceeded");
    const server = new ServerError("Network Error: Request failed with status code 429");

    expect(network).toBeInstanceOf(Error);
    expect(network.name).toBe("NetworkError");
    expect(network.message).toBe("Network Error: timeout of 10000ms exceeded");
    expect(server.name).toBe("ServerError");
  });
});

describe("isNetworkLikeError", () => {
  it("两个标记类异常为 true", () => {
    expect(isNetworkLikeError(new NetworkError("Network Error: x"))).toBe(true);
    expect(isNetworkLikeError(new ServerError("Network Error: x"))).toBe(true);
  });

  it('兼容历史上直接 new Error("Network Error: ...") 的抛法', () => {
    expect(isNetworkLikeError(new Error("Network Error: socket hang up"))).toBe(true);
    expect(isNetworkLikeError(new Error("Network Error:"))).toBe(true); // 只有前缀、无内容也算
  });

  it("其他异常 / 非异常值为 false", () => {
    expect(isNetworkLikeError(new Error("parse failed"))).toBe(false);
    expect(isNetworkLikeError(new CFBlockedError("cf"))).toBe(false);
    // 前缀判断基于 `instanceof Error`，被 throw 的裸字符串不会被识别
    expect(isNetworkLikeError("Network Error: x")).toBe(false);
    expect(isNetworkLikeError(undefined)).toBe(false);
    expect(isNetworkLikeError({ message: "Network Error: x" })).toBe(false);
  });
});

describe("siteErrorMessage", () => {
  it("从 Error 取 message", () => {
    expect(siteErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("从裸字符串取（并 trim），纯空白视为无信息", () => {
    expect(siteErrorMessage("boom")).toBe("boom");
    expect(siteErrorMessage("  boom  ")).toBe("boom");
    expect(siteErrorMessage("   ")).toBeUndefined();
    expect(siteErrorMessage("")).toBeUndefined();
  });

  it("从类 Error 对象（仅带 message 字段）取", () => {
    expect(siteErrorMessage({ message: "boom" })).toBe("boom");
    expect(siteErrorMessage({ message: 42 })).toBeUndefined();
    expect(siteErrorMessage({ code: 500 })).toBeUndefined();
  });

  it("null / undefined / 数字等返回 undefined", () => {
    expect(siteErrorMessage(null)).toBeUndefined();
    expect(siteErrorMessage(undefined)).toBeUndefined();
    expect(siteErrorMessage(42)).toBeUndefined();
  });
});

describe("siteErrorLogData", () => {
  it("Error 展开为可结构化克隆的纯数据", () => {
    const data = siteErrorLogData(new Error("boom"));
    expect(data.name).toBe("Error");
    expect(data.message).toBe("boom");
    expect(typeof data.stack).toBe("string");
  });

  it("非 Error 一律转成 { message: String(e) }", () => {
    expect(siteErrorLogData("boom")).toEqual({ message: "boom" });
    expect(siteErrorLogData(42)).toEqual({ message: "42" });
    expect(siteErrorLogData({ a: 1 })).toEqual({ message: "[object Object]" });
  });
});

describe("classifySiteError", () => {
  it("已知语义异常保持原有状态映射", () => {
    expect(classifySiteError(new CFBlockedError("cf 拦截"))).toEqual({
      status: EResultParseStatus.CFBlocked,
      statusMsg: "cf 拦截",
      retryable: true,
    });
    expect(classifySiteError(new NeedLoginError("需要登录"))).toEqual({
      status: EResultParseStatus.needLogin,
      statusMsg: "需要登录",
      retryable: false,
    });
    expect(classifySiteError(new NoUserInputError("缺少 apiKey"))).toEqual({
      status: EResultParseStatus.noUserInput,
      statusMsg: "缺少 apiKey",
      retryable: false,
    });
    expect(classifySiteError(new NoTorrentsError("没有结果"))).toEqual({
      status: EResultParseStatus.noResults,
      statusMsg: "没有结果",
      retryable: false,
    });
  });

  it("网络/服务端错误 -> unknownError 且可重试（不再被误标为解析错误）", () => {
    expect(classifySiteError(new NetworkError("Network Error: timeout"))).toEqual({
      status: EResultParseStatus.unknownError,
      statusMsg: "Network Error: timeout",
      retryable: true,
    });
    expect(classifySiteError(new ServerError("Network Error: 503"))).toEqual({
      status: EResultParseStatus.unknownError,
      statusMsg: "Network Error: 503",
      retryable: true,
    });
    expect(classifySiteError(new Error("Network Error: ECONNRESET"))).toEqual({
      status: EResultParseStatus.unknownError,
      statusMsg: "Network Error: ECONNRESET",
      retryable: true,
    });
  });

  it("解析类错误 -> parseError 且不可重试", () => {
    expect(classifySiteError(new Error("Cannot read properties of null (reading 'querySelector')"))).toEqual({
      status: EResultParseStatus.parseError,
      statusMsg: "Cannot read properties of null (reading 'querySelector')",
      retryable: false,
    });
    expect(classifySiteError(new TypeError("x is not a function"))).toEqual({
      status: EResultParseStatus.parseError,
      statusMsg: "x is not a function",
      retryable: false,
    });
  });

  it("非 Error 抛出物不会让分类流程崩掉", () => {
    expect(classifySiteError("boom")).toEqual({
      status: EResultParseStatus.parseError,
      statusMsg: "boom",
      retryable: false,
    });
    expect(classifySiteError(undefined)).toEqual({
      status: EResultParseStatus.parseError,
      statusMsg: undefined,
      retryable: false,
    });
    // 被 throw 的裸字符串不满足 instanceof Error，因此 "Network Error:" 前缀不会被识别为可重试
    expect(classifySiteError("Network Error: x")).toEqual({
      status: EResultParseStatus.parseError,
      statusMsg: "Network Error: x",
      retryable: false,
    });
  });

  it("子类优先级：CFBlocked 等状态先于网络类判断", () => {
    const cf = new CFBlockedError("Network Error: 假前缀");
    expect(classifySiteError(cf).status).toBe(EResultParseStatus.CFBlocked);
    expect(classifySiteError(cf).retryable).toBe(true);
  });
});
