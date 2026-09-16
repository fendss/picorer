# 复现与输出说明

分析环境：Python 3.12.13，完整包版本见 requirements.txt。已有隔离环境位于实验目录的 .venv-figures，未修改系统 Python。

在实验目录运行：

```sh
cd "/Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912"
.venv-figures/bin/python redraw_rs_v5.py
.venv-figures/bin/python verify_rs_v5.py
```

如需在本机另建环境，使用 Python 3.12：
```sh
uv venv --python 3.12 .venv-figures-replay
uv pip install --python .venv-figures-replay/bin/python -r analysis-rs-v5/requirements.txt
.venv-figures-replay/bin/python redraw_rs_v5.py
.venv-figures-replay/bin/python verify_rs_v5.py
```

绘图依赖已安装的 ~/.codex/skills/scientific-visualization/scripts 下的样式、导出和检查工具，GitHub 来源及 SKILL.md 哈希在 environment.json。图内文字统一为英文并使用 Times New Roman，PDF 嵌入所用字体。仅绘图模式要求本机已安装该字体并检查导出字体名称，不静默替换为其他字体。

只重新绘图、保留所有统计数据时，运行 `.venv-figures/bin/python redraw_rs_v5.py --figures-only`。该模式核验统计文件哈希不变、PDF 中没有中文或 sigmoid 字样且 Times New Roman 字体已嵌入，结果保存在 presentation-validation.json。

输入固定为 analysis-rs-v4/states.csv。核验另读 coverage/run1、run2、complete-run 的 state-replica.csv。脚本不调用模型、不连接服务器、不改原始输入；会重建本目录内派生表格、JSON 和同名图像，正文报告由人工核对后维护，不由拟合脚本自动撰写。

正文三图：01 均值轨迹，02 分跳数覆盖率均值，03 正确率连续回归。S1–S4 是单独的对照图。没有多面板拼图。每张图有 PDF、PNG、export.json；表格和图的对应关系保存在导出记录内。

统计设置：
- 所有分析先合并两个测量副本；p = sigmoid(状态平均 margin)。
- 时间曲线采用截至网格时刻最后观测状态；不在首个状态之前补值。均值与区间均为题目层面，不将同题三个运行当独立题目。
- 覆盖率均值先合并轨迹内重复覆盖状态，再合并题目内运行。
- 相关系数与固定效应回归区间：5,000 次题目级百分位 bootstrap，种子 20260914。
- 回归的轨迹权重为每状态 1/轨迹长度；固定效应吸收各轨迹截距。
- 最终正确率模型为二项逻辑回归，采用题目聚类稳健协方差；图的区间通过 delta 方法计算。没有把模型拟合曲线称为留出校准。
- 所有区间均为逐点/逐系数 95% 区间，没有针对全套探索分析作多重比较校正。
- 相关、回归、分层均值不一定估计同一对象，因此分别明确权重与样本单位。

validation.json 是程序核验结果；REVIEW.md 记录人工检查和结论边界。软件版本、输入哈希和随机种子用于复现，不代表科学有效性自动认证。
