# 县城步行友好 · 四省专题

以**县城中心**为锚，计算半径 2km 范围内的「步行好走度」，并在宏观地图上标出每个县城的**最大连片友好区域**。覆盖**山东 / 江苏 / 安徽 / 河南**四省共 **280** 个县城（县与县级市，不含市辖区）。

> 这是火车站版 `walkable-map` 的延伸：把"着力点"从大城市火车站转到更贴近日常生活的县城。县城 OSM 数据稀疏度更高，低分可能是「地图没画完」而非真不好走——详情页会对稀疏县城给出黄色警告。

## 怎么看

- 打开站点即进入**宏观图**：四省真实行政轮廓 + 280 个县城点位。
  - **绿点** = 已有数据，点一下**下钻**看该县城的友好连片；
  - **灰点** = 数据收集中。
- 顶部一行极简省份筛选；底部一条密集目录（县城名横排、可横向滚动、可收起）。
- 下钻后：绿色半透明多边形 = 最大友好连片，橙色圆 = 县城中心，右下角小卡片给出「最大连片 / 连片均分 / 县城好走度 / 可比均分 / 同省排名 / 全省名」。

线上站点：https://wadesha.github.io/county-walkability/

## 计算方法（每格 160m×160m，13×13=169 格）

五因子加权：

`score = 0.30·可达 + 0.18·连通 + 0.17·舒适 + 0.15·安全 + 0.20·吸引`

| 因子 | 权重 | 含义 | 数据来源 |
|------|------|------|----------|
| 可达 | 0.30 | 真实步行路网 Dijkstra 到 5 类目的地（park/metro/shop/school/hospital）距离的[高斯衰减](https://en.wikipedia.org/wiki/Gaussian_function)求和 | 路网 + POI |
| 连通 | 0.18 | 300m 内路网交叉口密度 | 路网 |
| 舒适 | 0.17 | 坡度（越平越舒适） | 高程 DEM |
| 安全 | 0.15 | 距主干道（trunk/primary）距离 | 路网 |
| 吸引 | 0.20 | 800m 内 POI 类型丰富度 | POI |

**友好区域** = 把「无 POI 重加权（可达+连通+舒适+安全）≥ 65」的相邻格做 4-连通聚类，**只取最大连片**绘制。

**可比性**：每县城算 `score_mean`（169 格整体好走度均值），按全省 min-max 归一为 `comparable_score`（0–100），并给出 `province_rank` / `global_rank`。

## 技术架构

- 前端**主路径**用 **MapLibre GL + OpenFreeMap** 矢量底图，**免 key、免域名白名单**，有真实街道/水系/地名；坐标直接采用 WGS-84，无需 GCJ-02 转换。
- **SVG 离线渲染兜底**：MapLibre 库未引入或底图加载失败时，自动切到内联 SVG（四省轮廓 + 点位 + 下钻），**保证页面永不空白**。
- 数据**内联**进 `data_bundle.js`（`window.APP_DATA`），避免相对路径 `fetch` 在代理环境下失败。

## 使用自有 POI / 路网数据（推荐路径）

> 本仓库默认从 **OSM Overpass** 抓取路网与 POI。但 Overpass 公共实例有公平使用上限，批量拉取容易触发**出口 IP 封禁**（本项目当前就遇到：沙箱出网被整体限流，5 个镜像 4 个连不上、1 个返回空）。**如果你手上有自己的 POI / 路网数据集，直接喂给管线即可，完全跳过 Overpass。**

### 数据契约（管线实际消费的字段）

打分只认两类输入，**其余都是可选的**：

1. **路网（必需要）** —— 用于「可达 / 连通 / 安全 / 街道好走度」。
   - 每条路是一个 `way`：带 `geometry`（经纬度序列）和 `tags.highway`（如 `footway / residential / secondary / primary / trunk`）。
   - 没有路网时，连通/安全会退化（中性偏低），分数仍算但不准。
2. **POI 点（强烈建议）** —— 用于「可达 + 吸引」。
   - 每个点带 `lng, lat` 与一个**类别** `type ∈ {park, metro, shop, school, hospital}`。
   - 类别映射：公园/绿地 → `park`；车站/地铁/公交枢纽 → `metro`；中小学/幼儿园 → `school`；医院/诊所 → `hospital`；商店/超市/药店/菜场/一般 amenity → `shop`。
3. **高程（可选）** —— 影响「舒适」。缺失时所有格坡度取 0，舒适分经归一后趋同，**无法区分坡度优劣**（不报错）。
4. **建筑 / 绿地（可选）** —— 仅用于详情页可视化覆盖，不参与打分。

⚠️ 坐标系统一用 **WGS-84**（`[经度 lng, 纬度 lat]`），**不要**喂 GCJ-02。

### 放数据：新建 `data/own/<adcode>.json`

`<adcode>` 是 6 位县城行政区划代码（与 `data/counties.json` 里一致，字符串）。支持两种子格式，**任选其一**：

**格式 A — 透传 Overpass 原始数据**（你已导出的 OSM/Overpass JSON，零转换）

```json
{
  "elements": [
    { "type": "node", "lat": 33.50, "lon": 116.90, "tags": { "amenity": "hospital" } },
    { "type": "way", "geometry": [ {"lat":33.50,"lon":116.90}, {"lat":33.51,"lon":116.91} ],
      "tags": { "highway": "residential" } }
  ]
}
```

> 直接用 Overpass 返回的全部 `elements` 即可，管线按既有规则解析（node 看 `tags`，way 看 `geometry`+`tags`）。

**格式 B — 简化 POI + 路网**（推荐，最省事）

```json
{
  "format": "own-v1",
  "pois": [
    { "lng": 116.901, "lat": 33.501, "type": "shop",    "name": "便利店" },
    { "lng": 116.905, "lat": 33.498, "type": "park",    "name": "小公园" },
    { "lng": 116.899, "lat": 33.503, "type": "school",  "name": "中心小学" },
    { "lng": 116.907, "lat": 33.497, "type": "hospital","name": "卫生院" },
    { "lng": 116.900, "lat": 33.494, "type": "metro",   "name": "公交枢纽" }
  ],
  "roads": [
    { "highway": "residential", "geometry": [[116.895,33.495],[116.910,33.495]] },
    { "highway": "footway",     "geometry": [[116.900,33.490],[116.900,33.510]] },
    { "highway": "primary",     "geometry": [[116.890,33.500],[116.915,33.500]] }
  ]
}
```

- `pois[].type` 只接受 `park / metro / shop / school / hospital`，其余会被忽略。
- `roads[].highway` 可省略（默认 `residential`）；`geometry` 是 `[[lng,lat], ...]`。
- `roads` 缺失 → 连通/安全退化；`pois` 缺失 → 可达/吸引退化。

### 跑起来

```bash
# 1) 算单个县城（会自动优先读 data/own/<adcode>.json，没有才走 Overpass）
python3 build_county.py <adcode>

# 2) 批量：有 own 文件的县城直接用自有数据，没有的仍走 Overpass（当前被封会失败跳过）
python3 batch_counties.py --pause 5

# 3) 全部搞定后，重抽连片 + 重建内联数据 + 部署
python3 extract_zones.py      # 由 data/<adcode>.json 生成 data/zones.json
python3 gen_bundle.py         # 内联成 data_bundle.js
node deploy.js                # 上传到 GitHub Pages
```

每个县城的产物会写 `data/<adcode>.json`，其中 `own_supplied: true` 且 `source` 标记为「自有数据(roads+POIs 注入)」，数据溯源透明。

### 字段速查表（精确到字段名 / 类型 / 必需性）

> 功能上**只有 2 类输入真正进打分**：路网（必需）+ 多类 POI（核心）；高程是第 3 类（可选，影响舒适）；建筑 / 绿地只用于可视化，不进打分。

| 维度 | 格式 A（Overpass 透传）字段 | 格式 B（自有简化）字段 | 类型 / 取值 | 必需性 | 进哪些因子 |
|------|------------------------------|--------------------------|-------------|--------|------------|
| **路网** | `elements[]` 中 `type:"way"` 且 `tags.highway` 存在；需 `geometry`（节点序列） | `roads[]`：`geometry:[[lng,lat],…]`（≥2 点）、`highway?`（默认 `residential`） | `highway ∈ {footway,path,pedestrian,living_street,residential,service,unclassified,tertiary,secondary,primary,trunk}`；`motorway/motorway_link` 被跳过 | **必需** | 可达 / 连通 / 安全 / 街道好走度 |
| **POI** | `elements[]` 中 node/way，按 `classify()` 映射：`tags.leisure∈{park,garden}`→park；`tags.railway∈{station,halt,stop,tram_stop}` 或 `station:subway`→metro；`tags.shop`→shop；`tags.amenity∈{hospital,clinic,dentist}`→hospital；`tags.amenity∈{school,university,college,kindergarten}`→school；其余 `amenity`→shop | `pois[]`：`lng`(float)、`lat`(float)、`type∈{park,metro,shop,school,hospital}`、`name?` | 点坐标；`type` 仅这 5 种 | **强烈建议（核心）** | 可达 / 吸引 |
| **高程** | 不来自 A；管线固定调 Open-Meteo 在网格角点采样 | 当前**不接受注入**（own 路径仍走 Open-Meteo） | 米；用于算坡度 | 可选 | 舒适 / 街道好走度(slope) |
| **建筑** | `elements[]` 中 `type:"way"` 且 `tags.building`，需 `geometry`（≥3 点成面） | `buildings[]`：`geometry:[[lng,lat],…]`（≥3 点） | 多边形 | 可选（仅可视化） | 不参与 |
| **绿地** | `elements[]` 中 `type:"way"` 且 `tags.leisure∈{park,garden}`，需 `geometry`（≥3 点） | `greens[]`：`geometry:[[lng,lat],…]`（≥3 点） | 多边形 | 可选（仅可视化） | 不参与 |
| **坐标基准** | 全部 `lon/lat` 为 **WGS-84 十进制度** | 同左：`geometry` 与 `pois` 的 `lng/lat` 均为 WGS-84 | 经度 lng、纬度 lat | 必需 | — |
| **覆盖半径** | 以县城中心 ±**2200m** 的盒子（`QUERY_R_M=2200`） | 你提供的 roads/pois 也应覆盖中心 ±2200m | 米 | 建议 | — |

- `classify()` 对格式 A：节点需带 `lat/lon`（node）或 `geometry`（way）；way 的中心点取几何均值后落为一个 POI。
- 5 类 `type` 的权重（`W_ACCESS`）：metro 1.2 / park 1.0 / shop 0.9 / hospital 0.8 / school 0.7；可达按 `exp(-d/450)` 衰减、1400m 内计、800m 内计类型多样性；吸引 = 800m 内不同 `type` 数 / 5。

### ⚠️ 数据不匹配风险预判（提前堵坑）

管线假设你给的数据**完全符合上面的契约**。一旦「你有的」和「管线要的」对不上，下面这些症状会直接出现——提前知道好对症：

| # | 不匹配情形 | 代码里为什么会错 | 表面症状 | 提前规避 |
|---|------------|------------------|----------|----------|
| 1 | **坐标系是 GCJ-02 / 百度 BD-09，未转 WGS-84**（高德/腾讯/百度导出常见） | 网格中心用 `rec.wgs`（已是 WGS-84），而 own 数据**不做任何坐标转换**，直接按 WGS-84 解读 | 整体偏移 **50–500m**：POI 落错格、路网与网格错位、友好区中心偏掉、**与 MapLibre 真实底图（WGS-84）对不上** | 喂之前把数据转成 WGS-84；或让我给 own 数据加一个 `coord_sys:"gcj02"` 自动反算开关 |
| 2 | **POI 类别不在 5 类内**（restaurant/bank/cafe/pharmacy/gas_station/gym/library…） | 格式 B：`load_own` 第 184 行 `if t not in (...) : continue` **静默丢弃**；格式 A：非已知 `amenity` 一律归 `shop`（可能错类） | 一大半 POI 凭空消失 → 可达/吸引塌缩，或全被错算成 shop | 喂之前把类别归并到 5 类；或让我加一张**可配置的类别映射表**（不再静默丢） |
| 3 | **经纬度顺序写反**（GeoJSON 是 `[lng,lat]`，很多 CSV 是 `[lat,lng]`） | 格式 B 读 `c[0]` 当经度、`c[1]` 当纬度；写反后整条路/点跑到错误半球 | 路网/POI 跑到离谱位置（如把纬度当经度），全城分数错乱 | 统一 `[lng,lat]`；或让我在 own 格式加 `coord_order:"latlng"` 声明 |
| 4 | **只给 POI、不给路网**（你说"我有一些 poi 数据"很可能就是这个） | `ways` 为空 → `build_graph` 返回空图 → 每格 `conn_raw=0`、`safe_raw=9999`、街道层为空 | 连通=0、安全=0、街道好走度图层空；分数只剩 `0.30·可达 + 0.20·吸引 + 0.17·中性舒适`，**连通/安全两个维度彻底缺失** | 尽量补全路网；接受"缺连通/安全"的降级结果；或后续用路网密度近似 |
| 5 | **数据只覆盖县城主城区，< 2200m** | 网格外圈格在 ±1000m 外、可达靠 1400m 衰减，路网稀疏 → 外圈 `conn=0` | 友好区偏小、偏中心，外圈全灰，排名失真 | 提供中心 ±2200m 的完整盒子 |
| 6 | **该县城不在 `data/counties.json`**（你手上是鲁苏豫皖以外，或名单漏了） | `main()` 遍历 `counties.json` 按 `adcode` 匹配，找不到就跳过（哪怕有 own 文件） | 跑 `build_county.py <adcode>` 什么也不生成 | 先把该县加进 `counties.json`（需要它的 wgs 中心，可用 DataV/fetch_counties 补） |
| 7 | **想要真实坡度舒适，但 Open-Meteo 被限流** | own 路径**没有高程注入字段**，仍调 Open-Meteo；失败 → `slope=0` → 归一后 `comfort` 全 = 100（不区分） | 所有县城舒适分都顶满 100，坡度优劣看不出来 | 让我给 own 格式加 `elev:[[lat,lng,h],…]` 或 DEM 栅格注入 |
| 8 | **数据用的是投影坐标（如 Web Mercator 米）而非经纬度** | 所有几何被当成"度"解读 | 全盘错乱、点飞到海外 | 先转成 WGS-84 十进制度 |
| 9 | **密度过低**（POI 只有几个 / 路网只有一两条） | `access`/`attr`/`conn` 都靠数量和分布，样本太少无法撑起分数 | 大量灰格、友好区极小甚至无连片 | 保证中心 ±2200m 内有足够 POI 与路网密度 |

> 一句话总结契约：**WGS-84 经纬度 + 路网（必需）+ 5 类 POI（核心）+ 覆盖 ±2200m**。这四条对齐了，结果就靠谱；任意一条对不上，上表就是对应的"症状—药方"。

## 文件结构

```
index.html / app.js / css/style.css / config.local.js   运行时必需
data_bundle.js                                          内联数据（县城280 + 详情 + 四省轮廓 + zones）
vendor/maplibre-gl.js + vendor/maplibre-gl.css          MapLibre 库（已本地化，避免 CDN 波动）
data/counties.json  四省县城中心（GCJ-02→WGS-84，DataV 行政区划）
data/provinces.json 四省行政边界（简化）
data/zones.json     已算县城的最大友好连片（extract_zones.py 生成）
data/<adcode>.json  单县城计算结果（build_county.py 生成）
data/own/<adcode>.json  你自己的 POI/路网数据（可选，优先级高于 Overpass）

build_county.py     单县城计算（OSM Overpass / 自有数据 + Open-Meteo 高程）
batch_counties.py   断点续跑批量计算
extract_zones.py    抽取最大连片 + 可比排名
gen_bundle.py       把数据内联成 data_bundle.js
fetch_counties.py   抓取四省县城中心（DataV）
fetch_provinces.py  抓取四省行政边界（并修复 GCJ-02 反算）
METHODOLOGY.md      计算依据与迭代路线图
```

## 如何新增县城 / 省份

- **用自有数据**：把 `data/own/<adcode>.json` 放好，见上文「使用自有 POI / 路网数据」。
- **用 Overpass（需网络通畅）**：在 `fetch_counties.py` 的 `PROV` 字典加省份 adcode，重跑抓取 `counties.json`；再 `batch_counties.py` 计算（自动跳过已算）。
- 最后 `extract_zones.py` → `gen_bundle.py` → `deploy.js`。

## 当前进度与已知限制

- **已算 48/280**（全在安徽），其中 **28 个县城**有友好连片（其余 20 个无连片被跳过）；山东/江苏/河南尚未开算。
- **Overpass 被封禁**：本项目沙箱出网走代理，此前数小时批量刷 `overpass-api.de` 触发了出口 IP 限流——5 个镜像 4 个连不上、1 个返回空。批量任务已暂停。**当前推进计算的最稳路径就是用你自己的 POI/路网数据（见上）**，或等封禁冷却（通常数小时~1 天）后一键续跑。
- 封禁期间 `build_county.py` 已加 `signal.alarm(150s)` 硬超时与断点续跑，避免单县城假死卡住整批。

## 部署

静态站点，GitHub Pages（`https://wadesha.github.io/county-walkability/`）。`node deploy.js` 通过 GitHub Contents API 上传全部资源（沙箱内 git 智能 HTTP 被拦，故走 REST）。仓库默认 `main` 分支，Pages 源设为 `main /`。

## 密钥说明

无需任何密钥。MapLibre 库与 OpenFreeMap 样式均为免 key 使用；如需换成商业底图（腾讯/高德/Google），可在 `config.local.js` 注入 key 并在 `app.js` 增加对应分支。
