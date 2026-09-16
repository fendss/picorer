# Picorer sufficiency 实验：数据位置、运行流程与文件组织

本文只记录已经存在的实验资产和执行方式，不讨论应当采用什么科研结论、指标或图表。

核验时间：2026-09-15。服务器目录通过 `ssh zgy-direct` 在 236 服务器上只读核验；本地工作区为：

```text
/Users/johnnychiu/Documents/memory harness from the first principle
```

## 1. 数据链路总览

```text
三轮 Picorer 自然检索
    ├── 原始 retrieval 请求与响应 captures/
    ├── 每次真实决策请求冻结为 decision state
    ├── 每个 state × 两个 Qwen 推理副本：native S 与 explicit J
    ├── 从成功 read 恢复 retained evidence package，并计算 R
    └── 每条自然轨迹的最终 answer/evaluation
             │
             ▼
2026-09-14 受控实验输入构造
    ├── coverage：枚举全部 gold-evidence 子集
    ├── preview：original / removed / irrelevant / relevant
    └── state_answers：每个自然 state 的 exact package 重复回答五次
             │
             ▼
34,126 个独立推理 job
    ├── 服务器原始输入、HTTP 响应与 result.json
    └── 本地汇总表 units.csv / answers.csv
```

两个服务 `qwen-r1` 和 `qwen-r2` 是同一个 Qwen3.6-27B backbone 的两个推理副本，不是两个不同模型。

## 2. 服务器上的正式原始数据

### 2.1 三轮自然轨迹

| 轮次 | 服务器根目录 | 题目 | 决策状态 | state-replica 行 | 核验体积 |
|---|---|---:|---:|---:|---:|
| run 1 | `/data/zhaogangyi/picorer-eval/qwen36-v100-sufficiency-dynamics-20260912` | 100 | 694 | 1,388 | 28 GB |
| run 2 | `/data/zhaogangyi/picorer-eval/qwen36-v100-sufficiency-dynamics-replicate-2-20260912` | 100 | 718 | 1,436 | 29 GB |
| run 3 | `/data/zhaogangyi/picorer-eval/qwen36-v100-sufficiency-dynamics-replicate-3-20260912` | 100 | 738 | 1,476 | 29 GB |

合计是 300 条自然轨迹、2,150 个决策状态、4,300 条 state-replica 测量。

每个自然轨迹根目录的主要结构为：

```text
<natural-root>/
├── experiment.json                 # 数据集、baseline、代码身份、端口和 manifest 哈希
├── config.yaml                     # 本轮 Picorer / question pipeline 配置
├── manifest-canary.json
├── manifest-main.json
├── manifest-full.json              # 100 道题的正式 manifest
├── state-*.sqlite                   # question pipeline 各阶段状态
├── captures/
│   └── <request-id>/
│       ├── meta.json               # 时间、状态码、request/response SHA-256
│       ├── request.body            # 原始 retrieval-model HTTP 请求
│       └── response.body           # 原始 HTTP 响应
├── decision-states-v2/
│   ├── index.jsonl                 # 每个真实 retrieval 决策状态
│   └── validation.json
├── probes-v2/
│   └── <question-hash>/step-<NNN>/<qwen-r1|qwen-r2>/
│       ├── input-state.json
│       ├── native-*.render.request.json / response.json
│       ├── native-s.request.json / response.json
│       ├── explicit-*.render.request.json / response.json
│       ├── explicit-j.request.json / response.json
│       └── result.json
├── artifacts-main/<question>/retrieval.json
├── artifacts-scoring/<question>/
│   ├── answer.json                 # 自然轨迹最终回答
│   └── evaluation.json             # 自然轨迹最终评分
├── runtime/memory-service/
│   ├── memory.sqlite               # memory 原文
│   └── wrap-audits.jsonl           # retrieval trace 与 evidence handoff
├── coverage-v1/
│   ├── states.jsonl / states.csv
│   ├── state-replica.jsonl / state-replica.csv
│   ├── hops.jsonl / hops.csv
│   └── summary.json
├── measurement-v2-summary.json
├── measurement-v2-audit.json       # run 2/3 明确保留
└── replicate-final.json            # run 2/3 的 measurement/scoring 完成标记
```

服务器保存完整请求、响应、渲染结果、token 分支测量和 pipeline artifact。本地没有完整复制这约 86 GB 的自然轨迹原始目录。

### 2.2 受控干预与逐状态回答

正式根目录：

```text
/data/zhaogangyi/picorer-eval/sufficiency-interventions-20260914-v2
```

核验体积约 12 GB。初始 pilot 位于不带 `-v2` 的目录，其中工具 schema 字段顺序被改变；该目录不属于正式数据，不能与 `-v2` 合并。

正式目录结构：

```text
sufficiency-interventions-20260914-v2/
├── code/                            # 本次运行使用的冻结代码
├── PROTOCOL.zh-CN.md
├── manifest.json                    # 单位数、job 数、副本和采样数
├── input-audit.json
├── units.json                       # 10,018 个逻辑实验单位
├── jobs.json                        # 34,126 个推理 job
├── gold-spec.json
├── blobs/<sha256>.json              # content-addressed 的输入
├── results/<job-id>/
│   ├── job.json
│   ├── completion.request.json / completion.response.json
│   ├── answer.request.json / answer.response.json
│   ├── fallback.request.json / fallback.response.json  # 仅 fallback 时
│   └── result.json
├── errors/
├── retry-history/                   # 原参数补跑前归档的未完成尝试
├── run-history/
├── scheduler-switches/
├── concurrency-changes/
├── summary/
│   ├── units.csv
│   ├── answers.csv
│   ├── status.json
│   └── missing-jobs.json
├── analysis/
├── output-audit.json
└── suite-complete.json
```

服务器实查：`results/` 下有 34,126 个 job 目录；`summary/status.json` 显示 34,126/34,126 完成、0 缺失、28 个逻辑 job 曾补跑、44 次未完成尝试被归档。

## 3. 本地已经同步的数据

### 3.1 自然轨迹的结构化副本

本地根目录：

[sufficiency-dynamics-20260912](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912>)

该目录约 325 MB。三轮正式 coverage 表位于：

```text
experiments/sufficiency-dynamics-20260912/coverage/
├── gold-spec.json
├── run1/
│   ├── states.csv / states.jsonl
│   ├── state-replica.csv / state-replica.jsonl
│   ├── hops.csv / hops.jsonl
│   └── summary.json
├── run2/
│   └── 同上
└── complete-run/                    # 对应服务器 replicate-3
    └── 同上
```

`complete-run` 只是本地目录名，不表示把三轮拼成一轮；它对应服务器上的第三轮独立轨迹。

主要输入 SHA-256：

```text
run1/states.jsonl          d84fbfb0c37b0c7684940daf9034bea3f0f61be784175b56e3080752fbc32945
run2/states.jsonl          252e2bf9c05fea76073dc6a8f5d35460c6d019fb1373233e9e580a0aeb087f58
complete-run/states.jsonl  db9b8e5e02cbd3bf14fab7468c89294c57a689a61fac6a9bc3c0455a982881c3
gold-spec.json             bf10ad3152fdb08aba95ed9c7d0567910bc726cdfed186a1dbd595e52e22032f
```

### 3.2 受控实验的本地汇总

本地根目录：

[sufficiency-interventions-20260914](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914>)

该目录约 51 MB。重新统计时主要读取：

- [summary/units.csv](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/summary/units.csv>)：10,018 行，每行一个逻辑实验单位。
- [summary/answers.csv](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/summary/answers.csv>)：18,390 行，每行一次独立回答生成。

SHA-256：

```text
units.csv    62a53a5b7ba5c3f11695d2a87ad9ffa002153eb6bad1e013c3ee6802dafda91
answers.csv  c6f4268bbde36f22e10f6e3311a42f47a8725f45f45883c26e343db9c580c9be
```

本地没有同步服务器的全部 `blobs/` 和 34,126 个 `results/<job-id>/`。检查精确 HTTP 请求或响应时，应读取服务器正式根目录。

### 3.3 后续离线分析产物

本地派生分析位于：

[evidence-sufficiency-dynamics-20260915](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/evidence-sufficiency-dynamics-20260915>)

该目录约 5.5 MB。这里的 CSV、图和报告都由上述本地结构化数据派生，不是新的模型原始响应。目录中的 `summary.json` 记录输入路径与哈希；`validation.json` 记录完整性检查。

## 4. 三轮自然轨迹是怎么生成的

### 4.1 Retrieval acquisition

数据集为 Fact-MH 262K 的 100 道题。三轮共同使用：

```text
model: Qwen3.6-27B
Picorer source identity: release:picorer-v1.0.0
baseline config: /data/zhaogangyi/picorer-eval/qwen36-v100-full-redial-factmh-20260911/config.yaml
baseline manifest: /data/zhaogangyi/picorer-eval/qwen36-v100-full-redial-factmh-20260911/manifest.json
```

[prepare_experiment.py](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/prepare_experiment.py>) 从 baseline 中抽出 100 道 Fact-MH 题，生成 retrieval-only 的 `config.yaml`、`manifest-canary.json`、`manifest-main.json` 和 `manifest-full.json`。原自然 acquisition transport 没有显式加入 temperature、top_p 或 seed，保持 Picorer v1.0.0 baseline transport。

真实 retrieval-model 请求通过 [capture_proxy.py](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/capture_proxy.py>) 原样转发；代理保存 request/response body，不保存 inbound authorization header。每一次真实 retrieval 请求后来成为一个 decision state。

三轮 capture endpoint：

| 轮次 | capture proxy | generation upstream |
|---|---|---|
| run 1 | `https://127.0.0.1:18193` | `https://127.0.0.1:18192/v1` |
| run 2 | `https://127.0.0.1:18201` | `https://127.0.0.1:18194/v1` |
| run 3 | `https://127.0.0.1:18202` | `https://127.0.0.1:18194/v1` |

每个根目录的 `experiment.json` 保存这一步的 baseline/config/manifest SHA-256。自然 acquisition 的实际 question-pipeline 状态和日志保存在各根目录的 `state-*.sqlite` 与 `logs/`。

这里需要区分“材料完整”和“一键命令完整”：三轮 acquisition 所用的生成配置、manifest、capture 请求/响应、pipeline 状态、日志和代码身份都已保留，但本地同步目录中没有一个脚本记录从启动 memory service、capture proxy 到提交 question-pipeline 的整条历史命令。因而可以从这些资产逐步还原运行环境，不能声称存在一条已经核验过的 acquisition 一键复现命令。S/J 测量、回答评分和 coverage 计算的执行脚本则完整保留。

### 4.2 每个 decision state 的 S 与 J

[run_measurements_v2.py](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/run_measurements_v2.py>) 扫描 `captures/` 和 retrieval artifact，建立 `decision-states-v2/index.jsonl`，然后对每个 state 调用两个 Qwen 推理副本：

```text
qwen-r1 = http://172.16.200.114:18081  # gpu08, GPU 7
qwen-r2 = http://172.16.200.114:18082  # gpu08, GPU 4
```

Native S 使用原 `finish` 协议，限制生成 token 为合法的 `sufficient` 和 `insufficient` 分支，保存分支 logprob、margin 和二状态归一化 likelihood。

Explicit J 在同一 state 上加入固定判断提示：

```text
Judge whether the evidence currently available in the conversation is sufficient
to answer the original user question correctly. Respond with exactly one label:
sufficient or insufficient.
```

最终结构化数据中，每个 state、每个副本有 101 次 J label。三轮合计 434,300 个 explicit labels。run 1 的 `experiment.json` 仍保留早期 `j_target_samples_per_state=63`，但最终的 `measurement-v2-summary.json`、`coverage-v1/state-replica.*` 和逐行 `j_sample_count` 均为 101；读取最终数据时应以这些最终产物为准。

run 2/3 的 measurement + answer/evaluation orchestration 由 [finish_replicate.sh](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/finish_replicate.sh>) 完成。它在 100 个 retrieval 全部完成后：

1. 启动每状态、每副本的 S/J 测量；
2. 复用冻结的 retrieval artifact；
3. 启动 answer capture proxy；
4. 运行 answer 和 evaluation；
5. 写入 `replicate-final.json`。

脚本接口：

```bash
finish_replicate.sh EXPERIMENT_ROOT ACQUISITION_STATE ANSWER_CAPTURE_PORT RUN_TAG
```

脚本内固定使用 `--workers 6 --samples 101` 测量 S/J；scoring 使用 answer concurrency 4、evaluation concurrency 8。

### 4.3 状态 coverage

[prepare_gold_coverage_spec.py](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/prepare_gold_coverage_spec.py>) 从 benchmark parquet、MQuAKE-CF 和 dataset audit 生成 `gold-spec.json`。100 道题合计 267 条 gold hops。

[compute_state_coverage.py](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/compute_state_coverage.py>) 从以下来源恢复状态证据：

- `decision-states-v2/index.jsonl`；
- `runtime/memory-service/wrap-audits.jsonl`；
- `runtime/memory-service/memory.sqlite`；
- 原始 memory 内容、UTF-16 excerpt 范围和内容哈希。

原始 `R` 是当前 state 之前成功 `read` 后，实际 retained package 中可见的 official MQuAKE gold-hop statement 比例；search preview 不计入 R。

时间对齐语义：

```text
states.csv 的第 t 行描述执行该行 action 之前的冻结 context。
如果第 t 行 action 是 read，该次 read 得到的证据从第 t+1 个 decision state 才进入 R。
```

### 4.4 自然轨迹最终回答

`artifacts-scoring/<question>/answer.json` 和 `evaluation.json` 是一条自然轨迹最终提交后的答案与评分。它们每轮每题各一个，共 300 个自然轨迹最终答案。

这与 2026-09-14 后来进行的“每个中间状态五次回答”不是同一套测量，不能混用。

## 5. 受控实验是怎么生成和运行的

### 5.1 输入准备

[prepare.py](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/prepare.py>) 读取三轮自然轨迹服务器根目录，并生成三类 logical units：

| experiment | 单位数 | native / 单位 | answer / 单位 | 内容 |
|---|---:|---:|---:|---|
| `coverage` | 1,528 | 2 | 5 | 全部 gold-evidence 子集，正序和逆序 |
| `preview` | 6,340 | 2 | 0 | preview original/removed/irrelevant/relevant |
| `state_answers` | 2,150 | 复用自然 state 的两个 native 值 | 5 | 每个自然 state 的 exact retained package |
| 合计 | 10,018 | — | — | — |

Coverage 单位展开：

```text
57 道 2-hop：57 × 2 orders × 2^2 masks = 456
19 道 3-hop：19 × 2 orders × 2^3 masks = 304
24 道 4-hop：24 × 2 orders × 2^4 masks = 768
总计                                             1,528
```

每个 mask 的每个槽位始终有一条事实。bit 为 1 时放该 hop 的 official fact；bit 为 0 时放实际知识池中近似词数匹配、且不包含题目实体和答案的 unrelated fact。`order=0` 为 forward，`order=1` 为 reverse。

Preview 单位：

```text
original    1,756
removed     1,756
irrelevant  1,756
relevant    1,072
```

`relevant` 只在缺失 gold fact 且该 fact/answer 没有在 preview 之外出现时构造；排除原因保存在 `input-audit.json`。

State-answer 单位恢复 action 发生前的 ledger，只使用当时的 exact package，禁用原最终 wrapper 可能执行的 full-parent expansion。

### 5.2 Job 展开

`units.json` 是逻辑条件；`jobs.json` 将其展开成实际请求：

```text
coverage:      1,528 × 2 native + 1,528 × 5 answers = 10,696 jobs
preview:       6,340 × 2 native                       = 12,680 jobs
state_answers: 2,150 × 5 answers                      = 10,750 jobs
总计                                                   34,126 jobs
```

按类型：

```text
native jobs  15,736
answer jobs  18,390
```

`state_answers` 没有重复运行 native S；其两个 native 值来自自然 state 的 `native_original`。所以 `manifest.json` 的 native job 数不是 `10,018 × 2`。

### 5.3 推理参数

[run.py](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/run.py>) 只连接两个既有副本：

```text
GPU 7 / port 18081
GPU 4 / port 18082
model name: qwen3.6-27b
dtype: bfloat16
max model length: 262,144
```

Native job：

```text
max_tokens = 1
temperature = 1.0
top_p = 1.0
seed = 20260914
allowed tokens = sufficient / insufficient branch tokens
```

Answer job：

```text
reasoning_effort = low
max_completion_tokens = 16,384
temperature = 0.7
top_p = 0.8
每个 unit 使用 5 个由 unit ID 和 sample 编号确定的 seed
```

回答为空时，runner 在相同 evidence 和 seed 上执行记录过的 no-thinking fallback；仍为空或发生长度截断时任务失败并进入原参数补跑。不会因为答案错误而重试。

评分调用 benchmark 原有 `score_prediction(task_config('fact-mh-262k'), ...)`。`official_score` 对应原 pipeline 的 substring exact-match 主分数；另存 strict `exact_match` 和 `f1`。

### 5.4 调度与完成

[supervise.py](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/supervise.py>) 的执行顺序：

1. 前 10 题 pilot；
2. pilot output audit；
3. 全量推理；
4. output audit；
5. `collect.py` 汇总；
6. `analyze.py` 统计和绘图；
7. `verify_figures.py` 检查导出；
8. 写 `suite-complete.json`。

历史并发为：初始总并发 64，后来改为 80，最后按用户指定降为 68，即每个副本最多 34 个在途任务。只改变客户端调度，没有改变 frozen units、job seed、模型或 endpoint。

服务器端入口：

```bash
INTERVENTION_ROOT=/data/zhaogangyi/picorer-eval/sufficiency-interventions-20260914-v2
PIPELINE_PY=/data/zhaogangyi/picorer-eval/queue-infra/question-pipeline-v2/.venv/bin/python

"$PIPELINE_PY" "$INTERVENTION_ROOT/code/supervise.py" \
  --root "$INTERVENTION_ROOT" \
  --workers 68 \
  --detach
```

现有正式根目录已经完成。若从头生成输入，`prepare.py` 会拒绝覆盖已有 `manifest.json`，所以必须使用新的明确根目录，不能指向正式结果目录。

## 6. 本地汇总表的组织方式

### 6.1 `summary/units.csv`

10,018 行，每行一个 logical unit，不是一个 HTTP job，也不是一次 answer sample。

共同字段：

| 字段 | 含义 |
|---|---|
| `id` | unit 主键 |
| `experiment` | `coverage`、`preview` 或 `state_answers` |
| `question_id`, `ordinal` | 题目标识与 0-based 题号 |
| `gold_hops` | official chain 的 hop 数 |
| `conflicted` | 是否属于 36 道已知 official-gold/LWW 冲突题 |
| `complete` | 该 unit 所需输出是否收齐 |

Native 字段：

| 字段 | 含义 |
|---|---|
| `native_n` | native 副本数；正式表全部为 2 |
| `margin` | 两副本 margin 先平均后的值 |
| `likelihood` | 对平均 margin 做二状态 logistic 归一化 |
| `replica_margin_difference` | 副本 2 margin 减副本 1 margin |
| `input_tokens` | 两副本 native prompt token 数的平均 |

Answer 字段：

| 字段 | 含义 |
|---|---|
| `answer_n` | coverage/state_answers 为 5，preview 为 0 |
| `official_score` | 五次 `official_score` 的平均 |
| `exact_match`, `f1` | 五次相应指标的平均 |
| `fallback_n` | 五次回答中触发 fallback 的次数 |

自然 state 字段：

| 字段 | 含义 |
|---|---|
| `run` | 1、2、3 |
| `step` | 本轨迹内 1-based decision step |
| `trajectory_length` | 本轨迹的 state 总数 |
| `r` | 当前 exact package 的 gold-hop coverage |
| `native_original_prefixes` | 服务器自然 native request 的两个路径 |
| `original_request_sha256` | 原始 state request 哈希 |

Coverage 字段：

| 字段 | 含义 |
|---|---|
| `mask` | gold subset bitmask |
| `order` | 0=forward，1=reverse |
| `r` | mask 中 gold hop 的比例 |

Preview 字段：

| 字段 | 含义 |
|---|---|
| `parent_state` | 对应的 `state_answers.id` |
| `condition` | original/removed/irrelevant/relevant |
| `introduced_hops` | relevant 条件加入的 hop index |
| `preview_slots` | 被操作的 preview body 数量 |

### 6.2 `summary/answers.csv`

18,390 行，每行一条实际 answer generation：

```text
unit, experiment, question_id,
sample, replica, seed,
prediction,
exact_match, f1, official_score, substring_exact_match,
fallback, prompt_tokens, completion_tokens
```

连接关系：

```text
answers.csv.unit == units.csv.id
```

查看五次回答的原文或离散分数时使用 `answers.csv`；查看一个状态/条件的五次平均时使用 `units.csv`。

### 6.3 自然 coverage 表

`coverage/<run>/states.csv` 每行是一个自然 decision state，字段包括：

- 身份与时间：`question_id`, `question_ordinal`, `decision_step`, `decision_state_count`, `normalized_progress`, `capture_id`；
- action：`action_tool_names`, `terminal_trajectory_status`；
- coverage：`gold_hop_count`, `covered_hop_count`, `gold_coverage_r`, `covered_hop_indices`, `missing_hop_indices`, `newly_available_hop_indices`；
- retained package：`cumulative_read_memory_count`, `cumulative_read_memory_ids`；
- 数据集与最终结果：`official_gold_lww_conflicted`, `final_official_score`, `final_correct`。

`final_official_score` 和 `final_correct` 是自然轨迹最终答案结果，为连接方便而重复写在该轨迹的每个 state 上；它们不是中间状态回答结果。

`state-replica.csv` 在上述 state 字段后增加：

```text
replica,
j_sample_count, j_sufficient_count, j_insufficient_count, j_sufficient_fraction,
native_sufficient_likelihood,
native_sufficient_logprob, native_insufficient_logprob,
native_logit_margin, native_margin_decision
```

`hops.csv` 每行是一个问题的一条 gold hop，记录：

```text
gold_statement, gold_raw_fact, gold_serial_number,
acquired_by_read,
first_read_action_state,
first_available_decision_state,
matching_read_memory_ids
```

## 7. ID 与表连接规则

### 7.1 Unit ID

```text
state-r<run>-q<ordinal>-t<step>
coverage-q<ordinal>-o<order>-m<mask>
state-r<run>-q<ordinal>-t<step>-preview-<condition>
```

### 7.2 Job ID

```text
<unit-id>-s0 / <unit-id>-s1   # 两个 native replicas
<unit-id>-a0 ... -a4          # 五个 answer samples
```

### 7.3 连接键

| 连接 | 键 |
|---|---|
| 三轮自然 state | `question_id + run + step` |
| state 与 replica | `question_id + decision_step`，再以 `replica` 区分 |
| answer sample 与 unit | `answers.unit = units.id` |
| preview 与原 state | `preview.parent_state = state_answers.id` |
| coverage 同题条件 | `question_id + order + mask` |
| hop acquisition 与 state | `question_id`，再用 `first_available_decision_state` 对齐 `decision_step` |

## 8. 容易混用的字段

1. `R` 是 official gold hops 的覆盖比例，不是 evidence package 条目数量。
2. state t 的 action 尚未作用到该行；该次 read 的证据从 state t+1 才进入 R。
3. `states.csv.final_official_score` 是自然轨迹最终答案；`units.csv` 中 `experiment=state_answers` 的 `official_score` 才是当前 state exact package 上五次回答的平均。
4. `terminal_trajectory_status` 是整条轨迹的终止状态，重复附在各 state 上，不是每个 state 的即时 finish 决策。
5. `native_sufficient_likelihood` 是 sufficient/insufficient 两个合法分支内的归一化值，不是模型在所有 action 中选择 `finish` 的概率。
6. `qwen-r1`/`qwen-r2` 是推理副本；`run=1/2/3` 才是三条独立 acquisition trajectory。
7. `preview` 没有 answer sample；其 `answer_n=0` 是设计结果，不是缺失。
8. `retry-history` 中未完成尝试不是额外样本；正式统计读取成功的 `results/<job-id>/result.json`。
9. 64 道 `conflicted=false` 和 36 道 `conflicted=true` 都保留在全量表中；筛选通过该字段完成。

## 9. 拉取与重建命令

### 9.1 从服务器刷新本地受控实验汇总

[fetch.py](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/fetch.py>)

```bash
python3 experiments/sufficiency-interventions-20260914/fetch.py
```

该脚本通过 `zgy-direct` 在服务器运行 `collect.py`，然后下载 `summary/`、`analysis/` 和完成/审计标记。它不会下载约 12 GB 的全部原始 job 目录。

### 9.2 在服务器重新汇总已有 job

```bash
INTERVENTION_ROOT=/data/zhaogangyi/picorer-eval/sufficiency-interventions-20260914-v2
PIPELINE_PY=/data/zhaogangyi/picorer-eval/queue-infra/question-pipeline-v2/.venv/bin/python

"$PIPELINE_PY" "$INTERVENTION_ROOT/code/collect.py" --root "$INTERVENTION_ROOT"
```

`collect.py` 不发模型请求；它读取已有 `result.json` 并重建 `summary/*.csv`。

### 9.3 当前本地派生分析

统一离线分析：

```bash
experiments/sufficiency-dynamics-20260912/.venv-figures/bin/python \
  experiments/evidence-sufficiency-dynamics-20260915/analyze.py
```

实验一独立派生目录：

```bash
experiments/sufficiency-dynamics-20260912/.venv-figures/bin/python \
  experiments/evidence-sufficiency-dynamics-20260915/experiment-1-evidence-sensitivity/analyze.py
```

这两个命令只读取本地 CSV/JSONL 并生成统计表和图，不访问模型服务。

## 10. 完成与审计标记

受控实验应同时检查：

- `manifest.json`：预期单位和 job 数；
- `summary/status.json`：实际完成与缺失数；
- `output-audit.json`：输入 blob、响应和 failure 审计；
- `suite-complete.json`：自动流程结束标记。

当前值：

```text
expected jobs       34,126
completed jobs      34,126
missing jobs             0
completed answers   18,390
native jobs         15,736
fallback answers     1,527
```

`suite-complete.json` 中 `manual_visual_review` 仍写为 `pending`；它不影响推理完成状态，但说明该历史标记没有记录最终人工图形验收。

三轮自然数据应检查各自的：

- `measurement-v2-summary.json`；
- `measurement-v2-audit.json` 或最终 `coverage-v1/state-replica.*`；
- `coverage-v1/summary.json`；
- run 2/3 的 `replicate-final.json`。

这些路径共同构成当前 sufficiency 实验的原始数据、结构化数据和派生结果链路。
