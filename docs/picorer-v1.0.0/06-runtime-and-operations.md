# 06 · 服务启动、数据复用与运行排查

本章面向要把 Picorer 真正跑起来的人。单题检索、HTTP memory service、三队列评测是三层不同的程序。先让服务能稳定读取已有数据，再启动评测 worker；只有进程存在，并不代表实际配置正确。

## 1. 安装与构建

正式仓库为 `https://github.com/fendss/picorer`。要复现本文版本，应检出具体标签，而不是假定今后的 main 仍然是同一份代码。

```bash
git clone https://github.com/fendss/picorer.git
cd picorer
git switch --detach v1.0.0
git rev-parse HEAD
npm ci
npm run build
```

预期版本标签为 `v1.0.0`。`package.json` 要求 Node 至少 22.19.0，`.nvmrc` 固定 22.19.0；目前服务器实验使用 Node 24.18.0。应保留 `package-lock.json`，Pi Agent 与 Pi AI 包都固定为 0.82.1。Python adapter 和队列有自己的依赖环境，`npm ci` 不会顺带安装它们。

产品检查入口为 `npm run check`，依次校验生成的代码目录、TypeScript、Vitest、Python 测试和构建。修改一个小模块时，可以先跑对应测试和类型检查；对外发布前再完成完整检查。测试通过不等于 benchmark 成绩不变。

## 2. 服务配置必须显式

当前测评使用 MemoryAgentBench 的 YAML 启动器。已有受保护配置可以这样检查和启动：

```bash
node integrations/memoryagentbench/run_from_yaml.mjs --check /absolute/path/config.yaml
node integrations/memoryagentbench/run_from_yaml.mjs service /absolute/path/config.yaml
```

`--check` 解析并打印脱敏配置，不发起模型实验。配置文件需要限制访问权限，例如 `chmod 600 /absolute/path/config.yaml`。`service` 启动 memory service，不会自动把所有题目派发出去。题目队列如何初始化和续跑，见 [评测使用指南](05-evaluation-guide.md)。

| 必须明确的配置 | 作用 |
|---|---|
| `paths.source`、`runtime_dir` | 实际加载的构建和服务数据库位置 |
| `service.source_identity`、`build_identity` | 当前源码及构建身份，进入运行契约 |
| `service.interface_mode`、`skill` | Agent 看到的接口与工具使用说明 |
| `service.retrieval_profile` | SQLite 混合检索，或 SQLite 配合 Qdrant |
| embedding 环境文件 | 端点、模型、维度及分批参数，必须与已有索引兼容 |
| `models.retrieval`、`models.answer` | 两阶段独立的模型、thinking、上下文和输出限制 |
| `max_run_ms`、`max_turns`、`max_tool_calls`、`max_search_calls` | 单题真实工作额度 |
| `max_concurrent_wraps` | 服务内部允许同时执行的检索 Agent 数 |
| 请求超时与重试 | 一次 HTTP 调用限制，不能与整题限制混淆 |

启动器生成模型配置和环境变量。底层 [load-model-runtime.ts](../../src/platform/pi/load-model-runtime.ts) 读取模型及 provider 设置，选择流式或非流式传输。[runtime-fetch.ts](../../src/platform/http/runtime-fetch.ts) 为该运行配置连接与超时，避免随意修改整个进程的全局网络行为。

模型配置里的名字只是请求路由。服务可能返回不同的模型名，因此轨迹还保存并验证实际响应模型。手动把 `model` 字符串改成 Qwen，不等于对端真的部署了对应模型。上下文长度和 `max_tokens` 是配置声明，也不自动证明服务端接受同样的值。

## 3. 确认服务身份，然后再请求

服务启动后，先检查：

```bash
curl -fsS http://127.0.0.1:3218/health
curl -fsS http://127.0.0.1:3218/runtime
```

这里的 3218 是本文 full 基线所用端口，自己的环境应按配置替换。`health` 展示活跃与排队 wrap 等负载；`runtime` 展示运行契约及 hash。比较源码身份、接口、模型、索引与预算，比只看 HTTP 200 更有用。端口能连通却加载错源码，是一种真实的实验配置错误。

服务没有最终答案路由。`/memory/wrap_user_prompt` 返回整理后的证据 prompt，由外部回答阶段继续调用模型。不要误以为服务返回的 `prompt` 本身就是答案。

## 4. 三个数据接口

请求 schema 在 [contracts.ts](../../src/entrypoints/memoryarena-public-api/contracts.ts) 中固定。服务拒绝未知字段。最小生命周期如下，示例使用一个专门的演示用户，不能套用到正在评测的用户身份：

```json
POST /memory/initialize
{"user_id":"demo-v100","memory_system_name":"picorer"}

POST /memory/add
{"user_id":"demo-v100","memory_system_name":"picorer","chunk":"Mira works as a botanist."}

POST /memory/wrap_user_prompt
{"user_id":"demo-v100","memory_system_name":"picorer","question":"What is Mira's occupation?","answer_handoff":"evidence-aware-v1"}
```

`initialize` 为该用户切换到新一代数据空间。它不是无害的“检查数据库是否存在”操作。对已入库任务重复初始化，后续查询会转向新一代，旧记录即使还在文件里也不再是当前可见数据。

`add` 可以携带结构化 `messages`，保留角色和时间。是否使用 messages、如何分批，由 adapter 决定。数据库只接受应用层确认的记录，不负责解释这个 chunk 是一段对话还是若干编号事实。

`wrap_user_prompt` 创建本题检索任务。`operator_experiment` 可指定 static 等模式与搜索预算；这与服务的 full 或 compact 接口是独立配置。金标准答案和 gold 文档 ID 不属于该接口。

## 5. 高并发为什么仍需要边界

[application.ts](../../src/entrypoints/memoryarena-public-api/application.ts) 对同一用户使用公平读写锁。initialize 和 add 是独占写操作；多个只读 wrap 可以同时运行。排到的写操作不会被无休止插入的读取饿死。不同用户无需共用一把长时间持有的大锁。

服务还有一个全局 wrap 准入器，限制同时执行的检索 Agent 数。它与队列 worker 并发不同：worker 发出 64 个请求，而服务只放行 24 个时，多出的请求主要在服务内等待。继续增加 worker，不会自动增加模型吞吐。

同一请求发生 HTTP 重试时，进程内的请求合并器可以共用正在运行或近期成功的 wrap。当前默认成功缓存保留 15 分钟，完成条目上限 4096；用户资料变更会失效相应缓存，失败不会作为成功缓存保留。这是单进程优化，重启后不保证请求只执行一次。

当前准入等待队列本身没有固定长度上限。外部评测队列仍需背压，否则只是把积压搬进服务进程。观察速度时，应同时看 worker 活跃数、服务等待数、模型运行与等待请求、输入输出吞吐及题目完成率，不能只看 GPU 显存或 KV cache。

## 6. 数据目录为什么不能随手复制一个文件

当前服务的数据目录包括：

| 文件 | 用处 |
|---|---|
| `memory.sqlite` 及活跃时的 WAL 文件 | 原文、索引、向量和持久化状态 |
| `active-generations.json` | 用户当前数据代次、追加顺序和未完成追加 |
| `persistence-identity.json` | 这份持久化数据的身份 |
| `operation-audits.jsonl` | initialize、add、wrap 的运行元数据与结果 |
| `wrap-audits.jsonl` | 检索轨迹、原文证据、交接 prompt 等完整记录 |
| `.picorer-memoryarena.lock` | 防止两个服务同时管理同一组数据与 sidecar |

在线备份 SQLite 应使用 SQLite backup API 等一致性手段，不应在服务运行时只复制主文件而漏掉 WAL。准备独立的只读实验数据库时，还要一致地复制代次和持久化身份。不能复制活动锁文件后冒充另一个合法服务。

如果正在入库，数据库和 sidecar 的一致时点也需要处理；仅做 SQLite backup 不足以保证另一个文件恰好与它同步。本文的 full 对照复用已经结束入库、仅作查询的语料快照。

复用 ingestion checkpoint 前，应核对用户身份、语料与切分版本、数据代次、记录数量、embedding 维度、检索 profile 以及数据身份。已有数据库并不代表当前题目的用户作用域一定存在。检查失败应先定位身份和配置，不应立即重新初始化把问题掩盖掉。

## 7. 失败如何定位

| 现象 | 先检查什么 | 含义 |
|---|---|---|
| 队列没有新完成题 | stage 心跳、worker 日志、服务 admission、模型等待队列 | 分清卡在排队、检索、回答还是评分 |
| HTTP 422 | 请求字段、数据类型、运行契约 | 通常应修调用参数，盲目重试不会改善 |
| 来源或 scope 不存在 | checkpoint 的 user ID、代次、数据库身份 | 不等同于“检索算法召回不到” |
| `pendingAppend` 导致不可查询 | 对应 add 的日志和状态 | 入库尚未提交完，不能读取半完成状态 |
| `turn_budget_exhausted` 或 `tool_budget_exhausted` | 工具循环、重复错误、finish 拒绝记录 | 请求可能正常完成多轮，只是整题额度耗尽 |
| 上下文超限或空答案 | 真正的回答 messages、输出限制、结束原因、usage | 与检索服务超时是不同问题 |
| 有 read、回答却缺资料 | 账本、wrap prompt、answer 输入逐层对照 | 检查原文在哪个边界被排除或截取 |
| 某阶段失败后补跑 | 所有 attempts 与对应 artifact | 区分最终成功率和首试成功率，成本不能只记最后一次 |

wrap 审计在成功响应前写入。写盘失败可能发生在模型已经完成之后，因此一个失败请求未必没有消耗。请求合并和队列重试都不能把这类成本自动抹掉。

轨迹包含原始资料和问题，应当与实验数据一样管理访问权限。文档中展示路径和配置结构即可，不需要复制 API key。

## 8. 两个其他入口

**LDBD API** 是另一套协议，入口为 [ldbd-api/main.ts](../../src/entrypoints/ldbd-api/main.ts)。它提供 `/v1/memories/add` 和 `/v1/memories/search`；可以配置 token 验证，有单独的请求门限。它在首次搜索后封闭对应作用域，后续追加会拒绝。不能把 MemoryArena 的代次初始化和在线追加语义直接套到这里。

**交互式 Agent** 位于 [interactive-memory-agent.ts](../../src/agent-runtime/interactive-memory-agent.ts)。它用于同时需要记忆检索和外部领域工具的任务。程序接收用户消息或外部工具回执，执行内部记忆工具，把需要由外部系统执行的动作返回给调用者，再核对工具 ID 和名称接续。内部记忆动作不能与外部动作混在一个未确认的批次里。

这套交互会话与本文的“检索结束后独立回答”是不同入口。Tau-Knowledge bridge 负责适配它；不能用 Tau 的会话行为推断 Fact-MH 的 finish 或回答输入。
