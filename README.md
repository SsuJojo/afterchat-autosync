# web-chats-deja — 把网页对话喂给 deja

管道：**网页打开即增量（AfterChat 自动同步写 `_sync`；Takeout、官方导出 zip 放 `_inbox`）→ 转换成 deja 本地源格式 → `deja index` 增量索引 → `deja` recall 可搜。**

已实测（2026-11-15 全量接入）：29 个平台全量索引成功，合计约 2.1 万条消息。

## 目录布局

```
C:\Users\SsuJo_\Chats\
├── chat2deja.py              # 主转换器（多类输入自动识别）
├── sync.cmd                  # 一键管道：转换 + deja index（计划任务调用这个）
├── README.md                 # 本文件
├── _inbox\                   # 手动放导出的地方（Takeout zip、官方导出 zip 等）
├── _sync\                    # AfterChat 自动同步落点：<平台>\ 子目录，转换器递归扫描（_failed\ 跳过）
├── _state\                   # 已处理输入指纹 processed.jsonl + sync.log（日志尾部保留 400 行）
├── amp-threads\              # → DEJA_AMP_ROOT     （28 个网页平台对话，Amp thread 格式）
├── gemini-home\tmp\Gemini\chats\   # → DEJA_GEMINI_ROOT （Gemini 对话，Gemini CLI jsonl 格式）
└── grok-home\sessions\…\          # → DEJA_GROK_ROOT  （Grok 对话，Grok CLI summary+updates 格式）
```

## 数据流（全平台增量 + 官方底档，自动合并去重）

| 来源 | 日常增量（转换器默认扫 `_inbox` + `_sync`） | 底档 / 一次性回填 |
|---|---|---|
| ChatGPT | AfterChat 自动同步 → `_sync\openai\*.md` → Amp store | 官方导出 zip（conversations.json）放 `_inbox` |
| Gemini | AfterChat 自动同步 → `_sync\gemini\*.md` → Gemini CLI 原生 store | 官方 Google Takeout（`我的活动/Gemini Apps/我的活动记录.json`）：放进 `_inbox`，或 `--with-takeout` 一次性回填 `G:\我的云端硬盘\Takeout`（zip 或散装 json） |
| Grok | AfterChat 自动同步 → `_sync\grok\*.md`（含 `grokcom`）→ Grok CLI 原生 store | grok.com 官方导出（含 prod-grok-backend.json 的 zip 或散装），放 `_inbox` |
| 其余平台 | AfterChat 自动同步 → `_sync\<平台>\ *.md`，带 `[平台名]` 前缀统一进 Amp store | 无官方底档；浏览器访问对应站点即可增量备份 |

转换器默认只扫 `_inbox` + `_sync`（`_sync` 递归，覆盖 `<平台>\` 子目录，目录名作为平台提示）。Gemini / Grok 写各自原生 deja store；**其余平台统一以 `[平台名]` 前缀写入 Amp store**，保留原始 URL 和完整消息（含 System），因此 `deja "关键词"` 可全局搜到。`_sync` 下路径中带 `_failed` 目录组件的文件会被跳过（失败件没有有效 AfterChat 元数据）。

> **为什么统一进 Amp，而不是各平台原生 store？** deja 没有通用 `import` 或多轮对话 JSONL 格式；Qwen/Kimi/MiniMax/DeepSeek/Copilot 的 schema 各异，且 DeepSeek 要 zstd、Kimi 要事件序列重建、Copilot Chat 随 VS Code 版本漂移，直接写活跃 store 风险高。Amp 则由 `DEJA_AMP_ROOT` 指向本仓自有目录，writer 字段（id / created 毫秒 / content 块）与 deja 官方 `amp.go` 解析器逐项吻合，幂等且不会污染其他应用的活跃数据。

转换器按内容自动识别格式，不认文件名；同一对话多来源按 (role, text) 哈希去重合并，时间戳取较新。处理过的输入记录 sha256，重复出现零处理。

## 日常使用

**平时什么都不用做。**浏览器打开任意已适配站点（29 个平台），AfterChat 自动同步就把「上次同步之后」的新对话直接写进 `_sync\<平台>\`；两个计划任务（`deja-chat-sync` 22:30、`deja-chat-sync-noon` 12:30）自动扫 `_inbox` + `_sync`，有新文件就转换并 `deja index`。手动跑：双击 `sync.cmd` 或 `Start-ScheduledTask deja-chat-sync`。想马上搜到刚同步的对话，也直接运行 `C:\Users\SsuJo_\Chats\sync.cmd`（增量，几秒到几分钟）。

历史导出 zip 放 `_inbox` 即被默认扫描；若留在 Downloads，用 `--with-downloads` 回填一次。

### 一次性准备（已完成的部分）

1. ✅ **Gemini 底档（2026-11-15 已完成）**：官方 Takeout 已在 `G:\我的云端硬盘\Takeout\`，此前已接入。该目录**不再日常扫**；今后拿到新 Takeout，放进 `_inbox`，或运行 `python chat2deja.py --with-takeout` 再跑 `sync.cmd` 回填。
2. ✅ **Grok（2026-11-15 已完成）**：60 个对话已通过 AfterChat 导出 zip 接入。日常增量改由自动同步写 `_sync\grok\`（见下节）。3. **全平台增量**：油猴里用 AfterChat + AutoSync（安装见下节）。在任意 29 个已适配站点打开网页即自动增量同步，不用再点导出、不再产生 Downloads 文件；手动导出 / 全量导出能力仍保留，但产物落在 Downloads 后需 `--with-downloads` 回填或手动移入 `_inbox`。

## 自动同步（AfterChat AutoSync · 全面热备份）

AfterChat 油猴脚本加了常驻同步模块：打开**任意 29 个已适配站点**就把「上次同步之后」的新对话直接写进 `_sync\<平台>\`，不再下载 zip、不进 Downloads。浏览器不开就不同步；deja 12:30 / 22:30 两班索引兜底。

- **安装 / 升级**：直接从 GitHub Releases 安装 `afterchat-autosync.user.js`。产物已写 `@updateURL` / `@downloadURL` 指向 latest Release；CI 每 3 小时跟随上游 AfterChat，发现新版自动构建并发 Release，Tampermonkey 通常会在之后自动升级。若要本地构建：`python tools/patch_afterchat.py` 会用 `vendor/afterchat.user.js` + `tools/ac-sync.module.js` 生成 `dist/afterchat-autosync.user.js`（在 `try { initialize(); }` 注入口前注入，同名同 namespace，可直接覆盖旧脚本槽位）。
- **首次启用**：在任意支持站点点右下角导出按钮左侧的 `⇅` 小圆钮 → 面板里「开启自动同步」→ 选目录。建议选一个空目录（首次先手工建好）；多人共用一台机器可各自选别的目录。每个平台在所选目录下建 `<平台>\` 与 `<平台>\_failed\`。换目录用面板里「更换目录」，锚点保留、文件同名覆盖，不会重导。
- **权限**：选目录时浏览器授予一次；重启浏览器后可能需要再点 `⇅` → 「立即同步」完成一次授权（浏览器要求手势，脚本不会自动弹窗）。
- **触发时机**：脚本启动 15 秒跑一轮，之后每 10 分钟一轮，从别的标签切回页面也触发（60 秒防抖）；后台页不跑。连续失败会退避，单飞锁防止并发。
- **平台范围（29 个，全部默认开启）**：M365 Copilot、Microsoft Copilot、腾讯 ima、Z.ai、智谱清言、DuckDuckGo、Perplexity、DeepSeek、通义千问、千问、腾讯元宝、腾讯混元、Kimi、豆包/Dola、MiniMax Agent、Google AI Studio、ChatGPT、Grok(x.com)、Grok Web、Gemini、Google AI Mode、Arena、Mistral、Sakana、Claude、Poe、Monica、StepFun Studio、StepFun Chat。要缩减范围就在同步模块的 `AC_SYNC_PLATFORMS` 数组里删对应 id。
- **只读导出**：只读取网页对话并写 `_sync` 文件，不会在网站上创建或修改任何对话。
- **失败与重置起点**：单条拉取失败写进对应平台的 `_failed\<时间>-<标题>.md`，主流程继续；转换器递归扫描 `_sync` 时会跳过所有名为 `_failed` 的目录组件，这些文件不会被摄入。零失败才推进同步锚点。面板里「重置起点(重导)」删锚点并清 `_failed`，下一轮按新起点重拉；因为转换器按 URL 会话 ID + 内容去重，重导在 deja 里是零增量（repair 语义）。

## CI / 自动更新

- `version.json` 记录上游版本和本仓发布版本（如 `1.24.1-ac2`）；`vendor/afterchat.user.js` 是可复现构建的上游快照。
- GitHub Actions：`upstream` 工作流每 3 小时拉取 AfterChat 上游 raw 快照比对；上游版本或内容有变化就更新 `vendor/` 快照、升发布版本、推 commit 并打 `v*` tag，由 `release` 工作流构建、校验并创建 Release。推 tag 或手动触发也能构建发版。
- Release 里固定资产名 `afterchat-autosync.user.js`，因此 userscript 的 `@updateURL` / `@downloadURL` 可用 latest-release 稳定地址自动升级。
- 本地校验：`python tools/verify_autosync.py --base .`。

## 查询

- `deja "关键词"` — 全局搜（Gemini/Grok 原生来源 + Amp 槽位里的其余 28 个平台，标题带 `[平台名]`）
- `deja --harness amp "…"` — 只搜 Amp 槽位的 28 个网页平台
- `deja --harness gemini "…"` — 只搜 Gemini
- `deja --harness grok "…"` — 只搜 Grok

## 注意事项 / 已知边界

- `setx` 设置的 `DEJA_*_ROOT` 对**已开着的**终端不生效——老终端里手动跑 `deja` 前先 `$env:DEJA_GEMINI_ROOT="C:\Users\SsuJo_\Chats\gemini-home"` 等三行（sync.cmd 内部已带）。**新开终端无此问题。**
- Gemini 官方 Takeout 是活动日志：多数条目只有“提问 + 回复”各一条，追问轮次的用户原文常缺失（标题取首条提问），个别纯图片提问记为 `[图片 N 张]`——这是 Google 导出的固有限制，AfterChat 同步的 md 补齐后有完整对话。
- 云盘挂载的 `G:\我的云端硬盘\Takeout` 现在只在 `--with-takeout` 时扫，用文件大小+mtime 做指纹（不整份重读 350MB zip）。
- 手动重新转换所有输入（忽略处理记录）：`python chat2deja.py --force`；处理记录会在每次运行后自动去重压缩。`--with-downloads` / `--with-takeout` 分别临时加上 Downloads / `G:\我的云端硬盘\Takeout` 扫描根，用于一次性回填。查看全部选项：`python chat2deja.py --help`（不写盘）。
- Grok 官方导出中 AI 消息的 create_time 缺失时按顺序排在用户消息后，排序可能略粗。
- 非同步目录下的散装 Markdown 不按对话摄入（避免误吞剪藏等无关文件）；`_sync\<平台>\` 里的 md 才有效。
- amp-threads 里 conversation_id 重复的文件名会被 sanitize 截断——如遇极端重名冲突，文件会覆盖（平台 id 均 uuid 或 URL 哈希，实际不会撞）。

## 撤销 / 卸载

```powershell
# 停自动任务
Unregister-ScheduledTask -TaskName "deja-chat-sync","deja-chat-sync-noon" -Confirm:$false
# 从索引移除全部导入对话
deja forget --harness amp --all; deja forget --harness gemini --all; deja forget --harness grok --all
# 删数据
Remove-Item -Recurse -Force C:\Users\SsuJo_\Chats
# 清环境变量
[Environment]::SetEnvironmentVariable("DEJA_AMP_ROOT",$null,"User")  # gemini/grok 同理
```
