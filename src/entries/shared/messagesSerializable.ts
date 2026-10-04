/**
 * 消息体解代理 + 显式序列化工具（见 docs/performance-audit.md P1-1）。
 *
 * `sendMessage` 需要在把数据交给 `chrome.runtime.sendMessage` 之前把 Vue 响应式代理展开成
 * 普通对象，否则会抛 DataCloneError（issue #1431）。早期实现是 `JSON.parse(JSON.stringify(data))`，
 * 对大 payload（搜索快照、备份数据、整份 metadata）会产生完整字符串 + 二次拷贝；
 * 这里改为递归解代理，不再做整份字符串往返。
 *
 * ⚠️ 不要再声称「真正的复制交给浏览器自身的结构化克隆」（缺陷清单 A-1，旧注释与事实不符）：
 * - `@webext-core/messaging` 直接调用 `chrome.runtime.sendMessage`（见
 *   node_modules/@webext-core/messaging/dist/index.mjs），**Chrome 对消息体使用 JSON 序列化**：
 *   `Map`/`Set`/`Blob`/`Error` → `{}`、`Date` → ISO 字符串、类型化数组 → `{"0":…}`；
 * - manifest 没有开启 `message_serialization: "structured_clone"`，而且该选项要求 Chrome 148+，
 *   本项目 `vite.config.ts` 声明的是 `minimum_chrome_version: "140"` ⇒ **加 manifest 选项不是可行修复**；
 * - Firefox 走结构化克隆，同样的数据能活下来 ⇒ 同一个消息在 Chrome/Firefox 下类型不同；
 * - 更糟的是**同一浏览器内**：`createMessageWrapper` 的本地 handler 快路径（同上下文注册了 handler 时直接调用）
 *   返回的是真对象，而远端路径返回的是平台序列化后的形状 ⇒ 同一条消息因分发路径不同而类型不同。
 *
 * 因此本模块自给自足：把「平台可能不保留的类型」显式转成 **JSON 可往返**的形状
 * （`JSON.parse(JSON.stringify(toSerializable(x)))` 与 `toSerializable(x)` 语义一致），
 * 让跨上下文消息与落盘两个场景得到同一个结果。
 *
 * 取舍（跨消息 vs 落盘，见缺陷清单 A-1 要求的说明）：
 * - `toSerializable` 同时被 `entries/messages.ts`（跨消息）与 `extends/pinia/webExtPersistence.ts`
 *   （`chrome.storage` 落盘）使用，两个场景的唯一共同要求就是「JSON 往返后语义不变」，
 *   所以共用同一套转换；`chrome.storage` 在 Chrome 下同样是 JSON 语义，转换结果对两者都成立。
 * - 转换是**有损**的：`Date` 只保留毫秒时间戳（类型信息丢失）、`Map` 变成 entries 数组、
 *   `Set` 变成值数组。刻意不做「带类型标签 + 配套反序列化」的方案：那会改变消息与 storage 的
 *   既有格式，并在所有消费点引入兼容分支，超出本次修复范围。
 * - 收到转换结果的一方看到的是转换后的形状（`Date` 是 number、`Map` 是数组），
 *   与本地 handler 快路径看到的一致 —— 这正是本次修复的目标，而不是副作用。
 * - `Blob`/`File` 无法同步转成 JSON 形状：**显式抛错**，不再像旧实现那样交给平台
 *   （Chrome 下会静默变成 `{}`，正是原缺陷的形态）。落盘场景遇到它们会让这次 `$save()` 失败并走
 *   既有的错误日志路径，而不是写进去半个空对象。
 * - 已知残留：`NaN`/`±Infinity` 与 `BigInt` 仍是平台相关的（JSON 会把非有限数字写成 `null`、
 *   遇到 `BigInt` 直接抛错），本次按「与既有 JSON 往返语义对齐」保持不变。
 *
 * 单独成模块的原因：它不依赖 chrome / vue 运行时，便于单测与复用。
 */
import { isTypedArray } from "es-toolkit";

/**
 * 把键写成**自有数据属性**，而不是 `out[key] = value`。
 *
 * `out["__proto__"] = value` 会命中 `Object.prototype.__proto__` 的 setter：输出对象的原型被改写，
 * 而 `__proto__` 自己**不会**成为自有属性 —— 于是从 `JSON.parse` 的远端数据或恢复的备份里
 * 带来的字面量 `__proto__` 键可以往输出对象的原型链上注入属性（缺陷清单 A-2）。
 *
 * 这里用 `Object.defineProperty` 建立自有可枚举属性，语义与 `JSON.parse` 一致
 * （`JSON.parse` 用 CreateDataProperty 建自有属性），因此 `__proto__` 这个键名本身仍会被
 * 后续的 `JSON.stringify` 往返保留。不用 `Object.create(null)` 容器：虽然它同样免疫原型污染，
 * 但会改变下游对「普通对象」的既有假设（`__v_raw` 探测、Vue 响应式包装、部分库的原型检查）。
 */
function setOwnKey(target: Record<string, any>, key: string, value: any): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    return;
  }
  target[key] = value;
}

/**
 * 显式转换「平台可能不保留」的原生类型。
 * 返回 `{ handled: false }` 表示不是这些类型，调用方按原有 JSON 语义继续展开。
 *
 * 顺序要求：必须在「普通对象展开」之前调用，否则 `Map`/`Set`/`Date` 会被 `Object.keys` 展开成 `{}`。
 */
function convertKnownType(raw: any, seen: WeakMap<object, any>): { handled: boolean; value?: any } {
  if (raw instanceof Date) {
    // Date → number（毫秒时间戳）。取时间戳而不是 ISO 字符串：数字在 JSON 与结构化克隆下都原样保留，
    // 不依赖任何一方的额外解析（`new Date(isoString)` 的时区语义反而是新的坑）。
    const timestamp = raw.getTime();
    seen.set(raw, timestamp);
    return { handled: true, value: timestamp };
  }

  if (raw instanceof RegExp) {
    // RegExp → { source, flags }：JSON 会把它变成 {}（信息全丢），这里至少保住正则字面量信息。
    const out = { source: raw.source, flags: raw.flags };
    seen.set(raw, out);
    return { handled: true, value: out };
  }

  if (raw instanceof Map) {
    // Map → entries 数组（保留键序，且键可以是任意可序列化值；折叠成普通对象会丢非字符串键）。
    const out: any[] = [];
    seen.set(raw, out); // 先登记：Map 可以自引用
    for (const [mapKey, mapValue] of raw) {
      out.push([toSerializable(mapKey, seen), toSerializable(mapValue, seen)]);
    }
    return { handled: true, value: out };
  }

  if (raw instanceof Set) {
    const out: any[] = [];
    seen.set(raw, out); // 先登记：Set 可以自引用
    for (const item of raw) {
      out.push(toSerializable(item, seen));
    }
    return { handled: true, value: out };
  }

  if (typeof ArrayBuffer !== "undefined" && (ArrayBuffer.isView(raw) || raw instanceof ArrayBuffer)) {
    /**
     * ArrayBuffer / 类型化数组 / DataView → 普通数组。
     * - 类型化数组（非 DataView）取**元素值**（`Array.from`），不做字节级展开；
     * - DataView 与 ArrayBuffer 没有元素语义，按字节展开。
     *
     * 分支顺序与类型收窄：`ArrayBuffer.isView` 只能把值收窄成 `ArrayBufferView` **接口**，
     * 而类型化数组与 DataView 都实现它（TS 6 的 `ArrayBufferView` 不再是两者的联合类型）
     * ⇒ `raw instanceof DataView` 只能收窄真分支，无法从接口里减掉 DataView，
     * 于是「按元素展开」这一支拿不到 `length` / 数字索引签名（旧写法只能靠一个不成立的断言糊过去）。
     * 这里用 `isTypedArray` 谓词（实现即 `ArrayBuffer.isView(x) && !(x instanceof DataView)`）
     * 把「按元素展开」限定在真正的类型化数组上，与运行时判定逐一对应。
     */
    let out: any[];
    if (ArrayBuffer.isView(raw)) {
      out = isTypedArray(raw)
        ? // 类型化数组：元素值（如 Float32Array([1.5]) → [1.5]）。
          // 显式声明 `number | bigint`：BigInt64Array / BigUint64Array 的元素是 bigint，
          // 不显式声明则联合类型无法匹配 `ArrayLike<number>`（与旧实现在运行时取值一致）
          Array.from<number | bigint>(raw)
        : Array.from(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)); // DataView：只取它覆盖的字节
    } else {
      out = Array.from(new Uint8Array(raw)); // ArrayBuffer：整段字节
    }
    seen.set(raw, out);
    return { handled: true, value: out };
  }

  if (raw instanceof URL) {
    // URL → href 字符串（JSON 下是 {}；字符串也正好是绝大多数消费方需要的形态）。
    const href = raw.href;
    seen.set(raw, href);
    return { handled: true, value: href };
  }

  if (raw instanceof Error) {
    // Error → { name, message, stack }：JSON 下 Error 的自有可枚举键为空 ⇒ {}，这里显式保住诊断信息。
    const out: Record<string, any> = { name: raw.name, message: raw.message };
    if (typeof raw.stack === "string") {
      out.stack = raw.stack;
    }
    seen.set(raw, out);
    return { handled: true, value: out };
  }

  if ((typeof Blob !== "undefined" && raw instanceof Blob) || (typeof File !== "undefined" && raw instanceof File)) {
    // 明确不支持：跨上下文消息在 Chrome 下走 JSON，无法无损传递二进制对象；
    // 静默降级成 {} 正是缺陷清单 A-1 描述的问题，所以这里必须让调用方看见。
    throw new TypeError(
      "toSerializable() 不支持 Blob/File：跨上下文消息与 chrome.storage 都只有 JSON 语义，" +
        "无法无损传递这类对象。请在调用前自行转成 ArrayBuffer / 普通数组。",
    );
  }

  return { handled: false };
}

/**
 * 与 JSON 往返语义对齐的「解代理 + 显式序列化」：
 * - Vue ref → 取 `.value`；Vue reactive/readonly 代理 → 取 `__v_raw`（不引入 vue 运行时）；
 * - Date/RegExp/Map/Set/URL/Error/ArrayBuffer/DataView/类型化数组 → 显式转成 JSON 可往返的形状（见上）；
 * - Blob/File → 抛 TypeError（明确不支持，见上）；
 * - 其余对象（含类实例）按 JSON 语义展开为普通对象；
 * - 对象中值为 undefined/function/symbol 的键丢弃，数组中置为 null；
 * - 处理循环引用；`__proto__` 键写成自有属性，不污染原型（A-2）。
 */
export function toSerializable(value: any, seen: WeakMap<object, any> = new WeakMap()): any {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }

  if (value.__v_isRef === true) {
    return toSerializable(value.value, seen);
  }
  const raw = value.__v_raw ?? value;

  if (typeof raw === "function" || typeof raw === "symbol") {
    return undefined;
  }

  if (seen.has(raw)) {
    return seen.get(raw);
  }

  if (Array.isArray(raw)) {
    const out: any[] = new Array(raw.length);
    seen.set(raw, out);
    for (let i = 0; i < raw.length; i++) {
      const item = toSerializable(raw[i], seen);
      out[i] = item === undefined || typeof item === "function" ? null : item;
    }
    return out;
  }

  const converted = convertKnownType(raw, seen);
  if (converted.handled) {
    return converted.value;
  }

  const out: Record<string, any> = {};
  seen.set(raw, out);
  for (const key of Object.keys(raw)) {
    const item = toSerializable(raw[key], seen);
    if (item === undefined || typeof item === "function" || typeof item === "symbol") {
      continue;
    }
    setOwnKey(out, key, item);
  }
  return out;
}
