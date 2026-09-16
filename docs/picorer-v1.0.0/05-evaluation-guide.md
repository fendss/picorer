# 05 · 使用指南：准备、启动、续跑与验收

这章的目标是让另一位工程师拿着文档，知道自己要准备哪些东西，启动后该看哪里，停机后哪些可以续，最后怎样得到没有漏题的结果。命令按本次审计的单题流水线编写；它是独立评测工程，不能在刚克隆的 Picorer v1.0.0 根目录直接执行。

以下操作用于说明新建实验的流程，命令中的实验目录应独立于已有运行。

## 1. 运行前需要四样东西

**可访问的 Picorer 服务。** 检查实际部署的源码、`full` 或 `compact` 交互模式、检索模型、搜索次数和证据预算。`source_identity` 只是一项运行时声明；不能代替源码哈希核查。使用 full 模式时，先启动并确认 full 服务，再让评测指向它。修改 eval YAML 不会把服务切换成 full。

**准备好的语料与数据清单。** MAB 需要数据文件、任务注册、已入库 context 与 user ID 的对应关系。Omni 需要 BEAM 或 LoCoMo 数据、服务版本与入库版本映射。本轮复用已有库；有 checkpoint 只能证明曾记录过入库，仍应核对服务实际挂载的数据库身份。

**独立评测工程与适配器。** 236 的现有流水线目录是：

```text
/data/zhaogangyi/picorer-eval/queue-infra/question-pipeline-v2
```

当前扩展过任务和评分协议的 MAB 适配器位于：

```text
/data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/adapter-candidate
```

这些是现有服务器路径，不是对外发布地址。迁移到另一台机器，需要完整搬运评测工程、对应 adapter 与 OmniMemEval 工程，再安装其依赖。流水线声明 Python 3.10 及以上；在独立目录中可使用 `python -m pip install -e .`。还要准备对应数据依赖，不能只安装流水线包就默认任务齐备。

**模型连接与 Redis。** 本地 Qwen 使用兼容 Chat Completions 的端点。Redis 默认地址为 `redis://127.0.0.1:6380/0`，可在 CLI 中覆盖。API key 从环境变量或受控配置读取，不写入可公开的 YAML、截图或报告。

服务部署与算子行为见前面的产品章节。本章只说明怎样调度这些服务完成实验。

## 2. 先把一次实验的目录定下来

建议一个实验一个目录、一个 state、一个 namespace。下面是推荐布局，其中 YAML 的绑定路径一经写入 manifest 就不要移动。

```text
experiment/
  mab-config.yaml            # 服务连接、数据和入库复用配置，可能含私密连接信息
  eval.yaml                  # 回答模型、回答 prompt、评分协议，无明文密钥
  manifest.json              # 固定的问题和配置绑定
  state.sqlite               # 权威状态账本
  artifacts/                 # 每题每阶段的 JSON
  logs/                      # worker、supervisor、空回答补发日志
  export/                    # 便于 benchmark 工具继续使用的汇总文件
  source-manifest.json       # 产品、adapter、pipeline 的源码身份与哈希
```

同名题目放在同一个 state 中，payload 发生变化会被拒绝。换模型、换接口、换输出额度属于新实验，应该使用新目录和新状态库。不要为绕过检查而手工改旧库的 payload。

## 3. 回答与评分用 eval YAML 配置

随文的 [eval.full.example.yaml](<./examples/eval.full.example.yaml>) 是一个最小可用样例，已通过服务器实际 `eval_config.validate()` 校验。它配置 Fact-MH 262K 和 ReDial 的回答与确定性评分，不调用付费裁判。`full` 是这份示例要搭配的服务模式，不是 YAML 内部的开关。

```yaml
schema_version: 1

models:
  local-qwen:
    id: qwen3.6-27b
    base_url_env: QWEN36_BASE_URL
    api_key_env: QWEN36_API_KEY
    thinking_level: low
    timeout_seconds: 600
    context_window: 131072
    context_safety_tokens: 4096

prompts:
  mab-answer:
    system: >-
      You are a helpful assistant that can read the context and memorize it
      for future retrieval.
    user: "${retrieval}"

datasets:
  agentmemorybench/fact-mh-262k:
    answer:
      model: local-qwen
      prompt: mab-answer
      max_tokens: 16384
    judge:
      method: native
      metric: substring_exact_match
  agentmemorybench/recsys-redial-full:
    answer:
      model: local-qwen
      prompt: mab-answer
      max_tokens: 16384
    judge:
      method: native
      metric: recsys_recall@5
```

`id` 必须是服务实际接受的模型名。样例中的上下文和 token 额度是一次实验的设置，不是 Qwen 架构上限的声明；需与部署端限制一致。

**样例展示 YAML 配置方法，不等同于正在运行的 300 题 full 复跑配置。** 后者未绑定 eval YAML，仍由原 MAB config 配置回答，其上下文安全余量为 24,576 tokens；样例设为 4,096。安全余量参与回答上下文预算计算，直接照抄样例可能改变最终送入模型的证据数量。严格复现既有结果时，应完整迁移实际参数，而不只对齐模型名与输出额度。

`models` 定义模型连接与请求设置，`prompts` 定义可复用模板，`datasets` 选择各数据集使用哪一套回答和裁判。模板用 Python `string.Template` 语法，即 `${name}`，不是 Jinja。MAB 回答可用 `${retrieval}`；BEAM、LoCoMo 回答可用 `${context}` 和 `${question}`。裁判占位符由对应实现约定，不能随意加一个变量名就期待自动获得内容。

需要完整裁判协议时，从已审计的流水线 `config/eval.yaml` 复制相应数据集、模型及 prompt 条目。该文件保存了 BEAM rubric 与排序裁判、LoCoMo 二元裁判、LongMemEval 问题类型 prompt、InfBench 三项评分模板。不要把本章简短示例当成这些官方协议的替代版本。

例如暂不执行某个外部裁判时，保留它的 answer 配置，把 judge 设为：

```yaml
judge:
  method: deferred
  reason: "外部裁判尚未启用，保留答案等待后续评分"
```

`native` 表示使用任务已注册的评分函数。样例的 `metric` 用来说明指标，当前代码不会根据这个字段切换算法。更换 `metric` 字符串不会把 ReDial 变成另一种评分方式。

配置有两层不能混淆：Picorer 服务配置决定检索 Agent；eval YAML 决定回答与评分。旧清单如果没有 `eval_config` 绑定，回答仍走 MAB config 或 Omni env 文件。生成新清单时必须显式传 `--eval-config`。

## 4. 先准备 manifest，再启动工作

下面命令是 **236 上新建一轮 Fact-MH 与 ReDial 实验**的模板。先把随文 YAML 放到新目录的 `eval.yaml`；再把核对过的 MAB config 复制为 `mab-config.yaml`。这份 MAB config 应指向已确认的 full 服务，并包含两项任务与它们的入库复用记录。配置可能有私密字段，目录与文件应按内部实验资料管理。

```bash
cd /data/zhaogangyi/picorer-eval/queue-infra/question-pipeline-v2

export PICORER_RUN=/data/zhaogangyi/picorer-eval/qwen36-v100-full-example
export PICORER_ADAPTER=/data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/adapter-candidate
export PICORER_NAMESPACE=picorer:qwen36:v100:full-example

test -f "$PICORER_RUN/mab-config.yaml"
test -f "$PICORER_RUN/eval.yaml"

.venv/bin/python -m question_pipeline.eval_config "$PICORER_RUN/eval.yaml"
```

模型端点和凭据应由运行环境预先注入 `QWEN36_BASE_URL`、`QWEN36_API_KEY`。校验 YAML 只检查 schema 与引用，不会替你发真实模型请求，也不保证端点可达。

检查 MAB 入库 checkpoint：

```bash
.venv/bin/python -m question_pipeline.mab_prepare \
  --dry-run \
  --config "$PICORER_RUN/mab-config.yaml" \
  --adapter-root "$PICORER_ADAPTER" \
  --task fact-mh-262k \
  --task recsys-redial-full
```

`--dry-run` 统计已有与缺少的 context checkpoint，不写入语料，也不逐条证明现有库中的内容正确。本轮需要复用库时，发现缺项应先核实配置和数据库，不要直接去掉 dry-run。

生成问题清单并固定 300 题数量：

```bash
.venv/bin/python -m question_pipeline.mab_manifest \
  --config "$PICORER_RUN/mab-config.yaml" \
  --adapter-root "$PICORER_ADAPTER" \
  --eval-config "$PICORER_RUN/eval.yaml" \
  --task fact-mh-262k \
  --task recsys-redial-full \
  --output "$PICORER_RUN/mab-manifest.json"

.venv/bin/python -m question_pipeline.combine_manifests \
  --input "$PICORER_RUN/mab-manifest.json" \
  --expected 300 \
  --output "$PICORER_RUN/manifest.json"
```

`combine_manifests` 拒绝重复题目 ID，检查总数，并按 benchmark 轮流排列题目，让不同数据集都能较早得到运行机会。300 只适用于这两项任务，不是框架内置的通用题数。

如果需要小规模试运行，可以先生成另一个带 `--limit` 的 manifest，放到独立试运行目录。limit 按配置遍历顺序截取，不会自动按数据集分层抽样。

### 增加 BEAM 或 LoCoMo

使用 `omni_manifest`，不要把它们写成 MAB task。JSON spec 的字段如下，路径应替换成实际文件；这里展示的是格式，不是可直接使用的数据路径。

```json
{
  "beam": [{
    "data": "/absolute/path/beam_100k.jsonl",
    "scale": "100k",
    "omni_root": "/absolute/path/OmniMemEval",
    "env_file": "/absolute/path/picorer.env",
    "service_version": "this-run",
    "ingestion_version": "existing-index",
    "top_k": 20
  }],
  "locomo": {
    "data": "/absolute/path/locomo.json",
    "omni_root": "/absolute/path/OmniMemEval",
    "env_file": "/absolute/path/picorer.env",
    "service_version": "this-run",
    "ingestion_version": "existing-index",
    "top_k": 20
  }
}
```

```bash
.venv/bin/python -m question_pipeline.omni_manifest \
  --spec "$PICORER_RUN/omni-spec.json" \
  --eval-config "$PICORER_RUN/eval.yaml" \
  --output "$PICORER_RUN/omni-manifest.json"
```

此时 eval YAML 还必须具有 `omnimemeval/beam-100k`、`omnimemeval/locomo` 等实际 dataset key。然后把 MAB 和 Omni manifest 一起传给 `combine_manifests`，使用这轮真实目标总数。本轮历史 4,211 题是一个特定组合，不应在别的实验里照抄。

服务器还有 `prepare_full` 便利脚本，但它固定检查 MAB 2,071 题、合计 4,211 题，包含历史结果迁移，而且当前不提供 `--eval-config` 参数。新建带 eval YAML 的实验应使用上面的 manifest 命令，不能把该历史脚本当成通用入口。

## 5. 初始化与启动

只有准备好开始派发时才执行 init。它会写 SQLite，并发送 Redis 通知。生成 manifest 本身不会调用回答模型。

```bash
.venv/bin/python -m question_pipeline.cli \
  --state "$PICORER_RUN/state.sqlite" \
  --namespace "$PICORER_NAMESPACE" \
  init --manifest "$PICORER_RUN/manifest.json"
```

启动三个阶段，下面的并发值只是一个起点，是否适合要看同机其他实验和模型负载：

```bash
export MAB_ANSWER_FALLBACK_AUDIT="$PICORER_RUN/logs/answer-fallback.jsonl"

.venv/bin/python -m question_pipeline.supervisor \
  --state "$PICORER_RUN/state.sqlite" \
  --namespace "$PICORER_NAMESPACE" \
  --artifacts "$PICORER_RUN/artifacts" \
  --logs "$PICORER_RUN/logs" \
  --retrieval-concurrency 16 \
  --answer-concurrency 8 \
  --evaluation-concurrency 4 \
  --max-answer-backlog 128 \
  --stale-seconds 1200 \
  --mab-export-dir "$PICORER_RUN/export/agentmemorybench" \
  --omni-export-dir "$PICORER_RUN/export/omnimemeval"
```

可以在 tmux 等持久终端中执行。不要为一个 state 启动两个 supervisor。若 Redis 不在默认地址，init、supervisor 都应显式使用相同的 `--redis-url`。

`stale-seconds` 是失去 worker 心跳多久以后允许重新认领，不是检索请求最长运行时间。健康 worker 每 20 秒续心跳，长题可以持续运行。HTTP timeout、Agent 搜索限制、模型输出额度分别配置，不能靠减小 stale 时间来加速慢题。

## 6. 看进度，要看三个阶段和完整分母

```bash
.venv/bin/python -m question_pipeline.cli \
  --state "$PICORER_RUN/state.sqlite" \
  --namespace "$PICORER_NAMESPACE" \
  status
```

输出包含每阶段各状态的题数、近五分钟完成量、成功阶段耗时的均值和分位数，以及部分最早的活跃任务。它不是 GPU 监控，耗时也不包含全部失败尝试与排队时间。

按数据集查看细项，可以用只读 SQLite 查询：

```bash
sqlite3 -readonly "$PICORER_RUN/state.sqlite" \
  "SELECT q.benchmark, s.stage, s.status, COUNT(*) AS questions
   FROM questions q JOIN question_stages s ON q.id=s.question_id
   GROUP BY q.benchmark, s.stage, s.status
   ORDER BY q.benchmark, s.stage, s.status;"
```

查失败原因与尝试次数：

```bash
sqlite3 -readonly "$PICORER_RUN/state.sqlite" \
  "SELECT question_id, stage, attempt, max_attempts, error
   FROM question_stages WHERE status='failed'
   ORDER BY stage, question_id;"
```

报告至少要有“目标题数、检索完成、回答完成、评分完成、失败、等待裁判、当前分数”这些列。比如 100 题中评分完成 70 题、正确 35 题，只能写“已评分 70 题中 35 题正确”；不能把 50% 隐去分母写成全量准确率。

具体分数保存在 evaluation artifact 的 `output.metrics` 中。Fact-MH 主看 `substring_exact_match`，ReDial 主看 `recsys_recall@5`；两者都是每题分数的平均，但 ReDial 单题可能是部分覆盖分，不宜称为“答对了多少题”。

## 7. 续跑与补跑是两件事

**续跑**保持同一份 manifest、源码、配置和 state。再次启动 supervisor，worker 会补发 queued 通知并恢复失去心跳的任务。已经 completed 的阶段不会因为重启自动再做一遍。若回答尚未完成，它直接使用已有 retrieval artifact。

重新执行相同 manifest 的 init 不会插入重复题目；配置漂移会报错。但 init 本身主要处理 ready 记录，补发已有 queued 记录发生在 worker 启动时。不要只运行 init 然后以为所有丢失通知已经处理好了。

**补跑**是有意识地给 failed 题增加一次机会。当前 CLI 没有通用 `retry-failed` 子命令，已失败的题也不会因为重启自动回到队列。需要保留第一次失败和原尝试数，按失败阶段建立独立补跑记录或使用经过审计的状态迁移操作。不要清空错误再称“零失败”。

回答重试可复用原证据；检索重试会让 Agent 重新生成动作，可能改变结果。普通重试次数由 manifest 的 `max_attempts` 控制，MAB 默认生成检索 2 次、回答 3 次；裁判是否绑定 eval YAML 会影响默认评测尝试数。空回答的适配器内部补发另计，详见框架章节。

暂停时优先正常终止 supervisor，让它给子进程清理机会。强行杀进程以后，要考虑服务端请求可能还在运行；不能仅凭本地进程消失就认定不会产生额外调用。

## 8. 裁判晚一点开，怎样只补评分

检索、回答产物已经保存，所以后面可以只评答案。但 `waiting_external` 不会自动因账户恢复而变回 ready，修改旧 eval YAML 还会触发哈希漂移检查。

有两条明确路径：

1. 导出已有答案，使用对应 benchmark 已固定的评分入口。这不需要重新运行检索和回答。
2. 建立独立的评分实验目录和 state，绑定新的裁判 YAML，通过 `PipelineState.seed_stage()` 引入原检索、回答产物，再只启动 evaluation worker。

第二条路径目前需要一个小的迁移脚本，仓库没有统一的“开启全部 deferred 裁判”命令。脚本应逐题核对 ID、原 payload、原产物内容与哈希；只更改 eval 配置绑定，不更改问题、答案或证据；先完成 seed，再派发任务。原实验保留 waiting_external 记录，新目录保存裁判和评分版本。不能直接更新旧库的哈希来绕过防漂移检查。

完成上述准备后，只启动评分 worker 的正式命令是：

```bash
.venv/bin/python -m question_pipeline.cli \
  --state "$PICORER_RUN/state.sqlite" \
  --namespace "$PICORER_NAMESPACE" \
  worker --stage evaluation \
  --artifacts "$PICORER_RUN/artifacts" \
  --concurrency 8
```

此处的变量应指向**准备好的独立评分实验**。worker 自己是常驻进程，不会因队列为空自动退出；需按状态停止，或交给 supervisor 管理。MAB adapter 目前仍会初始化 Picorer 客户端并检查运行身份，运行 pipeline 内的 MAB eval 时服务应可访问；这是现有工程耦合，不是评分算法本身必须检索。

## 9. 导出结果与保留轨迹

可以在运行中导出部分结果，也可以在结束后统一导出：

```bash
.venv/bin/python -m question_pipeline.mab_export \
  --state "$PICORER_RUN/state.sqlite" \
  --output-dir "$PICORER_RUN/export/agentmemorybench"

.venv/bin/python -m question_pipeline.omni_export \
  --state "$PICORER_RUN/state.sqlite" \
  --output-dir "$PICORER_RUN/export/omnimemeval"
```

MAB 每个任务生成一个 `*-static.json`，包含已回答题的输出、指标与检索审计。这里的 static 是固定算子模式，不表示无 Agent。导出的 metrics 对有值样本平均，必须同时看 `completed_queries`、`evaluated_queries` 和 `evaluation_statuses`。

Omni 导出 BEAM、LoCoMo 的搜索记录和答案文件。当前 exporter 不导出 pipeline 的裁判结果；要保留 evaluation artifacts 和 SQLite。Supervisor 结束时的 `supervisor-final.json` 会记录 settled、进程重启次数与导出错误，不应只检查进程 exit code。

对一条错题，建议按下面顺序阅读：

- `questions.payload`：题目、数据身份、服务与评分配置指向哪里。
- `retrieval.json`：实际取回的上下文；MAB 还可沿 `operator_experiment` 找搜索、读取与 finish 轨迹。
- `answer.json`：最终答案；Omni 正常模型回答保留 `model_input`，MAB answer artifact 当前只保存 prediction，真实截断后的输入仍需结合 ChatClient 或额外日志核查。
- `evaluation.json`：分数、裁判响应和解析结果。
- `events` 与服务日志：是否发生重试、空回答补发、租约恢复，是否影响比较口径。

不要假设某个 artifact 中声明了模型或源码身份，就已经证明真实网络请求完全使用它。对于重要回归，还应保存配置哈希、服务实际启动参数和响应审计。

## 10. 最终验收与常见问题

完成一次实验以后，先核对 manifest 中的目标题数与唯一 ID，再核对三个阶段的状态。评分全了才报完整分数；若仍有 run failure，单列题号、阶段与原因。重试得到的完整成绩可以报告，但必须说明重试策略和总尝试，而不是只展示最终成功状态。

| 现象 | 优先检查 |
|---|---|
| 改了 eval YAML，答案还是旧模型 | manifest 是否绑定 `eval_config`；是否正在看旧 state 或旧导出 |
| 文件名写 full，表现像另一轮 | 实际 Picorer 服务模式、端口、检索 prompt 和预算；文件名不是配置 |
| 任务注册找不到 ReDial | 是否错误用了 tag 内较早的 MAB adapter，缺少服务器扩展 |
| 已有库却提示未入库 | context checkpoint 的路径、user ID、服务持久化身份是否一致 |
| 所有回答完成却没有分数 | evaluation 是否 waiting_external，裁判配置与凭据是否准备好 |
| supervisor 已结束但有未完成题 | settled 允许 failed 和 waiting_external；检查各阶段统计 |
| 重启以后题目没补跑 | failed 不是 ready；重启只恢复可执行任务与失效租约 |
| 回答很快，整体仍慢 | retrieval 吞吐、回答背压、模型端点是否共享同一实例，以及长题占用 |
| SQLite attempt 少于实际模型请求 | 空回答内部补发、检索内部多步调用、裁判逐 rubric 多次调用 |
| 总分比预期高但题数不全 | exporter 可能只对已有指标求平均，先核对完整分母 |

一份可交接的最终报告，应写清产品版本、适配器与框架版本、数据清单、实际服务模式、模型与预算、完成情况、评分协议和产物位置。这样下一位同事既能使用结果，也能解释它是怎样得到的。
