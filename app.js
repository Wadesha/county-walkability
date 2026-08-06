// 县城步行友好 · 宏观图优先 + 下钻架构
// 渲染策略（两路）：
//  [主] MapLibre GL + OpenFreeMap 矢量底图（免 key，真实街道/水系/地名，坐标用 WGS-84 直标）
//  [兜底] 内联 SVG 离线图（带四省真实轮廓）——MapLibre 库未引入 / 底图加载失败时自动启用，永不空白
// 数据已内联到 data_bundle.js（window.APP_DATA），不依赖任何业务网络请求。
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";

  var COUNTIES = [], DETAIL = {}, DETAIL_LIST = [], PROVINCES = [];
  var mode = "overview", curProv = "全部";
  var ML = window.maplibregl;
  var map = null, mapLibreOk = false;
  var COUNTY_CACHE = {};   // adcode -> Promise<json>（县城明细，含路网 GeoJSON）
  var roadsAdcode = null; // 当前下钻县城，防止竞态
  var curDetailAdcode = null; // 当前下钻县城 adcode（用于"下一个县城"导航）
  var factorAdcode = null;   // 因子面板当前县城，防竞态

  // 五因子标准（透明展示用）：权重与线上 build_county.py 完全一致
  var FACTOR_META = [
    { key: "access",  name: "可达性", w: 0.30, color: "#38bdf8" },
    { key: "conn",    name: "连通度", w: 0.18, color: "#a78bfa" },
    { key: "comfort", name: "舒适度", w: 0.17, color: "#34d399" },
    { key: "safety",  name: "安全度", w: 0.15, color: "#f472b6" },
    { key: "attr",    name: "吸引力", w: 0.20, color: "#fbbf24" }
  ];

  // 街道步行质量分 walk(0-100) → 红(差)→黄(中)→绿(好)
  function hexMix(a, b, t) {
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    var ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
    var br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
    var r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }
  function walkColor(w) {
    if (w == null || isNaN(w)) return "#94a3b8";
    w = Math.max(0, Math.min(100, w));
    return w < 50 ? hexMix("#ef4444", "#facc15", w / 50) : hexMix("#facc15", "#22c55e", (w - 50) / 50);
  }
  // 从县城明细 cells 求某因子均值
  function avgFactor(d, key) {
    var fs = (d && d.cells && d.cells.features) || [];
    if (!fs.length) return null;
    var s = 0, n = 0;
    fs.forEach(function (f) { var v = f.properties && f.properties[key]; if (typeof v === "number") { s += v; n++; } });
    return n ? s / n : null;
  }
  // Step 2：县城卡片里的五因子分解面板（与渲染解耦，两路通用）
  function renderFactorPanel(adcode) {
    factorAdcode = adcode;
    loadCounty(adcode).then(function (d) {
      if (factorAdcode !== adcode) return; // 已离开该县城，丢弃
      var box = document.getElementById("factorbox");
      if (!box) return;
      if (!d || !d.cells || !d.cells.features || !d.cells.features.length) {
        box.innerHTML = '<div class="fnote">该县无格级因子数据</div>'; return;
      }
      var rows = FACTOR_META.map(function (m) { return { m: m, v: avgFactor(d, m.key) }; });
      var best = rows[0], worst = rows[0];
      rows.forEach(function (r) { if (r.v > best.v) best = r; if (r.v < worst.v) worst = r; });
      var html = '<div class="ftitle">五因子分解 <span class="fw">（权重已标）</span></div>';
      rows.forEach(function (r) {
        var v = Math.round(r.v);
        html += '<div class="frow"><span class="fl">' + r.m.name + '</span>'
          + '<span class="ftrack"><span class="fbar" style="width:' + v + '%;background:' + r.m.color + '"></span></span>'
          + '<span class="fv">' + v + '<span class="fw2">' + Math.round(r.m.w * 100) + '%</span></span></div>';
      });
      html += '<div class="fsum">优势 <b style="color:' + best.m.color + '">' + best.m.name + '</b> ｜ 短板 <b style="color:' + worst.m.color + '">' + worst.m.name + '</b></div>';
      box.innerHTML = html;
    }).catch(function () {
      var box = document.getElementById("factorbox");
      if (box) box.innerHTML = '<div class="fnote">因子加载失败</div>';
    });
  }

  function byAdcode(ad) {
    for (var i = 0; i < COUNTIES.length; i++) if (String(COUNTIES[i].adcode) === String(ad)) return COUNTIES[i];
    return null;
  }
  function visible() { return COUNTIES.filter(function (c) { return curProv === "全部" || c.province === curProv; }); }

  function flash(name) {
    var t = document.getElementById("hint"), old = t.textContent;
    t.textContent = "「" + name + "」数据收集中…";
    setTimeout(function () { t.textContent = old; }, 1500);
  }
  function showCard(z) {
    var q = z.quality || {}, total = (q.ways || 0) + (q.pois || 0) + (q.buildings || 0);
    var warn = total < 120
      ? '<div class="warn">⚠ 该县 OSM 数据偏稀疏（路' + (q.ways || 0) + '/POI' + (q.pois || 0) + '/建' + (q.buildings || 0) + '），低分可能反映地图未补全。</div>'
      : "";
    document.getElementById("detailcard").innerHTML =
      '<h2>' + z.name + '</h2>' +
      '<div class="meta">' + z.province + ' · ' + (z.parent || "") + '</div>' +
      '<div class="kv">' +
        '<div class="b"><div class="k">最大连片</div><div class="v">' + z.size + '<span style="font-size:10px;color:#94a3b8"> 格</span></div></div>' +
        '<div class="b"><div class="k">连片均分</div><div class="v">' + (z.score_avg || 0) + '</div></div>' +
        '<div class="b"><div class="k">县城好走度</div><div class="v">' + (z.score_mean || 0) + '</div></div>' +
        '<div class="b"><div class="k">可比均分</div><div class="v">' + (z.comparable_score != null ? z.comparable_score : "—") + '<span style="font-size:10px;color:#94a3b8"> /100</span></div></div>' +
        '<div class="b"><div class="k">同省排名</div><div class="v">' + (z.province_rank ? ("#" + z.province_rank) : "—") + '</div></div>' +
        '<div class="b"><div class="k">全省名</div><div class="v">' + (z.global_rank ? ("#" + z.global_rank) : "—") + '</div></div>' +
      '</div>' + warn +
      '<div id="factorbox" class="factorbox"></div>' +
      '<div class="nextrow"><span id="nextc" class="nextc">下一个县城 ›</span></div>';
  }

  // ===================== 省份筛选 + 密集目录（DOM，两路共用） =====================
  function buildChips() {
    var provs = ["全部"];
    COUNTIES.forEach(function (c) { if (provs.indexOf(c.province) < 0) provs.push(c.province); });
    var box = document.getElementById("provtabs"); box.innerHTML = "";
    provs.forEach(function (p) {
      var b = document.createElement("button");
      b.textContent = p; if (p === curProv) b.className = "active";
      b.onclick = function () {
        curProv = p;
        document.querySelectorAll("#provtabs button").forEach(function (x) { x.className = ""; });
        b.className = "active";
        renderOverview(); buildDir();
      };
      box.appendChild(b);
    });
  }
  function buildDir() {
    var box = document.getElementById("dirlist"); box.innerHTML = "";
    visible().forEach(function (c) {
      var s = document.createElement("span");
      s.className = "c " + (DETAIL[c.adcode] ? "on" : "off");
      s.textContent = c.name;
      s.onclick = function () { if (DETAIL[c.adcode]) enterDetail(String(c.adcode)); else flash(c.name); };
      box.appendChild(s);
    });
  }
  function bindUi() {
    document.getElementById("back").onclick = backToOverview;
    document.getElementById("dirtoggle").onclick = function () {
      var d = document.getElementById("dir");
      d.classList.toggle("collapsed");
      document.getElementById("dirtoggle").textContent = d.classList.contains("collapsed") ? "目录 ▸" : "目录 ▾";
    };
    // 详情卡片内的「下一个县城」——事件委托（innerHTML 重建后依然有效）
    document.getElementById("detailcard").addEventListener("click", function (e) {
      if (e.target && e.target.id === "nextc") {
        var n = nextCountyAdcode();
        if (n) enterDetail(n);
      }
    });
  }

  // ===================== 入口分发 =====================
  function renderOverview() {
    if (mapLibreOk) maplibreRenderOverview(); else renderOverviewSvg();
  }
  function enterDetail(adcode) {
    mode = "detail";
    document.body.classList.add("detail");
    var z = DETAIL[adcode];
    if (!z) { document.body.classList.remove("detail"); mode = "overview"; return; }
    curDetailAdcode = String(adcode); // 记录当前县城，供"下一个县城"使用
    if (mapLibreOk) maplibreEnterDetail(z); else drawDetailSvg(adcode);
    renderFactorPanel(String(adcode)); // Step 2 因子分解面板（与渲染解耦，两路通用）
  }
  // 在「当前省份筛选」顺序中，找下一个有数据的县城（循环到开头）
  function nextCountyAdcode() {
    if (!curDetailAdcode) return null;
    var list = visible();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].adcode) === curDetailAdcode) { idx = i; break; }
    }
    if (idx < 0) return null;
    for (var k = 1; k <= list.length; k++) {
      var cand = list[(idx + k) % list.length];
      if (DETAIL[cand.adcode]) return String(cand.adcode);
    }
    return null;
  }
  function backToOverview() {
    mode = "overview";
    document.body.classList.remove("detail");
    if (mapLibreOk) maplibreExitDetail(); else { setProj(116.5, 34, 17); renderOverviewSvg(); }
  }

  // ===================== GeoJSON 构造（MapLibre 用，坐标均为 WGS-84） =====================
  function countyPointFC() {
    var feats = visible().map(function (c) {
      return { type: "Feature", properties: { adcode: String(c.adcode), name: c.name, hasData: DETAIL[c.adcode] ? 1 : 0 },
               geometry: { type: "Point", coordinates: [c.wgs[0], c.wgs[1]] } };
    });
    return { type: "FeatureCollection", features: feats };
  }
  function provinceFC() {
    var feats = [];
    PROVINCES.forEach(function (pv) {
      pv.rings.forEach(function (ring) {
        feats.push({ type: "Feature", properties: { name: pv.name },
                     geometry: { type: "LineString", coordinates: ring.map(function (p) { return [p[0], p[1]]; }) } });
      });
    });
    return { type: "FeatureCollection", features: feats };
  }
  function cellsFC(z) {
    var feats = z.cells.map(function (cell) {
      var lng = cell.c[0], lat = cell.c[1], w = cell.w, h = cell.h;
      return { type: "Feature", properties: { name: z.name },
               geometry: { type: "Polygon", coordinates: [[[lng - w, lat - h], [lng + w, lat - h], [lng + w, lat + h], [lng - w, lat + h], [lng - w, lat - h]]] } };
    });
    return { type: "FeatureCollection", features: feats };
  }
  function centerFC(z) {
    return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: z.center } }] };
  }

  // ===================== 县城明细懒加载（路网 GeoJSON，WGS-84 直标，与底图对齐） =====================
  function loadCounty(adcode) {
    if (COUNTY_CACHE[adcode]) return COUNTY_CACHE[adcode];
    var p = fetch("data/" + adcode + ".json").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).catch(function (e) { delete COUNTY_CACHE[adcode]; throw e; });
    COUNTY_CACHE[adcode] = p;
    return p;
  }
  function hwColor(hw) {
    return ({ trunk: "#f59e0b", primary: "#f97316", secondary: "#38bdf8",
      tertiary: "#7dd3fc", residential: "#cbd5e1", service: "#64748b",
      unclassified: "#cbd5e1", path: "#a3a3a3", footway: "#a3a3a3" })[hw] || "#94a3b8";
  }
  function hwWidth(hw) {
    return ({ trunk: 4, primary: 3.2, secondary: 2.4, tertiary: 1.8,
      residential: 1.4, service: 1, unclassified: 1.4, path: 0.8, footway: 0.8 })[hw] || 1.4;
  }
  function addRoadLayer(layer) {
    var before = map.getLayer("detail-center") ? "detail-center" : undefined;
    map.addLayer(layer, before);
  }
  function renderRoadsML(adcode) {
    roadsAdcode = adcode;
    loadCounty(adcode).then(function (d) {
      if (roadsAdcode !== adcode || !mapLibreOk) return; // 已离开该县城，丢弃
      var roads = d && d.roads;
      if (!roads || !roads.features || !roads.features.length) return; // 无路网（稀疏/模拟）
      if (!map.getSource("roads")) {
        map.addSource("roads", { type: "geojson", data: roads });
        addRoadLayer({ id: "roads-casing", type: "line", source: "roads",
          paint: { "line-color": "#0b1220", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2, 15, 5], "line-opacity": 0.4 } });
        addRoadLayer({ id: "roads-line", type: "line", source: "roads",
          paint: {
            "line-color": ["interpolate", ["linear"], ["coalesce", ["get", "walk"], 50],
              5, "#ef4444", 50, "#facc15", 95, "#22c55e"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 11,
              ["match", ["get", "hw"], "trunk", 1.5, "primary", 1.2, "secondary", 0.9, "tertiary", 0.7, "residential", 0.6, "service", 0.4, "unclassified", 0.6, "path", 0.3, "footway", 0.3, 0.6],
              15, ["match", ["get", "hw"], "trunk", 4, "primary", 3.2, "secondary", 2.4, "tertiary", 1.8, "residential", 1.4, "service", 1, "unclassified", 1.4, "path", 0.8, "footway", 0.8, 1.4]]
          } });
      } else {
        map.getSource("roads").setData(roads);
      }
    }).catch(function (e) { console.warn("路网加载失败", adcode, e); });
  }
  function clearRoadsML() {
    if (map && map.getSource("roads")) {
      ["roads-line", "roads-casing"].forEach(function (id) { try { map.removeLayer(id); } catch (e) {} });
      try { map.removeSource("roads"); } catch (e) {}
    }
    roadsAdcode = null;
  }
  function renderRoadsSvg(adcode) {
    loadCounty(adcode).then(function (d) {
      var roads = d && d.roads;
      if (!roads || !roads.features) return;
      roads.features.forEach(function (f) {
        var g = f.geometry || {};
        var lines = g.type === "LineString" ? [g.coordinates] : (g.type === "MultiLineString" ? g.coordinates : []);
        lines.forEach(function (coords) {
          var pts = coords.map(function (p) { var q = toXY(p[0], p[1]); return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ");
          var pl = document.createElementNS(NS, "polyline");
          pl.setAttribute("points", pts);
          pl.setAttribute("fill", "none");
          pl.setAttribute("stroke", walkColor(f.properties && f.properties.walk));
          pl.setAttribute("stroke-width", Math.max(0.5, hwWidth(f.properties && f.properties.hw) * 0.4));
          pl.setAttribute("stroke-opacity", "0.9");
          svgG.appendChild(pl);
        });
      });
    }).catch(function () {});
  }

  // ===================== MapLibre 真实底图路径 =====================
  function tryInitMapLibre() {
    try {
      map = new ML.Map({ container: "map", style: "https://tiles.openfreemap.org/styles/liberty",
                         center: [116.5, 34], zoom: 6.4, attributionControl: true });
    } catch (e) {
      console.warn("MapLibre init threw, 回退 SVG:", e); fallbackSvg(); return;
    }
    map.on("load", function () {
      mapLibreOk = true;
      map.addSource("prov-lines", { type: "geojson", data: provinceFC() });
      map.addLayer({ id: "prov-lines", type: "line", source: "prov-lines",
        paint: { "line-color": "#64748b", "line-width": 1, "line-opacity": 0.75 } });
      map.addSource("county-points", { type: "geojson", data: countyPointFC() });
      map.addLayer({ id: "county-points", type: "circle", source: "county-points",
        paint: {
          "circle-radius": ["case", ["==", ["get", "hasData"], 1], 5, 3],
          "circle-color": ["case", ["==", ["get", "hasData"], 1], "#16a34a", "rgba(148,163,184,0.5)"],
          "circle-stroke-color": ["case", ["==", ["get", "hasData"], 1], "#bbf7d0", "rgba(148,163,184,0.7)"],
          "circle-stroke-width": 1
        } });
      map.on("click", "county-points", onPointClick);
      map.on("mousemove", "county-points", onPointMove);
      map.on("mouseleave", "county-points", onPointLeave);
      if (svg) svg.style.display = "none";
      document.getElementById("hint").textContent = "真实底图(OpenFreeMap) · 绿点=已有数据，点绿点下钻 · 灰点=收集中";
    });
    map.on("error", function (e) {
      if (!mapLibreOk) { console.warn("MapLibre 底图加载失败，回退 SVG:", e && e.error); fallbackSvg(); }
    });
  }
  function onPointClick(e) {
    if (!e.features || !e.features.length) return;
    var p = e.features[0].properties;
    if (p.hasData) enterDetail(p.adcode); else { var c = byAdcode(p.adcode); flash(c ? c.name : ""); }
  }
  function onPointMove(e) {
    if (!e.features || !e.features.length) return;
    var t = document.getElementById("tip");
    t.textContent = e.features[0].properties.name;
    t.style.left = e.point.x + "px"; t.style.top = e.point.y + "px"; t.style.display = "block";
  }
  function onPointLeave() { document.getElementById("tip").style.display = "none"; }

  function maplibreRenderOverview() {
    if (map && map.getSource("county-points")) map.getSource("county-points").setData(countyPointFC());
  }
  function maplibreEnterDetail(z) {
    if (!map.getSource("detail-fill")) {
      map.addSource("detail-fill", { type: "geojson", data: cellsFC(z) });
      map.addLayer({ id: "detail-fill", type: "fill", source: "detail-fill", paint: { "fill-color": "#16a34a", "fill-opacity": 0.45 } });
      map.addLayer({ id: "detail-line", type: "line", source: "detail-fill", paint: { "line-color": "#16a34a", "line-width": 1 } });
      map.addSource("detail-center", { type: "geojson", data: centerFC(z) });
      map.addLayer({ id: "detail-center", type: "circle", source: "detail-center",
        paint: { "circle-radius": 6, "circle-color": "#f97316", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
    } else {
      map.getSource("detail-fill").setData(cellsFC(z));
      map.getSource("detail-center").setData(centerFC(z));
    }
    map.flyTo({ center: z.center, zoom: 13 });
    showCard(z);
    renderRoadsML(String(z.id)); // 懒加载该县路网，下钻时才取
  }
  function maplibreExitDetail() {
    clearRoadsML();
    if (map.getSource("detail-fill")) {
      ["detail-line", "detail-fill", "detail-center"].forEach(function (id) { try { map.removeLayer(id); } catch (e) {} });
      ["detail-fill", "detail-center"].forEach(function (id) { try { map.removeSource(id); } catch (e) {} });
    }
    map.flyTo({ center: [116.5, 34], zoom: 6.4 });
  }

  // ===================== 内联 SVG 离线路径（带四省轮廓，兜底） =====================
  var svg = null, svgG = null;
  var VB = { w: 1000, h: 640 };
  var proj = { cx: 116.5, cy: 34, sl: 17, slat: 17 / 1000 * 640 };
  function setProj(cx, cy, sl) { proj.cx = cx; proj.cy = cy; proj.sl = sl; proj.slat = sl / VB.w * VB.h; }
  function toXY(lng, lat) {
    return [ (lng - proj.cx) / proj.sl * VB.w + VB.w / 2, (proj.cy - lat) / proj.slat * VB.h + VB.h / 2 ];
  }
  function ensureSvg() {
    if (svg) return;
    svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", "0 0 " + VB.w + " " + VB.h);
    svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
    svg.style.position = "absolute"; svg.style.inset = "0"; svg.style.background = "#0f172a";
    document.getElementById("map").appendChild(svg);
    svgG = document.createElementNS(NS, "g"); svg.appendChild(svgG);
  }
  function clearSvg() { while (svgG && svgG.firstChild) svgG.removeChild(svgG.firstChild); }
  function drawProvincesSvg() {
    PROVINCES.forEach(function (prov) {
      prov.rings.forEach(function (ring) {
        var pts = ring.map(function (p) { var q = toXY(p[0], p[1]); return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ");
        var pg = document.createElementNS(NS, "polygon");
        pg.setAttribute("points", pts);
        pg.setAttribute("fill", "rgba(51,65,85,0.55)");
        pg.setAttribute("stroke", "rgba(100,116,139,0.85)");
        pg.setAttribute("stroke-width", 1);
        svgG.appendChild(pg);
      });
    });
  }
  function renderOverviewSvg() {
    ensureSvg(); clearSvg();
    drawProvincesSvg();
    var lng, lat, x, y, ln, lt;
    for (lng = 110; lng <= 124; lng += 2) {
      x = toXY(lng, proj.cy)[0];
      ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", x); ln.setAttribute("y1", 0); ln.setAttribute("x2", x); ln.setAttribute("y2", VB.h);
      ln.setAttribute("stroke", "rgba(148,163,184,0.10)"); ln.setAttribute("stroke-width", 1);
      svgG.appendChild(ln);
    }
    for (lat = 30; lat <= 38; lat += 2) {
      y = toXY(proj.cx, lat)[1];
      lt = document.createElementNS(NS, "line");
      lt.setAttribute("x1", 0); lt.setAttribute("y1", y); lt.setAttribute("x2", VB.w); lt.setAttribute("y2", y);
      lt.setAttribute("stroke", "rgba(148,163,184,0.10)"); lt.setAttribute("stroke-width", 1);
      svgG.appendChild(lt);
    }
    visible().forEach(function (c) {
      var p = toXY(c.wgs[0], c.wgs[1]);
      var has = !!DETAIL[c.adcode];
      var dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", p[0]); dot.setAttribute("cy", p[1]);
      dot.setAttribute("r", has ? 4.5 : 3);
      dot.setAttribute("fill", has ? "rgba(22,163,74,0.95)" : "rgba(148,163,184,0.45)");
      dot.setAttribute("stroke", has ? "#bbf7d0" : "rgba(148,163,184,0.6)");
      dot.setAttribute("stroke-width", 1);
      dot.style.cursor = "pointer";
      dot.addEventListener("click", function () { if (has) enterDetail(String(c.adcode)); else flash(c.name); });
      dot.addEventListener("mousemove", function (e) {
        var t = document.getElementById("tip");
        t.textContent = c.name; t.style.display = "block";
        t.style.left = e.clientX + "px"; t.style.top = e.clientY + "px";
      });
      dot.addEventListener("mouseout", function () { document.getElementById("tip").style.display = "none"; });
      svgG.appendChild(dot);
    });
  }
  function drawDetailSvg(adcode) {
    var z = DETAIL[adcode]; if (!z) return;
    ensureSvg(); clearSvg();
    setProj(z.center[0], z.center[1], 0.06);
    z.cells.forEach(function (cell) {
      var lng = cell.c[0], lat = cell.c[1], w = cell.w, h = cell.h;
      var a0 = toXY(lng - w, lat + h), b0 = toXY(lng + w, lat + h), c0 = toXY(lng + w, lat - h), d0 = toXY(lng - w, lat - h);
      var pg = document.createElementNS(NS, "polygon");
      pg.setAttribute("points", [a0, b0, c0, d0].map(function (q) { return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" "));
      pg.setAttribute("fill", "rgba(22,163,74,0.45)");
      pg.setAttribute("stroke", "#16a34a"); pg.setAttribute("stroke-width", 0.5);
      svgG.appendChild(pg);
    });
    var cp = toXY(z.center[0], z.center[1]);
    var cdot = document.createElementNS(NS, "circle");
    cdot.setAttribute("cx", cp[0]); cdot.setAttribute("cy", cp[1]); cdot.setAttribute("r", 6);
    cdot.setAttribute("fill", "rgba(249,115,22,0.95)"); cdot.setAttribute("stroke", "#fff"); cdot.setAttribute("stroke-width", 1.5);
    svgG.appendChild(cdot);
    showCard(z);
    renderRoadsSvg(adcode); // 兜底 SVG 路径也画路网（best-effort）
  }

  function fallbackSvg() {
    if (mapLibreOk) return;
    try { if (map) map.remove(); } catch (e) {}
    map = null;
    ensureSvg(); setProj(116.5, 34, 17); renderOverviewSvg();
    document.getElementById("hint").textContent = "（离线示意图：真实底图不可用）· 绿点=已有数据，点绿点下钻 · 灰点=收集中";
  }

  // ===================== 启动 =====================
  var DATA = window.APP_DATA || { counties: [], zones: [], provinces: [] };
  COUNTIES = DATA.counties || [];
  DETAIL_LIST = DATA.zones || [];
  PROVINCES = DATA.provinces || [];
  DETAIL_LIST.forEach(function (z) { DETAIL[z.id] = z; });

  // 路网步行质量图例（红=差→黄=中→绿=好），仅在县城详情显示
  function updateRoadLegend() {
    var el = document.getElementById("roadlegend");
    if (!el) return;
    el.innerHTML = '<span class="rl-t">路网好走度</span>'
      + '<span class="rl-bar"></span>'
      + '<span class="rl-l"><b style="color:#ef4444">差</b> 0</span>'
      + '<span class="rl-l"><b style="color:#facc15">中</b> 50</span>'
      + '<span class="rl-l"><b style="color:#22c55e">好</b> 100</span>';
  }
  function boot() {
    if (COUNTIES.length === 0) {
      document.getElementById("hint").textContent = "数据为空：请重新生成 data_bundle.js";
      return;
    }
    updateRoadLegend();
    // 1) 立刻画 SVG 兜底（绝不空白），MapLibre 加载完会盖上去
    ensureSvg(); setProj(116.5, 34, 17); renderOverviewSvg();
    buildChips(); buildDir(); bindUi();
    document.getElementById("hint").textContent = "正在加载真实底图…";
    // 2) 尝试 MapLibre 真实底图（免 key）；失败/超时自动留 SVG
    if (typeof window.maplibregl !== "undefined") {
      tryInitMapLibre();
      // 兜底计时：真实底图未加载则回退 SVG。默认 15s（中国网络更稳），可用 ?fb=毫秒 覆盖用于调试。
      var fbMs = 15000;
      var m = /fb=(\d+)/.exec(location.search || "");
      if (m && m[1]) fbMs = parseInt(m[1], 10);
      setTimeout(function () { if (!mapLibreOk) fallbackSvg(); }, fbMs);
    } else {
      document.getElementById("hint").textContent = "（离线示意图：未引入地图库）· 绿点=已有数据，点绿点下钻 · 灰点=收集中";
    }
  }
  boot();
})();
