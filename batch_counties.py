#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量县城计算（可断点续跑）：
遍历 counties.json，跳过已存在 data/<adcode>.json（含 max_area）。
节奏：站间暂停，Overpass 失败则跳过继续。完成后刷新 zones.json。
用法：python3 batch_counties.py [--force] [--limit N] [--pause 8] [adcode ...]
"""
import sys, os, json, time
HERE=os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0,HERE)
import build_county, extract_zones

def main():
    args=sys.argv[1:]
    force="--force" in args; args=[a for a in args if a!="--force"]
    pause=8
    limit=None
    if "--pause" in args:
        i=args.index("--pause"); pause=float(args[i+1]); args=[a for a in args if a not in (args[i],args[i+1])]
    if "--limit" in args:
        i=args.index("--limit"); limit=int(args[i+1]); args=[a for a in args if a not in (args[i],args[i+1])]
    recs=build_county.load_counties()
    if args:
        recs=[r for r in recs if r["adcode"] in args]
    done=0
    for rec in recs:
        if limit and done>=limit: break
        ad=rec["adcode"]; dp=os.path.join(HERE,"data",f"{ad}.json")
        if (not force) and os.path.exists(dp):
            try:
                if json.load(open(dp,encoding="utf-8")).get("max_area") is not None or "max_area" in json.load(open(dp,encoding="utf-8")):
                    print(f"[{ad} {rec['name']}] 已存在，跳过"); continue
            except Exception: pass
        try:
            out=build_county.compute_county(rec)
        except Exception as e:
            print(f"[{ad} {rec['name']}] 计算失败，跳过: {e}"); time.sleep(pause); continue
        with open(dp,"w",encoding="utf-8") as f: json.dump(out,f,ensure_ascii=False)
        q=out["quality"]; ma=out["max_area"]
        print(f"[{ad} {rec['name']}] ✅ 路网{q['ways']} POI{q['pois']} 最大连片 {ma['size'] if ma else 0} 格\n")
        done+=1; time.sleep(pause)
    extract_zones.main()
    print(f"全部完成：本次处理 {done} 县城。")

if __name__=="__main__":
    main()
