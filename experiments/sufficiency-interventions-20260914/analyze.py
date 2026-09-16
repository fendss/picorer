"""Question-clustered analysis and separate, publication-style figures."""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata
import json
import os
import sys
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
import numpy as np
import pandas as pd
from scipy.special import expit
from scipy.stats import rankdata
import statsmodels.api as sm

SKILL=Path(os.environ.get('SCIENTIFIC_VISUALIZATION_SKILL','/Users/johnnychiu/.codex/skills/scientific-visualization'))
sys.path.insert(0,str(SKILL/'scripts'))
from figure_export import export_figure
from style_presets import style_context

SEED=20260914
BOOT=2000
COLORS=['#245C7C','#B21F32','#626262']
STYLE={'font.family':'serif','font.serif':['Times New Roman'],'font.size':11,
       'axes.labelsize':12,'xtick.labelsize':10.5,'ytick.labelsize':10.5,
       'legend.fontsize':10.5,'axes.linewidth':.7,'axes.edgecolor':'#555555',
       'text.color':'#262626','axes.labelcolor':'#262626','xtick.color':'#555555',
       'ytick.color':'#555555','axes.spines.top':False,'axes.spines.right':False,
       'pdf.fonttype':42,'ps.fonttype':42,'svg.fonttype':'none',
       'figure.constrained_layout.w_pad':.10,'figure.constrained_layout.h_pad':.10}


def interval(a):
    a=np.asarray(a,float);a=a[np.isfinite(a)]
    if not len(a):return np.nan,np.nan,np.nan
    rng=np.random.default_rng(SEED)
    v=rng.choice(a,size=(BOOT,len(a)),replace=True).mean(1)
    return a.mean(),*np.percentile(v,[2.5,97.5])


def weighted_corr(x,y,w):
    x=np.asarray(x);y=np.asarray(y);w=np.asarray(w)
    x=x-np.average(x,weights=w);y=y-np.average(y,weights=w)
    den=np.sqrt(np.sum(w*x*x)*np.sum(w*y*y))
    return np.sum(w*x*y)/den if den else np.nan


def correlation_table(d,sample):
    rows=[]
    for experiment in ['coverage','state_answers']:
        z=d[d.experiment.eq(experiment)].copy().reset_index(drop=True)
        if len(z)==0:continue
        groups=list(z.groupby('question_id').indices.values())
        w=1/z.groupby('question_id').r.transform('size').to_numpy()
        x=z.r.to_numpy();y=z.likelihood.to_numpy()
        xc=x-z.groupby('question_id').r.transform('mean').to_numpy()
        yc=y-z.groupby('question_id').likelihood.transform('mean').to_numpy()
        def estimate(idx):
            return [weighted_corr(x[idx],y[idx],w[idx]),
                weighted_corr(rankdata(x[idx]),rankdata(y[idx]),w[idx]),
                weighted_corr(xc[idx],yc[idx],w[idx])]
        point=estimate(np.arange(len(z)));rng=np.random.default_rng(SEED)
        boot=np.array([estimate(np.concatenate([groups[k] for k in rng.integers(len(groups),size=len(groups))])) for _ in range(BOOT)])
        for i,name in enumerate(['question_weighted_Pearson','question_weighted_Spearman','within_question_Pearson']):
            lo,hi=np.nanpercentile(boot[:,i],[2.5,97.5])
            rows.append(dict(sample=sample,experiment=experiment,metric=name,estimate=point[i],low=lo,high=hi,questions=len(groups)))
    return rows


def coverage_means(d,sample):
    c=d[d.experiment.eq('coverage')]
    q=c.groupby(['question_id','gold_hops','r'])[['likelihood','margin','official_score','exact_match']].mean().reset_index()
    rows=[]
    for (h,r),g in q.groupby(['gold_hops','r']):
        for metric in ['likelihood','official_score','exact_match']:
            mean,lo,hi=interval(g[metric])
            rows.append(dict(sample=sample,hops=h,r=r,metric=metric,mean=mean,low=lo,high=hi,questions=len(g)))
    return q,pd.DataFrame(rows)


def coverage_effects(d,sample):
    c=d[d.experiment.eq('coverage')];out=[];pairs=[]
    for (qid,order),g in c.groupby(['question_id','order']):
        bymask={int(x['mask']):x for x in g.to_dict('records')}
        h=int(g.iloc[0].gold_hops)
        for mask,left in bymask.items():
            for bit in range(h):
                if mask&(1<<bit):continue
                right=bymask.get(mask|(1<<bit))
                if right is None:continue
                pairs.append(dict(question_id=qid,order=order,mask=mask,hop=bit+1,
                    completes_chain=right['r']==1,
                    likelihood=right['likelihood']-left['likelihood'],
                    margin=right['margin']-left['margin'],
                    official_score=right['official_score']-left['official_score'],
                    token_change=right['input_tokens']-left['input_tokens']))
    p=pd.DataFrame(pairs)
    for subset,frame in [('all_additions',p),('last_missing_hop',p[p.completes_chain])]:
        q=frame.groupby('question_id')[['likelihood','margin','official_score','token_change']].mean()
        for metric in q:
            mean,lo,hi=interval(q[metric]);out.append(dict(sample=sample,comparison=subset,metric=metric,
                estimate=mean,low=lo,high=hi,questions=len(q)))
    # Question fixed effects; equal total weight per question and coverage level.
    z=c.copy();z['w']=1/z.groupby(['question_id','r']).r.transform('size')/(z.gold_hops+1)
    predictors=['r','input_tokens']
    centered=z[predictors+['likelihood']]-z.groupby('question_id')[predictors+['likelihood']].transform('mean')
    # Weighted centering is required for the fixed effects estimator.
    for col in predictors+['likelihood']:
        wm=(z[col]*z.w).groupby(z.question_id).transform('sum')/z.w.groupby(z.question_id).transform('sum')
        centered[col]=z[col]-wm
    fit=sm.WLS(centered.likelihood,centered[predictors],weights=z.w).fit()
    matrices=[];vectors=[]
    for ids in z.groupby('question_id').indices.values():
        xx=centered[predictors].iloc[ids].to_numpy();ww=z.w.iloc[ids].to_numpy();yy=centered.likelihood.iloc[ids].to_numpy()
        matrices.append(xx.T@(ww[:,None]*xx));vectors.append(xx.T@(ww*yy))
    n=len(matrices);counts=np.random.default_rng(SEED).multinomial(n,np.full(n,1/n),size=BOOT)
    bm=np.einsum('bq,qij->bij',counts,np.asarray(matrices));bv=counts@np.asarray(vectors)
    valid=np.linalg.matrix_rank(bm)==len(predictors)
    boot=np.linalg.solve(bm[valid],bv[valid,:,None])[:,:,0];ci=np.percentile(boot,[2.5,97.5],axis=0)
    for i,term in enumerate(predictors):out.append(dict(sample=sample,comparison='question_FE_length_adjusted',metric=term,
        estimate=fit.params[term],low=ci[0,i],high=ci[1,i],questions=z.question_id.nunique(),bootstrap_success=int(valid.sum())))
    return p,pd.DataFrame(out)


def preview_effects(d,sample):
    p=d[d.experiment.eq('preview')]
    wide=p.pivot(index=['parent_state','question_id','run'],columns='condition',values='likelihood')
    records=[];raw=[]
    comparisons=[('relevant','irrelevant','Relevant vs. unrelated'),('removed','original','Removed vs. original'),
                 ('irrelevant','original','Unrelated vs. original')]
    for a,b,label in comparisons:
        if a not in wide or b not in wide:continue
        paired=(wide[a]-wide[b]).dropna().rename('delta').reset_index()
        q=paired.groupby(['question_id','run']).delta.mean().groupby('question_id').mean()
        for qid,v in q.items():raw.append(dict(sample=sample,comparison=label,question_id=qid,delta=v))
        mean,lo,hi=interval(q)
        records.append(dict(sample=sample,comparison=label,mean=mean,low=lo,high=hi,
            questions=len(q),states=len(paired)))
    return pd.DataFrame(raw),pd.DataFrame(records)


def design(d,model):
    x=pd.DataFrame({'intercept':np.ones(len(d))},index=d.index)
    if model in ['Coverage','Coverage + likelihood','Coverage + margin']:x['r']=d.r
    if model in ['Likelihood','Coverage + likelihood']:x['likelihood']=d.likelihood
    if model=='Coverage + likelihood':x['interaction']=d.r*d.likelihood
    if model=='Coverage + margin':
        x['margin']=d.margin/10;x['interaction']=d.r*d.margin/10
    return x


def real_state_regression(d,sample):
    z=d[d.experiment.eq('state_answers')].copy().reset_index(drop=True)
    x=design(z,'Coverage + likelihood');y=z.official_score
    weights=1/z.groupby('question_id').r.transform('size')
    fit=sm.GLM(y,x,family=sm.families.Binomial(),freq_weights=weights).fit()
    groups=list(z.groupby('question_id').indices.values());rng=np.random.default_rng(SEED);betas=[]
    for _ in range(BOOT):
        idx=np.concatenate([groups[k] for k in rng.integers(len(groups),size=len(groups))])
        try:
            f=sm.GLM(y.iloc[idx].to_numpy(),x.iloc[idx].to_numpy(),family=sm.families.Binomial(),freq_weights=weights.iloc[idx].to_numpy()).fit(maxiter=80)
            if f.converged and np.isfinite(f.params).all():betas.append(np.asarray(f.params))
        except (np.linalg.LinAlgError,ValueError):pass
    betas=np.array(betas);ci=np.percentile(betas,[2.5,97.5],axis=0)
    coefficients=pd.DataFrame([dict(sample=sample,term=t,estimate=fit.params[t],low=ci[0,i],high=ci[1,i],bootstrap_success=len(betas)) for i,t in enumerate(x)])
    curves=[]
    for r in [0,.5,1]:
        support=z[np.isclose(z.r,r)]
        if support.question_id.nunique()<5:continue
        grid=np.linspace(support.likelihood.min(),support.likelihood.max(),80)
        new=pd.DataFrame({'r':r,'likelihood':grid});xx=design(new,'Coverage + likelihood')
        pred=expit(xx.to_numpy()@fit.params.to_numpy());boot=expit(xx.to_numpy()@betas.T)
        lo,hi=np.percentile(boot,[2.5,97.5],axis=1)
        for p,m,l,h in zip(grid,pred,lo,hi):curves.append(dict(sample=sample,r=r,likelihood=p,mean=m,low=l,high=h))
    # Cross-validation separates QUESTIONS, not states, runs, or answer samples.
    qids=np.array(sorted(z.question_id.unique()));np.random.default_rng(SEED).shuffle(qids)
    folds={q:i%5 for i,q in enumerate(qids)};cv=[]
    for model in ['Coverage','Likelihood','Coverage + likelihood','Coverage + margin']:
        xx=design(z,model);pred=np.empty(len(z))
        for fold in range(5):
            test=z.question_id.map(folds).eq(fold).to_numpy();train=~test
            f=sm.GLM(y[train],xx[train],family=sm.families.Binomial(),freq_weights=weights[train]).fit_regularized(alpha=1e-5,L1_wt=0,maxiter=1000)
            pred[test]=np.clip(f.predict(xx[test]),1e-8,1-1e-8)
        for i,row in z.iterrows():
            yy=float(y.iloc[i]);pp=float(pred[i])
            cv.append(dict(sample=sample,unit=row.id,question_id=row.question_id,fold=folds[row.question_id],model=model,
                prediction=pp,observed=yy,log_loss=-(yy*np.log(pp)+(1-yy)*np.log(1-pp)),
                brier=yy*(1-pp)**2+(1-yy)*pp**2))
    cv=pd.DataFrame(cv);metrics=[]
    qloss=cv.groupby(['question_id','model'])[['log_loss','brier']].mean().reset_index()
    for model,g in qloss.groupby('model'):
        for metric in ['log_loss','brier']:
            mean,lo,hi=interval(g[metric]);metrics.append(dict(sample=sample,model=model,metric=metric,estimate=mean,low=lo,high=hi))
    wide=qloss.pivot(index='question_id',columns='model',values='log_loss')
    for model in ['Coverage + likelihood','Coverage + margin']:
        mean,lo,hi=interval(wide[model]-wide['Coverage'])
        metrics.append(dict(sample=sample,model=model+' minus Coverage',metric='paired_log_loss_difference',estimate=mean,low=lo,high=hi))
    return coefficients,pd.DataFrame(curves),cv,pd.DataFrame(metrics)


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',type=Path,default=Path(__file__).resolve().parent)
    ap.add_argument('--pilot',action='store_true');args=ap.parse_args();root=args.root
    status=json.loads((root/'summary/status.json').read_text())
    if status['missing_jobs'] and not args.pilot:raise RuntimeError('Refuse final analysis with missing jobs')
    d=pd.read_csv(root/'summary/units.csv');d=d[d.complete].copy()
    if args.pilot:d=d[d.ordinal<10]
    out=root/('pilot-analysis' if args.pilot else 'analysis');out.mkdir(exist_ok=True)
    for path in (root/'fonts').glob('*.ttf'):font_manager.fontManager.addfont(str(path))
    font=font_manager.findfont('Times New Roman',fallback_to_default=False)
    provenance={'source':str(root/'summary/units.csv'),'source_sha256':hashlib.sha256((root/'summary/units.csv').read_bytes()).hexdigest(),
        'uncertainty':'95% question-cluster bootstrap; 2000 draws; seed 20260914',
        'font':font,'pilot':args.pilot,'python':sys.version,
        'packages':{p:importlib.metadata.version(p) for p in ['numpy','pandas','scipy','statsmodels','matplotlib','seaborn','pypdf']}}
    (out/'environment.json').write_text(json.dumps(provenance,indent=2))
    def export(fig,name,source,description):
        export_figure(fig,out/name,formats=['pdf','png'],dpi=400,bbox_inches=None,
            provenance=dict(provenance,table=source,description=description),write_manifest=True,overwrite=True)
        plt.close(fig)
    combined_corr=[];tables={}
    for sample,z in [('unconflicted',d[~d.conflicted]),('all',d),('conflicted',d[d.conflicted])]:
        if z.question_id.nunique()<3:continue
        q,means=coverage_means(z,sample);pairs,effects=coverage_effects(z,sample)
        raw,preview=preview_effects(z,sample)
        for name,table in [('coverage-question-means',q),('coverage-means',means),('coverage-pairs',pairs),('coverage-effects',effects),
                          ('preview-question-effects',raw),('preview-effects',preview)]:
            table.to_csv(out/f'{sample}-{name}.csv',index=False)
        combined_corr+=correlation_table(z,sample)
        if not args.pilot:
            coef,curves,cv,metrics=real_state_regression(z,sample)
            for name,table in [('regression',coef),('regression-curves',curves),('heldout-predictions',cv),('heldout-metrics',metrics)]:
                table.to_csv(out/f'{sample}-{name}.csv',index=False)
        tables[sample]=(means,preview,raw)
    pd.DataFrame(combined_corr).to_csv(out/'correlations.csv',index=False)
    with style_context('default'),plt.rc_context(STYLE):
        for sample,(means,preview,raw) in tables.items():
            prefix='' if sample=='unconflicted' else f'S-{sample}-'
            for metric,name,ylabel in [('likelihood','01-coverage-likelihood','Sufficiency likelihood'),
                    ('official_score','02-coverage-accuracy','Answer accuracy')]:
                fig,ax=plt.subplots(figsize=(5.3,3.8),layout='constrained')
                for i,h in enumerate([2,3,4]):
                    g=means[(means.hops==h)&(means.metric==metric)]
                    if g.empty:continue
                    ax.plot(g.r,g['mean'],marker=['o','s','^'][i],linestyle=['-','--',':'][i],
                            color=COLORS[i],lw=1.7,ms=5,label=f'{h}-hop')
                    ax.fill_between(g.r,g.low,g.high,color=COLORS[i],alpha=.10,lw=0)
                ax.set(xlabel='Evidence coverage',ylabel=ylabel,xlim=(-.025,1.025),ylim=(-.025,1.025))
                ax.set_xticks([0,.25,.5,.75,1]);ax.set_yticks([0,.25,.5,.75,1])
                ax.legend(frameon=False,loc='lower left',bbox_to_anchor=(0,1.015),ncol=3,handlelength=1.5,columnspacing=1.1,borderaxespad=0)
                ax.grid(axis='y',color='#EAEAEA',lw=.5);ax.set_axisbelow(True)
                export(fig,prefix+name,f'{sample}-coverage-means.csv','Question means after averaging evidence subsets and orders; shaded pointwise 95% intervals.')
            fig,ax=plt.subplots(figsize=(5.7,3.2),layout='constrained')
            for i,row in preview.reset_index(drop=True).iterrows():
                points=raw[raw.comparison==row.comparison].delta.to_numpy()
                jitter=np.random.default_rng(SEED+i).uniform(-.12,.12,len(points))
                ax.scatter(points,np.full(len(points),i)+jitter,s=13,color='#999999',alpha=.35,linewidths=0)
                ax.errorbar(row['mean'],i,xerr=[[row['mean']-row.low],[row.high-row['mean']]],fmt='o',
                    color=COLORS[0] if i==0 else COLORS[2],ms=6,capsize=3,lw=1.7)
            ax.axvline(0,color='#777777',lw=.8,ls='--')
            ax.set_yticks(range(len(preview)),preview.comparison);ax.invert_yaxis()
            ax.set_xlabel('Change in sufficiency likelihood');ax.spines['left'].set_visible(False);ax.tick_params(axis='y',length=0)
            export(fig,prefix+'03-preview-effect',f'{sample}-preview-effects.csv','Each gray point is one question; colored points and intervals show paired mean changes and 95% intervals.')
        if not args.pilot:
            curves=pd.read_csv(out/'unconflicted-regression-curves.csv')
            fig,ax=plt.subplots(figsize=(5.3,3.8),layout='constrained')
            for i,r in enumerate([0,.5,1]):
                g=curves[np.isclose(curves.r,r)]
                if g.empty:continue
                ax.plot(g.likelihood,g['mean'],color=COLORS[i],ls=[':', '--','-'][i],lw=1.8,label=f'Coverage = {r:g}')
                ax.fill_between(g.likelihood,g.low,g.high,color=COLORS[i],alpha=.10,lw=0)
            ax.set(xlabel='Sufficiency likelihood',ylabel='Estimated answer accuracy',xlim=(-.025,1.025),ylim=(-.025,1.025))
            ax.legend(frameon=False,loc='best');ax.grid(axis='y',color='#EAEAEA',lw=.5)
            export(fig,'04-state-answer-regression','unconflicted-regression-curves.csv','Binomial regression with coverage, likelihood, and their interaction; fitted curves, not held-out calibration.')
    if not args.pilot:
        effects=pd.read_csv(out/'unconflicted-coverage-effects.csv')
        preview=pd.read_csv(out/'unconflicted-preview-effects.csv')
        cv=pd.read_csv(out/'unconflicted-heldout-metrics.csv')
        def effect(comparison,metric):
            row=effects[(effects.comparison==comparison)&(effects.metric==metric)].iloc[0]
            return f'{row.estimate:.3f}（95% 区间 {row.low:.3f} 至 {row.high:.3f}）'
        pv=preview[preview.comparison=='Relevant vs. unrelated'].iloc[0]
        cc=cv[(cv.model=='Coverage + likelihood minus Coverage')&(cv.metric=='paired_log_loss_difference')].iloc[0]
        report=f'''# 实验结果：Sufficiency likelihood 与证据覆盖率

全部 {status['completed_jobs']:,} 个推理任务已收齐。100 道题、2,150 个真实状态；每个回答条件 5 次独立生成。两个 Qwen 服务是同一模型的推理副本，不是两个不同模型。

其中 {status['fallback_answers']:,} 个最终答案使用了预先规定的空输出 no-thinking 回退。原空输出和回退响应均保留，没有将空输出直接当作答错；任务数指逻辑测量任务，不等于包含回退的全部 HTTP 调用次数。

另有 {status.get('retried_jobs',0):,} 个任务因执行失败或输出不完整而按原参数补跑，归档了 {status.get('archived_failed_attempts',0):,} 次未完成记录；原输入、seed 和输出上限未变，没有因为答案错误而重试。原始记录位于 retry-history。补跑并不能保证消除与生成失败相关的选择偏差，需结合失败比例解释结果。

主分析使用 64 道无已知标准答案冲突的题目；全部 100 题及 36 道已知冲突题的结果另存。置信区间按题目重采样，不把状态和答案重复采样当成独立题目。

## 1. 补充标准证据会怎样？

固定问题、输入模板、证据槽数量和排列，用一条标准证据替换近似等长无关事实，likelihood 的平均配对变化为 {effect('all_additions','likelihood')}。补齐最后一条标准证据时，变化为 {effect('last_missing_hop','likelihood')}。

![证据覆盖率与 likelihood 的题目均值](01-coverage-likelihood.png)

图 1：各题先平均同覆盖率下的事实组合和正反排列，再跨题平均。三条线分别为 2、3、4 跳题目；阴影为逐点 95% 区间。它描述干净受控输入中的结果，不是自然轨迹的未经修改状态。

相同配对比较中，补齐最后一条标准证据时，答案正确率的平均变化为 {effect('last_missing_hop','official_score')}。

![证据覆盖率与答题正确率](02-coverage-accuracy.png)

图 2：每个证据组合独立回答 5 次，使用原 benchmark 评分器。图中的正确率来自当前组合，而非原轨迹最终答案。

## 2. 证据包不变，预览是否仍然有影响？

在 {int(pv.questions)} 道题、{int(pv.states)} 个符合条件的真实状态中，相对无关预览，加入未入包标准事实的预览使 likelihood 平均变化 {pv['mean']:.3f}（95% 区间 {pv.low:.3f} 至 {pv.high:.3f}）。该比较中证据包及 R 完全不变。

![只改变搜索预览的配对结果](03-preview-effect.png)

图 3：灰点代表题目层面的配对变化，深色点和横线为均值及 95% 区间。主要对比是相关预览与无关预览；另外两个对比使用各自符合条件的状态，因此样本集合可能不同，详见 preview-effects 表。文本排除检查不能证明不存在所有语义改写或模型参数知识。

## 3. Likelihood 能否提供覆盖率之外的答题信息？

![当前状态的答题正确率回归](04-state-answer-regression.png)

图 4：使用当前状态证据包的答案，而不是整条轨迹最后的答案。曲线来自覆盖率、likelihood 及交互项的二项回归，展示样本支持范围内的拟合关系；不是留出测试的校准图。

进一步按题目分成 5 折测试，保证同题的所有轨迹和状态不跨训练/测试集。加入 likelihood 后，联合模型相对只用覆盖率模型的测试对数损失变化为 {cc.estimate:.4f}（95% 区间 {cc.low:.4f} 至 {cc.high:.4f}）；负值代表预测误差减小，区间包含零则不能据此确认改善。

## 解释边界与核验状态

- R 是证据包中的标准事实覆盖率，不是证据条目总数，也不等于模型看见的全部信息。
- Likelihood 是既定 finish 前缀下的 sufficient/insufficient 条件比较，不是主动结束检索的概率。
- 标准证据链未必是唯一最小充分集合。低 R 时答对，不能直接解释为模型错误或测量失效。
- 本次回答禁用完整原文自动扩展，保证回答使用的事实与当前精确证据包对应。答案采样参数统一为 temperature=0.7、top_p=0.8、low reasoning。
- 初始字段排序错误的 pilot 已隔离，未用于本报告；正式 original 重放全部要求逐 token 匹配历史前缀。
- 相关系数见 correlations.csv；长度调整与配对效应见 unconflicted-coverage-effects.csv；回归与分题测试结果见 unconflicted-regression.csv 和 unconflicted-heldout-metrics.csv。
- 本报告为自动汇总。机械导出检查见 export-validation.json；人工视觉与案例复核仍需单独记录，不能由程序检查代替。

绘图采用 scientific-visualization skill 的可追溯导出与字体审计流程。软件方法来源：[Kassis et al., Scientific Agent Skills (2026)](https://doi.org/10.48550/arXiv.2609.00065)。
'''
        (out/'REPORT.zh-CN.md').write_text(report)
    print(json.dumps({'output':str(out),'questions':d.question_id.nunique(),'complete_units':len(d),'pilot':args.pilot}))


if __name__=='__main__':main()
