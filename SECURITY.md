# 安全说明

chenbinPT 会在本地保存完成搜索、推送、备份所需的凭据与数据。本文说明这些数据保存在哪里、扩展如何隔离它们，以及怎样使用更安全。

## 数据保存位置

扩展会在本地保存：

- 站点凭据：站点 `passkey` / `authkey` / `token`、用户名与密码等；
- 下载器、媒体服务器、备份服务器的连接凭据；
- 备份加密密钥（如果已设置）；
- 下载历史、用户信息历史、搜索快照、辅种任务与收藏等业务数据。

配置与凭据保存在扩展的 `chrome.storage.local`，下载历史等大体量数据保存在 IndexedDB。这些数据仅用于在本机完成搜索、推送与备份，不会主动上传到第三方；备份功能会按你的配置上传到你指定的远端存储。

## 存储访问级别

- **Chrome / Edge 140 及以上**：扩展在启动时调用 `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`，把本地存储限制为只有扩展自身页面（后台 Service Worker、offscreen、选项页）可读，内容脚本无法直接读取。
- **Firefox（以及不支持该 API 的浏览器）**：`chrome.storage.local.setAccessLevel` 尚未实现（[bugzil.la/1724754](https://bugzil.la/1724754)），扩展只能记录一条告警，**本地存储对内容脚本上下文仍然可读**。这是已知的平台能力缺口，属于纵深防御降级：
  - 普通网页的页面脚本（主世界 JS）无法直接调用扩展的 `chrome.storage`，因此不能直接读取这些数据；
  - 风险仅在「扩展的内容脚本自身被攻破 / 被恶意注入」时才可能兑现。

  在 Firefox 上使用时的建议：只从官方 Release 安装、保持浏览器与扩展更新、不要在来源不明的页面长期停留时保持扩展启用；如介意该降级，请使用 Chrome / Edge 140+。

## 内容脚本与页面可见资源

- 每个页面只运行一个约 15 KB 的引导脚本，用来判断当前页面是不是已添加的站点；确认后才由后台通过 `scripting.executeScript` 把站点助手界面注入到该页面（因此扩展需要 `scripting` 权限；扩展已有 `*://*/*` 主机权限，这不会增加安装时的权限提示）。
- 网页能访问的扩展资源（`web_accessible_resources`）只有图标与字体（`icons/*`、`lib/*`），在 Chrome 上使用动态 URL；扩展的脚本与页面都不对网页开放。

## 其他建议

- 定期更换站点的 `passkey` / 下载器密码；备份加密密钥与备份文件分开保管。
- 备份建议设置加密密钥：未设置密钥时，**上传到远端存储**的备份不允许包含 `cookies` / `metadata` / `downloadHistory` / `torrentFavorite` / `keepUploadTask` / `searchResultSnapshot`（避免明文凭据外传；导出到本地文件请自行妥善保管）。
- 「可选的本地原生桥接」（native messaging，默认关闭）只开放只读查询方法，返回值会做凭据脱敏；仅在确认本机宿主程序来源可信时开启。
- 恢复来源不明的备份前，请先检查其内容（尤其备份服务器配置是否被改写）。
- 卸载扩展会清除扩展本地数据，卸载前请先创建备份。

## 报告安全问题

请使用 [GitHub 安全公告](https://github.com/chenbin3625/chenbinPT/security/advisories/new) 私下报告，不要在公开 Issue 中贴出凭据、站点地址或其他敏感信息。
