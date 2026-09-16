# 存储、入库与检索：原文怎样变成可查、可读的证据

本文依据 Picorer v1.0.0 首次独立发布源码编写。它解释已实现的行为，不把实验设想当成功能，也不把某次评测的配置当成所有入口的默认值。Agent 如何决定读取、维护 working memory 和提交证据，见[下一章](03-agent-and-evidence.md)。

## 1. 先分清四种东西

Picorer 的存储层保存原文，检索层给原文排顺序，Agent 决定读哪些来源，Harness 负责把真正读到的来源交付出去。理解这条分工，首先要分清以下对象。

| 对象 | 是什么 | 不应误解成什么 |
|---|---|---|
| `MemoryRecord`，也称 parent | 一条有固定 ID、来源和正文的存储记录 | 不一定是一篇完整文档，也不保证是一条语义完整的事实 |
| `MemoryPassage` | parent 正文里的连续片段，带起止位置与 parent 的内容哈希 | 不是另一次摘要，不是默认独立入库的向量记录 |
| `RetrievalHit` | 一条命中记录，附查询、排名、预览及命中来源 | 命中 parent 不等于已找到目标关系，也不等于 Agent 已读 |
| `CandidateSet` | 算子产生或加工的一组候选 | 不是最终证据包，候选融合不会自动提交原文 |

例如，一条会议记录同时写了预算、人员和发布日期。它可以是一个 parent；关于发布日期的两句话可以成为 passage；搜索结果里看到了它，仍需要 Agent 发出 `read`。最终提交完整 parent，指的是这条入库记录的完整正文，不是恢复整份会议档案。

数据模型定义在 [memory.ts](https://github.com/fendss/picorer/blob/v1.0.0/src/memory/model/memory.ts#L18)、[search.ts](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/model/search.ts) 和 [passage.ts](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/model/passage.ts#L12)。

## 2. 入库：保存来源，建立索引

### 2.1 核心入口不负责理解文本

`ingestMemorySessions()` 接收已经整理好的 sessions。每个 session 包含 `scopeId`、`sessionId`、可选时间、若干 turns；每个 turn 包含角色、正文、可选 ID 与元数据。

函数逐项检查 scope、重复 session、重复 memory ID、角色、时间格式及 JSON 元数据，然后把每个 turn 变成一个 `MemoryRecord`。输入有 ID 就使用该 ID；没有则根据 scope、session 和 turn 位置生成稳定 ID。正文计算 SHA-256，session 与 turn 的元数据分别保留。空正文允许保存，因为空的一轮对话也可能有来源位置。

这里没有大模型，没有摘要，也没有事实抽取。核心入库保留的是**适配器交给它的正文**。如果适配器之前做过分句、空白合并或文档切块，不能再声称数据库与数据集最初文件逐字相同。[实现：ingest-memory-sessions.ts](https://github.com/fendss/picorer/blob/v1.0.0/src/memory/ingest-memory-sessions.ts#L169)。

### 2.2 parent 的边界由上游决定

Picorer 没有一个适用于所有数据集的“完整信息判断器”。聊天数据可以一轮消息一个 parent；长文数据可以先按句子聚合成块，再把块作为 parent。

仓库中的 MemoryAgentBench HTTP adapter 使用 NLTK 分句和 `gpt-4o-mini` 对应的 tokenizer，默认按约 4096 tokens 聚合句子。它用空格重新连接句子，单个超长句子不会进一步切开，所以 4096 是聚合目标，不能当作每块绝不超出的硬限制。独立的 public adapter 也有自己的 chunking 实现及固定参数。BEAM、LoCoMo 经 OmniMemEval 接入时，应查看那次实验使用的适配器，不能套用这里的 AMB 切块规则。[HTTP adapter](https://github.com/fendss/picorer/blob/v1.0.0/integrations/memoryagentbench/mab_adapter/chunking.py#L4)、[public adapter](https://github.com/fendss/picorer/blob/v1.0.0/integrations/memoryagentbench-public/hydrate.py#L135)。

因此，“保存完整 parent”解决的是后续读取和交付再次截断的问题。它不能补回入库前已经拆开的上下文，也不能保证编号与正文、主语与指代、更新与旧事实恰好落在同一块。

### 2.3 SQLite 是原文与索引身份的依据

`MemoryStore` 用 Node 的同步 SQLite API，启用 WAL 与外键。主要表如下。

| 表 | 保存什么 |
|---|---|
| `memories` | 原文、memory ID、scope、session、turn、角色、时间、内容哈希、元数据 |
| `memory_fts` | FTS5 全文索引；索引文本为角色前缀和正文 |
| `memory_embeddings` | 每个 memory、每个 embedding profile 的向量，及模型、维度、内容哈希 |
| `online_memory_scopes` | 在线 scope 正在入库还是已经封存 |
| `memory_append_sessions`、`memory_append_requests` | 在线追加的位置与请求幂等状态 |
| 时间、数值及向量发布辅助表 | 可重建的索引数据、抽取版本、向量同步与发布状态 |

批量 `ingestScope()` 在一个事务里同时写原文和 FTS。相同 scope 再次导入完全一致的记录会返回 `unchanged`；内容不同则报错，要求使用新的 scope 或版本。事务按 scope 提交，不是把全部 scopes 包成一个大事务。`memory_id` 在数据库里是全局唯一的，外部传入 ID 时也必须避免跨 scope 碰撞。[表结构与事务](https://github.com/fendss/picorer/blob/v1.0.0/src/platform/sqlite/picorer-store.ts#L136)。

在线追加另走 `appendMemoryRequest()`：同一 request ID 对应同一请求内容；重复调用返回原有记录，内容冲突则拒绝。scope 封存后不可继续追加，存在尚未完成的追加请求时也不能封存。这让追加原文、补齐索引与正式开始查询有明确边界。[在线生命周期](https://github.com/fendss/picorer/blob/v1.0.0/src/platform/sqlite/picorer-store.ts#L294)。

### 2.4 向量切块与 passage 是两回事

`indexScopeEmbeddings()` 只为当前 profile 缺失的记录生成向量。输入为 `role: 原文`，计算完成后按批次写回 SQLite。

默认 embedding 模型是 `text-embedding-v4`，维度 1024，每个输入块最多 2048 个 **Unicode code points**，每批默认 10 个输入。这里的 2048 不是模型 tokens。超长文本按字符均衡拆块，各块分别 embedding，然后取算术平均，最终仍然是**每个 parent 一个向量**。embedding 输入会清理少数模型特殊标记，但 SQLite 原文不受影响。

profile ID 包含 endpoint 指纹、模型、维度、输入长度、清理方式与聚合方式。配置变化会得到不同的 profile，避免把不同向量空间悄悄混用。默认请求超时 30 秒、最多重试 4 次；部署环境可覆盖这些值。[索引入口](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/index-scope-embeddings.ts#L21)、[embedding 默认值](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/adapters/openai/openai-compatible-embedder.ts#L274)、[长输入聚合](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/adapters/openai/openai-compatible-embedder.ts#L411)。

## 3. SQLite 与 Qdrant 如何一起工作

检索 profile 选择后端；算子选择查询方式。两者不能混为一个开关。

| profile | 关键词检索 | 语义检索 | 原文来自哪里 |
|---|---|---|---|
| `fts5`，解析器默认值 | SQLite FTS5 | 不启用 | SQLite |
| `picorer-hybrid` | SQLite FTS5 | 从 SQLite 读向量，精确计算余弦相似度 | SQLite |
| `picorer-hybrid-qdrant-hnsw-v1` | SQLite FTS5 | Qdrant HNSW 近似搜索 | 按命中 ID 回查 SQLite |

所以 Qdrant 没有替代 SQLite，`hybrid` 这个算子名字也不保证一定用了向量：如果装配时选 `fts5`，它委托的 store 就只有 FTS。[装配入口](https://github.com/fendss/picorer/blob/v1.0.0/src/composition/create-retrieval-context.ts#L30)。

SQLite 精确语义检索对 scope 内符合过滤条件的全部向量计算余弦，按分数与 memory ID 排序。优点是规则直接、便于回归对照；代价是语料大时每次都要扫描和计算，且这段计算发生在同步执行路径上，不能把它当作免费的高并发搜索服务。[精确检索实现](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/adapters/sqlite/exact-dense-retriever.ts#L35)。

Qdrant 使用显式的 generation。发布时从 SQLite 已有向量入队、同步、核验，再发布可查询的一代；不会因为 Qdrant 服务能返回结果，就认定本批语料完整。查询前检查 generation、模型、维度与 scope 覆盖数；返回后核对 point ID、内容哈希、session、角色及时间，并从 SQLite 取原文。[发布逻辑](https://github.com/fendss/picorer/blob/v1.0.0/src/composition/qdrant-retrieval.ts#L188)、[查询与来源校验](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/adapters/qdrant/dense-retriever.ts#L118)。

同步进度写在 SQLite 的 `vector_sync_outbox`，每项有待处理、执行中、已同步三种状态，以及尝试次数和领取租约。租约到期可重新领取；向量 point ID 是确定性的，重复同步不会生成另一个来源。generation 从入库阶段进入排空、核验，最后成为 `ready`；失败另记 `failed`。这是向量索引发布队列，与后文评测框架的检索、回答队列是两套东西。[向量同步状态机](https://github.com/fendss/picorer/blob/v1.0.0/src/platform/sqlite/vector-index-state-store.ts#L67)。

默认 HNSW 参数为 `m=32`、`ef_construct=200`、查询 `ef=800`，Qdrant 请求超时 120 秒。查询还会把 `ef` 至少提高到请求条数的两倍，上限 10000。这些是代码默认值，实验必须记录实际覆盖后的值。

Qdrant 网络不可用、限流或服务端错误时，可以退回 SQLite 精确语义检索，并累计 fallback 次数。数据身份不一致、索引不完整和配置错误会直接暴露，不会被 fallback 隐藏。这条退路可能显著增加延迟，也不意味着两种排名逐题完全相同。[错误边界](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/adapters/fallback-dense-retriever.ts#L49)。

## 4. 五个基础检索算子分别做什么

基础目录默认注册五个算子，版本均为 `4`。注册表启动后冻结，保存 ID、版本、用途、避免场景和成本说明。`executeSearchOperator()` 统一检查取消信号、scope、passage 身份和重复命中，避免插件把别人的记忆带进当前问题。[基础算子](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/adapters/operators/builtins.ts#L55)、[执行边界](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/use-cases/execute-operator.ts#L19)。

### 4.1 `hybrid`：兼顾措辞相似与语义相近

对每条 query，混合后端获取语义排名和词法排名，用 RRF 融合：第 r 名贡献 `1 / (60 + r)`。这里没有额外调用大模型重排，指标中的 rerank 候选数主要描述进入融合的候选规模。

每条 query 的内部发现池固定为 100，避免只改可见页大小就导致之前的排名变化。多 query 再按“最高单路分数加其他命中分数的四分之一”合并，并最多为 10 条 query 保留各自的候选覆盖。显式日期还可产生带时间过滤的检索路线，最多保留 4 个此类候选。最后才应用返回数量、排序与 session 限额。

它适合“记录里写的词与提问不同”的情况，但向量命中的是 parent，不能因此确定 parent 中具体哪句话回答了问题。[HybridRetriever.search](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/operators/hybrid-search.ts#L141)。

### 4.2 `lexical`：围绕明确的词找来源

它使用 FTS5 和 BM25 建候选，再融合三种查询计划：完整短语权重 1.2、最多六个信息词的 AND 权重 1.1、信息词 OR 权重 1。每个计划最多取 100 条；多 query 的合并同样兼顾最好排名与各路覆盖。

它适合人名、产品名、编号、引文和特殊术语。“精确文本检索”不意味着只接受整句完全匹配：OR 路线保留了较宽召回。FTS 使用 `unicode61` 分词，不能把它宣传成具备中文专用分词能力。[SqliteLexicalRetriever](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/adapters/sqlite/lexical-retriever.ts#L40)。

### 4.3 `chronological`：把找到的来源按时间排好

它仍调用配置好的检索后端，但要求按来源时间排序。时间缺失或无效的记录放在最后；时间相同则使用 session、turn 和 ID 稳定打破平局。搜索的 `order` 还支持倒序。

它没有遍历全部知识并选择“最新正确事实”，也不理解正文里的事实编号。因此在同一个 parent 内有多个更新版本，或者所有 parent 使用相同入库时间时，仅切换 chronological 不能解决版本判断。[时间比较](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/model/source-time.ts#L52)。

### 4.4 `temporal-index`：用时间索引扩展候选

先普通检索，再从问题里的显式或相对日期构造辅助检索，随后查询版本化的日期事实辅助表。扩展优先考虑目标日期与原命中、目标日期与原 session 的交集，也保留相关 session 的时间记录。候选上限 60。

抽取依靠规则处理日期表达式、来源时间及部分相对日期，不调用模型。配合 `annotate(temporal)` 可生成带原文引用和提及日期的表，但表中的日期关联不等于模型已经确认了事件关系。[数据库扩展](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/adapters/sqlite/database-evidence-operators.ts#L166)、[时间注释](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/operators/temporal-operator.ts#L266)。

日期与数值共用 `EvidenceFactIndex`。第一次使用时按 scope 检查缺失记录，再以 `picorer-evidence-facts-v2` 抽取版本增量建表，正文哈希不一致则报错。辅助表记录抽取位置与版本，重建这些表不需要修改原文；首次查询可能承担建表开销，不能把它全算成模型延迟。[辅助索引](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/adapters/sqlite/evidence-fact-index.ts#L23)。

### 4.5 `numeric-index`：把有用的数字找出来

先普通检索，再利用数值事实辅助表扩展同一来源、同一 session 或数字附近含 query 信息词的记录，最多保留 80 个候选。数字保留正文中的起止位置与事实索引。

`annotate(numeric)` 进一步输出数值、单位、原句、来源，并用附近措辞区分目标、累计值、当前快照和增量。实现主要覆盖有限的英文计数单位与货币表达式；输出最多 40 行，并可提供按时间得到的最新累计值或快照提示。它**没有通用求和或实体消歧算法**，提示也不能直接当成“当前问题的总数”：不同主体和单位仍需核对。[数值扩展](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/adapters/sqlite/database-evidence-operators.ts#L291)、[抽取与注释](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/operators/numeric-operator.ts#L132)。

## 5. 算子怎样组合

### 5.1 一次 search 可以表达多个检索路径

下面是一个普通项目记录查询，不依赖任何评测题规则：

```json
{
  "operator": "hybrid",
  "queries": ["Orion release date change"],
  "branches": [
    {"operator": "lexical", "queries": ["Orion launch postponed"]}
  ],
  "combine": "rrf",
  "maxPerSession": 3,
  "limit": 12
}
```

程序把主路径与 branches 编译成临时声明式计划，再融合、排序或分散 session。主路径之外最多 3 个 branches；每路 queries 最多 16 条。Agent 的 `limit` 是可见页大小，上限 20；下层检索 use case 允许 1 至 100，二者不能混为一个额度。

一次成功的 search 占一个 search 调用名额，但里面可以发生多路检索与多次 embedding 请求。因此“搜索最多 8 次”不是“最多 8 个物理请求”。`search_more` 只展示最近一次搜索的下一页，不重新 embedding、不重新检索。[search schema](https://github.com/fendss/picorer/blob/v1.0.0/src/evidence-agent/adapters/pi/tools/schemas.ts#L40)、[临时计划](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/use-cases/search.ts#L98)。

### 5.2 声明式步骤各自的含义

| 步骤 | 实现行为 | 使用边界 |
|---|---|---|
| `search` | 调用一个已有算子，生成候选集 | 可以给固定 queries；省略时继承本次输入 |
| `combine: union` | 各路按名次轮流取，合并重复来源 | 适合增加覆盖 |
| `combine: rrf` | 按各路名次投票，不要求原始分数可比 | 默认的多路融合 |
| `combine: intersection` | 只留下每一路都命中的相同候选身份 | 是候选 ID 交集，不是语义关系联结 |
| `sort` | 按相关分数、正序时间或倒序时间排序 | 只重排已有候选 |
| `diversify` | 按 session 轮流选，限制每组数量 | 不保证不同 session 就是独立事实 |
| `dedupe` | 正文经 Unicode、大小写、空白规范化后去重 | 不做语义去重；不会合并相近但不同的表述 |
| `limit` | 保留前若干条 | 是有损截断，顺序影响结果 |
| `annotate` | 加时间或数值的结构化注释 | 不改变原文，不自动读取或提交证据 |
| `filter` | 内部计划可按角色过滤 | Agent 当前公开 schema 不提供角色过滤 |

融合遇到同一来源会保留多条 query 路径、命中坐标与索引事实，内容哈希冲突则报错。单路变换若删掉注释来源，也会删掉相关注释；覆盖缩小时不继续暴露依赖完整集合的派生值。`combine` 不直接拼接此前的注释表，需要时应在融合后重新 annotate。[集合操作](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/use-cases/candidate-set.ts#L17)、[来源合并](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/model/hit-provenance.ts#L10)。

### 5.3 define_operator 是有边界的计划复用

`define_operator` 给本次运行注册一个具名计划，成功后再用 `search.operator` 调用。它不执行生成的 JavaScript、不读取原文、不创建 evidence。工具只允许引用初始目录中的算子，阻止层层嵌套模型临时定义；运行结束后不会自动成为全局算子。

计划最多 12 步，其中 search 最多 4 步，每个 combine 最多 4 个输入；引用必须指向之前的步骤，禁止重复 ID、自调用、未知算子与不参与最终输出的闲置步骤。每次定义记录 hash、catalog revision 与快照。注册表的 `forkForRun()` 默认允许定义 2 个，但实际入口可以覆盖或关闭，不能仅凭类默认值判断某轮是否开放。[工具边界](https://github.com/fendss/picorer/blob/v1.0.0/src/evidence-agent/adapters/pi/tools/define-operator-tool.ts#L10)、[计划校验](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/use-cases/operator-definition.ts#L50)。

执行器按步骤逐个 `await`，**当前没有把独立 branches 自动并行调度**。单个 hybrid 内部会并行等待多 query 和检索路线，但不能据此宣称整个组合计划并行。组合主要减少 Agent 往返、统一结果加工与审计；是否更快仍取决于实际路径成本。

它也不能把第一步找到的新实体自动插入第二步 query。声明式 search 的 queries 来自输入或固定定义；需要理解原文再决定下一跳时，仍由 Agent 读取后发起下一次动作。[执行器](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/use-cases/compose-operator.ts#L41)。

## 6. 命中后怎么定位原文

Agent search 的内部候选池为 80，通常每页最多显示 20；hybrid 和词法检索更内层的单 query 发现池为 100。固定内部池是为了让翻页展示同一次检索的结果，而不是用更大 limit 重跑后改变排名。[工具入口](https://github.com/fendss/picorer/blob/v1.0.0/src/evidence-agent/adapters/pi/tools/search-tool.ts#L169)。

v1.0.0 的 `full` 使用 parent 候选与围绕 query 的预览；`compact` 在存在局部线索时才投影成 passage。这一点是两种界面的实际差异，不只是 JSON 显示长短不同。[模式绑定](https://github.com/fendss/picorer/blob/v1.0.0/src/evidence-agent/adapters/pi/tools/search-tool.ts#L241)。

parent 预览默认最多 360 字符：先找 query 词聚集的位置，尽量覆盖整句；没有局部词法命中时使用正文开头和末尾。`sourcePreviewSpans()` 将已显示的逐字片段映射回原文，并最多向附近句界延伸 256 字符。无法匹配的摘要不会凭空得到原文坐标。同一句重复出现时，旧式预览只能确定性地找到一个出现位置，不能声称恢复了检索器最初命中的位置。[预览](https://github.com/fendss/picorer/blob/v1.0.0/src/util.ts#L138)、[坐标恢复](https://github.com/fendss/picorer/blob/v1.0.0/src/evidence-agent/model/source-preview-spans.ts#L54)。

passage 则直接从原文切片：目标 1200、最大 1600 个 UTF-16 代码单元，短尾句可重叠，重叠最多 240。位置不是 tokens，也不是 UTF-8 字节。其 ID 由版本、parent ID、内容哈希和起止位置共同生成；程序检查切片内容与 parent 是否一致。

定位优先级是已有命中坐标、原文引文、query 词匹配。每个 parent 最多提供两个 passage，优先让更多不同 parent 进入候选；纯语义命中而没有局部信号时继续保留 parent，避免默认选第一段造成虚假的精确性。这是一个确定性定位启发式，不能保证每次选到完整关系事实。[passage 实现](https://github.com/fendss/picorer/blob/v1.0.0/src/retrieval/model/passage.ts#L93)。

底层 `MemoryStore.read()` 按 scope 和 ID 取原文，可以带同 session 的前后 turns；存储函数默认前后均为 0，上限各 10，Agent 工具可能传入不同默认值。未知 ID 会报错。它返回 `MemoryRecord`，不会自行生成摘要或回答；后续展示裁剪、已读记录及 parent 交付由证据 Harness 负责。[存储 read](https://github.com/fendss/picorer/blob/v1.0.0/src/platform/sqlite/picorer-store.ts#L543)。

## 7. composition：把模块接起来，不往主循环塞业务规则

`src/composition` 是装配层，它选择依赖并管理生命周期。

| 文件 | 责任 |
|---|---|
| `ingest-memory-workspace.ts` | 打开 SQLite、入库与导出、按 profile 建向量，必要时发布 Qdrant；默认 embedding 槽位 1、速率 6 次每秒 |
| `create-retrieval-context.ts` | 选择 FTS、SQLite 精确混合或 Qdrant 混合，并返回 store、元数据和算子目录 |
| `create-search-operator-registry.ts` | 建立并冻结算子目录，也支持显式挑选基础算子 |
| `qdrant-retrieval.ts` | 解析环境参数、建立客户端、发布 generation |
| `scoped-qdrant-retrieval.ts` | 由 scope 和内容指纹生成独立 generation，合并同进程重复发布请求；发布期间 scope 变化就报错 |
| `load-search-operator-plugins.ts` | 加载受信任的本地插件模块并记录文件 hash；这是开发者扩展，不是模型随意加载代码 |
| `create-read-only-navigation.ts` | 为当前 scope 装配只读语料导航 |
| `run-question.ts` | 打开 store、加载模型、装配检索与导航、执行 Agent，最后关闭 store |

这让“换向量库”和“改检索策略”分别发生在后端适配器与算子层。开发新算子时应返回标准 hits、保留来源身份并进入统一校验；不应让算子直接写最终回答，或把 benchmark 金标准接入检索逻辑。[composition 源码目录](https://github.com/fendss/picorer/tree/v1.0.0/src/composition)。

## 8. 工程保证到哪里，研究问题从哪里开始

已有测试明确覆盖幂等入库、拒绝原文修改、scope 隔离、融合时保留来源、passage 坐标校验、查询分页稳定性、过滤下推边界、日期比较及预览句界恢复。这些约束让错误更容易被发现，不构成“系统没有 bug”的承诺。本文核对了测试与实现，未在编写期间重新执行模型实验。[存储测试](https://github.com/fendss/picorer/blob/v1.0.0/test/ingest-store.test.ts)、[算子回归](https://github.com/fendss/picorer/blob/v1.0.0/test/retrieval-operator-regressions.test.ts)、[passage 测试](https://github.com/fendss/picorer/blob/v1.0.0/test/passage-retrieval.test.ts)。

排查错题时，至少保留五个可分别核对的问题：原文是否入库；目标 parent 是否命中；必要原句是否显示；Agent 是否读取；读取的 parent 是否交付。只有前一项成立，才有必要把后一项失败归因给 Agent。程序可以保证某段原文没有换来源、某个已读 parent 没有在交付中被静默丢弃；它不能仅凭候选数量、排序分数或 `sufficient` 字样证明证据链闭合。
