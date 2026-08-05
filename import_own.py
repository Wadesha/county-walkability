#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
import_own.py — 把「用户自备的路网 / POI / 高程」合并成 build_county.py 能直接吃的
               data/own/<adcode>.json（格式 B：{pois, roads, 旋钮}）。

为什么需要它：
    沙箱出网对 Overpass / Geofabrik / planet / BBBike 处理后端 全部封锁，无法实时拉 OSM。
    本项目路网(连通0.18+安全0.15=0.33) 与 POI(可达0.30+吸引0.20) / 高程(舒适0.17) 分开来源：
    你自己有 POI，再自备路网文件，用本工具合成后，build_county.py 走「自有数据」路径，纯离线跑。

支持输入格式：
    路网 roads : GeoJSON(LineString/MultiLineString，highway 取自 properties) 或
                 CSV(列: id 分组, seq 排序可选, lng/lat, highway 可选)
    POI  pois  : GeoJSON(Point) 或 CSV(列: lng/lat/type/name，表头自动识别中英文)
    高程 elev  : CSV(lng,lat,h) 或 JSON([[lng,lat,h],...])
    坐标系     : 全部输入必须是「同一种」坐标系；用 --coord_sys 声明(wgs84 默认 / gcj02 高德腾讯百度)
                 转换由 build_county.load_own 统一做，本工具只负责传递旋钮。
    分类重映射 : --type_map "restaurant=shop,bank=shop" 把任意类别归并到 5 类，避免静默丢弃。
                 (park / metro / shop / school / hospital)

用法：
    # 单县
    python3 import_own.py --adcode 370522 \
        --roads 370522_roads.geojson \
        --pois  370522_pois.csv \
        --elev  370522_elev.csv \
        --coord_sys gcj02 \
        --type_map "restaurant=shop,bank=shop" --type_fallback shop

    # 整目录批量：把 <adcode>_roads.* / <adcode>_pois.* / <adcode>_elev.* 丢进一个文件夹
    python3 import_own.py --batch ./my_own_data/

输出：counties/data/own/<adcode>.json （已存在则覆盖）
"""
import os, sys, json, csv, glob, argparse, re

HERE = os.path.dirname(os.path.abspath(__file__))
OWN_DIR = os.path.join(HERE, "data", "own")
ALLOWED = {"park", "metro", "shop", "school", "hospital"}

# ---------- 读取：路网 ----------
def read_roads_geojson(path):
    gj = json.load(open(path, encoding="utf-8"))
    feats = gj["features"] if gj.get("type") == "FeatureCollection" else [gj]
    roads = []
    for f in feats:
        geom = f.get("geometry") or {}
        t = geom.get("type")
        props = f.get("properties") or {}
        hw = props.get("highway") or props.get("type") or "residential"
        if t == "LineString":
            lines = [geom.get("coordinates", [])]
        elif t == "MultiLineString":
            lines = geom.get("coordinates", [])
        else:
            continue
        for line in lines:
            if len(line) < 2:
                continue
            roads.append({"geometry": [[c[0], c[1]] for c in line], "highway": hw})
    return roads

def read_roads_csv(path):
    rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
    lng_k = _pick(rows[0].keys(), ["lng", "lon", "longitude", "经度", "x"])
    lat_k = _pick(rows[0].keys(), ["lat", "latitude", "纬度", "y"])
    id_k  = _pick(rows[0].keys(), ["id", "road_id", "gid", "编号", "路id"])
    seq_k = _pick(rows[0].keys(), ["seq", "order", "idx", "序号", "排序"])
    hw_k  = _pick(rows[0].keys(), ["highway", "type", "class", "等级", "类型"])
    if not (lng_k and lat_k):
        raise SystemExit(f"[roads csv] 找不到经纬度列（需要 lng/lat 或 经度/纬度）: {path}")
    groups = {}
    for r in rows:
        if id_k:
            gid = r.get(id_k)
        else:
            gid = "default"   # 无分组列 → 整张表当作一条线
        groups.setdefault(gid, []).append(r)
    roads = []
    for gid, grp in groups.items():
        if seq_k:
            grp = sorted(grp, key=lambda r: float(r.get(seq_k) or 0))
        geo = []
        for r in grp:
            try:
                geo.append([float(r[lng_k]), float(r[lat_k])])
            except ValueError:
                continue
        if len(geo) < 2:
            continue
        hw = (grp[0].get(hw_k) if hw_k else None) or "residential"
        roads.append({"geometry": geo, "highway": hw})
    return roads

# ---------- 读取：POI ----------
def read_pois_geojson(path):
    gj = json.load(open(path, encoding="utf-8"))
    feats = gj["features"] if gj.get("type") == "FeatureCollection" else [gj]
    pois = []
    for f in feats:
        geom = f.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        c = geom.get("coordinates", [])
        if len(c) < 2:
            continue
        props = f.get("properties") or {}
        t = (props.get("type") or props.get("category") or props.get("class")
             or props.get("amenity") or props.get("poi_type") or "")
        n = props.get("name") or props.get("title") or ""
        pois.append({"lng": c[0], "lat": c[1], "type": str(t), "name": str(n)})
    return pois

def read_pois_csv(path):
    rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
    lng_k = _pick(rows[0].keys(), ["lng", "lon", "longitude", "经度", "x"])
    lat_k = _pick(rows[0].keys(), ["lat", "latitude", "纬度", "y"])
    typ_k = _pick(rows[0].keys(), ["type", "category", "class", "kind", "类别", "类型"])
    nam_k = _pick(rows[0].keys(), ["name", "title", "名称"])
    if not (lng_k and lat_k):
        raise SystemExit(f"[pois csv] 找不到经纬度列（需要 lng/lat 或 经度/纬度）: {path}")
    pois = []
    for r in rows:
        try:
            lng = float(r[lng_k]); lat = float(r[lat_k])
        except (ValueError, TypeError):
            continue
        t = str(r.get(typ_k, "")) if typ_k else ""
        n = str(r.get(nam_k, "")) if nam_k else ""
        pois.append({"lng": lng, "lat": lat, "type": t, "name": n})
    return pois

# ---------- 读取：高程 ----------
def read_elev(path):
    if path.lower().endswith(".json"):
        return json.load(open(path, encoding="utf-8"))
    rows = list(csv.reader(open(path, encoding="utf-8-sig")))
    out = []
    for r in rows:
        if len(r) < 3:
            continue
        try:
            out.append([float(r[0]), float(r[1]), float(r[2])])
        except ValueError:
            continue
    return out

def _pick(keys, candidates):
    low = {k.lower(): k for k in keys}
    for c in candidates:
        if c.lower() in low:
            return low[c.lower()]
    return None

def _fmt_of(path):
    return "csv" if path.lower().endswith(".csv") else "geojson"

# ---------- 组装 ----------
def build_record(roads, pois, elev, args):
    rec = {"pois": pois, "roads": roads}
    if args.coord_sys and args.coord_sys != "wgs84":
        rec["coord_sys"] = args.coord_sys
    if args.coord_order and args.coord_order != "lnglat":
        rec["coord_order"] = args.coord_order
    if args.type_map:
        rec["type_map"] = args.type_map
    if args.type_fallback:
        rec["type_fallback"] = args.type_fallback
    if elev is not None:
        rec["elev"] = elev
    if getattr(args, "simulated", False):
        rec["simulated"] = True
    return rec

def parse_type_map(s):
    if not s:
        return {}
    m = {}
    for pair in s.split(","):
        if "=" not in pair:
            raise SystemExit(f"[type_map] 格式应为 a=b,c=d，收到: {pair}")
        k, v = pair.split("=", 1)
        if v.strip() not in ALLOWED:
            raise SystemExit(f"[type_map] 目标类别 {v} 不在 5 类 {sorted(ALLOWED)} 内")
        m[k.strip()] = v.strip()
    return m

def load_inputs(args):
    roads, pois, elev = [], [], None
    if args.roads:
        roads = read_roads_geojson(args.roads) if _fmt_of(args.roads) == "geojson" else read_roads_csv(args.roads)
    if args.pois:
        pois = read_pois_geojson(args.pois) if _fmt_of(args.pois) == "geojson" else read_pois_csv(args.pois)
    if args.elev:
        elev = read_elev(args.elev)
    return roads, pois, elev

def main():
    ap = argparse.ArgumentParser(description="合并自备路网/POI/高程 → data/own/<adcode>.json")
    ap.add_argument("--adcode", help="县城 adcode（单县模式必填）")
    ap.add_argument("--roads", help="路网文件 (.geojson 或 .csv)")
    ap.add_argument("--pois", help="POI 文件 (.geojson 或 .csv)")
    ap.add_argument("--elev", help="高程文件 (.csv lng,lat,h 或 .json [[lng,lat,h]])")
    ap.add_argument("--coord_sys", default="wgs84", choices=["wgs84", "gcj02"])
    ap.add_argument("--coord_order", default="lnglat", choices=["lnglat", "latlng"])
    ap.add_argument("--type_map", help='分类重映射, 如 "restaurant=shop,bank=shop"')
    ap.add_argument("--type_fallback", help="未命中 type_map 的兜底类别(须为5类之一)")
    ap.add_argument("--batch", help="整目录批量：扫描 <adcode>_roads.* / <adcode>_pois.* / <adcode>_elev.*")
    ap.add_argument("--simulated", action="store_true",
                    help="标记为模拟/演示数据（写入 simulated=true，build_county 透传到产物；真实数据到达后覆盖即可清除）")
    ap.add_argument("--out", help="输出目录（默认 counties/data/own）")
    args = ap.parse_args()

    args.type_map = parse_type_map(args.type_map)
    if args.type_fallback and args.type_fallback not in ALLOWED:
        raise SystemExit(f"[type_fallback] 须在 5 类 {sorted(ALLOWED)} 内")

    out_dir = args.out or OWN_DIR
    os.makedirs(out_dir, exist_ok=True)

    if args.batch:
        return batch_mode(args, args.batch, out_dir)

    if not args.adcode:
        raise SystemExit("单县模式需要 --adcode；或改用 --batch DIR")
    if not (args.roads or args.pois):
        raise SystemExit("至少需要 --roads 或 --pois 之一")

    roads, pois, elev = load_inputs(args)
    rec = build_record(roads, pois, elev, args)
    _write(out_dir, args.adcode, rec)

def batch_mode(args, d, out_dir):
    roads_files = glob.glob(os.path.join(d, "*_roads.*"))
    pois_files = glob.glob(os.path.join(d, "*_pois.*"))
    elev_files = glob.glob(os.path.join(d, "*_elev.*"))
    def adcode_of(p):
        base = os.path.basename(p)
        return base.split("_")[0]
    adcodes = set()
    for p in roads_files + pois_files + elev_files:
        adcodes.add(adcode_of(p))
    if not adcodes:
        raise SystemExit(f"在 {d} 未找到 <adcode>_roads.* / <adcode>_pois.* / <adcode>_elev.* 命名文件")
    done = 0
    for adcode in sorted(adcodes):
        rf = next((p for p in roads_files if adcode_of(p) == adcode), None)
        pf = next((p for p in pois_files if adcode_of(p) == adcode), None)
        ef = next((p for p in elev_files if adcode_of(p) == adcode), None)
        a = argparse.Namespace(
            roads=rf, pois=pf, elev=ef,
            coord_sys=args.coord_sys, coord_order=args.coord_order,
            type_map=args.type_map, type_fallback=args.type_fallback,
            simulated=args.simulated)
        roads, pois, elev = load_inputs(a)
        rec = build_record(roads, pois, elev, a)
        _write(out_dir, adcode, rec)
        done += 1
        print(f"  ✓ {adcode}: roads={len(roads)} pois={len(pois)}"
              f"{' elev='+str(len(elev)) if elev is not None else ''}")
    print(f"[batch] 完成 {done} 个县城 → {out_dir}")

def _write(out_dir, adcode, rec):
    p = os.path.join(out_dir, f"{adcode}.json")
    json.dump(rec, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"[写入] {p}  roads={len(rec['roads'])} pois={len(rec['pois'])}"
          f"  旋钮={[k for k in ('coord_sys','coord_order','type_map','type_fallback','elev') if k in rec]}")

if __name__ == "__main__":
    main()
