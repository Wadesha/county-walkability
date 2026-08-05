#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 counties/data/<adcode>.json 提取每个县城「最大友好连片」(max_area)，
转成展示用 counties/data/zones.json（WGS-84 中心 + 每格半宽半高，前端再转 GCJ-02 上腾讯底图）。

迭代5（可比性标准化）：除原有的「连片均分 score_avg」（街道品质）外，额外计算
  - score_mean：县城 169 格整体好走度均值（县城好走度总览）
  - comparable_score：score_mean 在全省 min–max 归一化到 0–100（县城之间可比）
  - province_rank / global_rank：按 comparable_score 排名（1=最好）
全部基于已存盘的每格分数，无需重拉 OSM。
"""
import json, os, math
HERE=os.path.dirname(os.path.abspath(__file__))
DATA=os.path.join(HERE,"data")
CELL_M=160

def main():
    recs={}
    for rec in json.load(open(os.path.join(DATA,"counties.json"),encoding="utf-8")):
        recs[rec["adcode"]]=rec
    zones=[]
    skipped=[]
    for fn in sorted(os.listdir(DATA)):
        if not fn.endswith(".json") or not fn[:-5].isdigit(): continue
        d=json.load(open(os.path.join(DATA,fn),encoding="utf-8"))
        ma=d.get("max_area")
        if not ma:
            skipped.append(d["name"]); continue
        lat0=d["center"][1]; mLng=111320.0*math.cos(lat0*math.pi/180); mLat=111320.0
        w=CELL_M/mLng/2; h=CELL_M/mLat/2
        cells=[{"c":[round(cx,6),round(cy,6)],"w":round(w,7),"h":round(h,7)}
               for (cx,cy) in [d["cells"]["features"][i*13+j]["properties"]["center"]
                               for (i,j) in ma["cells"]]]
        # 县城整体好走度均值（全部 169 格）
        allscores=[f["properties"]["score"] for f in d["cells"]["features"]]
        score_mean=round(sum(allscores)/len(allscores),1) if allscores else 0
        rec=recs.get(d["id"],{})
        zones.append({"id":d["id"],"name":d["name"],"province":d.get("province"),
            "parent":d.get("parent"),"center":d["center"],"gcj_center":d.get("gcj_center"),
            "score_avg":ma["score_avg"],"score_mean":score_mean,"size":ma["size"],
            "quality":d.get("quality",{}),"cells":cells})
    zones.sort(key=lambda z:(z["province"],z["parent"],-z["score_mean"],z["name"]))

    # 迭代5：min-max 归一化 + 排名
    by_prov={}
    for z in zones: by_prov.setdefault(z["province"],[]).append(z)
    all_means=[z["score_mean"] for z in zones]
    gmin,gmax=min(all_means),max(all_means)
    for prov,zs in by_prov.items():
        pmeans=[z["score_mean"] for z in zs]; pmin,pmax=min(pmeans),max(pmeans)
        for z in zs:
            z["comparable_score"]=round((z["score_mean"]-pmin)/(pmax-pmin)*100,1) if pmax>pmin else 50.0
    # 排名（按 score_mean 降序，1=最好）
    by_rank=sorted(zones,key=lambda z:-z["score_mean"])
    for i,z in enumerate(by_rank): z["global_rank"]=i+1
    for prov,zs in by_prov.items():
        zs_sorted=sorted(zs,key=lambda z:-z["score_mean"])
        for i,z in enumerate(zs_sorted): z["province_rank"]=i+1

    out={"generated":"2026-08-05","count":len(zones),"zones":zones}
    with open(os.path.join(DATA,"zones.json"),"w",encoding="utf-8") as f:
        json.dump(out,f,ensure_ascii=False,indent=1)
    from collections import Counter
    c=Counter(z["province"] for z in zones)
    print(f"zones.json 写出 ✅ 共 {len(zones)} 县城有友好连片（跳过 {len(skipped)} 个无连片）")
    for k,v in c.items(): print(f"  {k}: {v}")
    # 打印各省略影：同省前3
    print("--- 各省最好走的县城（同省排名）---")
    for prov,zs in by_prov.items():
        zs_sorted=sorted(zs,key=lambda z:-z["score_mean"])
        top=", ".join(f"{z['name']}({z['score_mean']})" for z in zs_sorted[:3])
        print(f"  {prov}: {top}")

if __name__=="__main__":
    main()
