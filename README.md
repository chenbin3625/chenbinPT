<div align="center">

# chenbinPT

**PT 站点辅助工具（浏览器扩展）** —— 在一个界面里管理你所有的 PT 站点：搜索、用户信息、推送到下载器、辅种、备份。

[![release](https://img.shields.io/github/v/release/chenbin3625/chenbinPT?include_prereleases&label=release)](https://github.com/chenbin3625/chenbinPT/releases)
[![license](https://img.shields.io/github/license/chenbin3625/chenbinPT)](./LICENSE)
![chrome](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)
![firefox](https://img.shields.io/badge/Firefox-MV3-FF7139?logo=firefoxbrowser&logoColor=white)
![node](https://img.shields.io/badge/node-%E2%89%A524-339933?logo=node.js&logoColor=white)

</div>

---

## 这是什么

chenbinPT 是一个浏览器扩展，把散落在几十个 PT 站点上的日常操作收拢到一处：

- 不必逐站打开页面找种子，**一次搜索覆盖你添加的所有站点**；
- 不必逐站看自己的分享率/等级/做种量，**一处汇总并可看时间线与统计**；
- 找到种子后**直接推送到本地下载器**（含批量与发送前确认）；
- 做种任务、下载历史、媒体服务器查重、配置备份都在同一个界面里。

它基于 [PT-depiler](https://github.com/rhilip/PT-depiler)（MIT）发展而来，当前分支 `refactor/antd` 正在把界面层从 Vuetify 迁移到 ant-design-vue。

## 功能

| 模块 | 能做什么 |
| --- | --- |
| **搜索** | 多站点并行搜索、按站点/方案筛选、高级筛选（分类、媒介、编码、分辨率、制作组…）、结果快照与分页、按大小排序、批量复制链接或推送下载 |
| **我的数据** | 汇总各站用户信息（上传/下载/分享率/做种量/做种数/时魔/等级/邀请…），时间线趋势图与分站统计，等级需求与下一级还差多少 |
| **我的下载器** | 统一查看各下载器的种子列表与进度，支持暂停/继续/重新校验/改标签/限速/删除，详情弹窗看文件、Peers、Tracker |
| **下载历史** | 每次推送的记录与状态轮询，失败原因可追溯（是否真的加进了下载器） |
| **辅种任务** | 把已下载的种子重新加入做种（keepUploadTask），可批量 |
| **媒体服务器** | 在 emby / jellyfin / plex / fnOS 中搜索是否已有该影片，避免重复下载 |
| **内容脚本** | 直接在你打开的站点页面上工作：悬浮球、列表/详情页的下载列、拖拽任意链接到悬浮球、高级列表弹窗、社区域解析。在站点页面上就能完成"搜索→推送"而不必切到扩展页 |
| **备份与恢复** | 本地文件或 8 种远端后端，支持加密；可定时自动备份、按策略保留历史 |
| **社交信息** | 从 Bangumi / AniDB / TMDB / IMDb / Douban / TVMaze 拉取条目信息，用于搜索与展示 |

## 支持范围

| 类别 | 数量 | 明细 |
| --- | --- | --- |
| 站点定义 | **341** | 见 [`src/packages/site/definitions/`](src/packages/site/definitions) |
| 解析引擎 | 10 | NexusPHP、Unit3D、Gazelle、GazelleJSONAPI、AvistazNetwork、Luminance、Rartracker、TCG + 两个基类（AbstractPrivateSite / AbstractBittorrentSite） |
| 下载器 | 8 | qBittorrent、Transmission、Deluge、Aria2、ruTorrent、uTorrent、Synology Download Station、Flood |
| 媒体服务器 | 4 | emby、jellyfin、plex、fnOS |
| 备份后端 | 8 | WebDAV、S3、Backblaze B2、Dropbox、Google Drive、Gist、CookieCloud、OWSS |
| 社交站点 | 6 | Bangumi、AniDB、TMDB、IMDb、Douban、TVMaze |

## 安装

### 方式一：下载 Release（推荐普通用户）

到 [Releases](https://github.com/chenbin3625/chenbinPT/releases) 下载：

- `extension-chrome.zip` —— Chrome / Edge 等 Chromium 内核浏览器；
- `extension-firefox.zip` —— Firefox。

**Chrome / Edge**：解压后打开 `chrome://extensions`（Edge 为 `edge://extensions`），打开右上角「开发者模式」，点「加载已解压的扩展程序」，选择解压出来的目录。

**Firefox**：打开 `about:debugging#/runtime/this-firefox` → 「临时载入附加组件」→ 选择解压目录里的 `manifest.json`。

> 注：Firefox 的临时载入在浏览器重启后失效。需要长期使用请用开发者版签名后自行提交到 AMO（仓库不包含发布工作流）。

### 方式二：从源码构建

```bash
git clone https://github.com/chenbin3625/chenbinPT.git
cd chenbinPT
npm ci

npm run build:dist            # Chrome（输出 dist-chrome/）
npm run build:dist-firefox    # Firefox（输出 dist-firefox/）
```

构建完按上文的「加载已解压的扩展程序」指向 `dist-chrome/` 或 `dist-firefox/` 即可。

打包成可分发的压缩包与自签名 CRX：

```bash
(cd dist-chrome && zip -qr ../build/extension-chrome.zip .)
(cd dist-firefox && zip -qr ../build/extension-firefox.zip .)
npm run pack:crx              # → build/extension.crx（自实现 CRX3 并自验签）
```

## 开发

### 环境要求

- **Node ≥ 24**、**npm ≥ 11**（仓库用 npm workspaces 之外的单包结构，锁文件为 `package-lock.json`）
- 可选：Playwright 的 Chromium（跑端到端冒烟测试用）

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | Vite 开发服务器（含扩展热更新） |
| `npm run check` | `vue-tsc --noEmit` 全量类型检查 |
| `npm run lint` | ESLint（历史违规由 `eslint-suppressions.json` 基线豁免，**基线只减不增**） |
| `npm test` | Vitest 单元/组件测试 |
| `npm run check:antd` | antd 迁移验收（禁止 Vuetify 残留、`<Ptd*` 兼容组件、原生控件等 12 项） |
| `npm run check:bundle` | 构建产物完整性 + 体积预算（`--target=firefox` 校验 firefox） |
| `npm run test:e2e` | Playwright + 真实 Chromium 加载构建产物做冒烟测试 |
| `npm run build:watch` | 开发态增量构建（不压缩） |

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)（`<type>(<scope>): <subject>`），由 husky + commitlint 在提交时校验；pre-commit 只对**暂存文件**跑 prettier/eslint。

### 项目结构

```
src/
├── entries/                 # 扩展的各个运行上下文
│   ├── background/          # Service Worker（MV3）/ 后台脚本（MV2）
│   ├── offscreen/           # Offscreen Document：真正发请求、读写 IndexedDB 的地方
│   ├── content-script/      # 注入到 PT 站点的浮层（shadow DOM）
│   ├── options/             # 选项页 SPA（Vue 3 + ant-design-vue）
│   ├── shared/              # 跨上下文共享的类型与工具
│   ├── messages.ts          # 跨上下文消息协议（类型化）
│   └── storage.ts           # 存储层
├── packages/                # 与平台无关（或尽量无关）的核心能力
│   ├── site/                # 站点元数据、10 个解析引擎、341 个站点定义
│   ├── downloader/          # 8 种下载器客户端
│   ├── mediaServer/         # 4 种媒体服务器客户端
│   ├── backupServer/        # 8 种备份后端 + ZIP/加密
│   └── social/              # 6 个社交/元数据站点
├── extends/                 # axios / pinia 的扩展（DNR 请求头、持久化）
└── locales/                 # i18n（en / zh_CN）

tests/                       # Vitest（单元 / 组件 / 契约 / Sizzle 差分 oracle）
scripts/                     # 构建与门禁脚本（打包 CRX、包体预算、antd 验收、E2E 冒烟…）
```

**架构要点**：消息拓扑为 `content-script / options ⇄ background ⇄ offscreen`。所有需要凭据的跨站请求、去重与队列、以及 IndexedDB 读写都集中在 offscreen 文档里，站点解析逻辑主体在 `packages/site`。Firefox 下 offscreen 的 handler 会被注册进 background 本身（本地消息快路径）。

## 数据、权限与隐私

这一点值得你花两分钟读完：

- **扩展申请了 `<all_urls>` 级别的 host 权限**。这是"一次搜索覆盖所有站点"的前提，但也意味着扩展**有能力**代你请求任意站点。代码里对可下载链接做了来源校验（只允许站点自身的域名族 / `magnet:`），但请仍然只从可信来源安装。
- **你的站点凭据（passkey、Cookie）与下载器密码只保存在浏览器本地**（`chrome.storage.local` + IndexedDB），不会上传到任何第三方服务器。
- **备份功能是唯一的例外**：如果你启用远端备份，备份内容（可能含 Cookie、下载器密码、站点 passkey）会被**加密后上传到你自己配置的服务器**。因此：不要恢复来源不明的备份文件——一份他人分享的备份可以植入指向攻击者的备份服务器，从而让你的凭据在下次自动备份时被上传。当前版本的恢复流程默认**不恢复**备份里的服务器配置，并在界面上给出显著警示。
- **`web_accessible_resources` 目前对全部站点开放**（`assets/*`、`vendor/*`），任何网站都能据此探测你是否安装了本扩展。这是已知的隐私面，收窄方案需要配合构建期 chunk 清单，见代码注释。

## 版本号规则

`manifest.json` 的 `version` 直接取 `package.json` 的三位版本号（如 `0.0.8`），**每次发布前手动抬版本号**：

```
<package.json version>               # manifest.version（Chrome / Firefox / 商店都要求纯数字点分）
<package.json version>+<short sha>   # chrome 的 version_name 与 __EXT_VERSION__，用于定位"用户装的是哪一次构建"
```

为什么不再把提交计数拼进版本号：旧实现用 `git rev-list --all --count`，该数字取决于**本机引用**
（包含远端已删除分支遗留的陈旧 remote-tracking 引用），换机器或 `git fetch --prune` 后会变小，
于是产出比已发布版本更低的号 —— Chrome 会拒绝降级安装，商店也会拒绝更低版本的包。

发布流程（仓库不含 CI 工作流，全部在本地完成）：

```bash
# 1) 抬 package.json 的 version（必须大于已发布版本）
# 2) 构建 + 打包
npm run build:dist && npm run build:dist-firefox
(cd dist-chrome  && zip -qr ../build/extension-chrome.zip .)
(cd dist-firefox && zip -qr ../build/extension-firefox.zip .)
npm run pack:crx        # → build/extension.crx（自实现 CRX3 并自校验，用 build/chrome-extension-signing-key.pem 签名）
# 3) 发布（tag 用 v<version>）
gh release create "v$(node -p "require('./package.json').version")" \
  build/extension-chrome.zip build/extension-firefox.zip build/extension.crx \
  --generate-notes --prerelease
```

> `build/chrome-extension-signing-key.pem` 决定扩展 ID（`.gitignore` 已忽略 `*.pem`）：**必须自行备份、永不提交**。换私钥等于换一个新扩展，老用户无法升级。

## 相关文档

- **代码审查报告（2026-10-04）** —— 一次全量审查的完整结果：116 条发现（含阻断级 S-1/S-2/S-3）、逐条修复状态、4 轮独立对抗性验证结论、以及未修项与理由。**建议在改动 `background` / `offscreen` / 存储与消息层之前先读它。**
  该报告已从仓库树中移除（不再随代码分发），但仍可在历史提交里查阅：[`docs/code-review-2026-10-04.md` @ 3b066d59](https://github.com/chenbin3625/chenbinPT/blob/3b066d59/docs/code-review-2026-10-04.md)

## 致谢

- [PT-depiler](https://github.com/rhilip/PT-depiler) —— 本项目的直接来源。
- [Jackett](https://github.com/Jackett/Jackett) —— 大量站点定义与解析规则的参考来源。
- [PTPP / PT-Plugin-Plus](https://github.com/pt-plugins/PT-Plugin-Plus) —— 同领域的先行者。
- [pt-plugins](https://github.com/pt-plugins) 及各站点定义的上游贡献者。

## 许可证

[MIT](./LICENSE)。本项目源自 PT-depiler，保留上游版权声明（`Copyright (c) 2020 pt-plugins`）。

---

> **免责声明**：本工具只做"自动化你在浏览器里本来就能做的事"，不提供任何站点内容，也不绕过站点的邀请/权限体系。请遵守你所在站点的规则与当地法律；因使用本工具导致的账号问题（包括因过于频繁的请求被站点判定为滥用）由使用者自行承担。
