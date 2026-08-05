# -*- coding: utf-8 -*-
"""两级抓取四省「县城/县级市」中心坐标：
  省 _full.json -> 地级市(adcode) -> 市 _full.json -> 区县(level=district)
DataV 坐标 GCJ-02，转 WGS-84 供 OSM 拉取。
过滤：去掉市辖区(name 以「区」结尾)，保留县/县级市；省直辖县级市(无 children)按 name 结尾 市/县 保留。
"""
import json, urllib.request, math

PROV = {"370000":"山东","320000":"江苏","340000":"安徽","410000":"河南"}
OUT = "counties/data/counties.json"

a=6378245.0; ee=0.00669342162296594323
def _tlat(lng,lat):
    r=math.pi/180
    ret=-100+2*lng+3*lat+0.2*lat*lat+0.1*lng*lat+0.2*math.sqrt(abs(lng))
    ret+=(20*math.sin(6*lng*r)+20*math.sin(2*lng*r))*2/3
    ret+=(20*math.sin(lat*r)+40*math.sin(lat/3*r))*2/3
    ret+=(160*math.sin(lat/12*r)+320*math.sin(lat*r/30))*2/3
    return ret
def _tlng(lng,lat):
    r=math.pi/180
    ret=300+lng+2*lat+0.1*lng*lng+0.1*lng*lat+0.1*math.sqrt(abs(lng))
    ret+=(20*math.sin(6*lng*r)+20*math.sin(2*lng*r))*2/3
    ret+=(20*math.sin(lat*r)+40*math.sin(lat/3*r))*2/3
    ret+=(160*math.sin(lat/12*r)+320*math.sin(lat*r/30))*2/3
    return ret
def wgs2gcj(lat,lng):
    dlat=_tlat(lng-105,lat-35); dlng=_tlng(lng-105,lat-35)
    rlat=lat/180*math.pi
    magic=1-ee*math.sin(rlat)**2; sq=math.sqrt(magic)
    dlat=(dlat*180)/((a*(1-ee))/(magic*sq)*math.pi)
    dlng=(dlng*180)/(a/sq*math.cos(rlat)*math.pi)
    return lat+dlat, lng+dlng
def gcj2wgs(lng,lat):
    # 近似反算：WGS ≈ 2·GCJ − wgs2gcj(GCJ)，误差 < ~1m
    glat,glng=wgs2gcj(lat,lng)
    return lng*2-glng, lat*2-glat

def get(url):
    req=urllib.request.Request(url,headers={"User-Agent":"county-fetch/1.0"})
    return json.loads(urllib.request.urlopen(req,timeout=120).read().decode())

def main():
    out=[]
    for pacode,prov in PROV.items():
        provdata=get(f"https://geo.datav.aliyun.com/areas_v3/bound/{pacode}_full.json")
        cities=[f for f in provdata.get("features",[]) if f.get("properties",{}).get("level")=="city"]
        for cf in cities:
            cp=cf.get("properties",{})
            cad=cp.get("adcode"); cname=cp.get("name")
            cn=cp.get("childrenNum",0)
            if cn==0 and (cname.endswith("市") or cname.endswith("县")):
                c=cp.get("center")
                if c:
                    wlng,wlat=gcj2wgs(c[0],c[1])
                    out.append({"name":cname,"province":prov,"parent":cname,"adcode":cad,
                                "gcj":[round(c[0],5),round(c[1],5)],"wgs":[round(wlng,6),round(wlat,6)]})
                continue
            try:
                cdata=get(f"https://geo.datav.aliyun.com/areas_v3/bound/{cad}_full.json")
            except Exception as e:
                print(f"  {cname}({cad}) 失败: {e}"); continue
            for df in cdata.get("features",[]):
                dp=df.get("properties",{})
                name=dp.get("name","")
                if name.endswith("区"): continue
                c=dp.get("center") or dp.get("centroid")
                if not c: continue
                wlng,wlat=gcj2wgs(c[0],c[1])
                out.append({"name":name,"province":prov,"parent":cname,"adcode":dp.get("adcode"),
                            "gcj":[round(c[0],5),round(c[1],5)],"wgs":[round(wlng,6),round(wlat,6)]})
    seen=set(); uniq=[]
    for r in out:
        k=(r["province"],r["name"])
        if k in seen: continue
        seen.add(k); uniq.append(r)
    uniq.sort(key=lambda r:(r["province"],r["parent"],r["name"]))
    with open(OUT,"w",encoding="utf-8") as f:
        json.dump(uniq,f,ensure_ascii=False,indent=1)
    from collections import Counter
    c=Counter(r["province"] for r in uniq)
    print("总计县城/县级市:",len(uniq))
    for k,v in c.items(): print(f"  {k}: {v}")

if __name__=="__main__":
    main()
