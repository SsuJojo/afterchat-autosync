# AfterChat AutoSync 计划书
把 AfterChat（油猴导出脚本）改造成 ChatGPT Degrade Checker 那样的「常驻句柄 + 自动增量同步」，绕开下载目录。
日期：2026-11-16 · 状态：待确认，未动工

---

## 1. 目标与非目标

**目标**
1. 打开 gemini.google.com / grok.com 时，脚本自动把「上次同步之后」的新对话写进 `C:\Users\SsuJo_\Chats\_sync\<平台>\`，**不再产生下载文件、不进 Downloads**。
2. 转换器 chat2deja.py 停止扫描 `~/Downloads` 和 `G:\Takeout`，改扫 `_sync`（+保留 `_inbox` 收手工底档）。
3. 幂等：同一对话反复同步、重复导出、标题变化都不产生重复数据（现有 Writer 按 URL 会话 ID + 内容去重已具备）。
4. 失败可修：有「重置起点重导」入口（对应 Degrade Checker 的 force/repair 语义），失败清单落在 `_sync\<平台>\_failed\`。

**非目标**
- 不做后台常驻（浏览器不开就不同步；每天照常用网页即可，deja 12:30/22:30 两次索引兜底）。
- 不动 AfterChat 现有手动导出/全量导出能力，只加自动同步。
- 本期只接 gemini + grok 两个平台（架构上平台无关，其余 20+ 平台改一行开关即可加）。
- 不上传、不改 deja 存储，只写 `_sync` 目录。

## 2. 现状对照（两份源码结论）

| 能力 | AfterChat 1.24.1 | Degrade Checker gpt-export.js | 计划取用 |
|---|---|---|---|
| 增量判定 | localStorage 锚点 `m365-export-anchor-<adapterId>`（毫秒时间戳，`t > boundary` 过滤，`t===null` 保守导出；成功且零失败才前移） | `_backup_index.json` 记 update_time，按会话 ID 精确对比 | **沿用锚点方案**，新 key `ac-sync-anchor-<id>`，与手动导出互不干扰 |
| 输出目标 | `a.click()` 下载 zip → 只能进 Downloads | FSA `showSaveFilePicker` 句柄 + createWritable 直接写原文件 | **FSA `showDirectoryPicker` 目录句柄**（比单 zip 更贴合转换器，免 zip 重打包） |
| 句柄持久化 | 无 | IndexedDB `gptIncrementalBackupDb/handles` + localStorage 状态双写 | 照抄：IndexedDB `acSyncDb/handles`（key=adapterId）+ `ac-sync-state` |
| 自动触发 | 无（纯手动点按钮） | 启动 12s 后跑一次 + setInterval 3min 静默跑 | 启动 15s 跑一次 + 每 10min + `visibilitychange` 回前台触发（60s 防抖） |
| 权限 | — | `queryPermission` → 已授予才静默跑；没授予提示点击 | 同策略。Chrome/Edge 122+ FSA 权限跨重启持久，正常「授权一次永久生效」 |
| 失败处理 | zip 里塞 export-failures.md | manifest + 修复流程 | `_failed/<时间>-<标题>.md` + 状态里记 lastError，重置起点可重导 |
| 限速 | API_PAGE_DELAY=300 / API_DELAY=1200 | baseDelay 500 + 重试退避 | 沿用 AfterChat 现有限速与 sleep，不动 |

关键可行性结论：
- AfterChat 是单个 IIFE，所有 adapter/锚点/限速都在闭包内；但**闭包结尾 `try { initialize(); } catch {}`（L11856）是稳定唯一注入口**——把同步模块整体插在它前面，即可直接复用 `PLATFORM_ADAPTERS`、`getConversationSortTime`、`loadExportAnchor` 等全部内部件，无需复制任何 adapter 代码（grok batchexecute、gemini 多账号这些复杂实现全白嫖）。
- 油猴 `@grant none` 跑在页面主世界，`showDirectoryPicker` / IndexedDB / localStorage 全可用（AfterChat 已有 Trusted Types 兼容写法）。
- AGPL-3.0：本地修改版不对外分发，无合规问题；文件头保留原版权声明并加修改说明。

## 3. 架构与数据流

```
[gemini.google.com] ─┐
                     │  AfterChat+AutoSync（同一脚本，注入块）
[grok.com] ──────────┘
   │ 启动15s/每10min/回前台
   ├─ 读锚点 ac-sync-anchor-<id>（无锚点→迁移旧 m365-export-anchor，避免重导 675+60 条）
   ├─ adapter.getAllConversations({boundary}) （boundary 早停翻页）
   ├─ 逐条 getConversationDetails → toMarkdown
   ├─ FSA dirHandle（IndexedDB 恢复）→ _sync/<adapter>/<YYYYMMDD-HHMMSS>-<标题>.md
   │    同名覆盖写（会话更新→同名→原地更新，天然幂等）
   ├─ 失败 → _failed/ + 状态记录；零失败才推进锚点
   └─ 状态写 localStorage ac-sync-state（lastRunAt/lastCount/lastError）
          ↓ 计划任务 12:30 / 22:30
chat2deja.py（扫描根改为 _inbox + _sync；移除 Downloads 与 G:\，留 --with-takeout/--with-downloads 一次性回填开关）
          ↓
deja index → deja --harness gemini/grok 查询
```

## 4. 模块设计

### AC1 存储层
- IndexedDB：`acSyncDb` / store `handles`，`put(dirHandle, adapterId)`；启动 `get(adapterId)` 恢复。
- localStorage `ac-sync-state`：`{ profiles: { <adapterId>: { enabled, dirName, firstBoundAt, lastRunAt, lastExported, lastError, failStreak } } }`。
- 锚点 `ac-sync-anchor-<adapterId>`：首次启用时从旧 `m365-export-anchor-<adapterId>` 迁移（当前值即「已导出 675/60 条」的时间点）。

### AC2 调度器
- `startAutoSync()`：启动 15s 后全平台跑一轮；`setInterval` 10min；`visibilitychange→visible` 且距上次 >60s 触发；`document.hidden` 时跳过（后台页限速严重且无意义）。
- 失败退避：连续失败 failStreak≥2 → 间隔翻倍（最多 60min），成功清零；API 失败不清锚点（宁重复不漏，转换器去重兜底）。
- 竞态：单飞锁 `syncing`，防止定时器与手动「立即同步」并发。

### AC3 导出器（每平台一轮）
1. `boundary = loadAnchor(id)`；无新会话（`getAllConversations` 过滤后为空）→ 只推进锚点下限到本次运行时刻，静默结束（AfterChat 现成逻辑同款）。
2. 新会话逐条拉详情（沿用 CONFIG.API_DELAY），`toMarkdown` 后写文件：`dirHandle.getFileHandle(name,{create:true}) → createWritable()`。
3. 文件名沿用 `makeMarkdownZipFilename` 的时间前缀规则 → 会话更新后重导仍同名 → 覆盖即更新；标题变化产生新文件也安全（同 URL 会话被 Writer 合并）。
4. 失败条目写 `_failed/<run时间戳>-<标题>.md`（含 ID 与错误），主流程继续；`failCount===0` 才 `saveAnchor(id, convs, runAt)`。
5. 「重置起点」：删锚点 + 清 `_failed`，下一轮自动按新起点重拉（repair 语义）；UI 上放右键菜单。

### AC4 权限与首次引导
- 气泡菜单加「开启自动同步」：`showDirectoryPicker({ mode:'readwrite', startIn:'documents' })` → 用户选 `C:\Users\SsuJo_\Chats\_sync`（首次手工创建空目录）→ 每平台建子目录 `<id>\`、`<id>\_failed\`。
- 每轮先 `queryPermission({mode:'readwrite'})`：`granted` 才静默跑；`prompt` → 气泡显示「同步待授权（点一下）」，点击时才 `requestPermission`（浏览器要求手势，不自动弹）。
- 换目录：重新选目录后重绑句柄，锚点保留（文件同名覆盖幂等，无需重导）。

### AC5 UI（挂在现有浮泡上，不新建常驻控件）
- 状态行：`自动同步: 开 · 上次 12:31 导出 3 条`；错误态显红。
- 菜单项：开启/关闭、立即同步、重置起点（重导）、更换目录。
- 手动导出按钮行为完全不变。

### AC6 打包与升级策略（重点）
- **不改上传主文件**：维护 `C:\Users\SsuJo_\Chats\tools\ac-sync.module.js`（同步模块，约 300 行）+ `patch_afterchat.py`。
- `patch_afterchat.py`：拉上游最新 afterchat.user.js → 在 `try { initialize(); }` 前拼接 ac-sync 模块 → 版本号加 `-acN` 后缀 → 输出 `afterchat-autosync.user.js`。
- 安装方式：Tampermonkey 里把现有 AfterChat 脚本内容替换为该产物（同名同 namespace 直接覆盖，避免双 UI 冲突）；上游更新后重跑 patch 脚本即可，合并面 = 1 个注入口。

### AC7 转换器配套（chat2deja.py）
- 扫描根：`_inbox` + `<BASE>\_sync`（递归含 `_failed`，md 路由已就绪：URL 分流 gemini/grok）。
- 移除默认 `~/Downloads` 与 `G:\Takeout`；加 `--with-downloads` / `--with-takeout` 一次性回填参数。
- `_sync` 文件被覆盖后指纹变化 → 正常重处理；Writer 按同源同时间戳去重，重复内容零增量。
- `sync.cmd` 不变。

## 5. 幂等性论证（为什么不会重复进 deja）
1. 同会话重导 → 文件同名覆盖 → 字节相同 → 指纹命中跳过。
2. 会话更新 → 同名覆盖 → 内容变 → 重解析，但消息 (role, text, ts) 与已索引条目相同 → Writer 丢弃。
3. 标题变化 → 新文件 → URL 会话 ID 相同 → 合并进同一 deja session，消息去重。
4. 失败重试重复导 → 同 1。

## 6. 里程碑
| 阶段 | 内容 | 产出 | 工作量 |
|---|---|---|---|
| M1 | ac-sync.module.js 骨架：存储层+调度器+UI，dry-run 只记状态不写盘 | 脚本可装、状态可见 | 0.5 天 |
| M2 | gemini 接通：锚点迁移、boundary 拉取、写盘 | `_sync/gemini/` 出文件 | 1 天 |
| M3 | grok 接通 + `_failed` 通路 | `_sync/grok/` 出文件 | 0.5 天 |
| M4 | 转换器改造 + patch 脚本 + 安装切换 | Downloads/G: 退役 | 0.5 天 |
| M5 | 验收+文档（README 增补自动同步章节） | 上线 | 0.5 天 |

合计约 3 个半天，可 2~3 个会话完成。

## 7. 验收标准
1. 在 gemini 发一条新对话 → 不点任何按钮，≤10min 内（或回前台 60s 内）`_sync\gemini\` 出现新 md，Downloads 无新文件。
2. 下一班计划任务后 `deja --harness gemini "<关键词>"` 命中新对话。
3. 重启 Edge → 不重新授权、不重新选目录，自动同步继续工作。
4. 对旧会话追加一轮对话 → 同名文件更新，deja 中消息无重复。
5. 断网/接口失败 → 锚点不动、`_failed` 有记录、恢复后自动补齐。
6. 「重置起点」后重导 → deja 总消息数不变（全被去重）。
7. 手动「导出全部聊天」「Shift 全量」行为与原来完全一致。

## 8. 风险与对策
| 风险 | 对策 |
|---|---|
| FSA 权限被浏览器重置（清缓存/隐私模式） | 静默检测→气泡一次性授权按钮；不自动弹窗打扰 |
| 页面没开 → 不同步 | 设计即如此；deja 一天两班兜底；README 写明「用网页即同步」 |
| 上游 AfterChat 大改注入口失效 | patch 脚本锚点探测失败时明确报错而非错拼；注入口另有 fallback（`// ---- 启动` 注释行） |
| 多账号 Gemini（/u/N） | conv ID 全局唯一、文件名含时间戳不冲突；锚点按 adapter 单值（AfterChat 现状一致） |
| 同步抓取触发风控 | 沿用上游限速（300/1200ms）+增量拉取量极小（每天几条）；失败退避不加压 |
| `_sync` 目录被手动删 | 状态里 dirName 失效 → 句柄校验失败 → 气泡提示重选目录，锚点仍在不重导 |

## 9. 待你拍板的两个小决定
1. 同步根目录就用 `C:\Users\SsuJo_\Chats\_sync\`？（首次授权时手动选这个目录，之后永久免选）
2. 本期只开 gemini + grok，其余平台留开关（`AC_SYNC_PLATFORMS = ['gemini','grok']`），还是要顺手全开？

确认后按 M1→M5 开工。
