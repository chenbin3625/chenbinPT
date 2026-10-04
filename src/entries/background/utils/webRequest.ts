import { onMessage } from "@/messages.ts";

onMessage("updateDNRSessionRules", async ({ data: { rule, extOnly = true } }) => {
  // 将规则正向圈定到本扩展发起的请求，避免误改普通网页的请求头（见 #1465）。
  //
  // DNR 的 initiatorDomains 按「请求 initiator 的 host」匹配。两浏览器下扩展自身上下文
  // （background/offscreen/options 等）发起的请求，其 initiator host 均等于扩展自身 origin 的 host：
  // - Chrome：chrome-extension://<id>，host 即 chrome.runtime.id；
  // - Firefox：moz-extension://<uuid>，host 是扩展的 moz-extension UUID。而 chrome.runtime.id 返回
  //   manifest 声明的 gecko.id（本扩展未声明，由 Firefox 生成内部 UUID），与 moz-extension UUID 并不
  //   相同（也非合法 domain），规则将永不命中，导致扩展发起的 unsafe header 请求（如 M-Team 校验所需的 Origin 头）
  //   在 Firefox 中全部失效（见 #1486）。因此 Firefox 侧取 new URL(chrome.runtime.getURL("")).host
  //   作为匹配值（在任何扩展上下文均可计算，不依赖 location）。
  if (extOnly) {
    rule.condition.initiatorDomains = [
      __BROWSER__ === "firefox" ? new URL(chrome.runtime.getURL("")).host : chrome.runtime.id,
    ];
    delete rule.condition.excludedTabIds;
  }

  /**
   * 防御性校验（见 docs/performance-audit.md P1-9）。
   *
   * 调用方（replaceUnsafeHeader）会按「URL + method + headers」派生确定性规则 id：
   * id 必须是正整数，否则无法按 id 精确删除；urlFilter 与 regexFilter 只能二选一
   * （两者同时存在时 Chrome 会直接拒绝安装）。这里显式抛错，让安装失败成为调用方可观察的
   * reject——否则调用方会把「没装上的规则」当成成功写进缓存，后续命中缓存不再重试。
   */
  if (!Number.isInteger(rule.id) || rule.id <= 0) {
    throw new Error(`[PTD] invalid DNR session rule id: ${String(rule.id)}`);
  }
  if (rule.condition.urlFilter && rule.condition.regexFilter) {
    throw new Error(`[PTD] DNR rule ${rule.id} must not set both urlFilter and regexFilter`);
  }

  return await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [rule.id],
    addRules: [rule],
  });
});

onMessage("removeDNRSessionRuleById", async ({ data: ruleId }) => {
  return await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
  });
});
