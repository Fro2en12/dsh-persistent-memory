# dsh-persistent-memory

> DSH 插件：**持久记忆 + 自动召回**。九类记忆分类学驱动的自动沉淀守则、写侧硬闸门、词法+RRF 混合召回、教训通道、记忆代谢、Claude Code 记忆一键导入、历史会话回捞，以及一个设置页面板——记忆不靠每次提醒，跨会话自动浮现。

English: A DeepSeek Harness (DSH) plugin for persistent memory with automatic recall. A nine-type memory taxonomy drives automatic capture guidance and a write-side gate; recall combines lexical scoring, zero-token RRF hybrid ranking, and LLM reranking; plus a lesson channel, memory metabolism, one-click import from Claude Code memory files, historical-session recall, and a settings panel.

> **兼容性**：本版本对齐 DSH `0.1.2-alpha` —— 工具注册走官方 `defineTool`、设置面板走官方 `ctx.settings.register` + `settings.section` slot、会话检索走 `ctx.get('sessionQuery')` 接缝（可选，缺失时工具报错降级）。数据落盘 `$DSH_HOME/dsh-persistent-memory/memory.jsonl`（JSONL 存储，首行为 `{"__schema":1}` 哨兵，标记存储格式版本、供后续迁移识别），重启不丢。

## ⚠️ AI 产物声明

**本项目为 AI（DeepSeek 驱动的智能体）产物**：功能设计、架构选型、代码编写、测试与文档均由 AI 在对话中迭代完成，人工提供需求与验收反馈。

- 开发过程中经真机验证（守则注入、召回/教训通道、写侧闸门、设置面板、3081 预演均有实测记录），但边界情况无法穷尽，生产使用前请自行审阅与测试；
- 欢迎提交 Issue / Pull Request 修正问题或扩展能力；
- 本项目基于 BSD-3-Clause 协议开源，可自由使用、修改与分发。

## 设计与对标来源

这个插件不是凭空设计的，主要受三处来源影响：

**1. Claude Code 官方记忆系统（memdir）** —— 核心机制的对标对象，依据其官方文档公开的机制描述：

- `findRelevantMemories`（sideQuery 选择器）→ 本插件的 LLM 语义重排；
- `memoryAge`（天龄 + 漂移警告）→ 本插件的新鲜度标注；
- `MEMORY.md`（索引与主题文件分离）→ 本插件的记忆索引兜底；
- 记忆类型学（user / feedback / project / reference）→ 本插件的九类分类学；
- 写侧规则（不记重复、矛盾时显式标注覆盖、plan/tasks 优先于 memory、敏感数据禁令）→ 本插件的守则判据。

**2. DSH 插件市场 135 个记忆类插件** —— 功能补齐的对标池（依据 awesome-dsh-plugin.com 市场目录，2821 个插件）：

- `dsh-evolve`：零 token RRF 混合召回、中文分词、重复观察强化 → 本插件的 RRF 混合召回；
- `dsh-mneme`：热度遗忘巩固 + 周期维护 → 本插件的记忆代谢（`memory_dream`）；
- `dsh-memory-porter` / `dsh-noema`：Claude / 多工具记忆导入 → 本插件的 `memory_import`；
- `dsh-native-memory`：`(sessionId, seq)` 来源引证 → 本插件的 source 引证；
- `dsh-memento`：写入审批门 → 本插件的 `approveOnSet`；
- `dsh-negative-ledger` / `MisakaNet`：负面知识账本 → 本插件的 lesson.* 分类；
- `dsh-butler-memory` / `dsh-memory-manager`：Web 治理面板 → 本插件的设置页面板与 `/memory panel`。

**3. DSH 自身生态与官方接缝** —— 决定实现方式：

- `dsh-email`：设置页面板三件套（`settings.section` slot + `exports ./client` + host 侧 `webServer` 路由）；
- `dsh-market`：`settings.register` 命名空间注册模式；
- DSH 官方 `docs/subsystems/settings.md`、`api-catalog` 与 dsh-plugin-guide 知识库：插件契约与接缝规范。

## 功能特性

| 机制 | 说明 |
|---|---|
| 九类记忆分类学 | 每会话首轮注入「自动记忆守则」（约 3070 字；第六轮起不再提供精简版，每会话只注入完整守则）：user（画像）/ rule（纠正+成功确认，Why/How to apply 结构）/ task（绝对日期）/ project（定稿结论）/ env（环境指针）/ tool（坑）/ ref（资源指针）/ auth（凭据，显式要求才记）/ lesson（负面知识账本）。判据含「不记清单」：代码可推导内容、git 史、完整修复配方、AGENTS.md/cairn 已有内容 |
| 写侧硬闸门 | `memory_set` 硬校验：key 前缀白名单、value ≤240 字（细节挪 full）、tags ≤3 个、非 auth.* 前缀命中凭据判据即**直接拒绝**——判据含**裸关键词**（`token`/`secret`/`api key`/`access key`/`AccountKey`/`password`/`passwd`/`密码`/`口令`/`密钥`；ASCII 词按词边界匹配，故 `passwordless`、`tokenizer` 不算）、厂商前缀、JWT、带账号密码的连接串、PRIVATE KEY 与高熵令牌串。裸关键词「出现即算」是**有意的 fail-closed**，所以「每轮注入预算按 token 计」这类正常经验也会被拒——**逃生路径**：改写措辞（如「上下文预算」），或确认确为凭据时用 `auth.*` 前缀。task.* 缺绝对日期只**警告** |
| 自动召回 | pre-step 词法评分（同义词展开+噪音词过滤+首轮阈值 6）；词法 0 命中时 **RRF 混合召回**（词法+中文二元组双排名倒数融合，零 token 零依赖）按语义补位 |
| LLM 语义重排 | 候选 ≥1 时用当前路由模型从 RRF 候选池挑「明确有用」的 ≤5 条（宁少勿多；正用工具的参考文档不选，警告/坑照选）；LLM 不可用/失败/5s 超时自动降级词法 |
| 教训通道 | 悔恨信号（「又错/还是失败」）或场景信号（路径/盘符/终端/命令）时**不受每会话一次限制**强制召回 rule.*/lesson.*，独立 120s 冷却——错误发生时把上次的坑摆到眼前。同一条在本会话历史里出现过就不再注入（v0.1.20 修 marker 格式，此前去重形同虚设） |
| 轮末自动提取 | 每轮结束（`agent/turn-stopping`）异步回顾对话、LLM 提取高置信记忆自动沉淀（对标 Claude Code extractMemories：AI 用 AI 写记忆，不依赖主模型当轮意愿）。互斥：主 agent 30s 内手动写过则跳过；提取中不重入；同会话 120s 冷却；fire-and-forget 不阻塞回合收尾。写入走与 memory_set 同源的最小闸门（前缀白名单 + 明文凭据拦截），auth.* 一律不提取，`source=轮末提取` |
| 记忆索引兜底 | 首轮 0 召回时注入动态【记忆索引】，**只列 key 不列摘要**（global 4 个：user.* 画像固定 2 席 + 其余最新 2 席；工作区 scope 各 3 个；v0.1.20 实测 424 → 约 160 字），不落盘；索引注入后本会话不再补召回，避免两套重叠（v0.1.20） |
| 新鲜度标注 | 每条召回显示天龄（今天/昨天/N 天前）；>1 天附漂移警告——时点观察，点名文件/路径引用前先验证现状 |
| 来源引证 | `memory_set` 自动填「日期+会话 id」，召回行展示 `· 自2026-09-01 s=xxx` |
| 子代理隔离 | 子代理会话注入只读守则 + `memory_set` 硬层拒绝写 global（提示 `scope=sub:<id>`）；`memory_get` 读 `auth.*` 被硬层拒绝；`memory_search` 不带 scope 时只返回 `sub:<id>` 与当前工作区 scope（不含 global，结果亦排除 auth.*）；成果回传父会话沉淀 |
| 记忆代谢 | `memory_dream` 工具 + `/memory dream`：task 超 30 天 / 任意超 90 天 / 标记完成超 14 天出候选，由模型决定更新/归档/删除；`memory_dream({ apply: true })` 直接归档——>90 天条目 value 压缩为摘要、原文移入 `full` |
| 注入预算 | 条数上限（`autoRecallLimit`，默认 2）+ 会话级总预算 `injectionBudgetChars`（默认 1200）：单轮「教训 + 召回 + 索引」共享，按优先级串行分配——**守则是每会话固定成本、不计入预算**（第六轮解耦：它本来就永不被砍，占额度只会让大守则静默挤掉记忆通道）；剩余预算不足时依次挤掉教训/召回/索引；单通道预算 `autoRecallBudgetChars`（v0.1.20 起默认 300，原 600）与剩余总预算取小，超出按分数顺序截断（单条成本约 200 字，300 的预算实际多为 1 条、偶尔 2 条）；漂移警告合并为一段而非每条一段（v0.1.16） |
| 召回阈值 | 绝对下限 + 相对比例组合（v0.1.17）：`autoRecallMinScore`（默认 3）挡住"整体都不相关"；`autoRecallRelativeFloor`（默认 0.5）只留与最高分同量级的，挡住"矮子里拔将军" |
| 补位收口 | `rrfFirstTurnOnly`（默认 true，v0.1.18）：RRF 语义补位只在首轮兜底；非首轮词法被阈值过滤即整体不相关，注入 0 条而非用另一通道放回排名靠前的记忆 |
| 注入去重 | 会话注入状态落盘 `session-injections.json`（v0.1.19，30 天 TTL）+ form 级去重（不再比对正文）：内存 Map 重启即失效会让同一会话每重启一次重复注入一份守则/召回（实测 5 次 = 8722 字） |
| 记忆导入 | `memory_import` + `/memory import`：CLAUDE.md / MEMORY.md / Claude Code memories.json，自动分 ref/rule/lesson 前缀，与库中 ≥70% 相似自动跳过 |
| 凭据隔离 | `auth.*` 不参与任何自动注入通道（召回/教训/索引，v0.1.20）：实测 `[global/auth.platforms]` 会把明文密码带进每个新会话的上下文；凭据只在模型显式 `memory_search` / `memory_get` 时返回 |
| 会话回捞 | `memory_recall`：走 `ctx.get('sessionQuery')` 全文检索历史会话，记忆没记但以前说过的事能捞回来；强制按当前会话工作区（cwd）过滤，会话无 cwd 时报错（跨会话检索不可用） |
| 内容冲突检测 | 写入时对同 scope 条目算内容相似度，≥55% 警告「确认是否应更新该条而非新建」 |
| 治理面板 | 设置页「记忆」分区 6 个开关（自动回忆/自动捕获/回忆重排/RRF 召回/RRF 首轮限定/写入审批）即时生效；`/memory panel` 在 `dataDir`（默认 `$DSH_HOME/dsh-persistent-memory`）生成自包含 HTML 浏览/搜索（auth.* 凭据排除） |
| 防护 | 注入前清洗控制字符/危险 URI/提示注入指令；同 scope 高相似 key 自动合并；stat 缓存失效 |

## 模型工具

- `memory_set` — 写入/更新（同 scope+key 覆盖；`full` 长文、`links` 关联、`confirmed` 审批门、`source` 引证）；库达 `maxItems`（默认 2000）后拒绝**新增**（更新已有 key 不受限），错误提示跑 `memory_dream`；`/memory restore` 作为救援通道不受此限；内容与旧值**全等**时按空操作处理（T17）：不刷新 `updatedAt`、不落盘，返回 `changed: false`，工具文本报「已确认」——避免反复重申让旧记忆伪装新鲜，污染召回排序与 `memory_dream` 的过期判定
- `memory_get` — 按 key 读取：返回 `value`、`tags`、`links`（关联 key）、`updatedAt` 与 `source` 引证，`includeFull: true` 时**同时把完整正文交给模型**（N2 修复：DSH 的 tool/result 只取 `output.render()` 的产物，`canonical value` 到不了模型，此前 render 只打印占位符「(已附完整正文)」——README 承诺的取回路径实际是断的）；凭据类条目默认掩码，需部署者 `allowCredentialReveal: true` 且带 `confirmed: true` 才可能取回原文
- `memory_search` — 关键词/标签/作用域搜索
- `memory_forget` — 删除一条
- `memory_stats` — 记忆库概况
- `memory_dream` — 代谢候选清单；`apply: true` 时直接归档：>90 天条目 value 压缩为摘要、原文移入 `full`
- `memory_import` — 外部文件导入：目标 scope 默认**当前工作区 scope**（`DSH_WORKSPACE_NAME` 优先，非 global）；三条限制——只允许导入工作区内的文件（realpath 白名单，防 symlink 逃逸）、单文件 ≤2MB、命中凭据闸门（token/secret/sk-/ghp_/AKIA/BEGIN PRIVATE KEY 等）的条目整条丢弃
- `memory_recall` — 历史会话回捞
- `/memory` 命令 — `status` / `recall` / `remember` / `forget` / `dream` / `import` / `export <文件>` / `restore <文件>` / `panel`，人不经过模型也能操作（`export` 导出完整 JSON（含 `full`）用于备份，库里有 auth.* 时会提示导出文件含明文凭据；`restore` 先校验来源文件、再自动把当前库备份为 `memory.jsonl.pre-restore-<时间戳>`，然后按 scope+key 覆盖或补入——是合并而非清库，空 items 不清库，非法文件报错且不写库）

## 安装

### 方式一：dsh plugin add（推荐）

```sh
dsh plugin --profile web add https://github.com/Fro2en12/dsh-persistent-memory
```

### 方式二：手动挂载

```sh
git clone https://github.com/Fro2en12/dsh-persistent-memory
# 编辑 profiles/web/cordis.patch.yml，在 plugins 后追加：
#   - insert:
#       - id: dsh-persistent-memory
#         name: '@dsh-external/dsh-persistent-memory'
```

安装后重启 `dsh web`，新会话首轮出现「自动记忆守则」注入即成功；设置页出现「记忆 (dsh-persistent-memory)」分区。

## 配置（可选）

所有阈值内置默认值；如需调整，在 `profiles/web/cordis.patch.yml` 的 insert 条目上加 `config`：

```yaml
- insert:
    - id: dsh-persistent-memory
      name: '@dsh-external/dsh-persistent-memory'
      config:
        autoRecall: true            # 每轮自动召回注入
        autoRecallLimit: 2          # 召回最多注入条数
        autoRecallRerank: true      # LLM 语义重排
        rrfRecall: true             # RRF 混合召回（词法 0 命中语义补位）
        rrfFirstTurnOnly: true      # 补位只在首轮（非首轮词法被阈值过滤 = 整体不相关，宁可不注入）
        autoCapture: true           # 每会话注入记忆守则
        autoExtract: true           # 轮末自动提取（默认开，可在 cordis.yml 关闭）
        autoExtractCooldownMs: 120000  # 同一会话提取冷却（默认 120s）
        injectionBudgetChars: 1200  # 单轮「教训+召回+索引」字符总预算（默认 1200，下限 300；守则不计入，每会话固定注入）
        autoRecallBudgetChars: 300  # 单次召回注入字符预算（默认 300 ≈ 1 条），超出按分数截断
        autoRecallMinScore: 3       # 非首轮召回的绝对分数下限（原 1 过松，会注入无关记忆）
        autoRecallRelativeFloor: 0.5 # 相对阈值：低于最高分该比例的记忆不注入；0 禁用
        taskTtlDays: 30             # task.* 保鲜期，超期在召回评分中降权
        fullMaxChars: 8000          # full 完整正文总长上限（默认 8000）：最新原文带时间戳置顶，不再尾部无限追加
        maxItems: 2000              # 写入容量守卫：达上限拒绝新增（更新不受限），提示跑 memory_dream
        allowCredentialReveal: false # 是否允许 memory_get 用 confirmed:true 取回凭据类原文（默认 false：confirmed 是模型自述，不是用户授权）
        redactPatterns: []          # 自定义敏感词（正则源串）：命中者出库即掩码（不做写侧拒绝），与固定凭据正则取并集
        approveOnSet: false         # 写入审批门（开启后须用户确认）
        dedupeOnSet: true           # 同 scope 高相似 key 自动合并
        synonymExpansion: true      # 同义词扩展评分
        autoRecallOnce: true        # 每会话只召回一次（false 时改用 cooldown）
        autoRecallCooldownMs: 600000
```

配置经插件内嵌 Schemastery `Config` 校验，非法值加载期响亮失败。

## 使用说明

- **自动沉淀**：无需操作——守则每会话首轮注入，模型自己判断该记什么；账号密码类只有你明确说「记住」才写；
- **主动检索**：`/memory recall <关键词>` 或 `memory_search`；
- **定期代谢**：`/memory dream` 看过期候选，让 agent 用 `memory_set`/`memory_forget` 处理，或跑 `memory_dream({ apply: true })` 把 >90 天条目一键归档（value 压成摘要、原文进 `full`）；
- **导入旧记忆**：`/memory import <CLAUDE.md 或 memories.json 绝对路径>`；
- **备份 / 迁移**：`/memory export <文件>` 导出完整 JSON（含 `full`；含 auth.* 时会提示明文风险），`/memory restore <文件>` 恢复；恢复先校验文件、再自动备份当前库为 `memory.jsonl.pre-restore-<时间戳>`（可回滚），随后按 scope+key 覆盖/补入（合并，不清库）；
- **设置面板**：设置页「记忆」分区 6 个开关即时生效；`/memory panel` 在 `dataDir`（默认 `$DSH_HOME/dsh-persistent-memory`，不再是进程 cwd）生成 HTML 面板文件，浏览器打开可浏览/搜索全部记忆。

## 架构

```
lib/index.js    Host 半部分（ESM；inject tools/commands/settings，webServer 惰性）
  ├─ Config（schemastery）      31 个可调参数（含 dataDir/defaultScope 两个部署参数）、加载期校验
  ├─ 写侧闸门                   前缀白名单 / ≤240 字 / tags ≤3 / 凭据检测 / 冲突警告
  ├─ pre-step 管线              守则（固定注入、不计预算）→ 教训通道 → RRF+词法召回 → LLM 重排 → 索引兜底（后三者共享会话级注入预算 injectionBudgetChars，按此优先级串行分配）
  ├─ RRF 混合召回               bigram-Jaccard 中文二元组 + 词法双排名倒数融合（K=60）
  ├─ 工具注册                   defineTool × 8 + /memory 命令
  ├─ /_dsh/dsh-persistent-memory/settings  面板 RPC（GET 快照 / POST 保存，localhost-only）
  └─ settings.register           ns=dsh-persistent-memory（6 字段，applies=live）
lib/client.js   Client 半部分（AMD bundle；window.__ModuleLoader__ 协议）
  └─ settings.section slot       设置页「记忆」分区，6 个开关 React 组件
```

### 关键机制与阈值

| 机制 | 数值 |
|---|---|
| 召回评分 | 首轮阈值 6（一次 key 直中+少量辅助）；弱主题词降权；value 命中降分 |
| 首轮召回门槛 | 首轮阈值 6 只能靠 key 直中跨过（key 全等 9 分 / 部分命中 5 分）再加少量辅助分（当前工作区 scope +4、tags 命中 +2、同义词落到 key +2、user.* 首轮 +1）；仅 value 命中只有 2 分（弱主题词 1 分）——「只记得内容里的词」在首轮召不到，改用 `memory_search` 或等后续轮次 |
| RRF 融合 | K=60；候选 rrf ≥0.025 才进入语义补位/重排池 |
| LLM 重排 | 候选 ≥1 就调用一次，5s 超时+失败降级词法，宁少勿多 |
| 教训通道 | 悔恨/场景信号强制召回 rule.*/lesson.*，独立 120s 冷却，不受 once 限制 |
| 索引配额 | global 4 条（user.* 固定 2 席），工作区 scope 各 3 条 |
| 注入总预算 | `injectionBudgetChars` 默认 1200：单轮「教训+召回+索引」共享；**守则不计入**（每会话固定注入完整版约 3070 字），剩余预算不足时依次挤掉教训/召回/索引；单通道 `autoRecallBudgetChars` 300 与剩余总预算取小 |
| scope 归一 | `normalizeScope` 只做 trim + 小写（M8）；报告建议的「_`/`空格折叠为 `-`」**有意未做**——避免改写用户已有的 scope 命名（如 `my project`），README 与源码注释均记录该决策 |
| 写侧闸门 | value ≤240 字、tags ≤3、前缀白名单九类 |
| 写入容量 | `maxItems` 默认 2000：达上限拒绝新增（更新不受限），提示跑 `memory_dream`；`/memory restore` 救援通道不受限 |
| full 归档 | `fullMaxChars` 默认 8000：同 key 反复超长更新时最新原文带时间戳置顶，旧内容保留在尾部但整体受上限约束，超限截断并警告 |
| 冲突检测 | 同 scope 内容相似 ≥55% 警告 |
| 导入去重 | 与库中 ≥70% 相似自动跳过 |
| 代谢候选 | task>30 天 / 任意>90 天 / 完成>14 天；`memory_dream({ apply: true })` 归档 >90 天条目（value 压成摘要、原文进 full） |
| 生命周期 | 所有注册随插件 Fiber 卸载；子代理写 global 被硬层拒绝 |

## 已知限制

- RRF 混合召回是词法+中文二元组双排名，**无 embedding**——远距离语义联想仍依赖词面部分重叠或 LLM 重排兜底；
- `memory_recall` 依赖 `sessionQuery` 服务，宿主未提供时报错（工具不可用）；且强制按会话工作区（cwd）过滤，会话无 cwd 时报错（跨会话检索不可用）；
- 审批门默认关闭；开启后每次写入需用户确认（`confirmed: true`）；
- 代谢只列候选，更新/归档/删除由模型执行，不自动删；
- 会话回捞返回的是历史会话片段，不保证与当前记忆库语义对齐。
- **插件的 `ctx.logger.warn` 在默认部署下不可见，这不是缺陷**：cordis 导出器的默认阈值是 INFO（DSH 源码 `vendor/cordis/src/logger.ts` 的 `exporter.levels?.default ?? this.level ?? LoggerLevel.INFO`；枚举里 `WARN = 2` 大于 `INFO = 1`，`targetLevel < level` 即丢弃），DSH 默认也不挂 `@deepseek-ai/cordis-plugin-logger-console`（其 `getDefaults()` 同样不设 `levels`，挂了不配仍是 INFO）——所以「轮末提取失败 / 后台写失败」这类 warn 默认看不到。要看它们，需在 profile 里挂 `@deepseek-ai/cordis-plugin-logger-console` 并配置 `levels: { default: 2 }`（WARN）或更高。官方对可预期的后台失败一律用 warn（`packages/session/session-title/src/index.ts` 的自动标题失败分支、`packages/session/session-persistence-jsonl/src/storage.ts` 的后台写失败回调），本插件的级别选择与官方一致。

## 隐私与数据边界

- **记忆内容会进入模型上下文**：`memory_get` 返回的 `value`、`tags`、`links`、`updatedAt`、`source`，以及 `includeFull: true` 时的 `full`；`memory_search` 返回的 `value`——都作为工具结果进入会话上下文，并随该会话的请求发送至配置的 LLM provider（当前默认 provider 为 `deepseek-official`）；记忆库本身只落盘在本地 `$DSH_HOME/dsh-persistent-memory/memory.jsonl`，插件不向其它服务发送记忆数据。
- **自动注入通道已排除凭据**：`auth.*` 前缀条目，以及 `value` 命中凭据正则（token / secret / api key / bearer / sk- / ghp_ / AKIA / PRIVATE KEY / 中文口令）或命中 `redactPatterns` 自定义敏感词的条目，都不参与自动注入（召回 / 教训 / 索引；凭据类记忆只在模型显式 `memory_search` / `memory_get` 时返回）。模型显式调用时主会话读到的 `auth.*`/`凭据类条目`默认是**掩码**；子代理会被硬层拒绝。
- **`confirmed` 是模型自述，不构成用户授权**：`memory_get` 的 `confirmed: true` 由模型自己填写，没有任何用户审批通道介入。因此默认配置下**即使带 `confirmed: true` 也只返回掩码**（`allowCredentialReveal` 默认 `false`）；只有部署者在 cordis 配置里显式写 `allowCredentialReveal: true`（视为部署者授权）才开放取回原文的路径。
- **导出文件是明文**：`/memory export` 会把整库（含 `auth.*` 明文凭据与所有 `full` 正文）写入你指定的文件，仅本地落盘、插件不上传，但请自行保管该文件。
- **`<memory-data trust="untrusted">` 是数据标注，不是脱敏**：工具输出中的记忆内容包裹在该标签内，并经 `sanitizeValue` 清洗（控制字符、危险 URI scheme、提示注入模式），但清洗不改变内容本身——不要把明文凭据写进非 `auth.*` 前缀，敏感内容入库前请自行判断。

## 开发

```sh
tsc -p tsconfig.json                    # 编译 host（零错误门禁）
Copy-Item src\client.js lib\client.js # client bundle 拷贝（构建产物）
npm pack                                # 打包 tgz
node --check lib/index.js               # host 语法检查
node --check lib/client.js              # client 语法检查
```

## License

BSD-3-Clause
