# 运行状态与继续方式

实验尚未完成，不得将 `_qa` 或未收齐的 pilot 当成正式结果。

正式数据位于 236：`/data/zhaogangyi/picorer-eval/sufficiency-interventions-20260914-v2`。

现有两个推理服务位于 gpu08：`172.16.200.114:18081`（GPU 7）与 `:18082`（GPU 4）。两个副本均为 Qwen3.6-27B，仅复用这两张卡。

- 总任务 34,126：18,390 个答案，15,736 次 native 测量；没有 J。
- 10 题 pilot 共 4,070 任务，64 并发；pilot 原始响应、token 前缀及输入哈希审计通过后才转全量。
- 当前 supervisor PID 520411，full runner PID 520537；已进入全量，4,070 项 pilot 已完成并通过审计。2026-09-14 18:16 经用户批准平滑排空后，从每卡 40 降至每卡 34 个在途任务（总数 68）。成功响应不重算。操作前必须重新核验实际进程和命令，不能盲用旧 PID。
- 自动流程已包含收集、全量统计、图表生成与字体/文件检查；完成标记是 `suite-complete.json`，不是某个单独任务的成功响应。
- 用户于 2026-09-14 明确批准将现有两份服务上下文上限由 131,072 调整到模型原生支持的 262,144，仍仅 GPU 4、7。完整 tokenize 审计确认 2,217 个独立回答输入中，6 个状态（30 个答案任务）超出旧总预算限制，最长输入 180,129 token；所有输入加 16,384 输出预算均能放入 262,144。不得截断或悄悄排除这些状态。
- 升级已完成：在两份服务 running/waiting 都为零后，仅修改 max-model-len 并重启。2026-09-14 14:02（北京时间）验证两副本的 262,144 上限、最长原始请求 180,129 token 加 16,384 正式输出预算的准入，以及该输入的实际单 token 推理均通过。14:02 恢复原 runner 的 64 并发；已完成数据保持不变，未截断证据。验证记录为 `context-upgrade-verification.json`。诊断 token 不计作实验答案。
- 新服务启动 PID：GPU 7 为 2581871，GPU 4 为 2581863；原服务启动配置有备份。升级脚本为 `upgrade_context.py`，配置及部署审计位于模型服务器 gpu4-18082 实例目录。操作时仍需重新核验 PID。升级前的原始环境另存为 `pilot-environment-before-262k.json`；升级后部署为 `context-deployment-verified.json`，后续重试的 `pilot-environment.json` 可以更新而不丢失原始配置。
- 调度切换时共 7,989 项成功逻辑任务，已由新 runner 全部复用。原进度、配置、成功结果 SHA-256 和 71 个未完成目录归档至 `scheduler-switches/1789371810540975839`。未改变输入、seed、任务副本绑定或测量函数，模型服务未重启。部分未落盘在途任务重新执行，不能算成额外样本。失败任务仍按原参数补跑，原错误文件可能保留，判断未解决失败应同时检查成功 result.json 是否存在。
- 新 runner 支持 SIGUSR1 平滑排空：停止提交新任务，等待在途响应保存后以 75 退出；supervisor 将写 supervisor-paused.json 后退出，不会立刻自动重开。需要恢复时重新运行 supervise.py --detach；历史环境自动归档在 run-history，切勿盲用旧 PID。
- 80 并发恢复命令应带 `supervise.py --workers 80 --detach`（另加 --root）；不指定 workers 默认仍为 64。此次排空/恢复记录在 `concurrency-changes/1789378958591488964`，19,399 项成功结果全部复用。run.py、replica_scheduler.py、jobs.json、units.json、manifest.json 的哈希均未变，只给 supervisor 增加并发参数并传入 80；模型服务未改。根目录 supervisor-paused.json / full-drained.json 是此次切换的历史记录，不代表当前仍暂停，应结合进程和 full-progress.json 的 draining 字段判断。
- 当前恢复命令使用 `supervise.py --workers 68 --detach`（另加 --root），不是上述历史 80 并发命令。18:16 的变更保留 21,284 项成功结果；记录及成功结果哈希在 `concurrency-changes/1789380704368552155`。运行和测量代码、冻结清单哈希均未改变，只调整 CLI 并发参数，模型服务未重启。启动后确认两个独立队列上限均为 34。
- 初始不带 `-v2` 的目录是字段排序错误的已停止 pilot，保留用于审计，不能与正式数据合并。

本地执行 `python3 fetch.py` 可一次性拉取当前统计表和已产生的图，不设置后台监控。结果完整时，正文为 `analysis/REPORT.zh-CN.md`，核心图为 `01-coverage-likelihood`、`02-coverage-accuracy`、`03-preview-effect`、`04-state-answer-regression` 的 PDF/PNG。需要人工检查实际图像，程序核验不替代视觉与案例复核。

方法、条件、均值权重和区间定义见 `PROTOCOL.zh-CN.md`。原始 HTTP 响应和精确输入均在服务器保留。
