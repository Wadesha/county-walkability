# -*- coding: utf-8 -*-
# 把 counties.json + 真实 zones.json（+ provinces.json 省界）内联成 data_bundle.js，
# 避免预览代理环境下 fetch 相对路径解析失败（TypeError: Failed to fetch）。
# 真实 zones.json 不存在时回退到 sample_zones.json（示例数据）。
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
c = json.load(open(os.path.join(DATA, "counties.json"), encoding="utf-8"))
p = json.load(open(os.path.join(DATA, "provinces.json"), encoding="utf-8"))

real = os.path.join(DATA, "zones.json")
if os.path.exists(real):
    z = json.load(open(real, encoding="utf-8"))
    src = "真实 zones.json"
else:
    s = json.load(open(os.path.join(DATA, "sample_zones.json"), encoding="utf-8"))
    z = {"zones": s.get("zones", [])}
    src = "示例 sample_zones.json（真实数据尚未生成）"

with open(os.path.join(HERE, "data_bundle.js"), "w", encoding="utf-8") as f:
    f.write("// 自动生成：县城位置 + 详情 + 四省轮廓 内联，避免 fetch 失败。\n")
    f.write("window.APP_DATA = ")
    f.write(json.dumps({"counties": c, "zones": z.get("zones", []), "provinces": p},
                       ensure_ascii=False, separators=(",", ":")))
    f.write(";\n")

print("data_bundle.js 写入完成（数据源：%s）；counties=%d zones=%d provinces=%d" %
      (src, len(c), len(z.get("zones", [])), len(p)))
