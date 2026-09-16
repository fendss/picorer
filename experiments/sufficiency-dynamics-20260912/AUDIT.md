# Picorer v1.0.0 Sufficiency Dynamics：首轮审计

审计日期：2026-09-12

服务器实验目录：

`/data/zhaogangyi/picorer-eval/qwen36-v100-sufficiency-dynamics-20260912`

## 结论

首轮 acquisition 轨迹和 694 个 agent decision states 可以保留。文件完整性、请求与响应哈希、轨迹对齐和测量数量均通过检查。

首轮 `J` 不能作为对 `S` 的独立行为验证。实现中，`S` 是 native `finish.status` 两个分支 token 的归一化概率；`J` 又从同一 prompt prefix、同一对 token logits 中约束采样 63 次。因此：

\[
J_i \sim \operatorname{Binomial}(63, S_i) / 63.
\]

当前的高 agreement/correlation 证明采样与 logprob 读取相互一致，但不能证明 native likelihood 能预测一个独立的显式 sufficiency judgment。

在重新定义并运行独立的显式 `J` 之前，不应把首轮数值作为论文主结果。

## 已核对的数据

- 100 道 Fact-MH 262K 问题，manifest ordinal 完整覆盖 `0..99`。
- 100 份 retrieval artifacts 和 100 份 Picorer wrap audits。
- 694 份真实 `/v1/chat/completions` acquisition captures。
- 694 个 agent decision states；全部状态均已 probe。
- 每个状态 63 个 `J` 选择，共 43,722 个单-token choice。
- probe 阶段墙钟时间 2,593.04 秒，即 43.2 分钟。
- 0 个测量失败；所有 capture request/response SHA-256 均重新计算通过。
- 运行使用 Picorer v1.0.0、`full` interface、`picorer-v0` skill 和 `qwen3.6-27b`。

## 首轮数值为何过高

- binary agreement：0.9870
- Pearson：0.9963
- Spearman：0.9832
- mean absolute error：0.0236
- 标准化二项残差均值：0.0108
- 标准化二项残差标准差：1.0041

残差几乎正好服从由 `Binomial(63, S)` 预期的尺度，这与当前实现的构造一致。

## 需要修正的实验定义

### 1. `J` 必须成为独立显式判断

从每个冻结的 agent context 离线分叉，加入固定的 sufficiency judgment prompt，只允许输出 `sufficient` 或 `insufficient`，独立采样并保存每一个原始选择。该 prompt 不进入原 acquisition 轨迹。

### 2. 明确 `S` 的条件事件

当前 `S` 实际测量的是：在 canonical native `finish` prefix 已给定之后，`status` 为 `sufficient` 而不是 `insufficient` 的条件概率。它不是 agent 在 `search`、`read`、`finish` 等所有动作中主动选择 `finish` 的概率。论文需按此定义，或另行设计 action-level likelihood。

### 3. 补齐 evidence coverage

当前 probe 文件没有 `R_t`。100 道题的 manifest `keypoints` 全部为空，原始 Fact-MH 数据没有可直接使用的逐题 gold evidence set。Fact-MH 是模板化多跳冲突消解任务，可以从原始事实图与 serial-number 更新规则构造 reference evidence set，但必须先实现并抽样人工核验，之后才能称为 gold/reference-evidence coverage。

### 4. 区分 decision state 与 evidence acquisition event

694 个状态中包含：

- 100 个 `finish` 决策；
- 356 个 `search`、7 个 `search_more`、226 个 `read`；
- 1 个同轮 `read+search`；
- 1 个仅 `workingMemory`；
- 3 个无合法工具调用、随后由 harness 恢复的状态。

因此，`t/T` 当前是 model decision-turn 进度，不严格等于 evidence-changing acquisition-event 进度。主分析应明确采用哪一种，并对 3 个 recovery states 做纳入/排除敏感性检查。

### 5. 加强可审计性与副本控制

首轮结果只保存了 `J` 的计数，没有保存 63 个原始 token 序列，也没有保存原始 `S/J` HTTP responses。正式重跑需要全部保存。

两个 Qwen 服务副本报告相同模型路径和 vLLM 版本，但不是逐位一致。11 个分层状态的复测中，两个副本的 `S` 绝对差平均为 0.00377、最大为 0.02782；2/11 个状态的 `J` sufficient count 不同，最大相差 5/63。同一副本、同一 seed 的第二轮 10 次重复中，`J` 序列均完全一致。正式实验应在两个副本上成对测量，并把副本差异作为稳定性结果保留。

## 审计文件

- `audits/measurement-audit.json`：全量文件、哈希、数量、协议和数值检查。
- `audits/replay-audit.json`：11 个分层状态在两个上游副本上的重放。
- `audits/repeatability-audit.json`：同一中间状态、同 seed、每个副本 10 次重复。

## 冻结 handoff 的补充评分

在不重跑 retrieval/acquisition 的前提下，对 100 份冻结 evidence handoff 补跑了一次 `answer` 和确定性 `evaluation`。评分任务全部完成，无 stage failure、无 retry、无空 prediction。

- official score / substring exact match：0.48（48/100）
- exact match：0.47
- token F1：0.48045454545454547
- terminal status 为 `sufficient`：47/93 正确（0.5054）
- terminal status 为 `insufficient`：1/7 正确（0.1429）

完整导出保存在 `scoring/fact-mh-262k-static.json`，supervisor 完成记录保存在 `scoring/supervisor-final.json`。这是每道题单次 answer generation 的得分。
