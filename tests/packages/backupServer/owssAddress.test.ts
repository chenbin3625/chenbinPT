/**
 * SERVERSSOCIAL-8：OWSS 地址规范化曾用 `address.indexOf("storage")` 做全文子串判断，
 * 自建实例部署在 storage 主机名 / 含 storage 的路径段上时不会补 `/storage`，
 * 后续所有请求（/list、/add、/get、/delete）都打到 `<地址>/<authCode>`，表现为 ping 恒 false、list 恒空。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

import OWSS from "@ptd/backupServer/entity/OWSS.ts";

const OWSSCtor = OWSS as unknown as new (config: any) => OWSS;

const makeClient = (address: string, authCode = "auth-code") =>
  new OWSSCtor({ id: "owss-1", type: "OWSS", name: "OWSS", config: { address, authCode } });

describe("SERVERSSOCIAL-8：OWSS 按路径段判断是否已有 /storage", () => {
  it.each([
    // 主机名里出现 storage 不再被误判为「已有 /storage 段」
    ["https://storage.example.com", "https://storage.example.com/storage/auth-code"],
    ["http://storage.local:8088", "http://storage.local:8088/storage/auth-code"],
    // 路径段里出现 storage 子串同理
    ["http://host/my-storage", "http://host/my-storage/storage/auth-code"],
    // 真正的 /storage 段（含尾斜杠）保持原样
    ["http://127.0.0.1:8088/storage", "http://127.0.0.1:8088/storage/auth-code"],
    ["http://127.0.0.1:8088/storage/", "http://127.0.0.1:8088/storage/auth-code"],
    ["http://127.0.0.1:8088", "http://127.0.0.1:8088/storage/auth-code"],
  ])("%s → %s", (address, expected) => {
    expect(makeClient(address).address).toBe(expected);
  });

  it("授权码首尾空白被去掉，避免空白进入请求路径", () => {
    expect(makeClient("http://127.0.0.1:8088/storage", "  auth-code  ").address).toBe(
      "http://127.0.0.1:8088/storage/auth-code",
    );
  });
});
