"""Package the existing reports, unchanged figures and tables into one offline HTML.

No inference or statistical estimation is performed. Original assets are retained in
an in-memory ZIP embedded in the HTML; large CSVs have explicitly labelled previews.
"""
from __future__ import annotations
import base64
import csv
import hashlib
import html
from html.parser import HTMLParser
import io
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlparse
import zipfile

HERE = Path(__file__).resolve().parent
NEW = HERE.parent
ROOT = NEW.parent.parent
OLD = NEW.parent / 'sufficiency-dynamics-20260912' / 'analysis-rs-v5'
NODE = Path('/Users/johnnychiu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node')
MARKED = Path('/Users/johnnychiu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/marked/lib/marked.esm.js')
OUT = HERE / 'Picorer-Sufficiency-完整实验资料.html'
DOCS = [HERE/'REPORT.zh-CN.md', OLD/'REPORT.zh-CN.md', NEW/'PROTOCOL.zh-CN.md',
        HERE/'REVIEW.md', OLD/'REVIEW.md']
E = html.escape
assets: set[Path] = set()
headings: list[tuple[str, str]] = []
displayed_images: set[Path] = set()


def rel(p):
    return str(p.relative_to(ROOT))


def aid(p):
    return 'asset-' + hashlib.sha256(rel(p).encode()).hexdigest()[:14]


def image_id(p):
    return 'figure-' + aid(p)[6:]


def table_id(p):
    return 'table-' + aid(p)[6:]


def data_uri(p):
    return 'data:image/png;base64,' + base64.b64encode(p.read_bytes()).decode()


def resolve_local(url, source):
    u = unquote(url)
    if urlparse(u).scheme or u.startswith('#'):
        return None
    p = Path(u)
    return (p if p.is_absolute() else source.parent/p).resolve()


def target(p):
    if p.suffix == '.png':
        return image_id(p)
    if p.suffix == '.csv':
        return table_id(p)
    if p == HERE/'REPORT.zh-CN.md':
        return 'report'
    if p == OLD/'REPORT.zh-CN.md':
        return 'previous-report'
    if p == NEW/'PROTOCOL.zh-CN.md':
        return 'protocol'
    if p in [HERE/'REVIEW.md', OLD/'REVIEW.md']:
        return 'review-records'
    return aid(p)


class Rewrite(HTMLParser):
    def __init__(self, source, prefix):
        super().__init__(convert_charrefs=False)
        self.source, self.prefix = source, prefix
        self.out, self.index = [], 0
        self.capture, self.heading_id, self.heading_depth = None, None, None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ['h1','h2','h3','h4']:
            self.index += 1
            attrs['id'] = f'{self.prefix}-heading-{self.index}'
            self.capture, self.heading_id, self.heading_depth = [], attrs['id'], tag
        if tag == 'a':
            p = resolve_local(attrs.get('href',''), self.source)
            if p is not None:
                if p not in assets:
                    raise ValueError(f'Unbundled link: {self.source}: {p}')
                attrs['href'] = '#' + target(p)
                attrs['title'] = f'文件内资料：{p.name}'
            elif attrs.get('href','').startswith('http'):
                attrs['rel'] = 'noopener noreferrer'
                attrs['target'] = '_blank'
        if tag == 'img':
            p = resolve_local(attrs['src'], self.source)
            assert p in assets and p.suffix == '.png'
            attrs.update(src=data_uri(p), decoding='async')
            if p not in displayed_images:
                attrs['id'] = image_id(p)
            displayed_images.add(p)
        if tag == 'table':
            self.out.append('<div class="table-scroll" tabindex="0" role="region" aria-label="报告表格">')
        self.out.append('<' + tag + ''.join(f' {k}="{E(v, quote=True)}"' if v is not None else f' {k}' for k,v in attrs.items()) + '>')

    def handle_endtag(self, tag):
        self.out.append(f'</{tag}>')
        if tag == 'table':
            self.out.append('</div>')
        if tag == self.heading_depth:
            if self.prefix == 'main' and tag == 'h2':
                headings.append((self.heading_id, ''.join(self.capture)))
            self.capture, self.heading_depth = None, None

    def handle_data(self, data):
        self.out.append(data)
        if self.capture is not None:
            self.capture.append(data)

    def handle_entityref(self, name):
        self.out.append(f'&{name};')
        if self.capture is not None:
            self.capture.append(html.unescape(f'&{name};'))

    def handle_charref(self, name):
        self.out.append(f'&#{name};')


def render(md, source, prefix):
    program = f"import {{marked}} from {json.dumps(MARKED.as_uri())};let s='';for await(const c of process.stdin)s+=c;process.stdout.write(marked.parse(s));"
    raw = subprocess.run([str(NODE), '--input-type=module', '-e', program],
                         input=md, capture_output=True, text=True, check=True).stdout
    parser = Rewrite(source, prefix)
    parser.feed(raw)
    return ''.join(parser.out)


def figure_title(p):
    old_names = {'01-mean-trajectories':'原轨迹：随检索进度的均值变化',
        '02-sufficiency-by-coverage':'原轨迹：覆盖率与充分性均值',
        '03-correctness-regression':'原终止状态：分数与正确率回归',
        'S1-aligned-mean-trajectories':'原轨迹：首尾对齐的时间均值',
        'S2-raw-margin-trajectory':'原轨迹：原始分数随进度变化',
        'S3-raw-margin-by-coverage':'原轨迹：原始分数与覆盖率',
        'S4-sigmoid-correctness-regression':'原终止状态：likelihood 与正确率回归'}
    if p.parent == OLD:
        return old_names[p.stem]
    group = '全部 100 题' if p.stem.startswith('S-all-') else '36 道已知冲突题' if p.stem.startswith('S-conflicted-') else '主分析 64 题'
    suffix = re.sub(r'^S-(all|conflicted)-', '', p.stem)
    names = {'01-coverage-likelihood':'受控证据与 likelihood',
             '02-coverage-accuracy':'受控证据与答题正确率',
             '03-preview-effect':'预览修改的配对效果',
             '04-state-answer-regression':'逐状态正确率的样本内回归'}
    return f'{group}：{names[suffix]}'


def source_tables(p):
    meta = json.loads(p.with_suffix('.export.json').read_text())
    provenance = meta['provenance']
    names = provenance.get('source_tables', [provenance.get('table')])
    return [p.parent/n for n in names if n]


def fig_caption(p):
    if p.parent == OLD:
        if 'S1-' in p.stem:
            return '100 题、300 条轨迹；使用 (t−1)/(T−1) 首尾对齐，不能与原定义 t/T 混用。先平均题内运行，再平均题目；逐点 95% 题目级重采样区间。'
        if 'S2-' in p.stem:
            return '原始 S 为 sufficient 相对 insufficient 的 logit margin。使用 t/T；不向首个观测之前外推。早期可用题目数随进度变化，完整支持数量见数据表。'
        if 'S3-' in p.stem:
            return '100 题的自然轨迹；按跳数分组，题内先平均相同覆盖率状态与运行。不同覆盖点的题目集合可能不同，不是固定样本的干预曲线。'
        if 'S4-' in p.stem:
            return '300 个原始终止状态的样本内描述性回归，并非留出预测或校准检验。220 个状态的 likelihood 超过 0.99，右端聚集来自真实数值压缩。'
    if p.stem.endswith('04-state-answer-regression'):
        return '64 题、1,181 个真实状态；二项回归包含 R、likelihood 与交互项。逐点 95% 题目级区间。部分范围的不确定性很大；该图不是留出测试的校准图。'
    group = '100 道题（二／三／四跳：57／19／24）' if 'S-all-' in p.stem else '36 道已知冲突题（二／三／四跳：8／12／16）'
    if p.stem.endswith('preview-effect'):
        states = '1,072／1,756／1,756' if 'S-all-' in p.stem else '508／813／813'
        return f'{group}。三项比较的状态数依次为 {states}；同状态配对后先平均运行、题目，再跨题平均。灰点为题目，深色点及区间为均值和 95% 区间。'
    return f'{group}。题内平均同覆盖率组合与正反顺序，再跨题平均；阴影是逐点 95% 题目级重采样区间。正确率来自每条件五次回答。'


def format_cell(value):
    if value == '':
        return '<span class="missing" title="原 CSV 的空字段；不是零">—</span>'
    if re.fullmatch(r'[+-]?\d*\.\d+(?:[eE][+-]?\d+)?', value):
        return f'<span title="{E(value)}">{float(value):.6g}</span>'
    return E(value)


TABLE_NAMES = {
    'correlations':'相关系数', 'coverage-effects':'受控证据配对效应及长度回归',
    'coverage-means':'覆盖率分组均值与区间', 'coverage-pairs':'逐事实配对变化',
    'coverage-question-means':'覆盖率的逐题均值', 'heldout-metrics':'分题留出预测指标',
    'heldout-predictions':'逐状态留出预测', 'preview-effects':'预览配对效应',
    'preview-question-effects':'预览效应的逐题数据', 'regression':'逐状态回归系数',
    'regression-curves':'逐状态回归曲线数据', 'states-with-sigmoid':'旧逐状态 R 与充分性数据',
    'within-trajectory-regression':'控制轨迹和时间的回归', 'terminal-logistic-regression':'旧终止状态回归系数',
    'terminal-observed-cells':'旧终止状态分组正确率', 'terminal-states':'旧终止状态明细',
    'terminal-empirical-quartiles':'旧终止状态分位数组均值', 'terminal-regression-curves':'旧终止状态回归曲线数据',
    'temporal-original-means':'原进度定义的均值及样本数', 'temporal-aligned-means':'首尾对齐的均值及样本数',
    'temporal-original-question-values':'原进度定义的题目级数据', 'temporal-aligned-question-values':'首尾对齐的题目级数据',
    'temporal-original-trajectory-values':'原进度定义的轨迹级数据', 'temporal-aligned-trajectory-values':'首尾对齐的轨迹级数据',
    'units':'新增实验：全部测量条件', 'answers':'新增实验：全部独立回答与评分',
    'data-counts':'汇总数据计数', 'state-descriptives':'状态按证据包完整度分组'}


def table_name(p):
    name = p.stem
    group = '旧轨迹分析' if p.parent == OLD else '新增实验'
    for prefix, label in [('unconflicted-', '主分析 64 题'), ('conflicted-', '已知冲突 36 题'), ('all-', '全部 100 题')]:
        if name.startswith(prefix):
            group, name = label, name[len(prefix):]
            break
    return group + ' · ' + TABLE_NAMES.get(name, name)


def render_table(p):
    rows = list(csv.reader(io.StringIO(p.read_text(encoding='utf-8-sig'))))
    header, values = rows[0], rows[1:]
    n = len(values)
    # Aggregated statistics are shown in full; large record-level tables remain in the embedded ZIP.
    preview = n > 350
    shown = values[:20] if preview else values
    info = f'共 {n:,} 行、{len(header)} 列。' + ('此处仅预览前 20 行；完整 CSV 已嵌入本文件的数据包。' if preview else '本表全部行均在下方；原始精度 CSV 同时收录于内嵌数据包。')
    head = ''.join(f'<th scope="col">{E(x)}</th>' for x in header)
    body = ''.join('<tr>' + ''.join(f'<td>{format_cell(v)}</td>' for v in row) + '</tr>' for row in shown)
    return (f'<details class="data-table" id="{table_id(p)}"><summary>{E(table_name(p))}<span class="count">{n:,} 行</span></summary>'
            f'<p class="meta">{E(info)} <a href="#embedded-data">提取完整资料包</a></p><p class="filename">{E(rel(p))}</p>'
            f'<div class="table-scroll" tabindex="0" role="region" aria-label="{E(table_name(p))}"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div></details>')


STYLE = r'''
:root{--ink:#25282b;--muted:#60676b;--rule:#dce0e2;--accent:#a51c30;--paper:#fff;--link:#245c7c}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:28px}body{margin:0;background:#f5f5f3;color:var(--ink);font-family:"Times New Roman","Songti SC","Noto Serif CJK SC",serif;font-size:17px;line-height:1.9}
a{color:var(--link);text-decoration-thickness:1px;text-underline-offset:3px}a:hover{color:var(--accent)}a:focus-visible,summary:focus-visible,button:focus-visible,.table-scroll:focus-visible{outline:2px solid var(--link);outline-offset:4px}
.skip{position:absolute;top:-100px}.skip:focus{top:12px;left:16px;background:white;z-index:5;padding:8px}
.layout{display:grid;grid-template-columns:250px minmax(0,1000px);max-width:1390px;margin:auto;gap:38px;padding:50px 32px 110px}
nav{position:sticky;top:32px;align-self:start;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;font-size:13px;line-height:1.6;max-height:calc(100vh - 64px);overflow:auto;padding-right:12px}
nav .brand{font-family:"Times New Roman",serif;font-size:30px;letter-spacing:.03em;color:var(--accent);border-bottom:2px solid var(--accent);padding-bottom:12px;margin-bottom:18px}#nav-toggle{display:none}
nav a{display:block;text-decoration:none;padding:7px 0;color:#42494d}nav .nav-section{margin:22px 0 7px;font-size:11px;letter-spacing:.12em;color:var(--muted)}
main{min-width:0;background:var(--paper);padding:54px 64px 72px;border:1px solid #e5e6e4;box-shadow:0 3px 16px #00000004}
header{border-bottom:1px solid var(--rule);padding-bottom:30px;margin-bottom:34px}.eyebrow{font-family:-apple-system,"PingFang SC",sans-serif;font-size:11px;letter-spacing:.16em;color:var(--accent);margin:0 0 10px}
h1{font-weight:600;font-size:34px;line-height:1.4;letter-spacing:.015em;margin:0 0 15px}h2{font-size:24px;line-height:1.55;margin:52px 0 20px;padding-top:6px;border-top:1px solid var(--rule);padding-top:23px}h3{font-size:19px;margin:28px 0 10px}h4{font-size:17px}p{margin:13px 0}strong{font-weight:700}ul,ol{padding-left:1.5em}li{margin:7px 0}
.subtitle,.meta,.filename,figcaption{color:var(--muted);font-size:13px;line-height:1.75}.filename{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px;overflow-wrap:anywhere}.intro-note{background:#f8f8f6;border-left:3px solid var(--accent);padding:14px 18px;margin:24px 0;font-size:14px;line-height:1.9}.intro-note p{margin:0}
img{display:block;max-width:100%;height:auto;margin:28px auto 12px;background:#fff}figure{margin:25px 0 32px}figcaption{margin-top:12px}figure .figure-data{font-size:12px;margin-top:10px}
.table-scroll{max-width:100%;overflow:auto;margin:22px 0;border-top:2px solid #59636a;border-bottom:1px solid var(--rule)}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.6;font-variant-numeric:tabular-nums}th{font-weight:600;text-align:left;background:#f5f6f5;border-bottom:1px solid #aab1b5}th,td{padding:10px 11px;vertical-align:top;min-width:72px;border-bottom:1px solid #ecefee}tr:last-child td{border-bottom:0}td:first-child{min-width:160px}code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.82em;background:#f2f3f2;padding:2px 4px;border-radius:2px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:#f5f6f5;padding:16px}
details{border-top:1px solid var(--rule);padding:14px 0;margin:12px 0}summary{cursor:pointer;font-size:16px;line-height:1.6;color:#333e43;padding:6px 0;font-weight:600}details[open]>summary{color:var(--accent);margin-bottom:14px}.appendix>summary{font-size:22px}.appendix{margin-top:38px;border-top:2px solid #758188}.appendix-body h1{font-size:26px}.count{font-size:11px;color:var(--muted);font-weight:400;margin-left:10px;font-family:system-ui,sans-serif}.data-table td{max-width:450px;overflow-wrap:anywhere}.data-table .table-scroll{max-height:600px}.data-table th{position:sticky;top:0;z-index:1}.data-table table{font-family:"Times New Roman","Songti SC",serif;font-size:12px}.missing{color:#747b80}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}.button,button{display:inline-block;border:1px solid #b5bec2;border-radius:3px;padding:7px 13px;background:white;color:var(--link);font:13px/1.6 -apple-system,"PingFang SC",sans-serif;cursor:pointer;text-decoration:none}.button.primary{background:var(--accent);color:white;border-color:var(--accent)}.asset-index{font-size:12px}.asset-index td:first-child{min-width:280px;overflow-wrap:anywhere}.asset-index td{overflow-wrap:anywhere}.backtop{float:right;font-size:12px;font-family:system-ui,sans-serif}footer{border-top:1px solid var(--rule);margin-top:45px;padding-top:18px;font-size:12px;color:var(--muted)}
@media(max-width:1100px){.layout{grid-template-columns:200px minmax(0,1fr);gap:24px;padding:28px 20px}main{padding:38px 32px}h1{font-size:29px}}
@media(max-width:760px){.layout{display:block;padding:0}nav{position:static;padding:20px 24px;max-height:none;border-bottom:1px solid var(--rule)}nav .brand{font-size:24px;margin:0;padding-bottom:8px}nav .nav-links{display:none}nav.nav-open .nav-links{display:block}#nav-toggle{display:block;float:right;margin:0;padding:3px 12px}main{padding:30px 22px;border:0}body{font-size:16px}h1{font-size:27px}h2{font-size:22px}.table-scroll{font-size:12px}}
@media print{body{background:white;font-size:10.5pt}.layout{display:block;padding:0;max-width:none}nav,.actions,.skip,.backtop,.archive-index{display:none!important}main{border:0;box-shadow:none;padding:0}h1{font-size:23pt}h2{font-size:16pt;break-after:avoid}h3,summary{break-after:avoid}img{max-height:190mm;object-fit:contain;break-inside:avoid}table{font-size:8pt}.table-scroll{overflow:visible}details:not([open]){display:none}.table-scroll,figure{break-inside:avoid}a{color:inherit;text-decoration:none}header{margin-bottom:15px}footer{font-size:8pt}@page{size:A4;margin:18mm}}
'''

SCRIPT = r'''
function revealTarget(){const id=decodeURIComponent(location.hash.slice(1));const node=document.getElementById(id);if(!node)return;let p=node;while(p){if(p.tagName==='DETAILS')p.open=true;p=p.parentElement;}requestAnimationFrame(()=>node.scrollIntoView({block:'start'}));}
window.addEventListener('hashchange',revealTarget);window.addEventListener('DOMContentLoaded',revealTarget);
document.querySelectorAll('a[href^="#"]').forEach(a=>a.addEventListener('click',()=>{if(a.hash===location.hash)revealTarget();}));
document.getElementById('expand-all').addEventListener('click',()=>document.querySelectorAll('details:not(.data-table)').forEach(d=>d.open=true));
document.getElementById('collapse-all').addEventListener('click',()=>{document.querySelectorAll('details').forEach(d=>d.open=false);location.hash='report';});
document.getElementById('print-report').addEventListener('click',()=>window.print());
document.getElementById('nav-toggle').addEventListener('click',()=>{const nav=document.querySelector('nav');const open=nav.classList.toggle('nav-open');document.getElementById('nav-toggle').setAttribute('aria-expanded',String(open));});
'''


def main():
    for directory in [OLD, NEW/'analysis']:
        assets.update(p.resolve() for p in directory.iterdir() if p.suffix in ['.md','.csv','.json','.png','.pdf'])
    assets.update(p.resolve() for p in DOCS)
    assets.update((NEW/'summary'/n).resolve() for n in ['units.csv','answers.csv','status.json'])
    assets.update((HERE/n).resolve() for n in ['evidence-checks.json','data-counts.csv','state-descriptives.csv','verify_synthesis.py'])
    assets.update((NEW/n).resolve() for n in ['output-audit.json','suite-complete.json'])
    assets.add(Path(__file__).resolve())
    # Ensure every local citation in the rendered documents travels with this file.
    for source in DOCS:
        for url in re.findall(r'\]\(<?([^\n]+?)>?\)', source.read_text()):
            p = resolve_local(url, source)
            if p is not None:
                assert p.is_file(), (source, p)
                assets.add(p)
    images = sorted(p for p in assets if p.suffix == '.png')
    tables = sorted(p for p in assets if p.suffix == '.csv')
    assert len(images) == 17

    main_md = re.sub(r'^# .+\n', '', DOCS[0].read_text(), count=1)
    body = render(main_md, DOCS[0], 'main')
    previous = render(DOCS[1].read_text(), DOCS[1], 'old')
    protocol = render(DOCS[2].read_text(), DOCS[2], 'protocol-text')
    reviews = ''.join(render(p.read_text(), p, 'review-'+str(i)) for i,p in enumerate(DOCS[3:]))

    gallery = []
    for p in images:
        if p in displayed_images:
            continue
        links = ' · '.join(f'<a href="#{table_id(t)}">{E(t.name)}</a>' for t in source_tables(p))
        gallery.append(f'<details class="supp-figure"><summary>{E(figure_title(p))}</summary><figure>'
            f'<img id="{image_id(p)}" src="{data_uri(p)}" alt="{E(figure_title(p)+"。"+fig_caption(p))}" decoding="async">'
            f'<figcaption>{E(fig_caption(p))}</figcaption><p class="figure-data">底层数据：{links}；原尺寸 PNG 与矢量 PDF 均在内嵌资料包中。</p></figure></details>')
        displayed_images.add(p)
    assert set(images) == displayed_images
    table_html = ''.join(render_table(p) for p in tables)

    entries = [{'path':rel(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(assets)]
    manifest = {'title':'Picorer sufficiency research collection', 'experiment_date':'2026-09-14',
                'figures':len(images),'csv_tables':len(tables),'files':entries,
                'scope':'Previous v5 report and completed v2 interventions; excludes J, historical superseded plots, server HTTP responses and model weights.',
                'transformation':'Presentation-only Markdown rendering and base64 embedding; source bytes retained without modification.'}
    package = io.BytesIO()
    with zipfile.ZipFile(package,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for p in sorted(assets):
            z.writestr(rel(p),p.read_bytes())
        z.writestr('MANIFEST.json',json.dumps(manifest,ensure_ascii=False,indent=2))
    zip_bytes = package.getvalue()
    b64 = base64.b64encode(zip_bytes).decode()
    archive_rows = ''.join(f'<tr id="{aid(p)}"><td>{E(rel(p))}</td><td>{p.stat().st_size:,}</td><td><code>{hashlib.sha256(p.read_bytes()).hexdigest()[:16]}…</code></td></tr>' for p in sorted(assets))
    archive_index = f'<details class="archive-index"><summary>内嵌文件目录与来源校验 <span class="count">{len(assets)} 个源文件</span></summary><div class="table-scroll"><table class="asset-index"><thead><tr><th>原文件路径</th><th>字节</th><th>SHA-256 前 16 位</th></tr></thead><tbody>{archive_rows}</tbody></table></div></details>'
    toc = ''.join(f'<a href="#{i}">{E(t)}</a>' for i,t in headings)
    page = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Picorer｜充分性实验完整资料</title><style>{STYLE}</style></head><body id="top">
<a class="skip" href="#report">跳转到报告正文</a><div class="layout"><nav aria-label="文件目录"><div class="brand">Picorer<button id="nav-toggle" aria-expanded="false" aria-controls="nav-links">目录</button></div><div class="nav-links" id="nav-links"><div class="nav-section">完整实验报告</div>{toc}<div class="nav-section">同文件附录</div><a href="#previous-report">A · 上一版报告全文</a><a href="#supplementary-figures">B · 全部补充图</a><a href="#statistics">C · 完整统计表与数据预览</a><a href="#protocol">D · 实验方案及运行记录</a><a href="#review-records">E · 结论与图表复核记录</a><a href="#embedded-data">F · 可提取资料与来源索引</a></div></nav>
<main id="report"><header><p class="eyebrow">RESEARCH COLLECTION · QWEN3.6-27B</p><h1>证据覆盖与原生充分性<br>完整实验资料</h1><p class="subtitle">2026 年 9 月 14 日 · 自然检索轨迹与三组离线实验</p><p class="meta">17 张独立图 · {len(tables)} 份 CSV 表 · 旧报告、综合报告、实验方案与核验记录</p><div class="actions"><button id="print-report">打印当前展开内容</button><button id="expand-all">展开全部附录与图片</button><button id="collapse-all">收起附录</button></div></header>
<aside class="intro-note"><p>这是一个可离线阅读、可直接转发的单文件。正文、图片和表格不依赖原文件夹或网络；目录及资料引用均可在文件内跳转。大表提供明确标注的预览，完整 CSV、原图 PNG/PDF 和方法材料另作为资料包嵌入本文件。外部学术参考链接仅供查阅，不影响离线阅读。</p></aside>
<article>{body}</article>
<details class="appendix" id="previous-report"><summary>附录 A · 上一版 R–S 报告全文</summary><p class="intro-note">以下保留 analysis-rs-v5 原报告内容，便于核对结论演变；新旧估计的样本、权重及回答协议不同。若解释存在张力，以综合报告说明的证据边界为准。</p><div class="appendix-body">{previous}</div></details>
<details class="appendix" id="supplementary-figures"><summary>附录 B · 全部补充图</summary><p class="meta">正文三个新增图与旧报告三个正文图已分别就地收录。这里补全其余十一张图，包括全样本和冲突题敏感性分析。图片保持原始像素，不裁剪、不重画、不改变轴或图例。</p>{''.join(gallery)}</details>
<details class="appendix" id="statistics"><summary>附录 C · 完整统计表与数据预览</summary><p>以下直接读取已完成分析的 CSV，不重新计算结果。estimate／mean 为估计值，low／high 为相应区间端点，questions／states 为题目数／状态数；具体估计和区间定义以正文与来源表为准。</p><p class="meta">显示的小数最多六位有效数字，鼠标停留可查看原精度；空字段显示为“—”，不当作零。超过 350 行的明细表仅预览前 20 行，全部原始行保存在本文件的内嵌资料包中。</p>{table_html}</details>
<details class="appendix" id="protocol"><summary>附录 D · 实验方案与运行变更记录</summary><div class="appendix-body">{protocol}</div></details>
<details class="appendix" id="review-records"><summary>附录 E · 结论与图表核对记录</summary><div class="appendix-body">{reviews}</div></details>
<section id="embedded-data"><h2>附录 F · 内嵌资料与来源索引</h2><p>下面的资料包已经存储在这个 HTML 文件内部，无需联网。需要另行分析、编辑或引用原图时，可从这里提取；平时阅读只需保留当前这一个文件。</p><p class="meta">资料包含 {len(assets)} 个源文件及清单，包括全部 {len(tables)} 份 CSV、17 张 PNG 及对应 PDF、原始 Markdown 报告、实验方案和审计材料。未打包服务器的全部原始 HTTP 响应、模型权重、被取代的旧版图和 J 数据。</p><div class="actions"><a id="archive-download" class="button primary" download="Picorer-Sufficiency-内嵌原始资料.zip" href="data:application/zip;base64,{b64}">提取内嵌原始资料包（{len(zip_bytes)/1024/1024:.1f} MB）</a></div><p class="filename">资料包 SHA-256：{hashlib.sha256(zip_bytes).hexdigest()}</p>{archive_index}</section>
<footer><a class="backtop" href="#top">返回顶部 ↑</a>本文件只整合已完成实验，不新增模型调用、不修改原始数值。原图英文与 Times New Roman 字体保持不变。整理与视觉审查流程及软件来源见报告末尾。</footer></main></div><script>{SCRIPT}</script></body></html>'''
    OUT.write_text(page,encoding='utf-8')
    manifest.update(output=str(OUT),html_bytes=OUT.stat().st_size,zip_bytes=len(zip_bytes),
                    zip_sha256=hashlib.sha256(zip_bytes).hexdigest())
    (HERE/'single-file-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:manifest[k] for k in ['output','figures','csv_tables','html_bytes','zip_bytes']},ensure_ascii=False))


if __name__ == '__main__':
    main()
