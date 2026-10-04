/**
 * 流式 ZIP 写出器（见 docs/performance-audit.md P1-25）。
 *
 * 背景：备份导出原本走 JSZip：所有条目的内容都以 JS 字符串形式常驻内存，
 * `generateAsync()` 时才组装成 Blob。加密备份的条目是不可压缩的 base64 密文，
 * 几十万条历史时会同时持有「全部密文 + 整包输出」，峰值内存可达备份体积的数倍。
 *
 * 这里实现一个**只用 STORE（不压缩）**的 ZIP 写出器：
 * - 逐条目生成 `Blob([localHeader, content])`，内容随即进入浏览器的 blob 存储
 *   （大 Blob 通常落盘，不占 JS 堆），因此 JS 堆峰值 ≈ 单条条目；
 * - 最后 `new Blob(parts)` 以**引用方式**拼接，而不是把整包数据复制进堆；
 * - 产物是标准 ZIP（STORE + UTF-8 名称 + 中央目录），JSZip 等任意解压实现都能读。
 *
 * 安全阀：单个/总大小或中央目录偏移超过 4GiB（ZIP32 上限）时抛错，
 * 避免悄悄产出损坏的 zip（备份体积远达不到该量级，正常不会触发）。
 */
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_VERSION_NEEDED = 20; // 2.0：STORE + 基础特性
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;

const UINT32_MAX = 0xffffffff;

export interface IZipEntry {
  name: string;
  content: string | Uint8Array;
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** 标准 CRC-32（IEEE 802.3），ZIP 条目校验用 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crc32Table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

/**
 * 用 STORE 方式把条目写成 zip Blob。
 *
 * 参数是 Iterable 而非数组：调用方可以边加密边产出条目，避免一次性持有全部内容。
 */
export interface ICreateZipOptions {
  /** 是否对条目做 raw deflate 压缩（ZIP method 8）。加密密文等不可压缩内容应传 false */
  compress?: boolean;
  modifiedAt?: Date;
}

/** 单条目 raw deflate（ZIP method 8 要求的是不带 zlib 头的 deflate 流） */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function createZipBlob(entries: Iterable<IZipEntry>, options: ICreateZipOptions = {}): Promise<Blob> {
  const { compress = false, modifiedAt = new Date() } = options;
  const encoder = new TextEncoder();
  const { time, date } = toDosDateTime(modifiedAt);

  const parts: BlobPart[] = [];
  const centralDirectory: Uint8Array[] = [];
  let offset = 0;
  let entryCount = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const contentBytes = typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;

    if (contentBytes.length > UINT32_MAX) {
      throw new Error(`[PTD] zip entry "${entry.name}" exceeds 4GiB, which is not supported by this writer`);
    }

    const crc = crc32(contentBytes);
    const method = compress ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORE;
    const storedBytes = compress ? await deflateRaw(contentBytes) : contentBytes;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, ZIP_LOCAL_FILE_HEADER_SIGNATURE, true);
    localView.setUint16(4, ZIP_VERSION_NEEDED, true);
    localView.setUint16(6, ZIP_FLAG_UTF8, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, storedBytes.length, true); // 压缩后大小（STORE 时等于原大小）
    localView.setUint32(22, contentBytes.length, true); // 原始大小
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true); // extra field 长度
    localHeader.set(nameBytes, 30);

    // 每条目单独成 Blob：内容进入浏览器 blob 存储后即可释放 JS 堆引用
    // TS 5.7 起 Uint8Array<ArrayBufferLike> 与 BlobPart 的类型不完全兼容，这里显式收窄
    parts.push(new Blob([localHeader as unknown as BlobPart, storedBytes as unknown as BlobPart]));

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, ZIP_CENTRAL_DIRECTORY_SIGNATURE, true);
    centralView.setUint16(4, ZIP_VERSION_NEEDED, true); // version made by
    centralView.setUint16(6, ZIP_VERSION_NEEDED, true); // version needed
    centralView.setUint16(8, ZIP_FLAG_UTF8, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, storedBytes.length, true);
    centralView.setUint32(24, contentBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    // 30: extra 长度、32: comment 长度、34: 起始磁盘号、36: 内部属性、38: 外部属性 均为 0
    centralView.setUint32(42, offset, true); // local header 偏移
    centralHeader.set(nameBytes, 46);
    centralDirectory.push(centralHeader);

    offset += localHeader.length + storedBytes.length;
    entryCount += 1;
  }

  const centralDirectoryOffset = offset;
  let centralDirectorySize = 0;
  for (const header of centralDirectory) {
    parts.push(header as unknown as BlobPart);
    centralDirectorySize += header.length;
  }

  if (centralDirectoryOffset > UINT32_MAX || centralDirectorySize > UINT32_MAX || entryCount > 0xffff) {
    throw new Error("[PTD] backup archive exceeds ZIP32 limits (4GiB / 65535 entries)");
  }

  const endOfCentralDirectory = new Uint8Array(22);
  const endView = new DataView(endOfCentralDirectory.buffer);
  endView.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  endView.setUint16(4, 0, true); // 当前磁盘号
  endView.setUint16(6, 0, true); // 中央目录起始磁盘号
  endView.setUint16(8, entryCount, true);
  endView.setUint16(10, entryCount, true);
  endView.setUint32(12, centralDirectorySize, true);
  endView.setUint32(16, centralDirectoryOffset, true);
  endView.setUint16(20, 0, true); // 注释长度
  parts.push(endOfCentralDirectory);

  // Blob 之间按引用拼接：不会把整包数据复制进 JS 堆
  return new Blob(parts, { type: "application/zip" });
}
