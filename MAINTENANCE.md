# 注释待办处理记录

本记录对应 2026-11-17 对工作区四个项目的注释审计。原始清单有 40 处 TODO/FIXME 注释，其中 32 处已实现或按当前行为关闭，6 处仍等待可信数据源，2 处属于不可变的第三方测试基准。另有 8 处小写 hack 实现说明，不应统一当成缺陷或删除。

## 已实现

| 原始项目                 | 实现与兼容约定                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 内容脚本整块 HTML 拖拽   | 只保留明确下载链接、magnet、带 download 属性或命中本站下载选择器的链接；仍执行协议和可信主机校验，保留用户确认。                               |
| 下载历史状态筛选         | 增加等待、下载中、完成、失败的三态筛选，复用现有查询字典和国际化状态文案。                                                                     |
| Flood 客户端版本         | 读取 `/api/openapi.json` 的 `info.version`；旧版未提供接口时保持未知版本，不影响下载。                                                         |
| favicon Blob 转换        | 与推荐海报、媒体服务器共用 `helper.ts` 的转换函数；读取失败或中止均拒绝 Promise。                                                              |
| pter 状态                | 仅在证据充分时标为做种或完成；部分进度不能区分下载中/暂停，返回未知，未知状态用灰色问号展示。非法宽度不推导为完成。                            |
| cspt 状态/进度           | 只读取明确百分比，校验 0–100，兼容大小写和小数逗号；不再误读 peers 等其他数字。                                                                |
| 朱雀 CSRF                | 缓存缺失时从已有用户信息端点获取；合并并发获取；仅对明确 CSRF 的 403/419 拒绝刷新并重放一次。一般登录失效、Cloudflare 和网络重试沿用父类契约。 |
| M-Team 空 token          | 网络请求前拒绝缺失、空白或非字符串 token，归为用户配置错误；有效 token 去除两端空白。                                                          |
| Gazelle 分类             | 读取真实 `cats_*` 图标 class，并映射默认分类；保留未知分类 token，避免把标签 tooltip 误当分类。                                                |
| HUDBT 大类               | 新增大类搜索组，展开已有叶子分类参数；保留原细分类及已保存方案，组合时取参数并集。                                                             |
| IPTorrents 旧列表分类    | 复用现有分类编号表，兼容图标 alt 与数字分类链接；未知编号/名称保留原值。                                                                       |
| BeyondHD 中文和 HDR 标签 | 补官方、DoVi、HDR10、HDR10+、HLG、评论音轨；兼容明确布尔/数字 flag，保留优惠比例和全站 H&R 约定。                                              |
| RuTracker 长分类         | 保留完整论坛细分类；表格限制显示宽度并用 title 保留完整文字，不做有损分类映射。                                                                |
| Aidoru 消息数            | 从已有账户页的公共私信导航提取；缺失时保持未提供，真实 0 保留，不额外请求页面。                                                                |

## 按现状关闭

| 原始项目                    | 处理依据                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 全局 enabledAutoBackup 字段 | 仅有类型和默认值，没有业务读取；移除死配置，保持按每服务器 enabled/backupInterval 调度的既有行为。未新增或强制启用全局开关。       |
| 直接发送下载器的开关        | 已有默认关闭配置、设置界面和后台限制，去掉过时注释。                                                                               |
| 搜索方案 i18n 说明          | 当前工具函数和 store 均已国际化，更新历史说明。                                                                                    |
| pter 游戏页裸标记           | 已有完整列表字段配置，移除没有缺失项说明的标记。                                                                                   |
| Cinemageddon 时区           | 保留与 Jackett 一致的固定 UTC−7 约定及现有回归覆盖；未声称核实了站点夏令时政策。                                                   |
| Cinemageddon 做种表         | 已有选择器及异常行修复，说明改为当前解析行为；真实站点分页仍须以页面样本核对。                                                     |
| SpringSunday 标签颜色       | 已有特殊标签选择器和颜色映射，删除“尚未实现”的错误说明。未替换为未经核实的官方色值。                                               |
| HUNO DOM 标签数组           | 当前 JSON 行已有专用标签解析，删除不适用的注释代码。                                                                               |
| SewerPT 默认等级名          | 保留历史 User 匹配，不猜测新名称；移除无内容的标记并说明兼容约定。                                                                 |
| 八份自动转换来源头注释      | kufei、itzmx、raingfh、ptgtk、playletpt、sewerpt、ggpt、oshenpt 改为来源说明；不将自动生成等同于故障，也不声称已在线验证这些站点。 |
| yangleme 备份规则模板       | manifest 已禁用备份且没有引用规则，移除未使用模板。若未来启用备份，须先设计明确的包含/排除规则。                                   |

## 等待可信数据源

以下 6 处代码标记仍保留，涉及 7 个字段。不得以删除注释、填 0、复制其他站点选择器或统计单页行数代替完成。

| 站点与字段                       | 当前证据及完成条件                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| HDTorrents `uploads`             | 现有上传流量不是发布数；需要当前用户页发布数摘要或完整分页样本。                                     |
| SportsCult `uploads`             | 现有列表是做种表，不能作为发布列表；需要发布总数或完整列表样本。                                     |
| HDSpace `uploads`、`seedingSize` | 公开上游没有可靠发布数，做种体积使用 -1 哨兵；需要本站真实摘要或可完整分页的体积列表。               |
| Monikadesign `hnrUnsatisfied`    | 平均做种时间已由 Unit3D 继承；累计 H&R、人工警告不等于当前未满足 H&R，需要明确统计样本。             |
| HUNO `hnrPreWarning`             | 当前已采用 `data.hit_and_runs` 违规数；没有独立预警字段证据，不能把违规数重复映射或恢复旧 DOM 方案。 |
| Nebulance `hnrPreWarning`        | 现有 HnRs 表示违规；方括号内容的预警语义未证实，需要独立预警来源及正反样本。                         |

接入这些字段时必须覆盖真实 0、字段缺失、登录页、请求失败和分页；缺失或失败不应覆盖已有值或伪造 0。

## 保留的参照与实现说明

- `tests/packages/site/utils/oracle/selector-oracle-2.3.10.js.txt` 的两个版本识别标记及 ID hack 说明属于逐字节冻结的 Sizzle 2.3.10 差分基准，保持原样。
- `selector.ts` 三处 ID hack、Luminance/NexusPHP 的整行解析说明、BtEtree 的补年说明均描述现有算法，未发现对应新待办，保留。
- SkidrowRepack 的时间说明已修正：真实装配路径默认 UTC，公共解析层不依赖主机时区；该默认值不等于已确认站点实际时区。

## 公开依据

- [Flood v4.16.4 OpenAPI 路由](https://github.com/jesec/flood/blob/v4.16.4/server/routes/swagger.ts#L55) 及 [版本来源](https://github.com/jesec/flood/blob/v4.16.4/server/routes/index.ts#L64)。
- [WhatCD Gazelle 分类图标](https://github.com/WhatCD/Gazelle/blob/63b337026d49b5cf63ce4be20fdabdc880112fa3/sections/torrents/browse.php#L565)、[默认分类](https://github.com/WhatCD/Gazelle/blob/63b337026d49b5cf63ce4be20fdabdc880112fa3/classes/config.template)；图标 title 来自标签，不是分类。
- [Jackett HUDBT 参数](https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/hudbt.yml)、[IPTorrents 分类](https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Indexers/Definitions/IPTorrents.cs)、[BeyondHD 响应](https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Indexers/Definitions/BeyondHDAPI.cs)。
- [Aidoru 私信导航](https://github.com/pt-plugins/PT-Plugin-Plus/blob/master/resource/sites/aidoru-online.me/config.json#L136)。
- [HDSpace 上游哨兵](https://github.com/pt-plugins/PT-Plugin-Plus/blob/master/resource/sites/hd-space.org/config.json#L110)、[Unit3D 公开用户字段](https://github.com/HDInnovations/UNIT3D-Community-Edition/blob/master/app/Http/Resources/UserResource.php)、[真正的预警条件](https://github.com/HDInnovations/UNIT3D-Community-Edition/blob/master/app/Console/Commands/AutoPreWarning.php)。

## 验证记录

- 扩展回归矩阵：31 个测试文件、586 个测试通过，覆盖站点定义静态校验、六批定义回归、Gazelle 分组、时间解析、下载器、海报/媒体服务器、拖拽与筛选交互。
- 最后补充合法 100% 进度条兼容用例后，`maintenanceMarkers.test.ts` 的 73 个测试再次全部通过。
- 上海时区独立运行 SkidrowRepack 装配路径的 3 个时间用例通过。
- TypeScript、改动相关 ESLint/Prettier 检查和 `git diff --check` 通过。
- Chrome 生产构建通过，仍有构建工具的分块体积提示。
- yangleme 的离线 `processDebugResources` 构建通过。
- 没有连接需凭据的真实私站或下载器；上述缺证字段未标为完成。
