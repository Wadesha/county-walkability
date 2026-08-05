# -*- coding: utf-8 -*-
"""抓取四省（鲁苏皖豫）真实行政边界并简化，内联进 data_bundle 做底图轮廓。
DataV GeoJSON（GCJ-02），轮廓只用于示意，转 WGS-84 后按度存储。
Douglas-Peucker 简化到 ~0.01° 容差，控制体积。
坐标转换使用已验证正确的近似逆算：WGS ≈ 2·GCJ − wgs2gcj(GCJ)
"""
import json, urllib.request, math, os

PROV = {"370000": "山东", "320000": "江苏", "340000": "安徽", "410000": "河南"}
OUT = "data/provinces.json"

a = 6378245.0
ee = 0.00669342162296594323
x_pi = 3.14159265358979324 * 3000.0 / 180.0

def wgs2gcj(lat, lng):
    if out_of_china(lat, lng):
        return lat, lng
    dlat = transformlat(lng - 105.0, lat - 35.0)
    dlng = transformlng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - ee * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180.0) / (a / sqrtmagic * math.cos(radlat) * math.pi)
    mglat = lat + dlat
    mglng = lng + dlng
    return mglat, mglng

def out_of_china(lat, lng):
    return not (73.66 < lng < 135.05 and 3.86 < lat < 53.55)

def transformlat(lng, lat):
    ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * math.sqrt(abs(lng))
    ret += (20.0 * math.sin(6.0 * lng * math.pi / 180.0) + 20.0 * math.sin(2.0 * lng * math.pi / 180.0)) * 2.0 / 3.0
    ret += (20.0 * math.sin(lat * math.pi / 180.0) + 40.0 * math.sin(lat / 3.0 * math.pi / 180.0)) * 2.0 / 3.0
    ret += (160.0 * math.sin(lat / 12.0 * math.pi / 180.0) + 320.0 * math.sin(lat * math.pi / 30.0 / 180.0)) * 2.0 / 3.0
    return ret

def transformlng(lng, lat):
    ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * math.sqrt(abs(lng))
    ret += (20.0 * math.sin(6.0 * lng * math.pi / 180.0) + 20.0 * math.sin(2.0 * lng * math.pi / 180.0)) * 2.0 / 3.0
    ret += (20.0 * math.sin(lat * math.pi / 180.0) + 40.0 * math.sin(lat / 3.0 * math.pi / 180.0)) * 2.0 / 3.0
    ret += (160.0 * math.sin(lat / 12.0 * math.pi / 180.0) + 320.0 * math.sin(lat * math.pi / 30.0 / 180.0)) * 2.0 / 3.0
    return ret

def gcj2wgs(lng, lat):
    # 近似逆算：WGS ≈ 2·GCJ − wgs2gcj(GCJ)
    g = wgs2gcj(lat, lng)
    return lng * 2 - g[1], lat * 2 - g[0]

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "prov-fetch/1.0"})
    return json.loads(urllib.request.urlopen(req, timeout=120).read().decode())

def extract_rings(geom):
    rings = []
    t = geom.get("type")
    if t == "Polygon":
        for ring in geom["coordinates"]: rings.append(ring)
    elif t == "MultiPolygon":
        for poly in geom["coordinates"]:
            for ring in poly: rings.append(ring)
    return rings

def dp(pts, eps):
    if len(pts) < 3: return pts
    def pdist(p, aa, bb):
        x0, y0 = p; x1, y1 = aa; x2, y2 = bb
        dx = x2 - x1; dy = y2 - y1
        if dx == 0 and dy == 0: return math.hypot(x0 - x1, y0 - y1)
        t = ((x0 - x1) * dx + (y0 - y1) * dy) / (dx * dx + dy * dy)
        t = max(0, min(1, t)); px = x1 + t * dx; py = y1 + t * dy
        return math.hypot(x0 - px, y0 - py)
    def rec(start, end):
        dmax = 0; idx = -1
        for i in range(start + 1, end):
            d = pdist(pts[i], pts[start], pts[end])
            if d > dmax: dmax = d; idx = i
        if dmax > eps:
            return rec(start, idx) + rec(idx, end)[1:]
        return [pts[start], pts[end]]
    return rec(0, len(pts) - 1)

def main():
    out = []
    for adcode, name in PROV.items():
        print("抓", name)
        data = get("https://geo.datav.aliyun.com/areas_v3/bound/%s.json" % adcode)
        feats = data.get("features", [])
        geom = None
        for f in feats:
            g = f.get("geometry")
            if g and g.get("coordinates"):
                geom = g; break
        if not geom:
            print("  ", name, "无几何"); continue
        rings = extract_rings(geom)
        simp = []
        for ring in rings:
            conv = [list(gcj2wgs(p[0], p[1])) for p in ring]
            # 校验：经度应在 [-180,180]，否则丢弃该环
            if any(not (-180 <= c[0] <= 180 and -90 <= c[1] <= 90) for c in conv):
                print("  ", name, "跳过坏环（点数", len(ring), "）")
                continue
            s = dp(conv, 0.01)
            simp.append([[round(x, 3), round(y, 3)] for x, y in s])
        out.append({"name": name, "adcode": adcode, "rings": simp})
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("体积:", os.path.getsize(OUT), "bytes; 各省环数:", {o["name"]: len(o["rings"]) for o in out})

if __name__ == "__main__":
    main()
