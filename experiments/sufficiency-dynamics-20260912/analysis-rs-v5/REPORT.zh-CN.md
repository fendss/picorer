# Picorer：证据获取、充分性分数与答题结果
2026-09-14 · 离线重分析与图表重制 · Qwen3.6-27B

图表样式更新：正文和附录的全部图内文字为英文，统一使用 Times New Roman。图中概率量标为 Sufficiency likelihood，仍对应下文定义的 p；图例顶部居中、无边框，以线型和标记对应各组。本次仅修改展示，不改变数据、统计结果及中文图注。

## 这次重分析改变了什么

**总体关系仍然存在，但不能说“把 S 换成 sigmoid(S)，所有结论都一样”。** 证据覆盖率与两种分数都正相关；排序完全不变。然而，控制检索进度以后，原始 S 的覆盖率系数稳定为正，sigmoid(S) 的系数则对模型形式敏感，不能确认独立的正向关系。

本版只保留三张正文图：检索过程中的均值变化、不同覆盖率下的均值、终止状态与正确率的关系。图中不堆放统计结论；相关系数、回归规格和限制在正文说明。所有图独立导出，不拼成大面板。

## 1. 数据和变量

分析使用同一组 100 道题的三次独立运行，共 300 条轨迹、2,150 个状态；两份模型服务的 4,300 条测量先合并为状态级数据。两个服务运行相同模型，不是两个不同模型的比较。最终答对 133/300，正确率 44.3%。不使用 J，也没有新增模型调用。

R 始终指**当前状态证据包的标准证据覆盖率**：

`R = 包内匹配到的不同标准证据条数 / 该题标准证据总条数`

它不是包里所有证据的数量，更不是只在最终回答时才存在的变量。R=0 不意味着包为空，R=1 也不意味着模型理解了全部事实。本次沿用已审计的每状态证据包重建结果；当前状态将执行的 read 在下一状态计入。

S 是原有 finish 协议下，sufficient 相对 insufficient 的 logit margin。为便于阅读，以下用 p 表示 `sigmoid(S) = 1 / (1 + exp(-S))`。这里的 p 只是两个 status 之间归一化的倾向，不是真实证据充分性的校准概率，也不是选择 finish 动作的概率。

计算顺序是：两份副本的 margin 取平均，得到一个状态的 S；对这个 S 计算 p；最后进行状态、运行、题目层面的聚合。**平均 sigmoid(S) 不等于 sigmoid(平均 S)。**

## 2. 检索越往后，分数和证据覆盖总体都上升

图 1 对比两种量在检索过程中的均值。中段进度 t/T=0.5 时，平均 p 为 0.588，平均 R 为 0.169；终止状态分别为 0.868 和 0.762。模型表达的充分性倾向与包内标准证据积累并不处于同一数值水平。

![图1：平均充分性倾向和证据包覆盖率随轨迹进度变化，阴影表示题目级95%区间。](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/01-mean-trajectories.png>)

图 1｜每个进度点先在一道题内平均可用运行，再跨题平均。采用原定义 t/T；以 0.05 为网格，使用截至该进度最后一个已观测状态，不向首个状态之前外推。灰底区域尚未覆盖全部轨迹：例如 0.10 时只有 64 条轨迹、37 道题；从 0.35 起均为 300 条轨迹、100 道题。连线仅连接网格估计，不表示连续观测；阴影是逐点 95% 题目级重采样区间，不是整条曲线的同时置信带。

这张图不能用两条曲线的纵向差直接测量“过度自信”，因为 R 与 p 的含义不同，也没有“二者本应相等”的校准假设。最后一段的明显上跳还受终止状态全部对齐到 t/T=1 的影响，不能解释为真实时间中的突然爆发。首尾对齐、全程使用全部 300 条轨迹的对照图见附录 S1；它使用另一种明确标注的进度定义。

去掉时间后，图 2 展示同一覆盖水平下的平均 p，并按标准证据链长度分开画。这样不会把主要来自三跳题的 R=1/3，与来自二跳或四跳题的 R=1/2，混成同一条“增长轨迹”。

![图2：二、三、四跳题分别显示覆盖率与平均充分性倾向，整体上升但不强制单调。](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/02-sufficiency-by-coverage.png>)

图 2｜同一 R 的多个状态先在轨迹内平均，再在题目内平均运行，最后跨题平均；误差线为 95% 题目级重采样区间。圆、方、三角分别代表二、三、四跳题，连线仅描述均值。对应题目数分别为：二跳 57/49/54；三跳 19/18/15/13；四跳 24/21/15/14/9，顺序均为 R 从低到高。即使在同一跳数内，各点的题目集合也不同，不能当成固定样本的干预曲线。

三类题都呈现总体上升，但不支持每次证据增加都提高 p。例如四跳题从 R=0.25 到 0.5 的均值几乎不变。三跳题在 R=1 时的均值为 0.766，区间较宽；四跳题完整组均值接近 1，但只有 9 道题到达过该覆盖水平，不能据此声称四跳题更容易。

## 3. 正相关保留了，但控制时间后的结论发生变化

表 1｜R 与充分性分数的相关系数。括号内为按题目重采样 5,000 次得到的 95% 区间。

| 分析 | 原始 S | sigmoid(S) |
|---|---:|---:|
| 全部状态的 Pearson 相关 | 0.450（0.353–0.551） | 0.321（0.212–0.436） |
| 全部状态的 Spearman 秩相关 | 0.424（0.320–0.534） | 0.424（0.320–0.534） |
| 轨迹内去均值、轨迹等权的 Pearson 相关 | 0.686（0.647–0.720） | 0.517（0.473–0.555） |

前两行每个状态等权；第三行先减去各自轨迹的均值，再以轨迹长度的倒数加权，使长轨迹不占更大权重。第三行还没有控制时间。三次运行及其全部状态始终跟随题目一起重采样，不能把 2,150 个状态当成独立样本。

Spearman 完全一致是因为 sigmoid 严格保留次序，不是一次额外的验证证据。Pearson 下降说明两种数值尺度上的线性关系不同；它本身不说明哪一种更接近“真实充分性”。

为排除“检索越往后，两者都越高”的部分影响，我们进一步拟合轨迹固定效应回归。每条轨迹有自己的截距，控制 t/T，并增加时间平方项作为敏感性检查；每条轨迹总权重相同。

表 2｜控制轨迹与时间后，R 的回归系数。括号为 95% 题目级重采样区间。

| 分数 | 时间控制 | R 的系数 |
|---|---|---:|
| 原始 S | 时间 | +2.575（+1.833 到 +3.317） |
| 原始 S | 时间及时间平方 | +2.738（+1.978 到 +3.491） |
| sigmoid(S) | 时间 | −0.051（−0.148 到 +0.044） |
| sigmoid(S) | 时间及时间平方 | +0.051（−0.026 到 +0.129） |

**原始 S 的正向系数可以复现，但同一句回归结论不能搬到 p 上。** p 的系数在两种时间控制下变号，且两个区间都包含 0。三轮单独拟合时，p 的 R 系数区间也均包含 0。

去掉 36 道存在标准证据版本冲突的题后，原始 S 的结论仍为正：两种规格的系数为 +1.773 和 +2.104。p 在线性时间控制下为 −0.182（−0.319 到 −0.058），加入时间平方后变为 −0.017（−0.119 到 +0.076）。因此，既不应宣称 p 有稳定的独立正向关系，也不应把某个规格的负系数解释成“加入证据让模型更不充分”。

这一变化在数学上并不矛盾。sigmoid 把两端的变化压缩了，改变了加性线性模型所拟合的关系。例如 S 从 3 增加到 6，p 只从约 0.953 增加到 0.998；同样增加 3 个 S 单位，在 0 附近对应的 p 变化大得多。严格单调变换保留排序，但不保留线性回归的系数与显著性。不能为获得某个结论而只保留其中一种规格。

## 4. 高分不能代替完整证据；完整组内部仍有区分信息

正确性只在最终答案上测量，因此以下仅使用 300 个终止状态。图 3 使用连续 S 拟合正确率，而不是事先把 S 二分。

![图3：按终止证据包是否完整分组的答案正确率回归，完整组内部高S对应更高正确率。](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/03-correctness-regression.png>)

图 3｜二项逻辑回归包含 S、R 是否完整、二者交互项和实验轮次；曲线平均三轮预测，并限制在各组实际观测的 S 范围内。阴影为按题目聚类的稳健协方差与 delta 方法得到的逐点 95% 区间。空心点为各 R 组内按 S 四分位分组的实际正确率，横坐标是该组平均 S，不是拟合值；点没有额外平滑。这是同一样本的描述性回归，不是留出测试集的校准结果。

主图保留 S 的理由是信息可读性：220/300 个终止状态的 p 已超过 0.99，在普通 0–1 横轴上会挤在右端。附录 S4 给出 p 版本，原始数据未删除或人为抖动。数值压缩不意味着排序信息消失。

直接分组的观测结果如下，完全不依赖回归曲线。

表 3｜终止状态分组的实际正确率。S>0 等价于 sufficient 的 logit 高于 insufficient；换成 p 后分组不变。

| 当前证据包 | 分数条件 | 答对 / 总数 | 正确率 |
|---|---|---:|---:|
| 标准证据不完整 | S≤0 | 1 / 29 | 3.4% |
| 标准证据不完整 | S>0 | 5 / 98 | 5.1% |
| 标准证据完整 | S≤0 | 3 / 10 | 30.0% |
| 标准证据完整 | S>0 | 124 / 163 | 76.1% |

连续回归中，完整组的 S 斜率为 +0.224（95% 区间 +0.102 到 +0.346），不完整组为 +0.103（−0.113 到 +0.319）。这些是正确率的 log-odds 斜率，不是正确率百分点变化。p 版本也在完整组内呈现正向关系。

**“完整组中关系可检测、不完整组中未检测到”，不等于两组斜率差异已经成立。** S 的连续交互项检验 p 值为 0.333，sigmoid(S) 版本为 0.301；当前样本不足以确认连续斜率不同。不完整组总共只有 6 个正确答案，这也是估计不稳定的重要限制。旧版二分分组的差异与这里的连续交互，检验的不是同一个问题。

按最终正确性计算的排序 AUC，S 与 sigmoid(S) 都是 0.712，完全相同；R 为 0.834。这些是同一批终止答案上的样本估计，不是新的系统准确率，也不是可以直接部署的停止策略，因为线上通常没有计算 R 所需的标准证据。

## 5. 当前可以成立的结论

证据包完整度与模型的原生充分性倾向有关，且这种关系不只是完全不同题目之间的差异。但关系的具体形式依赖分数尺度与时间控制：原始 S 的条件线性关系较稳定，sigmoid(S) 的对应结论不稳定。

S 与 R 不能互相替代。高 S 并不保证标准证据完整；完整证据组内部的 S 又确实包含一些与最终正确性有关的区分信息。现有结果不足以把 S 或 p 宣称为已经验证的“真实充分性概率”。

这是观察性轨迹分析，没有对同一状态主动增删证据，也没有为中间状态生成独立答案。R 来自标注与精确文本匹配，不是模型可见信息、语义理解或所有替代证据的完整测量。搜索预览和包内证据的区别仍然重要，但本版不从均值曲线推出预览导致了某种停止行为。结果目前仅覆盖一个模型、一个任务集合和 100 道题。

## 图表与复现材料

补充图独立提供，不堆在正文里：

- [S1：首尾对齐的均值曲线](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/S1-aligned-mean-trajectories.png>)：进度改为 (t−1)/(T−1)，全程保持 100 道题、300 条轨迹；不能与原定义混用。
- [S2：原始 S 随进度变化](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/S2-raw-margin-trajectory.png>)。
- [S3：原始 S 与覆盖率](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/S3-raw-margin-by-coverage.png>)。
- [S4：sigmoid(S) 与最终正确率](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/S4-sigmoid-correctness-regression.png>)。

所有图都有同名矢量 PDF、450 dpi PNG 和包含数据来源的导出记录。图内文字全部为英文，采用统一 Times New Roman 字体、克制的线宽和留白。顶部图例使用简洁的线段与标记，不将置信带或误差线端帽塞入图例，也不在右侧零散标注。图采用深红、蓝灰、灰色，并同时使用线型和点型；未假定某个期刊的投稿规格。颜色的白底对比度经过检查，但不将这一检查当成完整无障碍认证。

- [全部相关系数及区间](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/correlations.csv>)
- [轨迹内回归：全部、分轮、排除标注冲突](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/within-trajectory-regression.csv>)
- [最终正确率回归的完整系数](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/terminal-logistic-regression.csv>)
- [覆盖率均值及每点样本数](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/coverage-means.csv>)
- [原定义下的时间均值及支持样本数](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/temporal-original-means.csv>)
- [逐状态 S、sigmoid(S)、R 与原始字段](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/states-with-sigmoid.csv>)
- [重分析和绘图脚本](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/redraw_rs_v5.py>)
- [独立核验脚本](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/verify_rs_v5.py>)与[核验结果](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/validation.json>)
- [软件版本与 skill 来源记录](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/environment.json>)、[复现方式](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/REPRODUCE.md>)及[结论核对记录](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/REVIEW.md>)

分析使用 SciPy、Statsmodels、Seaborn 和 Matplotlib。按照新安装的 [K-Dense scientific-visualization skill](https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills/scientific-visualization)，本版重新明确了统计单位、缺失进度、区间含义、颜色冗余、导出尺寸和来源记录。该 skill 对本次图表流程有实质贡献，软件参考文献为：Kassis, T., Agarwal, V., He, Y., Patel, D., & Brueckner, A. M. (2026). [Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents](https://arxiv.org/abs/2609.00065)。论文元数据已核验。
