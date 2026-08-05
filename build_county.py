#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
县城版步行友好专题（离线真实数据管线）。

与火车站版 build_station.py 的唯一区别：
  - 计算锚点 = 县城中心（来自 DataV 行政区划 centroid，已 GCJ-02→WGS-84），
    不再做「回正到 OSM 火车站」那一步（县城不一定有火车站）。
  - 其余打分逻辑 100% 复用，保证县城与城市「好走度」可比：
      可达0.30 / 连通0.18 / 舒适0.17 / 安全0.15 / 吸引0.20
    友好区域 = 无 POI 重加权(可达+连通+舒适+安全) ≥ 阈值 的相邻格连通聚类。
  - 额外记录数据质量字段 quality（路网段数/POI数/建筑数/绿地数），用于透明度与稀疏县城的 caveat。

数据源：OSM Overpass（路网/POI/建筑/绿地） + Open-Meteo 高程（坡度）。
仅用 Python 标准库。
输出 counties/data/<adcode>.json。
"""
import sys, json, math, urllib.request, urllib.parse, heapq, os, time, socket, signal
# 防止 Overpass 卡死连接：单条 socket 操作最多 60s（urlopen 的 timeout 在部分
# HTTPS stalled 连接下不可靠，全局默认超时才稳）。失败会自动换端点/重试。
socket.setdefaulttimeout(60)

HERE = os.path.dirname(os.path.abspath(__file__))
COUNTIES = os.path.join(HERE, "data", "counties.json")

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]
ELEV_API = "https://api.open-meteo.com/v1/elevation"

QUERY_R_M = 2200
GRID_HALF = 1000
CELL_M = 160
N = 13
FRIENDLY_THRESH = 65
W_ACCESS = {"park":1.0,"metro":1.2,"shop":0.9,"school":0.7,"hospital":0.8}
W_PFOI = {"access":0.30/0.80,"conn":0.18/0.80,"comfort":0.17/0.80,"safety":0.15/0.80}

def poi_free_score(p):
    return (W_PFOI["access"]*p["access"] + W_PFOI["conn"]*p["conn"]
            + W_PFOI["comfort"]*p["comfort"] + W_PFOI["safety"]*p["safety"])

def hav(lng1,lat1,lng2,lat2):
    R=6371000; r=math.pi/180
    dLat=(lat2-lat1)*r; dLng=(lng2-lng1)*r
    a=math.sin(dLat/2)**2+math.cos(lat1*r)*math.cos(lat2*r)*math.sin(dLng/2)**2
    return 2*R*math.asin(math.sqrt(a))

class _OverpassHardTimeout(Exception):
    pass

def _on_alarm(signum, frame):
    raise _OverpassHardTimeout()

def overpass(q, tries=2):
    """逐端点尝试；单端点硬超时 150s（signal.alarm 兜底，专治“连接通但无数据”的假死）。
    任一端点成功即返回；全部失败抛异常，由 batch 跳过该县城继续。"""
    last=None
    prev=None
    try:
        prev=signal.signal(signal.SIGALRM,_on_alarm)
        for ep in OVERPASS_ENDPOINTS:
            for attempt in range(tries):
                signal.alarm(150)
                try:
                    data=urllib.parse.urlencode({"data":q}).encode()
                    req=urllib.request.Request(ep,data=data,headers={"User-Agent":"county-walk/1.0"})
                    with urllib.request.urlopen(req,timeout=60) as resp:
                        return json.load(resp)
                except _OverpassHardTimeout:
                    last=RuntimeError("overpass 硬超时150s @ %s"%ep); time.sleep(2); continue
                except Exception as e:
                    last=e; time.sleep(3)
                finally:
                    signal.alarm(0)
    finally:
        if prev is not None:
            signal.signal(signal.SIGALRM,prev)
    raise last or RuntimeError("overpass failed")

# 高程接口偶尔被限流（429）。首次失败即整轮禁用，避免每个县城都空等数十秒。
ELEV_OK = True

def elev_batch(points, retries=2):
    import urllib.error
    global ELEV_OK
    if not ELEV_OK:
        return {}
    out={}
    for i in range(0,len(points),100):
        chunk=points[i:i+100]
        lat=",".join(str(p[0]) for p in chunk)
        lng=",".join(str(p[1]) for p in chunk)
        url=f"{ELEV_API}?latitude={lat}&longitude={lng}"
        ok=False
        for attempt in range(retries):
            try:
                req=urllib.request.Request(url,headers={"User-Agent":"county-walk/1.0"})
                with urllib.request.urlopen(req,timeout=20) as resp:
                    j=json.load(resp)
                for p,e in zip(chunk,j.get("elevation",[])):
                    out[(round(p[0],6),round(p[1],6))]=e
                ok=True
                break
            except Exception:
                time.sleep(3)
        if not ok:
            print(f"  [elev] 高程接口不可用，整轮降级为坡度0（舒适分取中性）")
            ELEV_OK=False
            return {}
    return out

def classify(tags):
    if not tags: return None
    if tags.get("leisure") in ("park","garden"): return "park"
    if tags.get("railway") in ("station","halt","stop","tram_stop") or tags.get("station")=="subway": return "metro"
    if "shop" in tags: return "shop"
    am=tags.get("amenity")
    if am in ("hospital","clinic","dentist"): return "hospital"
    if am in ("school","university","college","kindergarten"): return "school"
    if am: return "shop"
    return None

def coords_of(el):
    g=el.get("geometry")
    if not g: return []
    out=[]
    for c in g:
        if isinstance(c,dict): out.append((c["lon"],c["lat"]))
        elif isinstance(c,list): out.append((c[0],c[1]))
    return out

# ---------------------------------------------------------------------------
# 自有 POI / 路网数据入口（跳过 Overpass；适合自带数据集或 Overpass 被封时）
# 把文件放到 data/own/<adcode>.json 即可，格式见 README「使用自有 POI 数据」。
# ---------------------------------------------------------------------------
OWN_DIR = os.path.join(HERE, "data", "own")

def _parse_elements(data):
    """把 Overpass 形状的 elements 解析成 (ways, pois, buildings, greens)。"""
    ways=[]; pois=[]; buildings=[]; greens=[]
    for el in data.get("elements",[]):
        t=el.get("type"); tags=el.get("tags",{})
        if t=="way" and tags.get("highway"): ways.append(el)
        if t=="way" and tags.get("building"): buildings.append(el)
        if t=="way" and tags.get("leisure") in ("park","garden"): greens.append(el)
        ctype=classify(tags)
        if not ctype: continue
        if t=="node" and "lat" in el: pll=(el["lon"],el["lat"])
        elif t=="way" and el.get("geometry"):
            g=coords_of(el)
            if not g: continue
            pll=(sum(c[0] for c in g)/len(g), sum(c[1] for c in g)/len(g))
        else: continue
        pn=tags.get("name") or tags.get("name:en") or ctype
        pois.append({"lng":pll[0],"lat":pll[1],"type":ctype,"name":pn})
    return ways, pois, buildings, greens

def load_own(rec):
    """返回自有数据 dict，或 None（None=走默认 Overpass）。
    两种子格式：
      A) {"elements":[...]}           透传 Overpass 原始数据（nodes/ways + geometry/tags）
      B) {"pois":[...],"roads":[...]} 简化 POI+路网；pois.type ∈ park/metro/shop/school/hospital
    """
    p=os.path.join(OWN_DIR,f"{rec['adcode']}.json")
    if not os.path.exists(p): return None
    d=json.load(open(p,encoding="utf-8"))
    if "elements" in d:
        return {"mode":"overpass","elements":d["elements"]}
    ways=[]
    for r in d.get("roads",[]):
        geo=r.get("geometry",[])
        if len(geo)<2: continue
        ways.append({"type":"way",
                     "geometry":[{"lon":c[0],"lat":c[1]} for c in geo],
                     "tags":{"highway":r.get("highway","residential")}})
    pois=[]
    for p0 in d.get("pois",[]):
        t=p0.get("type")
        if t not in ("park","metro","shop","school","hospital"): continue
        pois.append({"lng":p0["lng"],"lat":p0["lat"],"type":t,
                     "name":p0.get("name") or t})
    greens=[w for w in d.get("greens",[]) if w.get("geometry")]
    buildings=[w for w in d.get("buildings",[]) if w.get("geometry")]
    return {"mode":"simple","ways":ways,"pois":pois,
            "greens":greens,"buildings":buildings}

def build_graph(ways, skip=("motorway","motorway_link")):
    adj={}; nodes={}
    def nid(lon,lat): return (round(lon,5),round(lat,5))
    for w in ways:
        hw=w.get("tags",{}).get("highway")
        if hw in skip: continue
        geo=coords_of(w)
        if len(geo)<2: continue
        pts=[(round(c[0],5),round(c[1],5)) for c in geo]
        for p in pts: nodes[p]=p
        for a,b in zip(pts,pts[1:]):
            d=hav(a[0],a[1],b[0],b[1])
            adj.setdefault(a,[]).append((b,d)); adj.setdefault(b,[]).append((a,d))
    return adj, nodes

def dijkstra(adj, src):
    dist={src:0.0}; pq=[(0.0,src)]
    while pq:
        d,u=heapq.heappop(pq)
        if d>dist.get(u,1e18): continue
        for v,w in adj.get(u,[]):
            nd=d+w
            if nd<dist.get(v,1e18): dist[v]=nd; heapq.heappush(pq,(nd,v))
    return dist

def nearest_node(nodes, lng, lat):
    best=None; bd=1e18
    for n in nodes:
        d=hav(n[0],n[1],lng,lat)
        if d<bd: bd=d; best=n
    return best, bd

ROAD_BASE={"footway":92,"path":90,"pedestrian":90,"living_street":88,"residential":82,
           "service":68,"unclassified":70,"tertiary":62,"tertiary_link":60,
           "secondary":52,"secondary_link":50,"primary":38,"primary_link":36,
           "trunk":30,"trunk_link":28}
def road_walk(hw, slope_deg, major_dist):
    base=ROAD_BASE.get(hw,60)
    comfort=max(0,100-slope_deg*6)
    safety=max(0,min(100, major_dist/300.0*100)) if major_dist<9999 else 80
    return round(0.40*base+0.35*comfort+0.25*safety)

def load_counties():
    with open(COUNTIES, encoding="utf-8") as f:
        return json.load(f)

def compute_county(rec):
    sid=rec["adcode"]; name=rec["name"]
    lng0,lat0=rec["wgs"][0],rec["wgs"][1]
    mLat=111320.0; mLng=111320.0*math.cos(lat0*math.pi/180)
    dLat=QUERY_R_M/mLat; dLng=QUERY_R_M/mLng
    S=lat0-dLat; Nn=lat0+dLat; W=lng0-dLng; E=lng0+dLng
    bbox=f"{S:.5f},{W:.5f},{Nn:.5f},{E:.5f}"

    print(f"[{sid} {name}] [1/5] 数据源")
    own = load_own(rec)
    if own and own["mode"] == "overpass":
        ways, pois, buildings, greens = _parse_elements({"elements": own["elements"]})
    elif own and own["mode"] == "simple":
        ways, pois, buildings, greens = own["ways"], own["pois"], own["buildings"], own["greens"]
        print(f"[{sid} {name}]      自有数据：路网 {len(ways)} ｜ POI {len(pois)}")
    else:
        q=("""[out:json][timeout:180];
(
  way["highway"](__BBOX__);
  node["amenity"](__BBOX__);
  node["shop"](__BBOX__);
  node["leisure"~"park|garden"](__BBOX__);
  node["railway"~"station|halt"](__BBOX__);
  way["amenity"](__BBOX__);
  way["shop"](__BBOX__);
  way["leisure"~"park|garden"](__BBOX__);
);
out geom;""").replace("__BBOX__",bbox)
        data=overpass(q)
        ways, pois, buildings, greens = _parse_elements(data)
    print(f"[{sid} {name}]      路网 {len(ways)} ｜ POI {len(pois)} ｜ 建筑 {len(buildings)} ｜ 绿地 {len(greens)}")

    bld_feats=[]; green_feats=[]
    for w in buildings:
        g=coords_of(w)
        if len(g)<3: continue
        bld_feats.append({"type":"Feature","geometry":{"type":"Polygon",
            "coordinates":[[[c[0],c[1]] for c in g]]},"properties":{}})
    for w in greens:
        g=coords_of(w)
        if len(g)<3: continue
        green_feats.append({"type":"Feature","geometry":{"type":"Polygon",
            "coordinates":[[[c[0],c[1]] for c in g]]},"properties":{}})

    print(f"[{sid} {name}] [2/5] 步行图 + 高程")
    adj, nodes = build_graph(ways)
    print(f"[{sid} {name}]      图节点 {len(nodes)} ｜ 边 {sum(len(v) for v in adj.values())//2}")

    corners=[]
    for i in range(N+1):
        for j in range(N+1):
            cx=lng0+(-GRID_HALF+i*CELL_M+CELL_M/2)/mLng
            cy=lat0+(-GRID_HALF+j*CELL_M+CELL_M/2)/mLat
            corners.append((round(cy,6),round(cx,6)))
    elev=elev_batch(list(set(corners)))
    print(f"[{sid} {name}]      高程采样 {len(elev)}")

    major=[]
    for w in ways:
        hw=w.get("tags",{}).get("highway","")
        if hw in ("trunk","trunk_link","primary","primary_link"):
            for c in coords_of(w): major.append(c)
    poi_nodes=[]
    for p in pois:
        n,_=nearest_node(nodes,p["lng"],p["lat"]); poi_nodes.append((n,p))

    print(f"[{sid} {name}] [3/5] 逐格计算")
    raw={}; cell_map={}
    for i in range(N):
        for j in range(N):
            cx=lng0+(-GRID_HALF+i*CELL_M+CELL_M/2)/mLng
            cy=lat0+(-GRID_HALF+j*CELL_M+CELL_M/2)/mLat
            sn,_=nearest_node(nodes,cx,cy)
            if sn and adj: dist=dijkstra(adj,sn)
            else: dist={}
            dcat={}
            for n,p in poi_nodes:
                d=dist.get(n)
                if d is None: d=hav(p["lng"],p["lat"],cx,cy)
                if p["type"] not in dcat or d<dcat[p["type"]]: dcat[p["type"]]=d
            acc=0; types_in=set()
            for cat,d in dcat.items():
                if d<1400:
                    acc+=W_ACCESS.get(cat,0.9)*math.exp(-d/450)
                    if d<800: types_in.add(cat)
            access=min(100,acc*55)
            attr=min(100,len(types_in)/5*100)
            conn_cnt=0
            for n in nodes:
                if len(adj.get(n,[]))>=3 and hav(n[0],n[1],cx,cy)<300: conn_cnt+=1
            esw=elev.get((round(cy-CELL_M/2/mLat,6),round(cx-CELL_M/2/mLng,6)))
            ene=elev.get((round(cy+CELL_M/2/mLat,6),round(cx+CELL_M/2/mLng,6)))
            enw=elev.get((round(cy+CELL_M/2/mLat,6),round(cx-CELL_M/2/mLng,6)))
            ese=elev.get((round(cy-CELL_M/2/mLat,6),round(cx+CELL_M/2/mLng,6)))
            slope=0.0
            if None not in (esw,ene,enw,ese):
                gx=(ese-esw)/(2*CELL_M); gy=(ene-enw)/(2*CELL_M)
                slope=math.degrees(math.atan(math.hypot(gx,gy)))
            sd=min((hav(m[0],m[1],cx,cy) for m in major), default=9999)
            raw[(i,j)]={"cx":cx,"cy":cy,"access":access,"attr":attr,
                        "conn_raw":conn_cnt,"slope":slope,"safe_raw":sd}

    def mm(vals):
        lo,hi=min(vals),max(vals)
        return (lambda v:0.0 if hi==lo else (v-lo)/(hi-lo)*100)
    conn_n=mm([v["conn_raw"] for v in raw.values()])
    slope_n=mm([v["slope"] for v in raw.values()])
    safe_n=mm([v["safe_raw"] for v in raw.values()])

    print(f"[{sid} {name}] [4/5] 合成分数 + GeoJSON")
    cells=[]; cell_map={}
    for (i,j),v in raw.items():
        conn=conn_n(v["conn_raw"]); comfort=100-slope_n(v["slope"]); safety=safe_n(v["safe_raw"])
        score=0.30*v["access"]+0.18*conn+0.17*comfort+0.15*safety+0.20*v["attr"]
        swLng=v["cx"]-CELL_M/2/mLng; swLat=v["cy"]-CELL_M/2/mLat
        dLng=CELL_M/mLng; dLat=CELL_M/mLat
        feat={"type":"Feature",
            "geometry":{"type":"Polygon","coordinates":[[[swLng,swLat],[swLng+dLng,swLat],[swLng+dLng,swLat+dLat],[swLng,swLat+dLat],[swLng,swLat]]]},
            "properties":{"center":[v["cx"],v["cy"]],"score":round(score),
                "access":round(v["access"]),"conn":round(conn),"comfort":round(comfort),
                "safety":round(safety),"attr":round(v["attr"]),"slope":round(v["slope"],1)}}
        cells.append(feat); cell_map[(i,j)]=feat
    sc=[c["properties"]["score"] for c in cells]
    print(f"[{sid} {name}]      分数 {min(sc)}–{max(sc)} 均值 {sum(sc)/len(sc):.1f}")

    print(f"[{sid} {name}] [4.5/5] 聚类友好区域（阈值 {FRIENDLY_THRESH}）")
    friendly=set((i,j) for (i,j),c in cell_map.items() if poi_free_score(c["properties"])>=FRIENDLY_THRESH)
    visited=set(); areas=[]
    for start in friendly:
        if start in visited: continue
        stack=[start]; comp=[]
        while stack:
            cur=stack.pop()
            if cur in visited or cur not in friendly: continue
            visited.add(cur); comp.append(cur)
            for d in ((1,0),(-1,0),(0,1),(0,-1)):
                nb=(cur[0]+d[0],cur[1]+d[1])
                if nb in friendly and nb not in visited: stack.append(nb)
        if len(comp)<2: continue
        lngs=[]; lats=[]
        for (i,j) in comp:
            cc=cell_map[(i,j)]["properties"]["center"]; lngs.append(cc[0]); lats.append(cc[1])
        edges=[]
        for (i,j) in comp:
            poly=cell_map[(i,j)]["geometry"]["coordinates"][0]
            c0,c1,c2,c3=tuple(poly[0]),tuple(poly[1]),tuple(poly[2]),tuple(poly[3])
            neigh={(c0,c1):(i,j-1),(c1,c2):(i+1,j),(c2,c3):(i,j+1),(c3,c0):(i-1,j)}
            for seg,nb in neigh.items():
                if nb not in comp: edges.append([list(seg[0]),list(seg[1])])
        areas.append({"size":len(comp),
            "score_avg":round(sum(poi_free_score(cell_map[k]["properties"]) for k in comp)/len(comp),1),
            "centroid":[round(sum(lngs)/len(lngs),6),round(sum(lats)/len(lats),6)],
            "cells":[[i,j] for (i,j) in comp],"edges":edges})
    areas.sort(key=lambda a:-a["size"])
    max_area=areas[0] if areas else None
    print(f"[{sid} {name}]      友好区域 {len(areas)} 片 ｜ 最大连片 {max_area['size'] if max_area else 0} 格")

    print(f"[{sid} {name}] [4.8/5] 街道好走度")
    roads=[]
    for w in ways:
        hw=w.get("tags",{}).get("highway","")
        geo=coords_of(w)
        if len(geo)<2: continue
        clat=sum(c[1] for c in geo)/len(geo); clng=sum(c[0] for c in geo)/len(geo)
        e0=elev.get((round(geo[0][1],6),round(geo[0][0],6)))
        e1=elev.get((round(geo[-1][1],6),round(geo[-1][0],6)))
        slope=0.0
        if e0 is not None and e1 is not None:
            L=hav(geo[0][0],geo[0][1],geo[-1][0],geo[-1][1])
            if L>1: slope=math.degrees(math.atan(abs(e1-e0)/L))
        md=min((hav(m[0],m[1],clng,clat) for m in major), default=9999)
        walk=road_walk(hw,slope,md)
        wname=w.get("tags",{}).get("name") or w.get("tags",{}).get("name:en") or ""
        roads.append({"type":"Feature","geometry":{"type":"LineString","coordinates":[[c[0],c[1]] for c in geo]},
            "properties":{"hw":hw,"walk":walk,"slope":round(slope,1),"name":wname}})

    out={"id":sid,"name":name,"province":rec.get("province"),"parent":rec.get("parent"),
        "center":[lng0,lat0],"gcj_center":rec.get("gcj"),
        "generated":"2026-08-05",
        "source":("自有数据(roads+POIs 注入)" if own else "OSM Overpass(路网/POI/建筑/绿地) + Open-Meteo 高程；5因子加权(可达.30/连通.18/舒适.17/安全.15/吸引.20)；友好区域=无POI重加权连通聚类"),
        "own_supplied": bool(own),
        "friendly_threshold":FRIENDLY_THRESH,
        "quality":{"ways":len(ways),"pois":len(pois),"buildings":len(buildings),"greens":len(greens)},
        "cells":{"type":"FeatureCollection","features":cells},
        "pois":pois,"roads":{"type":"FeatureCollection","features":roads},
        "buildings":{"type":"FeatureCollection","features":bld_feats},
        "greens":{"type":"FeatureCollection","features":green_feats},
        "friendly_areas":areas,"max_area":max_area}
    return out

def main():
    recs=load_counties()
    want=set(str(x) for x in sys.argv[1:]) if len(sys.argv)>1 else None
    for rec in recs:
        if want and str(rec["adcode"]) not in want: continue
        out=compute_county(rec)
        odir=os.path.join(HERE,"data"); os.makedirs(odir,exist_ok=True)
        with open(os.path.join(odir,f"{rec['adcode']}.json"),"w",encoding="utf-8") as f:
            json.dump(out,f,ensure_ascii=False)
        q=out["quality"]; ma=out["max_area"]
        print(f"[{rec['adcode']} {rec['name']}] 写出 ✅ 路网{q['ways']} POI{q['pois']} 最大友好连片 {ma['size'] if ma else 0} 格\n")

if __name__=="__main__":
    main()
