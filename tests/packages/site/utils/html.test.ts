import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cfDecodeEmail,
  createDocument,
  extractContent,
  extractTextExcluding,
  getHostFromUrl,
  restoreSecureLink,
  rot13,
} from "@ptd/site/utils/html.ts";

describe("getHostFromUrl", () => {
  beforeEach(() => {
    // 非法 URL 时实现会 console.debug 记录兜底信息（见 html.ts 中 P1-5 的注释），单测里静音
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("返回 host（含非默认端口）并统一小写", () => {
    expect(getHostFromUrl("https://pt.example.com/browse.php?id=1")).toBe("pt.example.com");
    expect(getHostFromUrl("https://pt.example.com:8443/a")).toBe("pt.example.com:8443");
    expect(getHostFromUrl("HTTPS://PT.EXAMPLE.COM/x")).toBe("pt.example.com");
  });

  it("IPv4 / 带端口 / 顶层域都可解析", () => {
    expect(getHostFromUrl("https://example.com")).toBe("example.com");
    expect(getHostFromUrl("http://127.0.0.1:8080/x")).toBe("127.0.0.1:8080");
    expect(getHostFromUrl("https://pt.example.com./x")).toBe("pt.example.com.");
  });

  it("host 为空的协议按 URL 语义返回空串（不回落到原字符串）", () => {
    expect(getHostFromUrl("mailto:someone@example.com")).toBe("");
    expect(getHostFromUrl("file:///tmp/a.html")).toBe("");
  });

  it("畸形输入回落为原字符串而不是抛错（调用方依赖该兜底）", () => {
    expect(getHostFromUrl("")).toBe("");
    expect(getHostFromUrl("not-a-url")).toBe("not-a-url");
    expect(getHostFromUrl("//pt.example.com/x")).toBe("//pt.example.com/x");
    expect(getHostFromUrl("https://")).toBe("https://");
  });
});

describe("extractContent", () => {
  it("剥离标签并解码 HTML 实体", () => {
    expect(extractContent("<b>粗体</b> 普通")).toBe("粗体 普通");
    expect(extractContent("a &amp; b &lt;c&gt; &quot;d&quot;")).toBe('a & b <c> "d"');
    expect(extractContent("&#65;&#x42;")).toBe("AB");
  });

  it("块级元素与 <br> 之间不插入分隔符（纯 textContent 语义）", () => {
    expect(extractContent("<div>line1<br>line2</div>")).toBe("line1line2");
    expect(extractContent("<p>a</p><p>b</p>")).toBe("ab");
  });

  it("空输入与无文本节点输入返回空串", () => {
    expect(extractContent("")).toBe("");
    expect(extractContent("<img src=x>")).toBe("");
    expect(extractContent("<div><span></span></div>")).toBe("");
  });

  it("script/style 的文本同样被取出（本函数不做净化，调用方需自行处理）", () => {
    expect(extractContent("<script>alert(1)</script>")).toBe("alert(1)");
    expect(extractContent("<style>.a{color:red}</style>")).toBe(".a{color:red}");
  });

  it("CJK / emoji / 组合字符按原样保留", () => {
    expect(extractContent("<span>你好</span>😀")).toBe("你好😀");
    expect(extractContent("e\u0301")).toBe("e\u0301"); // 分解形式的 e + 组合尖音符
  });
});

describe("extractTextExcluding", () => {
  const build = (html: string): HTMLDivElement => {
    const el = document.createElement("div");
    el.innerHTML = html;
    return el;
  };

  it("排除匹配选择器的后代元素", () => {
    const el = build(`<span class="meta">上传 1GB</span>Hello <b>world</b><span class="meta">dl</span>`);
    expect(extractTextExcluding(el, ".meta")).toBe("Hello world");
  });

  it("被排除元素的整棵子树都被丢弃", () => {
    const el = build(`<span class="meta"><i>inner</i>tail</span>keep`);
    expect(extractTextExcluding(el, ".meta")).toBe("keep");
  });

  it("只作用于后代：element 自身即使匹配选择器也不被排除", () => {
    const el = build(`<span>a</span>b`);
    el.className = "self";
    expect(extractTextExcluding(el, ".self")).toBe("ab");
  });

  it("选择器不匹配时等价于 textContent", () => {
    const el = build(`<span>a</span>b<em>c</em>`);
    expect(extractTextExcluding(el, ".definitely-not-here")).toBe(el.textContent);
  });

  it("按文档顺序拼接，不重排也不插入分隔符", () => {
    const el = build(`1<span>2</span>3<i>4</i>`);
    expect(extractTextExcluding(el, ".none")).toBe("1234");
  });

  it("空元素返回空串", () => {
    expect(extractTextExcluding(build(""), "*")).toBe("");
  });
});

describe("rot13", () => {
  it("字母平移 13 位且保留大小写", () => {
    expect(rot13("Hello, World!")).toBe("Uryyb, Jbeyq!");
    expect(rot13("abcXYZ")).toBe("nopKLM");
  });

  it("非 ASCII 字母字符原样保留（数字 / 标点 / CJK / emoji）", () => {
    expect(rot13("123-_.~/%")).toBe("123-_.~/%");
    expect(rot13("中文😀")).toBe("中文😀");
  });

  it("对合：两次调用回到原文", () => {
    const url = "https://pt.example.com/browse.php?search=你好&page=2";
    expect(rot13(rot13(url))).toBe(url);
  });

  it("空串返回空串", () => {
    expect(rot13("")).toBe("");
  });
});

describe("restoreSecureLink", () => {
  it("以 uggc 开头的链接会被 ROT13 解码", () => {
    // 站点定义里存的是整串（含 host）ROT13 后的 URL，
    // 例如 src/packages/site/definitions/52movie.ts 的 "uggcf://jjj.52zbivr.gbc/"
    expect(restoreSecureLink("uggcf://jjj.52zbivr.gbc/")).toBe("https://www.52movie.top/");
    expect(restoreSecureLink(rot13("https://pt.example.com/"))).toBe("https://pt.example.com/");
  });

  it("未加密的链接原样返回", () => {
    expect(restoreSecureLink("https://pt.example.com/")).toBe("https://pt.example.com/");
    expect(restoreSecureLink("")).toBe("");
  });
});

describe("cfDecodeEmail", () => {
  // 回归背景（Lead 已修复 html.ts）：
  // 1) 旧实现把上游的 `substr(n, 2)` 写成 `slice(n, 2)`。slice 第二参是「结束下标」，
  //    n>=2 时永远取到空串 -> parseInt("",16) === NaN -> NaN ^ r === r，整串解不出来。
  // 2) 旧实现的循环条件 `encodedString.length - n` 在 length < 2 或为奇数时恒为真值，
  //    短输入会无限循环直至 OOM。下面这三个用例就是钉住这两个缺陷不再回归。
  it("按 Cloudflare 算法解码十六进制编码的邮箱", () => {
    // "41" 是异或键 0x41('A')，其后每两个十六进制字符编码一个明文字符：
    // 'a'(0x61) ^ 0x41 = 0x20 -> "20"，'b'(0x62) ^ 0x41 = 0x23 -> "23"
    expect(cfDecodeEmail("412023")).toBe("ab");
  });

  it("解出真实的邮箱串", () => {
    // 用同一算法先编码再解码，避免硬编码十六进制串写错
    const key = 0x6a;
    const plain = "a@b.c";
    const encoded = [...plain].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
    expect(cfDecodeEmail(key.toString(16) + encoded)).toBe(plain);
  });

  it.each(["", "4", "41", "412"])("对过短/不完整输入（%j）安全返回空串而不死循环", (input) => {
    expect(cfDecodeEmail(input)).toBe("");
  });

  it("对非十六进制输入返回空串", () => {
    expect(cfDecodeEmail("zzzz")).toBe("");
  });
});

describe("createDocument", () => {
  it("按 text/html 解析并可通过选择器查询", () => {
    const doc = createDocument("<div id='a'><span>hi</span></div>");
    expect(doc.querySelector("#a span")?.textContent).toBe("hi");
  });

  it("支持显式指定 MIME 类型", () => {
    const doc = createDocument("<root><child>x</child></root>", "application/xml");
    expect(doc.querySelector("child")?.textContent).toBe("x");
  });
});
