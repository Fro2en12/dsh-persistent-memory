# @dsh-external/dsh-persistent-memory

DSH 持久记忆插件：跨会话保存/检索用户偏好、项目事实与任务状态，数据落盘 JSONL，并支持**每轮自动召回注入**——记忆会自动浮现，不用你每次提醒。

## 功能

- `memory_set`：写入/更新一条记忆（同 scope + key 覆盖；支持 `full` 完整正文与 `links` 关联）
- `memory_get`：按 key 读取（`includeFull` 时才返回完整正文，默认只给摘要）
- `memory_search`：按关键词/标签/作用域搜索记忆
- `memory_forget`：删除一条记忆
- `memory_stats`：查看记忆库概况
- **/`memory` 斜杠命令**：`status` / `recall <查询>` / `remember <key> <内容>` / `forget <key>`——人不经过模型也能直接查看/写入
- **自动召回**：`agent/pre-step` 时自动从记忆库召回相关/最近记忆，注入为带 source 标记的插件消息（可重放、压缩可见）；命中“网络/代理/失败/认证/权限”等障碍信号时额外召回环境与工具类记忆；每会话只注入一次 + 冷却期
- **教训/规则通道（防重复犯错，v0.1.3 新增）**：检测到悔恨信号（“又错/还是失败/老是…”）或场景信号（路径/盘符/目录/PowerShell/终端/命令/脚本/字符）时，**不受每会话一次的限制**强制召回 `rule.*` 与教训/坑/修复类记忆（独立 120s 冷却），错误发生时立刻把上次的坑摆到眼前
- **画像兜底（v0.1.3 新增；v0.1.6 由记忆索引取代；v0.1.7 画像配额修复）**：首轮常规召回无命中时注入 `user.*` 画像的历史分支已移除——画像改由【记忆索引】呈现；v0.1.6 施工版只取「最新 4 条」导致画像被高频条目挤出，v0.1.7 起 global 组给 `user.*` 固定 2 席配额，画像真实呈现；v0.1.4 修正（发图提问跳过画像）依然生效
- **自动沉淀**：每会话首轮以 `pre-step` 注入“自动记忆守则”，让模型自己发现并总结值得长期记住的信息（**不走 system-prompt section**——`complete: true` 的预设如 stock minimal 装配后只保留 persona section，其余全部静默丢弃；pre-step 注入在任何 preset 下都可达；**v0.1.5 起守则对标 Claude Code 记忆类型学**：user./rule./task./ref. 四类、rule 记"纠正+成功确认"并带 Why/How to apply、时间用绝对日期、明确不记清单：代码可推导内容/git 史/完整修复配方/会话临时进度）
- **新鲜度标注（v0.1.5 新增，对标 Claude Code memoryAge.ts）**：召回/教训注入的每条记忆显示天龄（今天/昨天/N 天前）；>1 天记忆附漂移警告——记忆是写入时的时点观察，点名文件/路径/命令须先验证现状再引用，与当前信息冲突以现状为准并更新记忆（防止"过时断言当事实"成为重复犯错之源）
- **LLM 语义重排（v0.1.6 新增，对标 Claude Code findRelevantMemories）**：常规召回词法命中后，若候选 ≥2 且本轮非看图提问，用当前路由模型从预筛候选池挑选"明确有用"的 ≤5 条（宁少勿多；正在使用的工具的参考文档不选，但警告/坑/已知问题要选；陈旧状态记忆优先不选，rule.*/user.* 除外）；LLM 不可用/失败/超时（5s）自动降级词法 top，不影响原有链路
- **记忆索引兜底（v0.1.6 新增，对标 Claude Code MEMORY.md）**：首轮常规召回 0 命中、非看图提问、教训通道未注入时，注入动态生成的【记忆索引】（global 4 条——`user.*` 画像固定 2 席 + 其余分类最新 2 席（v0.1.7）；当前工作区 scope 各 3 条，带天龄，不落盘），替代原画像兜底
- **子代理隔离（v0.1.6 新增）**：子代理会话（session.header.origin==='subagent' / delegationDepth>0 / parentSession 存在）注入只读版守则（不写全局记忆，成果回传父会话沉淀）；`memory_set` 硬层拒绝子代理写 `scope=global`（提示改用 `scope=sub:<id>`）；召回/教训通道保留，索引兜底对子代理跳过
- **写侧闸门（v0.1.7 新增）**：`memory_set` 写入硬校验，把守则的执行纪律变成硬约束——① key 前缀白名单 user/rule/task/ref/env/project/tool/auth（plugin 为插件自留前缀；项目专属记忆用 scope 承载项目名勿塞进 key；例外：key 前缀与 scope 同名放行）；② value ≤160 字（超限拒绝，细节挪 full）；③ tags ≤3 个；④ 非 auth.* 前缀检测到明文密码/密钥直接拒绝（auth.* 为用户授权凭据类放行）；警告不拒绝：task.* 缺绝对日期、内容含 token/secret 类关键词（提示确认是否指针）。守则同步修订为八类分类学 + 冲突仲裁（矛盾时要么不写、要么显式标注覆盖）+ rule.* 失效更新 + cairn 边界（本项目内 cairn 会记的写 cairn 不写 memory）
- **auth.* 显式记忆模式（v0.1.8 新增，守则层）**：账号/密码/密钥**只有用户明确要求记住时**才写入 auth.*（如「把这个账号密码记住」）；用户没要求时，配置过程中见到的账号密码一律不主动沉淀进记忆库。其余七类守则不变
- **九项能力补齐（v0.1.9，市场对比后）**：① RRF 混合召回（词法+中文二元组双排名融合，零 token 零依赖；词法 0 命中时按语义补位，LLM 重排候选池改 RRF）；② source 来源引证（memory_set 自动填日期+会话，召回/教训行展示）；③ 记忆代谢 memory_dream 工具 + /memory dream（task 超 30 天/任意超 90 天/标记完成超 14 天出候选）；④ 治理面板：/memory panel 生成自包含 HTML（可搜索，auth.* 凭据排除）+ 设置页开关卡片（autoRecall/autoCapture/autoRecallRerank/rrfRecall/approveOnSet）；⑤ 记忆导入 memory_import + /memory import（CLAUDE.md/MEMORY.md/memories.json，自动分 ref/rule/lesson 前缀，与库中 ≥70% 相似自动跳过）；⑥ 内容冲突检测（写入时同 scope 相似度 ≥55% 警告提示）；⑦ lesson.* 负面知识账本（第九类，教训通道联动）；⑧ 写入审批门 approveOnSet + confirmed 参数（默认关闭）；⑨ memory_recall 会话回捞（ctx.get('sessionQuery') 全文检索历史会话，无服务时报错降级）
- **摘要 + 正文分层**：`value` 写自足摘要（召回/搜索只见它），长文放 `full`（`memory_get includeFull` 才返回），控制 token 膨胀
- **关联提示**：`links` 声明同 scope 的其他记忆 key，召回时展示 🔗 关联行（每个 item 最多 3 个）
- **防护与去重**：注入前清洗控制字符/非 http(s) URI scheme/提示注入指令；同 scope 高相似 key 自动合并更新；写前应向用户确认不确定/敏感的信息（守则引导）
- **文件级读取缓存**：stat（mtime+size）未变时复用解析结果，写入后自动失效
- **评分收紧（v0.1.3）**：低信息量词（语气/泛化词）不参与评分；同义词展开限制为短 token（≤6 字符）且只作用于 key/tags；弱主题词（记忆/上下文/插件等）降权；value 命中降分；首轮阈值 5→6——显著减少“dsh-web-profile 类无关环境记忆”误召回

记忆默认持久化在 `$DSH_HOME/dsh-persistent-memory/memory.jsonl`
（`DSH_HOME` 未设置时使用 `~/.dsh`），重启/跨会话不丢失。

## 自动召回配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `autoRecall` | `true` | 是否在每轮请求前自动召回注入 |
| `autoRecallLimit` | `3` | 自动召回最多注入条数（v0.1.3 由 5 下调） |
| `autoRecallMaxChars` | `160` | 每条记忆 value 最大展示字符数（v0.1.3 由 200 下调，按句子边界截断） |
| `autoRecallScope` | 空 | 自动召回限定作用域；空表示全部 |
| `autoRecallFallback` | `false` | 没有相关匹配时是否回退注入最近记忆；默认关闭，避免无关上下文污染 |
| `autoRecallOnce` | `true` | 每个会话只自动注入一次记忆（教训/规则通道不受此限制） |
| `autoRecallCooldownMs` | `600000` | `autoRecallOnce=false` 时的冷却毫秒数（默认 10 分钟） |
| `autoCapture` | `true` | 是否每会话首轮注入“自动记忆守则” |
| `synonymExpansion` | `true` | 同义词扩展评分（代理↔梯子↔vpn、认证↔登录↔凭据等；v0.1.3 起仅短 token 且只匹配 key/tags） |
| `dedupeOnSet` | `true` | `memory_set` 对同 scope 高相似 key 自动合并更新，避免记忆库膨胀 |
| `autoRecallRerank` | `true` | LLM 语义重排开关（LLM 不可用/失败自动降级词法 top） |
| `autoRecallRerankMax` | `5` | 语义重排时 LLM 最多可选条数（1~8，候选池=该值×4） |

## 构建

```bash
DSH_CHECKOUT=<dsh 源码路径> bash scripts/build.sh
# 本仓库常用：DSH_CHECKOUT=E:/改着玩/deepseek-harness bash scripts/build.sh
```

## 注入

```bash
# 常规 profile bundle 安装（推荐）
dsh plugin --profile web add E:/改着玩/dsh-persistent-memory

# 开发环境（超级模组注入器，免重启；需要 routing-suite 的 injector 在场）
dev_inject_plugin E:/改着玩/dsh-persistent-memory
```

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/dsh-persistent-memory` | 记忆库目录 |
| `defaultScope` | `global` | 未显式传 scope 时的默认作用域 |
| `maxResults` | `20` | 搜索返回条数上限 |
