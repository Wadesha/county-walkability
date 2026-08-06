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

## 产品需求文档（PRD）

> 本文档定义县城步行友好专题的产品目标、用户、功能、标准、数据与路线图，作为后续迭代的单一事实来源。技术细节见下文各章节。

### 1. 背景与目标

**缘起**：本项目是 `walkable-map`（火车站步行友好）的延伸，把着力点从大城市火车站转到更贴近日常生活的**县城**。县城 OSM 数据稀疏度更高，更需要一套"标准透明、可解释、不靠黑盒"的步行友好度评估。

**目标**
- **G1** 让任何人一眼看清：哪些县城步行好走、好在哪里、差在哪里。
- **G2** 评分标准**透明、可调、可审计**——不仅给分数，还要给"为什么"。
- **G3** 不依赖任何商业密钥（地图/底图免 key），可静态托管、可离线兜底。
- **G4** 对数据稀疏县城友好（低密度不轻易判死刑，给出数据质量警告）。

**成功度量**：宏观图加载即见四省 280 县城与友好连片；下钻任意县城可见路网质量 + 五因子分解 + 单格解读 + 可调权重 + 方法学；0 密钥、0 商业依赖、首屏 < 200KB。

### 2. 目标用户与场景

| 用户 | 典型场景 | 关键功能 |
|------|----------|----------|
| 普通居民 | "我老家县城步行好走吗？" | 宏观图找县城 → 下钻看友好区/路网 |
| 规划 / 研究 | "可达和连通哪个更弱？能不能调权重对比？" | 图层切换、五因子面板、权重滑块、方法学 |
| 数据贡献者 | "我有自己的 POI/路网，想替换 OSM" | import_own.py 一键导入、标记 simulated |

### 3. 范围

**In scope**：四省（鲁苏皖豫）280 县城步行好走度计算与可视化；宏观图 + 县城下钻详情 + 路网好走度 + 五因子透明 + 标准可调 + 方法学公开；自有数据导入（绕开 Overpass）。

**Out of scope**：实时导航 / 路线规划（只评估"好走度"，不指路）；商业 POI 补全、众包采集；移动端原生 App（当前为响应式 Web）；跨城绝对值排名（分数为相对值，仅做同省校正）。

### 4. 功能需求（P0 = 已上线，P1 = 演示 / 规划中）

- **4.1 宏观图（P0）**：四省真实行政轮廓 + 280 县城点位；绿点=可下钻，灰点=收集中；省份筛选 + 密集目录。
- **4.2 县城下钻详情（P0）**：友好连片（绿）/ 县城中心（橙）/ 右下卡片（最大连片、连片均分、好走度、可比均分、同省/全省排名）；「下一个县城」按钮连续翻阅。
- **4.3 路网好走度可视化（P0）**：下钻懒加载该县 `roads` GeoJSON，按每条路 `walk`（0–100，等级+坡度+离主干道）红→黄→绿上色；左下角图例。
- **4.4 五因子分解面板（P0）**：卡片内显示可达/连通/舒适/安全/吸引均值横条（标权重），点出优势与短板因子。
- **4.5 图层切换（P0）**：顶部图层栏切换 友好区 / 综合分 / 可达 / 连通 / 舒适 / 安全 / 吸引，一键换热力着色。
- **4.6 单格下钻解读（P0）**：点任意格子弹"是否友好格、综合分、最强/最弱因子 vs 全县均、一句话解读"，标准不再黑盒。
- **4.7 权重可调（P0）**：5 滑块实时重算「综合分」图层；友好区阈值不随权重变（面板已提示）。
- **4.8 方法学公开（P0）**：弹层公开公式、权重、友好区判定、数据来源与已知局限。
- **4.9 标准演示 · 架空县城（P0 演示）**：独立 `demo.html` 虚构「云栖县」，含单格叙事、图层切换、权重滑块、**升级标准开关**（绿地进舒适、步道/路灯/过街进安全并对比均分）；用于讲清"标准如何升级"，与正式站点隔离。
- **4.10 自有数据导入（P0）**：`import_own.py` 把 GeoJSON/CSV 路网+POI+高程合成 `data/own/<adcode>.json`，支持 GCJ-02 反算、类别重映射、坐标顺序、模拟标记，绕开 Overpass。

### 5. 评分标准（产品口径）

五因子加权（经验默认值，结构上对齐 Walk Score 思路：POI 可达+多样占 0.50、路网环境占 0.50）：

`score = 0.30·可达 + 0.18·连通 + 0.17·舒适 + 0.15·安全 + 0.20·吸引`

| 因子 | 权重 | 含义 | 来源 |
|------|------|------|------|
| 可达 | 30% | 步行可达 5 类目的地（park/metro/shop/school/hospital）的距离高斯衰减求和 | 路网 + POI |
| 连通 | 18% | 路网交叉口密度 | 路网 |
| 舒适 | 17% | 坡度 | 高程 |
| 安全 | 15% | 离主干道距离（代理） | 路网 |
| 吸引 | 20% | POI 类型丰富度 | POI |

**友好区判定**：刻意去掉吸引力，用其余 4 因子重归一化，均分 ≥ 阈值（默认 65）判为友好格，连片即形成友好区——避免 POI 少的县城被系统性惩罚（有意的公平性决策）。

**可比性**：分数为全县相对值（min-max 归一），跨县不可直接比；站点已做同省排名校正并给 `comparable_score`。

### 6. 数据需求

- **必需**：路网（WGS-84，每县 ±2200m 覆盖）；**核心**：5 类 POI（park/metro/shop/school/hospital）；**可选**：高程（影响舒适）、建筑/绿地（仅可视化，当前不进模型）。
- 坐标系统一 WGS-84；覆盖县城中心 ±2200m；详见下文「使用自有 POI / 路网数据」。
- 数据质量直接影响分数：稀疏县城低分可能是"地图没画完"，详情页给黄色警告。

### 7. 非功能需求

- **性能**：路网不进首屏，下钻才 `fetch` 单县（平均 ~195KB），一次仅驻留一县；首屏 bundle ~172KB。
- **可用性**：MapLibre 失败自动切内联 SVG 兜底，页面永不空白。
- **隐私 / 密钥**：0 密钥、0 商业依赖，GitHub Pages 静态托管。
- **可审计**：方法学公开，县城明细（含每格因子）随站部署可读。

### 8. 验收标准（Definition of Done）

- [x] 宏观图加载可见四省轮廓与县城点位；
- [x] 点绿点下钻出现友好连片 + 路网（红→绿好走度）+ 五因子面板；
- [x] 图层栏切换 7 种热力、点格子出单格解读、权重滑块实时重算、方法学弹层可开；
- [x] 无 key、首屏 < 200KB、SVG 兜底可用；
- [ ] 真实浏览器运行时自测通过（当前受沙箱限制，仅语法 + 逻辑校验）。

### 9. 路线图

**已完成（P0）**：宏观图 / 下钻 / 路网 walk 上色 / 五因子面板 / 图层切换 / 单格解读 / 权重可调 / 方法学 / 架空演示 / 自有数据导入。

**规划中**
- **P1 升级标准落地真实县城**：把绿地纳入舒适、把 `sidewalk/lit/crossing` 纳入安全——需重跑 `build_county.py` 重新生成每格字段（当前真实数据缺这些字段，该能力暂只在演示页）。
- **P1 友好区几何对齐**：前端友好区着色改用后台 `friendly_areas` 几何，消除与前端重算的细微出入。
- **P0（已完成）宏观图接入全部已算县城**：`extract_zones.py` 已改为收录全部已算县城（含无连片者，size=0/连片均分显示"—"），宏观图 280/280 均可下钻（无连片县城下钻后无绿色友好区，仅显示路网与五因子热力）。
- **P2 模拟数据替换**：利津县（370522）当前为 `simulated` 模拟数据，真实数据到达后覆盖即清除。
- **P2 批量续跑看护**：沙箱长后台有 wall-clock 上限，考虑自动化"被杀即重启"续跑。
- **P3 跨县绝对值校准**：把相对分校准为可比绝对值（需外部基准或人工标注样本）。
- **P3 移动端适配**：当前响应式 Web，未做手势 / 性能专项优化。

### 10. 已知限制

1. 分数为全县相对值，跨县不可直接比（已做同省校正）。
2. 安全度用"离主干道距离"代理，未用 OSM 的 `sidewalk/lit/crossing`。
3. 舒适度只看坡度，绿地数据已采集但未进模型。
4. "升级标准"能力需重算数据，目前仅演示页可用。
5. 无连片友好区的县城（112 个）下钻后无绿色友好区，仅显示路网与五因子热力（属预期，非缺陷）。
6. 沙箱无法跑真实浏览器，交互改动仅做语法 + 逻辑校验，未做运行时点击验证。

## 标准演示（架空县城，纯演示）

为把"评分标准如何变得透明、可调、可升级"讲清楚，单独做了一个**虚构县城「云栖县」**的演示页 `demo.html`，与正式站点完全隔离：

- 路网按**街道好走度 walk**（等级 + 坡度 + 离主干道）上色：红 = 不好走、绿 = 好走；
- 点任意格子 → **单格下钻**，自动生成"为什么这格分高/低"的叙事（主因 / 短板 / 是否友好格）；
- 图层可切换：友好区 / 综合分 / 可达 / 连通 / 舒适 / 安全 / 吸引；
- **权重滑块**实时重算综合分（标准可调）；
- **「升级标准」开关**：把绿地纳入舒适度、把步道/路灯/过街纳入安全度，并对比升级前后全县均分；
- 内置「方法学」弹层，公开公式、权重、阈值与数据来源。

演示站点：https://wadesha.github.io/county-walkability/demo.html

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

### 一键导入：import_own.py（GeoJSON / CSV → own 文件）

你手上多半是**导出的 GeoJSON 或 CSV**，不是手写 JSON。本仓库自带转换器，把常见格式直接合成 `data/own/<adcode>.json`（格式 B + 旋钮），不用手工拼 JSON：

```bash
# 单县：路网(GeoJSON) + POI(CSV) + 高程(CSV)，声明 GCJ-02 与类别重映射
python3 import_own.py --adcode 370522 \
    --roads 370522_roads.geojson \
    --pois  370522_pois.csv \
    --elev  370522_elev.csv \
    --coord_sys gcj02 \
    --type_map "restaurant=shop,bank=shop" --type_fallback shop

# 整目录批量：把 <adcode>_roads.* / <adcode>_pois.* / <adcode>_elev.* 丢进一个文件夹
python3 import_own.py --batch ./my_own_data/

# 演示/模拟数据：加 --simulated，产物会带 simulated=true 标记（地图可识别，真实数据到达后覆盖即清除）
python3 import_own.py --adcode 370522 --roads r.geojson --pois p.csv --simulated
```

**输入格式约定**

| 输入 | 支持格式 | 字段 / 说明 |
|------|----------|------------|
| 路网 `--roads` | GeoJSON（`LineString` / `MultiLineString`，`highway` 取 `properties.highway`，缺省 `residential`） | 推荐用高德/腾讯/OSM 导出的路网 GeoJSON |
| 路网 `--roads` | CSV（`id` 分组，`seq` 排序可选，`lng`,`lat`,`highway` 可选） | 无 `id` 列时整张表当作一条线 |
| POI `--pois` | GeoJSON（`Point`，`type`/`name` 取 `properties`） | — |
| POI `--pois` | CSV（`lng`,`lat`,`type`,`name`；表头自动识别中英文：`经度/纬度/类型/名称` 等） | `type` 可任意，靠 `--type_map` 归并到 5 类 |
| 高程 `--elev` | CSV（`lng,lat,h`）或 JSON（`[[lng,lat,h],…]`） | 米；声明后跳过 Open-Meteo |

**旋钮原样透传**：`--coord_sys`（wgs84/gcj02）、`--coord_order`、`--type_map`、`--type_fallback` 都写进 own 文件顶层，真正的坐标反算/重映射由 `build_county.load_own` 统一做——所以**导入时不用预先转坐标、不用改类别**（`build_county.py` 一节已验证：GCJ-02 + 类别非标 + 自带高程四件套同时命中也能正确出分）。

> ⚠️ **坐标系要统一**：`--roads`/`--pois`/`--elev` 必须是**同一种**坐标系，再用 `--coord_sys` 声明。混合坐标系（如路网 GCJ-02、POI WGS-84）无法用一个旋钮覆盖，请先统一再导入。
>
> ⚠️ **数据要盖住县城中心 ±2200m**：管线以 `data/counties.json` 里该县 `wgs` 中心做 169 格网格（±~1040m 盒 + 打分半径）。路网/POI 若离中心太远（>~1.5km），会落在网格盒外 → 连通/可达直接退化。**导出数据时请以县城中心为范围中心**，不要只截主城区一角。

### 字段速查表（精确到字段名 / 类型 / 必需性）

> 功能上**只有 2 类输入真正进打分**：路网（必需）+ 多类 POI（核心）；高程是第 3 类（可选，影响舒适）；建筑 / 绿地只用于可视化，不进打分。

| 维度 | 格式 A（Overpass 透传）字段 | 格式 B（自有简化）字段 | 类型 / 取值 | 必需性 | 进哪些因子 |
|------|------------------------------|--------------------------|-------------|--------|------------|
| **路网** | `elements[]` 中 `type:"way"` 且 `tags.highway` 存在；需 `geometry`（节点序列） | `roads[]`：`geometry:[[lng,lat],…]`（≥2 点）、`highway?`（默认 `residential`） | `highway ∈ {footway,path,pedestrian,living_street,residential,service,unclassified,tertiary,secondary,primary,trunk}`；`motorway/motorway_link` 被跳过 | **必需** | 可达 / 连通 / 安全 / 街道好走度 |
| **POI** | `elements[]` 中 node/way，按 `classify()` 映射：`tags.leisure∈{park,garden}`→park；`tags.railway∈{station,halt,stop,tram_stop}` 或 `station:subway`→metro；`tags.shop`→shop；`tags.amenity∈{hospital,clinic,dentist}`→hospital；`tags.amenity∈{school,university,college,kindergarten}`→school；其余 `amenity`→shop | `pois[]`：`lng`(float)、`lat`(float)、`type∈{park,metro,shop,school,hospital}`、`name?` | 点坐标；`type` 仅这 5 种 | **强烈建议（核心）** | 可达 / 吸引 |
| **高程** | 不来自 A；管线固定调 Open-Meteo 在网格角点采样 | **已支持注入**：`elev:[[lng,lat,h],…]`（米），声明后跳过 Open-Meteo，真实区分坡度 | 米；用于算坡度 | 可选 | 舒适 / 街道好走度(slope) |
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
| 1 | **坐标系是 GCJ-02 / 百度 BD-09，未转 WGS-84**（高德/腾讯/百度导出常见） | own 数据默认按 WGS-84 解读 | 整体偏移 **50–500m**：POI 落错格、与 MapLibre 真实底图（WGS-84）对不上 | ✅ 已内置预案：在 own 文件顶层声明 `"coord_sys":"gcj02"`，管线自动 `gcj2wgs` 反算回 WGS-84（BD-09 需先转 GCJ-02，本管线不处理） |
| 2 | **POI 类别不在 5 类内**（restaurant/bank/cafe/pharmacy/gas_station/gym/library…） | 格式 B 非 5 类会被静默丢弃；格式 A 非已知 amenity 一律归 shop | 一大半 POI 凭空消失 → 可达/吸引塌缩，或全被错算成 shop | ✅ 已内置预案：`"type_map":{"restaurant":"shop","bank":"shop"}` 把任意类别归并到 5 类；再加 `"type_fallback":"shop"` 兜底未命中项（必须在 5 类内） |
| 3 | **经纬度顺序写反**（GeoJSON 是 `[lng,lat]`，很多 CSV 是 `[lat,lng]`） | 格式 B 读 `c[0]` 当经度、`c[1]` 当纬度；写反后整条路/点跑到错误半球 | 路网/POI 跑到离谱位置，全城分数错乱 | ✅ 已内置预案：`"coord_order":"latlng"` 声明数组坐标按 `[lat,lng]` 存，管线自动交换（仅影响 roads/greens/buildings 数组，pois 的命名字段不受影响） |
| 4 | **只给 POI、不给路网**（你说"我有一些 poi 数据"很可能就是这个） | `ways` 为空 → `build_graph` 返回空图 → 每格 `conn_raw=0`、`safe_raw=9999`、街道层为空 | 连通=0、安全=0、街道好走度图层空；分数只剩 `0.30·可达 + 0.20·吸引 + 0.17·中性舒适`，**连通/安全两个维度彻底缺失** | 尽量补全路网；接受"缺连通/安全"的降级结果；或后续用路网密度近似 |
| 5 | **数据只覆盖县城主城区，< 2200m** | 网格外圈格在 ±1000m 外、可达靠 1400m 衰减，路网稀疏 → 外圈 `conn=0` | 友好区偏小、偏中心，外圈全灰，排名失真 | 提供中心 ±2200m 的完整盒子 |
| 6 | **该县城不在 `data/counties.json`**（你手上是鲁苏豫皖以外，或名单漏了） | `main()` 遍历 `counties.json` 按 `adcode` 匹配，找不到就跳过（哪怕有 own 文件） | 跑 `build_county.py <adcode>` 什么也不生成 | 先把该县加进 `counties.json`（需要它的 wgs 中心，可用 DataV/fetch_counties 补） |
| 7 | **想要真实坡度舒适，但 Open-Meteo 被限流** | own 路径若未注入高程，仍调 Open-Meteo；失败 → `slope=0` → 归一后 `comfort` 全 = 100（不区分） | 所有县城舒适分都顶满 100，坡度优劣看不出来 | ✅ 已内置预案：`"elev":[[lng,lat,h],…]` 注入自带高程（米），声明后跳过 Open-Meteo，真实区分坡度（注意：elev 固定 `[lng,lat,h]`，不受 `coord_order` 影响，只受 `coord_sys` 反算影响） |
| 8 | **数据用的是投影坐标（如 Web Mercator 米）而非经纬度** | 所有几何被当成"度"解读 | 全盘错乱、点飞到海外 | 先转成 WGS-84 十进制度 |
| 9 | **密度过低**（POI 只有几个 / 路网只有一两条） | `access`/`attr`/`conn` 都靠数量和分布，样本太少无法撑起分数 | 大量灰格、友好区极小甚至无连片 | 保证中心 ±2200m 内有足够 POI 与路网密度 |

> 一句话总结契约：**WGS-84 经纬度 + 路网（必需）+ 5 类 POI（核心）+ 覆盖 ±2200m**。这四条对齐了，结果就靠谱；任意一条对不上，上表就是对应的"症状—药方"。

### 数据不匹配预案：4 个已内置旋钮（格式 B 顶层声明）

上面风险表里的 ①/②/③/⑦ 现在都有**代码级预案**，不用你手工对齐数据。全部在 `data/own/<adcode>.json` 的**顶层**声明，与 `pois`/`roads` 同级：

| 旋钮 | 取值 | 解决的问题 | 作用域 |
|------|------|-----------|--------|
| `coord_sys` | `"wgs84"`(默认) \| `"gcj02"` | ① GCJ-02（高德/腾讯/百度导出）自动反算回 WGS-84 | 所有坐标（pois 命名字段 + roads/greens/buildings/elev 数组） |
| `coord_order` | `"lnglat"`(默认) \| `"latlng"` | ③ 数组坐标按 `[lat,lng]` 存时自动交换 | 仅 roads/greens/buildings 数组；pois 的 `lng`/`lat` 命名字段不受影响 |
| `type_map` | `{"源类别":"目标类别"}` | ② 任意 POI 类别归并到 5 类，不再静默丢弃 | 仅 pois 的 `type` |
| `type_fallback` | 5 类之一（如 `"shop"`） | ② 未命中 `type_map` 的兜底类别（不在 5 类内会被忽略） | 仅 pois 的 `type` |
| `elev` | `[[lng,lat,h], …]`（米） | ⑦ 自带高程，跳过 Open-Meteo，真实区分坡度 | —（固定 `[lng,lat,h]`，只受 `coord_sys` 反算，不受 `coord_order` 影响） |

**完整示例**（GCJ-02 + 数组写反 + 类别非标 + 自带高程，四种情况同时命中）：

```json
{
  "coord_sys": "gcj02",
  "coord_order": "latlng",
  "type_map": { "restaurant": "shop", "bank": "shop", "cafe": "shop" },
  "type_fallback": "shop",
  "elev": [
    [116.890, 33.490, 12], [116.915, 33.490, 85],
    [116.900, 33.510, 40], [116.902, 33.500, 60]
  ],
  "pois": [
    { "lng": 116.901, "lat": 33.501, "type": "shop",      "name": "便利店" },
    { "lng": 116.905, "lat": 33.498, "type": "restaurant","name": "餐馆" },
    { "lng": 116.899, "lat": 33.503, "type": "bank",      "name": "银行" }
  ],
  "roads": [
    { "highway": "residential", "geometry": [[33.495,116.895],[33.495,116.910]] },
    { "highway": "primary",     "geometry": [[33.500,116.890],[33.500,116.915]] }
  ]
}
```

> 上面的 `geometry` 写成 `[[lat,lng],…]`（因 `coord_order:"latlng"`）、`pois` 里 `restaurant`/`bank` 会被 `type_map` 归成 `shop`、`elev` 自带米制高程——管线全部自动处理，你不必预先转坐标、不必改类别、不必等 Open-Meteo。
>
> ⚠️ 已知坑（已修）：`elev` **固定为 `[lng,lat,h]`**，不要因 `coord_order:"latlng"` 而写成 `[lat,lng,h]`，否则高程会被当成纬度>90 而查表全失效、坡度变 0。
>
> ⚠️ 坐标反算用的是 `wandergis/coordtransform` 标准 GCJ-02 算法（本仓库 `fetch_provinces.py` 同款）。BD-09（百度）需先转 GCJ-02 再喂本管线。

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
import_own.py        把 GeoJSON/CSV 路网+POI+高程 合成 data/own/<adcode>.json（绕过 Overpass）
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

- **已算 280/280** 县城（鲁苏皖豫四省），**全部接入宏观图下钻**（其中 **168 个**有友好连片，112 个暂无连片但仍可下钻看路网与五因子）；另有 **1 个模拟县城（利津县 370522，own_supplied 且 `simulated:true` 标记）**用于演示，真实数据到达后覆盖即清除。
- **Overpass 当前可用镜像（2026-08-06 实测）**：`maps.mail.ru` 的 Overpass 接口真实可拉（利津县 bbox 实测返回 112 段道路）；`overpass-api.de` 偶发 504 过载；`kumi/private.coffee` 沙箱出网仍 000；**`overpass.osm.ch` 是空壳镜像（永远 200 但 elements 为空，会静默拿到空路网，已从端点列表剔除）**。端点顺序已按可用度重排，失败自动换端点 + 指数退避。
- **防封禁已加固**（`build_county.py`）：① 原始 Overpass 响应按县城缓存到 `data/raw/<adcode>.json`，续跑/重跑**不再打扰服务器**（最关键）；② 端点顺序重排 + 指数退避（3→6→12s，封顶 60s）应对 429/504/空结果；③ 县城间礼貌延时（`batch_counties.py --pause 8`，默认 8 秒，失败跳过继续）；④ `signal.alarm(150s)` 硬超时 + 断点续跑。**当前推进计算最稳路径仍是用你自己的 POI/路网数据（见上）**，或等镜像冷却后一键续跑。
- **已修复两个影响数据质量的 bug（针对自有数据路径）**：
  1. GCJ-02 反算主公式分母写错 + `sin` 参数漏 `/180.0`，会把 GCJ-02 坐标算飞到 `1e10` 量级——现已对齐 `wandergis/coordtransform` 标准算法，往返误差 ~1e-7 度（厘米级）。
  2. 坡度（舒适因子）的网格角点查表与建表坐标错开半个格（80m），导致 **169 格全部 miss、坡度永远 0**（舒适分恒为 100、不区分坡度）。现已对齐网格，自有 `elev` 注入与 Open-Meteo 路径的坡度均正常。
  - 注：已算的 48 个县城（走 Overpass）当时也受 bug 2 影响，舒适维度是平的；待 Overpass 恢复后续算会自动修正。

### 防封禁：安全拉取 Overpass 的 5 条纪律
1. **缓存优先**：管线已把每个县城的原始 Overpass 响应存 `data/raw/<adcode>.json`，命中即跳过网络。本地已有缓存时**绝不再查询**，这是避免被限流/封 IP 最根本的一环。
2. **单县串行、县城间留白**：永远单连接顺序拉，县城之间 `--pause 8`（可调到 10~15 更稳），不要并发轰炸。
3. **用可靠镜像 + 退避**：当前 `maps.mail.ru` 最稳；遇 429/504 让管线按 3→6→12s 指数退避，勿立刻重试。
4. **踢掉空壳/坏镜像**：`overpass.osm.ch` 之类"永远 200 但空"的端点必须剔除，否则会静默得到空路网而不报错。
5. **本地镜像兜底**：若担心长期被封，可在**未封锁的网络**下一份 `china-latest.osm.pbf` 或四省裁剪包，放进工作区后离线按县城 bbox 裁切（Geofabrik/planet 在沙箱出网被封，只能本机下）。

## 部署

静态站点，GitHub Pages（`https://wadesha.github.io/county-walkability/`）。`node deploy.js` 通过 GitHub Contents API 上传全部资源（沙箱内 git 智能 HTTP 被拦，故走 REST）。仓库默认 `main` 分支，Pages 源设为 `main /`。

## 密钥说明

无需任何密钥。MapLibre 库与 OpenFreeMap 样式均为免 key 使用；如需换成商业底图（腾讯/高德/Google），可在 `config.local.js` 注入 key 并在 `app.js` 增加对应分支。
