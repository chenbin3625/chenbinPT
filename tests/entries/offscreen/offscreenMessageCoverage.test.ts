import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function collectTypeScriptFiles(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) {
      collectTypeScriptFiles(path, files);
    } else if (path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("offscreen 消息清单覆盖", () => {
  it("消息路由清单与 offscreen 实际处理器必须一一对应", () => {
    const messagesSource = readFileSync(resolve(repoRoot, "src/entries/messages.ts"), "utf8");
    const listBlock = messagesSource.match(/const offscreenMessageTypes[\s\S]*?\]\);/)?.[0];
    expect(listBlock).toBeTruthy();

    const listed = new Set([...listBlock!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!));
    const handled = new Set<string>();
    for (const file of collectTypeScriptFiles(resolve(repoRoot, "src/entries/offscreen"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/onMessage\(\s*"([^"]+)"/g)) {
        handled.add(match[1]!);
      }
    }

    expect({
      handlersNotListed: [...handled].filter((type) => !listed.has(type)).sort(),
      listedWithoutHandler: [...listed].filter((type) => !handled.has(type)).sort(),
    }).toEqual({
      handlersNotListed: [],
      listedWithoutHandler: [],
    });
  });
});
