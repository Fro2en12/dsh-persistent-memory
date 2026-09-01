# dsh-persistent-memory

> DSH 插件：**持久记忆 + 自动召回**。九类记忆分类学驱动的自动沉淀守则、写侧硬闸门、词法+RRF 混合召回、教训通道、记忆代谢、Claude Code 记忆一键导入、历史会话回捞，以及一个设置页面板——记忆不靠每次提醒，跨会话自动浮现。

English: A DeepSeek Harness (DSH) plugin for persistent memory with automatic recall. A nine-type memory taxonomy drives automatic capture guidance and a write-side gate; recall combines lexical scoring, zero-token RRF hybrid ranking, and LLM reranking; plus a lesson channel, memory metabolism, one-click import from Claude Code memory files, historical-session recall, and a settings panel.

> **兼容性**：本版本对齐 DSH `0.1.2-alpha` —— 工具注册走官方 `defineTool`、设置面板走官方 `ctx.settings.register` + `settings.section` slot、会话检索走 `ctx.get('sessionQuery')` 接缝（可选，缺失时工具报错降级）。数据落盘 `$DSH_HOME/dsh-persistent-memory/memory.jsonl`，重启不丢。

## ⚠️ AI 产物声明

**本项目为 AI（DeepSeek 驱动的智能体）产物**：功能设计、架构选型、代码编写、测试与文档均由 AI 在对话中迭代完成，人工提供需求与验收反馈。

- 开发过程中经真机验证（守则注入、召回/教训通道、写侧闸门、设置面板、3081 预演均有实测记录），但边界情况无法穷尽，生产使用前请自行审阅与测试；
- 欢迎提交 Issue / Pull Request 修正问题或扩展能力；
- 本项目基于 BSD-3-Clause 协议开源，可自由使用、修改与分发。

## 功能特性

| 机制 | 说明 |
|---|---|
| 九类记忆分类学 | 每会话首轮注入「自动记忆守则」：user（画像）/ rule（纠正+成功确认，Why/How to apply 结构）/ task（绝对日期）/ project（定稿结论）/ env（环境指针）/ tool（坑）/ ref（资源指针）/ auth（凭据，显式要求才记）/ lesson（负面知识账本）。判据含「不记清单」：代码可推导内容、git 史、完整修复配方、AGENTS.md/cairn 已有内容 |
| 写侧硬闸门 | `memory_set` 硬校验：key 前缀白名单、value ≤160 字（细节挪 full）、tags ≤3 个、非 auth.* 前缀检测到明文密码直接拒绝；task.* 缺绝对日期、含 token 类关键词只警告 |
| 自动召回 | pre-step 词法评分（同义词展开+噪音词过滤+首轮阈值 6）；词法 0 命中时 **RRF 混合召回**（词法+中文二元组双排名倒数融合，零 token 零依赖）按语义补位 |
| LLM 语义重排 | 候选 ≥2 时用当前路由模型从 RRF 候选池挑「明确有用」的 ≤5 条（宁少勿多；正用工具的参考文档不选，警告/坑照选）；LLM 不可用/失败/5s 超时自动降级词法 |
| 教训通道 | 悔恨信号（「又错/还是失败」）或场景信号（路径/盘符/终端/命令）时**不受每会话一次限制**强制召回 rule.*/lesson.*，独立 120s 冷却——错误发生时把上次的坑摆到眼前 |
| 记忆索引兜底 | 首轮 0 召回时注入动态【记忆索引】（global 4 条：user.* 画像固定 2 席 + 其余最新 2 席；工作区 scope 各 3 条），不落盘 |
| 新鲜度标注 | 每条召回显示天龄（今天/昨天/N 天前）；>1 天附漂移警告——时点观察，点名文件/路径引用前先验证现状 |
| 来源引证 | `memory_set` 自动填「日期+会话 id」，召回行展示 `· 自2026-09-01 s=xxx` |
| 子代理隔离 | 子代理会话注入只读守则 + `memory_set` 硬层拒绝写 global（提示 `scope=sub:<id>`）；成果回传父会话沉淀 |
| 记忆代谢 | `memory_dream` 工具 + `/memory dream`：task 超 30 天 / 任意超 90 天 / 标记完成超 14 天出候选，由模型决定更新/归档/删除 |
| 记忆导入 | `memory_import` + `/memory import`：CLAUDE.md / MEMORY.md / Claude Code memories.json，自动分 ref/rule/lesson 前缀，与库中 ≥70% 相似自动跳过 |
| 会话回捞 | `memory_recall`：走 `ctx.get('sessionQuery')` 全文检索历史会话，记忆没记但以前说过的事能捞回来 |
| 内容冲突检测 | 写入时对同 scope 条目算内容相似度，≥55% 警告「确认是否应更新该条而非新建」 |
| 治理面板 | 设置页「记忆」分区 5 个开关（自动回忆/自动捕获/回忆重排/RRF 召回/写入审批）即时生效；`/memory panel` 生成自包含 HTML 浏览/搜索（auth.* 凭据排除） |
| 防护 | 注入前清洗控制字符/危险 URI/提示注入指令；同 scope 高相似 key 自动合并；stat 缓存失效 |

## 模型工具

- `memory_set` — 写入/更新（同 scope+key 覆盖；`full` 长文、`links` 关联、`confirmed` 审批门、`source` 引证）
- `memory_get` — 按 key 读取（`includeFull` 才返回完整正文）
- `memory_search` — 关键词/标签/作用域搜索
- `memory_forget` — 删除一条
- `memory_stats` — 记忆库概况
- `memory_dream` — 代谢候选清单
- `memory_import` — 外部文件导入
- `memory_recall` — 历史会话回捞
- `/memory` 命令 — `status` / `recall` / `remember` / `forget` / `dream` / `import` / `panel`，人不经过模型也能操作

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
        autoRecallLimit: 3          # 召回最多注入条数
        autoRecallRerank: true      # LLM 语义重排
        rrfRecall: true             # RRF 混合召回（词法 0 命中语义补位）
        autoCapture: true           # 每会话注入记忆守则
        approveOnSet: false         # 写入审批门（开启后须用户确认）
        dedupeOnSet: true           # 同 scope 高相似 key 自动合并
        synonymExpansion: true      # 同义词扩展评分
        autoRecallOnce: true        # 每会话只召回一次 + 冷却
        autoRecallCooldownMs: 600000
```

配置经插件内嵌 Schemastery `Config` 校验，非法值加载期响亮失败。

## 使用说明

- **自动沉淀**：无需操作——守则每会话首轮注入，模型自己判断该记什么；账号密码类只有你明确说「记住」才写；
- **主动检索**：`/memory recall <关键词>` 或 `memory_search`；
- **定期代谢**：`/memory dream` 看过期候选，让 agent 用 `memory_set`/`memory_forget` 处理；
- **导入旧记忆**：`/memory import <CLAUDE.md 或 memories.json 绝对路径>`；
- **设置面板**：设置页「记忆」分区 5 个开关即时生效；`/memory panel` 生成 HTML 面板文件，浏览器打开可浏览/搜索全部记忆。

## 架构

```
lib/index.js    Host 半部分（ESM；inject tools/commands/settings，webServer 惰性）
  ├─ Config（schemastery）      16 个可调参数、加载期校验
  ├─ 写侧闸门                   前缀白名单 / ≤160 字 / tags ≤3 / 凭据检测 / 冲突警告
  ├─ pre-step 管线              守则 → 教训通道 → RRF+词法召回 → LLM 重排 → 索引兜底
  ├─ RRF 混合召回               bigram-Jaccard 中文二元组 + 词法双排名倒数融合（K=60）
  ├─ 工具注册                   defineTool × 8 + /memory 命令
  ├─ /_dsh/dsh-persistent-memory/settings  面板 RPC（GET 快照 / POST 保存，localhost-only）
  └─ settings.register           ns=dsh-persistent-memory（5 字段，applies=live）
lib/client.js   Client 半部分（AMD bundle；window.__ModuleLoader__ 协议）
  └─ settings.section slot       设置页「记忆」分区，5 个开关 React 组件
```

### 关键机制与阈值

| 机制 | 数值 |
|---|---|
| 召回评分 | 首轮阈值 6（一次 key 直中+少量辅助）；弱主题词降权；value 命中降分 |
| RRF 融合 | K=60；候选 rrf ≥0.025 才进入语义补位/重排池 |
| LLM 重排 | 候选 ≥2 才调用一次，5s 超时+失败降级词法，宁少勿多 |
| 教训通道 | 悔恨/场景信号强制召回 rule.*/lesson.*，独立 120s 冷却，不受 once 限制 |
| 索引配额 | global 4 条（user.* 固定 2 席），工作区 scope 各 3 条 |
| 写侧闸门 | value ≤160 字、tags ≤3、前缀白名单九类 |
| 冲突检测 | 同 scope 内容相似 ≥55% 警告 |
| 导入去重 | 与库中 ≥70% 相似自动跳过 |
| 代谢候选 | task>30 天 / 任意>90 天 / 完成>14 天 |
| 生命周期 | 所有注册随插件 Fiber 卸载；子代理写 global 被硬层拒绝 |

## 已知限制

- RRF 混合召回是词法+中文二元组双排名，**无 embedding**——远距离语义联想仍依赖词面部分重叠或 LLM 重排兜底；
- `memory_recall` 依赖 `sessionQuery` 服务，宿主未提供时报错降级；
- 审批门默认关闭；开启后每次写入需用户确认（`confirmed: true`）；
- 代谢只列候选，更新/归档/删除由模型执行，不自动删；
- 会话回捞返回的是历史会话片段，不保证与当前记忆库语义对齐。

## 开发

```sh
tsc -p tsconfig.json                    # 编译 host（零错误门禁）
Copy-Item src\client.js lib\client.js # client bundle 拷贝（构建产物）
npm pack                                # 打包 tgz
node --check lib/index.js               # host 语法检查
node --check lib/client.js              # client 语法检查
```

**部署前三步验证**（本项目铁律）：① tsc 零错误；② package.json 每个 exports 路径的文件在产物里存在；③ 3081 临时实例预演（`bin.js --profile web --port 3081 --no-open`）确认加载成功、无崩溃日志——全部通过才替换 vendor、改依赖、重启 3080。

## License

BSD-3-Clause
