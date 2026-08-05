# 县城步行友好 · 四省专题

以**县城中心**为锚，计算半径 2km 范围内的「步行好走度」，并在宏观地图上标出每个县城的**最大连片友好区域**。覆盖**山东 / 江苏 / 安徽 / 河南**四省共 280 个县城（县与县级市，不含市辖区）。

> 这是火车站版 `walkable-map` 的延伸：把"着力点"从大城市火车站转到更贴近日常生活的县城。县城 OSM 数据稀疏度更高，低分可能是「地图没画完」而非真不好走——详情页会对稀疏县城给出黄色警告。

## 怎么看
- 打开站点即进入**宏观图**：四省真实行政轮廓 + 280 个县城点位。
  - **绿点** = 已有数据，点一下**下钻**看该县城的友好连片；
  - **灰点** = 数据收集中。
- 顶部一行极简省份筛选；底部一条密集目录（县城名横排、可横向滚动、可收起）。
- 下钻后：绿色半透明多边形 = 最大友好连片，橙色圆 = 县城中心，右下角小卡片给出「最大连片 / 连片均分 / 县城好走度 / 可比均分 / 同省排名 / 全省名」。

## 计算方法（每格 160m×160m，13×13=169 格）
五因子加权：
`score = 0.30·可达 + 0.18·连通 + 0.17·舒适 + 0.15·安全 + 0.20·吸引`
- **可达** 0.30：真实步行路网 Dijkstra 到 5 类目的地（park/metro/shop/school/hospital）距离高斯衰减求和
- **连通** 0.18：300m 内路网交叉口密度
- **舒适** 0.17：Open-Meteo DEM 坡度（越平越舒适）
- **安全** 0.15：距主干道（trunk/primary）距离
- **吸引** 0.20：800m 内 POI 类型丰富度

**友好区域** = 把「无 POI 重加权（可达+连通+舒适+安全）≥ 65」的相邻格做 4-连通聚类，**只取最大连片**绘制。

**可比性（迭代 5）**：每县城算 `score_mean`（169 格整体好走度均值），按全省 min-max 归一为 `comparable_score`（0–100），并给出 `province_rank` / `global_rank`。

## 技术架构
- 前端**主路径**用 **MapLibre GL + OpenFreeMap** 矢量底图，**免 key、免域名白名单**，有真实街道/水系/地名；坐标直接采用 WGS-84，无需 GCJ-02 转换。
- **SVG 离线渲染兜底**：MapLibre 库未引入或底图加载失败时，自动切到内联 SVG（四省轮廓 + 点位 + 下钻），**保证页面永不空白**。
- 数据**内联**进 `data_bundle.js`（`window.APP_DATA`），避免相对路径 `fetch` 在代理环境下失败。

## 文件结构
```
index.html / app.js / css/style.css / config.local.js   运行时必需
data_bundle.js                                          内联数据（县城280 + 详情 + 四省轮廓）
vendor/maplibre-gl.js + vendor/maplibre-gl.css          MapLibre 库（已本地化，避免 CDN 波动）
data/counties.json  四省县城中心（GCJ-02→WGS-84，DataV 行政区划）
data/provinces.json 四省行政边界（简化）
data/zones.json     已算县城的最大友好连片（由 extract_zones.py 生成）
build_county.py     单县城计算（OSM Overpass + Open-Meteo 高程）
batch_counties.py   断点续跑批量计算
extract_zones.py    抽取最大连片 + 可比排名
gen_bundle.py       把数据内联成 data_bundle.js
METHODOLOGY.md      计算依据与 7 步迭代路线图
```

## 如何新增县城 / 省份
1. 在 `fetch_counties.py` 的 `PROV` 字典加省份 adcode，重跑抓取 `counties.json`；
2. 跑 `batch_counties.py` 计算（自动跳过已算）；
3. `extract_zones.py` 重抽 `zones.json`；
4. `gen_bundle.py` 重建 `data_bundle.js`。

## 部署
静态站点，GitHub Pages（`https://wadesha.github.io/county-walkability/`）。

## 密钥说明
无需任何密钥。MapLibre 库与 OpenFreeMap 样式均为免 key 使用；如需换成商业底图（腾讯/高德/Google），可在 `config.local.js` 注入 key 并在 `app.js` 增加对应分支。
