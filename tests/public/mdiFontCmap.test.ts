/**
 * MDI 子集字体的 cmap 必须带 BMP 兼容桩（移植自上游 800c7ef，上游 issue #1669）。
 *
 * 背景：MDI 的码位全在补充私用平面（U+F0000+），子集化重建 cmap 后只剩 format 12。
 * Windows GDI 字体后端（`--disable-direct-write`，MacType 用户的常规做法）会把字体交给
 * `AddFontMemResourceEx` 安装，而安装器只认 BMP 的 (3,1) format 4：字体面创建失败，
 * UserDataTimeline 画布里的 MDI 图标全部变成缺字方块（控制台报
 * "Unable to instantiate font face from font data"）。DirectWrite / macOS / Linux / Firefox
 * 都原生支持 format 12，默认环境下看不出来。
 *
 * `public/lib/mdi/webfont.woff2` 已离线补上一张零映射的 (3,1) format 4（与上游全量 MDI 字体里那张
 * 逐字节一致）。重新子集化时这张不含映射的子表通常会被丢掉（上游的 harfbuzz 流程如此，修复前的
 * 这份字体也缺它），所以**以后重新子集化必须再补一次**：做法见上游 pt-plugins/PT-depiler 800c7ef
 * 的 `vite/utils/sfnt.ts`（ensureBmpCmapSubtable：补表 → 重建表目录与校验和），再压回 woff2。
 * 本测试防的就是漏掉这一步。
 *
 * 只用 node:zlib 解析 WOFF2：cmap 在 WOFF2 里不做变换，按表目录算出它在 Brotli 解压流里的位置即可原样读出。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const FONT_PATH = resolve(import.meta.dirname, "../../public/lib/mdi/webfont.woff2");

/**
 * WOFF2 Known Table Tags 里本测试需要认出的几个下标（表目录 flags 的低 6 位）：
 * cmap 是要读的表；glyf / loca 的 transformVersion 语义与其它表相反。
 * 其余表只需要长度来推进解压流里的偏移，不需要知道 tag。
 */
const KNOWN_TAG_BY_INDEX = new Map<number, string>([
  [0, "cmap"],
  [10, "glyf"],
  [11, "loca"],
]);
const ARBITRARY_TAG_INDEX = 63;

interface CmapEncodingRecord {
  platformID: number;
  encodingID: number;
  format: number;
}

/** WOFF2 的 UIntBase128：每字节低 7 位是数据、最高位表示后面还有字节，最多 5 字节。 */
function readUIntBase128(buf: Buffer, cursor: { pos: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf.readUInt8(cursor.pos++);
    if (i === 0 && byte === 0x80) throw new Error("UIntBase128 不允许前导 0");
    if (value > 0x1ffffff) throw new Error("UIntBase128 超出 32 位");
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  throw new Error("UIntBase128 超过 5 字节");
}

/** 从 WOFF2 里取出一张未做变换的表的原始字节。 */
function readWoff2Table(woff2: Buffer, wantedTag: string): Buffer {
  if (woff2.toString("latin1", 0, 4) !== "wOF2") throw new Error("不是 WOFF2 文件（签名不是 wOF2）");
  if (woff2.toString("latin1", 4, 8) === "ttcf") throw new Error("不支持 WOFF2 字体集合");
  const numTables = woff2.readUInt16BE(12);
  const totalCompressedSize = woff2.readUInt32BE(20);

  // 表目录紧跟 48 字节的文件头；每项 = flags [+ 4 字节 tag] + origLength [+ transformLength]
  const cursor = { pos: 48 };
  const entries: { tag: string; start: number; length: number; transformed: boolean }[] = [];
  let streamLength = 0;
  for (let i = 0; i < numTables; i++) {
    const flags = woff2.readUInt8(cursor.pos++);
    const tagIndex = flags & 0x3f;
    const transformVersion = flags >> 6;
    let tag = KNOWN_TAG_BY_INDEX.get(tagIndex) ?? `#${tagIndex}`;
    if (tagIndex === ARBITRARY_TAG_INDEX) {
      tag = woff2.toString("latin1", cursor.pos, cursor.pos + 4);
      cursor.pos += 4;
    }
    const origLength = readUIntBase128(woff2, cursor);
    // glyf / loca：transformVersion 0 才是「已变换」（3 是原样）；其它表：0 是原样
    const transformed = tag === "glyf" || tag === "loca" ? transformVersion === 0 : transformVersion !== 0;
    // 已变换的表在解压流里占 transformLength 字节，未变换的占 origLength 字节
    const length = transformed ? readUIntBase128(woff2, cursor) : origLength;
    entries.push({ tag, start: streamLength, length, transformed });
    streamLength += length;
  }

  // Brotli 压缩流紧跟在表目录之后（位置随表目录长度变化，不是固定的 48）
  const stream = brotliDecompressSync(woff2.subarray(cursor.pos, cursor.pos + totalCompressedSize));
  if (stream.length !== streamLength) {
    throw new Error(`WOFF2 表目录解析有误：解压流 ${stream.length} 字节，表长合计 ${streamLength} 字节`);
  }

  const entry = entries.find((e) => e.tag === wantedTag);
  if (!entry) throw new Error(`字体里没有 ${wantedTag} 表（实际：${entries.map((e) => e.tag).join(" ")}）`);
  if (entry.transformed) throw new Error(`${wantedTag} 表做了 WOFF2 变换，无法原样读取`);
  return stream.subarray(entry.start, entry.start + entry.length);
}

/** cmap 头：version、numTables，随后每条编码记录 8 字节（platformID、encodingID、子表偏移）。 */
function readCmapEncodingRecords(cmap: Buffer): CmapEncodingRecord[] {
  return Array.from({ length: cmap.readUInt16BE(2) }, (_, i) => {
    const p = 4 + i * 8;
    return {
      platformID: cmap.readUInt16BE(p),
      encodingID: cmap.readUInt16BE(p + 2),
      format: cmap.readUInt16BE(cmap.readUInt32BE(p + 4)),
    };
  });
}

const readMdiCmapRecords = () => readCmapEncodingRecords(readWoff2Table(readFileSync(FONT_PATH), "cmap"));

describe("MDI 子集字体 cmap（Windows GDI 兼容）", () => {
  it("带 (3,1) format 4 兼容桩：GDI 字体后端安装字体的前提", () => {
    expect(
      readMdiCmapRecords(),
      "缺 (3,1) format 4 时 Windows GDI 后端装不上字体、图标全变方块，补桩做法见本文件头",
    ).toContainEqual({ platformID: 3, encodingID: 1, format: 4 });
  });

  it("仍保留 (3,10) format 12：图标码位都在补充私用平面，只能靠它映射", () => {
    expect(readMdiCmapRecords()).toContainEqual({ platformID: 3, encodingID: 10, format: 12 });
  });
});
