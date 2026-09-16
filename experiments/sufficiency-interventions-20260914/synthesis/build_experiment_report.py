"""Render one experiment-only document, without historical reports or process notes."""
from pathlib import Path
import base64
import hashlib
import html
import io
import json
import re
import shutil
import zipfile
import csv
import build_single_file as layout

BASE=Path(__file__).resolve().parent
ROOT=BASE.parent
DERIVED=BASE/'unified'
SOURCE=BASE/'EXPERIMENTS.zh-CN.md'
OUT=BASE/'Picorer-Sufficiency-完整实验资料.html'
E=html.escape


def caption(p):
    if p.parent==DERIVED:
        return '64 道题、192 条轨迹，进度定义为 (t−1)/(T−1)。先平均题内运行，再跨题平均；阴影为逐点 95% 题目级重采样区间。'
    if p.stem=='04-state-answer-regression':
        return '64 道题、1,181 个状态。模型包含 R、likelihood 及其交互项，展示样本内拟合与 95% 题目级区间；不是留出校准图。部分范围的不确定性较大。'
    return layout.fig_caption(p)


def label(p):
    if p.parent==DERIVED:return '检索进度首尾对齐的敏感性分析'
    return layout.figure_title(p)


def table(p,title):
    rows=list(csv.reader(io.StringIO(p.read_text())))
    head=''.join(f'<th scope="col">{E(x)}</th>' for x in rows[0])
    body=''.join('<tr>'+''.join(f'<td>{layout.format_cell(x)}</td>' for x in row)+'</tr>' for row in rows[1:])
    return f'<details class="data-table"><summary>{E(title)}</summary><div class="table-scroll" tabindex="0" role="region" aria-label="{E(title)}"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div></details>'


def main():
    images=set((ROOT/'analysis').glob('*.png'))|set(DERIVED.glob('*.png'))
    layout.assets={p.resolve() for p in images}
    layout.headings.clear();layout.displayed_images.clear()
    md=re.sub(r'^# .+\n','',SOURCE.read_text(),count=1)
    body=layout.render(md,SOURCE,'main')
    main_images=set(layout.displayed_images)
    supplements=[]
    for p in sorted(images-main_images):
        supplements.append(f'<details class="supp-figure"><summary>{E(label(p))}</summary><figure><img id="{layout.image_id(p)}" src="{layout.data_uri(p)}" alt="{E(label(p)+"。"+caption(p))}" decoding="async"><figcaption>{E(caption(p))}</figcaption></figure></details>')

    shown=[(DERIVED/'natural-time-regression.csv','自然轨迹：控制轨迹和检索时间的回归'),
           (DERIVED/'natural-temporal-means.csv','自然轨迹：时间均值与支持样本数'),
           (DERIVED/'natural-coverage-means.csv','自然轨迹：各覆盖率的均值与支持样本数'),
           (ROOT/'analysis/correlations.csv','自然状态与受控组合：相关系数及区间')]
    for cohort,name in [('unconflicted','主分析 64 题'),('all','全部 100 题'),('conflicted','已知冲突 36 题')]:
        for suffix,description in [('coverage-effects','标准证据配对效果及长度回归'),('preview-effects','预览配对效果'),('heldout-metrics','按题留出预测误差'),('regression','逐状态正确率回归系数')]:
            shown.append((ROOT/f'analysis/{cohort}-{suffix}.csv',name+'：'+description))
    tables=''.join(table(p,title) for p,title in shown)
    archive_files={}
    for p in (ROOT/'analysis').glob('*.csv'):archive_files[f'statistics/{p.name}']=p
    for p in DERIVED.glob('*.csv'):archive_files[f'statistics/{p.name}']=p
    for name in ['units.csv','answers.csv']:archive_files[f'measurements/{name}']=ROOT/'summary'/name
    for p in sorted(images):
        for ext in ['.png','.pdf']:
            f=p.with_suffix(ext);archive_files[f'figures/{f.name}']=f
    archive_files['实验报告.md']=SOURCE
    buf=io.BytesIO()
    with zipfile.ZipFile(buf,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for name,p in sorted(archive_files.items()):z.writestr(name,p.read_bytes())
    raw=buf.getvalue()
    toc=''.join(f'<a href="#{i}">{E(title)}</a>' for i,title in layout.headings)
    style=layout.STYLE+'''header{padding-bottom:22px;margin-bottom:24px}.subtitle{margin-bottom:0}h2{margin-top:40px}article p:first-child{margin-top:0}.data-table th{min-width:90px}td{border-bottom:0}.report-download{margin-top:24px;border-top:1px solid var(--rule);padding-top:18px;font-size:13px}'''
    script='''function reveal(){const n=document.getElementById(decodeURIComponent(location.hash.slice(1)));if(!n)return;for(let p=n;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;requestAnimationFrame(()=>n.scrollIntoView({block:'start'}));}addEventListener('hashchange',reveal);addEventListener('DOMContentLoaded',reveal);document.getElementById('nav-toggle').onclick=()=>{const n=document.querySelector('nav');const open=n.classList.toggle('nav-open');document.getElementById('nav-toggle').setAttribute('aria-expanded',String(open));};'''
    page=f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Picorer：证据覆盖与原生充分性</title><style>{style}</style></head><body id="top"><a class="skip" href="#report">正文</a><div class="layout"><nav aria-label="目录"><div class="brand">Picorer<button id="nav-toggle" aria-expanded="false" aria-controls="nav-links">目录</button></div><div class="nav-links" id="nav-links">{toc}<a href="#supplementary">补充图</a><a href="#statistics">统计明细</a></div></nav><main id="report"><header><h1>Picorer：证据覆盖与原生充分性</h1><p class="subtitle">Qwen3.6-27B · 多跳事实检索 · 自然轨迹与受控干预</p></header><article>{body}</article>
<details class="appendix" id="supplementary"><summary>补充图</summary>{''.join(supplements)}</details>
<details class="appendix" id="statistics"><summary>统计明细</summary><p class="meta">estimate／mean 为估计值，low／high 为 95% 区间端点，questions／states 为题目数／状态数。表中小数显示六位有效数字，完整精度保留在 CSV 中。空字段表示缺失或不适用，不当作零。</p>{tables}</details>
<div class="report-download"><a id="archive-download" download="Picorer-实验数据与图表.zip" href="data:application/zip;base64,{base64.b64encode(raw).decode()}">实验数据与图表（CSV、PNG、PDF）</a></div></main></div><script>{script}</script></body></html>'''
    backup=BASE/'archive'/'资料汇编.html'
    if OUT.exists() and not backup.exists():
        backup.parent.mkdir(exist_ok=True);shutil.copy2(OUT,backup)
    OUT.write_text(page)
    manifest={'output':str(OUT),'images':len(images),'main_figures':len(main_images),'visible_statistical_tables':len(shown),
        'archive_csv_tables':sum(p.suffix=='.csv' for p in archive_files.values()),
        'archive_sha256':hashlib.sha256(raw).hexdigest(),'bytes':OUT.stat().st_size,
        'source_sha256':{name:hashlib.sha256(p.read_bytes()).hexdigest() for name,p in archive_files.items()},
        'cohort':'64 primary questions; 192 trajectories; 1181 states; all 100 questions as sensitivity analysis'}
    (DERIVED/'report-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:manifest[k] for k in ['output','images','main_figures','visible_statistical_tables','archive_csv_tables','bytes']},ensure_ascii=False))


if __name__=='__main__':main()
