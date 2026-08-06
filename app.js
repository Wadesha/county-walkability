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
        '<div class="b"><div class="k">最大连片</div><div class="v">' + (z.size ? (z.size + '<span style="font-size:10px;color:#94a3b8"> 格</span>') : '—') + '</div></div>' +
        '<div class="b"><div class="k">连片均分</div><div class="v">' + (z.score_avg != null ? z.score_avg : '—') + '</div></div>' +
        '<div class="b"><div class="k">县城好走度</div><div class="v">' + (z.score_mean || 0) + '</div></div>' +
        '<div class="b"><div class="k">可比均分</div><div class="v">' + (z.comparable_score != null ? z.comparable_score : "—") + '<span style="font-size:10px;color:#94a3b8"> /100</span></div></div>' +
        '<div class="b"><div class="k">同省排名</div><div class="v">' + (z.province_rank ? ("#" + z.province_rank) : "—") + '</div></div>' +
        '<div class="b"><div class="k">全省名</div><div class="v">' + (z.global_rank ? ("#" + z.global_rank) : "—") + '</div></div>' +
      '</div>' + warn +
      (z.size ? '' : '<div class="warn">该县暂无连片友好区（仍可下钻看路网与五因子分解）</div>') +
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
      var zd = DETAIL[c.adcode];
      s.className = "c " + (zd ? (zd.size > 0 ? "on" : "") : "off");
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
    // 县城内交互：图层切换
    document.querySelectorAll("#layerbar .lb").forEach(function (b) {
      b.onclick = function () { setLayer(b.getAttribute("data-k")); };
    });
    // 「用户点亮网格」标记模式开关（仅当前会话，点格变红并假装记录）
    var markBtn = document.getElementById("markbtn");
    if (markBtn) markBtn.onclick = function () {
      markMode = !markMode;
      markBtn.classList.toggle("on", markMode);
      markBtn.textContent = markMode ? "标记中 ✓" : "标记";
      updateMarkBadge();
      refreshCells(); // 重绘当前县城：MapLibre 加红层 / SVG 实时变红
    };
    // 权重面板开关
    var wt = document.getElementById("wtoggle");
    if (wt) wt.onclick = function () {
      var wp = document.getElementById("wpanel");
      var show = wp.style.display === "none";
      wp.style.display = show ? "block" : "none";
      wt.textContent = show ? "权重 ▴" : "权重 ▾";
    };
    // 生成 5 个权重滑块（插入到 #wnote 之前）
    var wp = document.getElementById("wpanel");
    if (wp) {
      FACTOR_META.forEach(function (m) {
        var row = document.createElement("div"); row.className = "wrow";
        row.innerHTML = '<span class="wl">' + m.name + '</span>'
          + '<input id="w_' + m.key + '" class="wslider" type="range" min="0" max="100" value="' + Math.round(m.w * 100) + '">'
          + '<span class="wv" id="wv_' + m.key + '">' + Math.round(m.w * 100) + '%</span>';
        wp.insertBefore(row, document.getElementById("wnote"));
        var el = row.querySelector("input");
        el.addEventListener("input", function () {
          document.getElementById("wv_" + m.key).textContent = el.value + "%";
          onWeightInput();
        });
      });
    }
    var mb = document.getElementById("mbtn"); if (mb) mb.onclick = openMethod;
    var mc = document.getElementById("mclose"); if (mc) mc.onclick = closeMethod;
    var mm = document.getElementById("methodmodal"); if (mm) mm.addEventListener("click", function (e) { if (e.target === mm) closeMethod(); });
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
    marked = {}; updateMarkBadge();    // 进入新县城：清空上一县城的标记（仅会话级）
    var cn = document.getElementById("cellnote"); if (cn) cn.style.display = "none";
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
    markMode = false;
    var mb2 = document.getElementById("markbtn"); if (mb2) { mb2.classList.remove("on"); mb2.textContent = "标记"; }
    updateMarkBadge();
    var cn = document.getElementById("cellnote"); if (cn) cn.style.display = "none";
    closeMethod();
    if (mapLibreOk) maplibreExitDetail(); else { setProj(116.5, 34, 17); renderOverviewSvg(); }
  }

  // ===================== GeoJSON 构造（MapLibre 用，坐标均为 WGS-84） =====================
  function countyPointFC() {
    var feats = visible().map(function (c) {
      var z0 = DETAIL[c.adcode];
      return { type: "Feature", properties: { adcode: String(c.adcode), name: c.name, hasData: z0 ? 1 : 0, hasArea: (z0 && z0.size > 0) ? 1 : 0 },
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
          "circle-radius": ["case", ["==", ["get", "hasArea"], 1], 5, 4],
          "circle-color": ["case", ["==", ["get", "hasArea"], 1], "#16a34a", "rgba(148,163,184,0.6)"],
          "circle-stroke-color": ["case", ["==", ["get", "hasArea"], 1], "#bbf7d0", "rgba(148,163,184,0.8)"],
          "circle-stroke-width": 1
        } });
      map.on("click", "county-points", onPointClick);
      map.on("mousemove", "county-points", onPointMove);
      map.on("mouseleave", "county-points", onPointLeave);
      if (svg) svg.style.display = "none";
      document.getElementById("hint").textContent = "真实底图(OpenFreeMap) · 绿点=有连片友好区，灰点=已接入(暂无连片友好区)，点任意点下钻";
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
    if (!map.getSource("detail-center")) {
      map.addSource("detail-center", { type: "geojson", data: centerFC(z) });
      map.addLayer({ id: "detail-center", type: "circle", source: "detail-center",
        paint: { "circle-radius": 6, "circle-color": "#f97316", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
    } else {
      map.getSource("detail-center").setData(centerFC(z));
    }
    map.flyTo({ center: z.center, zoom: 13 });
    showCard(z);
    renderRoadsML(String(z.id)); // 懒加载该县路网
    renderCellsML(String(z.id)); // 格级热力 + 单格下钻 + 权重
  }
  function maplibreExitDetail() {
    clearRoadsML();
    if (map.getSource("cells-fill")) {
      try { map.off("click", "cells-fill", onCellClick); } catch (e) {}
      try { map.off("mousemove", "cells-fill", onCellMove); } catch (e) {}
      try { map.off("mouseleave", "cells-fill", onCellLeave); } catch (e) {}
      ["cells-fill", "detail-center"].forEach(function (id) { try { map.removeLayer(id); } catch (e) {} });
      ["cells-fill", "detail-center"].forEach(function (id) { try { map.removeSource(id); } catch (e) {} });
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
      var z = DETAIL[c.adcode];
      var drill = !!z, area = z && z.size > 0;
      var dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", p[0]); dot.setAttribute("cy", p[1]);
      dot.setAttribute("r", area ? 4.5 : (drill ? 4 : 3));
      dot.setAttribute("fill", area ? "rgba(22,163,74,0.95)" : "rgba(148,163,184,0.5)");
      dot.setAttribute("stroke", area ? "#bbf7d0" : "rgba(148,163,184,0.7)");
      dot.setAttribute("stroke-width", 1);
      dot.style.cursor = "pointer";
      dot.addEventListener("click", function () { if (drill) enterDetail(String(c.adcode)); else flash(c.name); });
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
    renderCellsSvg(adcode); // 真实因子热力 + 路网 + 单格点击（含即时绿色占位已由上面画出）
  }

  function fallbackSvg() {
    if (mapLibreOk) return;
    try { if (map) map.remove(); } catch (e) {}
    map = null;
    ensureSvg(); setProj(116.5, 34, 17); renderOverviewSvg();
    document.getElementById("hint").textContent = "（离线示意图：真实底图不可用）· 绿点=有连片友好区，灰点=已接入(暂无连片友好区)，点任意点下钻";
  }

  // ===================== 县城内交互：图层 / 单格下钻 / 权重 / 方法学 =====================
  var curLayer = "friendly";
  var curW = {}; FACTOR_META.forEach(function (m) { curW[m.key] = m.w; });
  var cellsData = {};     // adcode -> { features, means, thr }
  var cellAdcode = null;  // 防竞态
  var markMode = false;   // 「用户点亮网格」标记模式
  var marked = {};        // cellKey -> true（仅当前会话，刷新即清空，不落盘）
  function cellKey(p) { var c = p && p.raw && p.raw.center; return c ? (c[0].toFixed(5) + "," + c[1].toFixed(5)) : null; }
  function markFC() {
    var ad = cellsData[curDetailAdcode]; if (!ad) return { type: "FeatureCollection", features: [] };
    var feats = ad.features.filter(function (f) { var k = cellKey(f.properties); return k && marked[k]; })
      .map(function (f) { return { type: "Feature", properties: {}, geometry: f.geometry }; });
    return { type: "FeatureCollection", features: feats };
  }
  function ensureMarkLayerML() {
    if (!map || !map.getSource("cells-fill") || map.getSource("cells-marked")) return;
    map.addSource("cells-marked", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "cells-marked", type: "fill", source: "cells-marked",
      paint: { "fill-color": "rgba(239,68,68,0.8)", "fill-opacity": 0.85 } }, "cells-fill");
  }
  function updateMarkLayer() { if (mapLibreOk && map.getSource("cells-marked")) map.getSource("cells-marked").setData(markFC()); }
  function updateMarkBadge() {
    var b = document.getElementById("markbadge"); if (!b) return;
    if (!markMode) { b.style.display = "none"; return; }
    var n = Object.keys(marked).length;
    b.style.display = "block";
    b.innerHTML = "已标记 <b>" + n + "</b> 格 · 已记录" + (n ? ' <a id="markclear" href="javascript:void(0)">清空</a>' : "");
    var clr = document.getElementById("markclear"); if (clr) clr.onclick = clearMarks;
  }
  function clearMarks() { marked = {}; refreshCells(); updateMarkBadge(); }
  function refreshCells() {
    if (mapLibreOk) { ensureMarkLayerML(); updateMarkLayer(); }
    else if (mode === "detail" && curDetailAdcode) renderCellsSvg(curDetailAdcode);
  }
  function toggleMark(p) {
    var k = cellKey(p); if (!k) return;
    if (marked[k]) delete marked[k]; else marked[k] = true;
    refreshCells(); updateMarkBadge();
  }

  function normF(v, mn, mx) { if (mn === mx) return 50; return Math.round((v - mn) / (mx - mn) * 100); }
  function compOf(n) {
    var s = 0, ws = 0;
    FACTOR_META.forEach(function (m) { s += curW[m.key] * n[m.key]; ws += curW[m.key]; });
    return Math.round(s / ws);
  }
  function buildCellFeatures(d) {
    var feats = d.cells.features;
    var mn = {}, mx = {};
    FACTOR_META.forEach(function (m) { mn[m.key] = Infinity; mx[m.key] = -Infinity; });
    feats.forEach(function (f) {
      var p = f.properties || {};
      FACTOR_META.forEach(function (m) { var v = p[m.key]; if (typeof v === "number") { if (v < mn[m.key]) mn[m.key] = v; if (v > mx[m.key]) mx[m.key] = v; } });
    });
    var thr = d.friendly_threshold || 65, means = {};
    FACTOR_META.forEach(function (m) { means[m.key] = 0; });
    var out = feats.map(function (f) {
      var p = f.properties || {};
      var n = {};
      FACTOR_META.forEach(function (m) { n[m.key] = normF(p[m.key], mn[m.key], mx[m.key]); means[m.key] += n[m.key]; });
      var fscore = (n.access + n.conn + n.comfort + n.safety) / 4;
      var nf = Object.assign({}, n, { friendly: fscore >= thr, raw: p });
      nf.comp = compOf(nf);
      return { type: "Feature", properties: nf, geometry: f.geometry };
    });
    FACTOR_META.forEach(function (m) { means[m.key] = Math.round(means[m.key] / out.length); });
    return { features: out, means: means, thr: thr };
  }
  function cellsPaint() {
    if (curLayer === "friendly") {
      return { "fill-color": ["case", ["get", "friendly"], "rgba(34,197,94,0.55)", "rgba(100,116,139,0.05)"], "fill-opacity": 1 };
    }
    var key = curLayer === "score" ? "comp" : curLayer;
    return { "fill-color": ["interpolate", ["linear"], ["get", key], 0, "#ef4444", 50, "#facc15", 100, "#22c55e"], "fill-opacity": 0.8 };
  }
  function applyCellsPaint() {
    if (!map || !map.getLayer("cells-fill")) return;
    var p = cellsPaint();
    map.setPaintProperty("cells-fill", "fill-color", p["fill-color"]);
    map.setPaintProperty("cells-fill", "fill-opacity", p["fill-opacity"]);
  }
  function renderCellsML(adcode) {
    cellAdcode = String(adcode);
    loadCounty(adcode).then(function (d) {
      if (cellAdcode !== String(adcode) || !mapLibreOk) return;
      if (!d || !d.cells || !d.cells.features || !d.cells.features.length) return;
      var built = buildCellFeatures(d);
      cellsData[adcode] = built;
      if (!map.getSource("cells-fill")) {
        map.addSource("cells-fill", { type: "geojson", data: { type: "FeatureCollection", features: built.features } });
        map.addLayer({ id: "cells-fill", type: "fill", source: "cells-fill", paint: cellsPaint() }, map.getLayer("detail-center") ? "detail-center" : undefined);
        map.on("click", "cells-fill", onCellClick);
        map.on("mousemove", "cells-fill", onCellMove);
        map.on("mouseleave", "cells-fill", onCellLeave);
      } else {
        map.getSource("cells-fill").setData({ type: "FeatureCollection", features: built.features });
        applyCellsPaint();
      }
      if (markMode) { ensureMarkLayerML(); updateMarkLayer(); }
    }).catch(function (e) { console.warn("cells 加载失败", adcode, e); });
  }
  function onCellMove(e) {
    if (!e.features || !e.features.length) return;
    var p = e.features[0].properties, t = document.getElementById("tip");
    var label = curLayer === "friendly" ? (p.friendly ? "友好格" : "非友好格")
      : (curLayer === "score" ? "综合分 " + p.comp : factorName(curLayer) + " " + p[curLayer]);
    t.textContent = label; t.style.left = e.point.x + "px"; t.style.top = e.point.y + "px"; t.style.display = "block";
  }
  function onCellLeave() { var t = document.getElementById("tip"); if (t) t.style.display = "none"; }
  function factorName(k) { var m = FACTOR_META.filter(function (x) { return x.key === k; })[0]; return m ? m.name : k; }
  function onCellClick(e) {
    if (!e.features || !e.features.length) return;
    if (markMode) { toggleMark(e.features[0].properties); return; }
    showCellNote(e.features[0].properties, cellsData[curDetailAdcode]);
  }
  function showCellNote(p, ad) {
    if (!ad) ad = cellsData[curDetailAdcode];
    if (!ad) return;
    var means = ad.means, thr = ad.thr;
    var order = FACTOR_META.slice().sort(function (a, b) { return p[b.key] - p[a.key]; });
    var best = order[0], worst = order[order.length - 1];
    var bestM = Math.round(p[best.key]), worstM = Math.round(p[worst.key]);
    var txt = '<div class="cn-t">单格解读</div>'
      + '<div class="cn-row">友好格：<b style="color:' + (p.friendly ? "#4ade80" : "#94a3b8") + '">' + (p.friendly ? "是 ✓" : "否") + '</b> ｜ 综合分 <b>' + p.comp + '</b></div>'
      + '<div class="cn-row">最强：<b style="color:' + best.color + '">' + best.name + ' ' + bestM + '</b> <span class="cn-m">全县均 ' + means[best.key] + '</span></div>'
      + '<div class="cn-row">最弱：<b style="color:' + worst.color + '">' + worst.name + ' ' + worstM + '</b> <span class="cn-m">全县均 ' + means[worst.key] + '</span></div>'
      + '<div class="cn-note">' + (p.friendly
        ? ("该格「可达/连通/舒适/安全」4 项环境因子（不含吸引）达友好阈值 " + thr + "，属连片友好区的一部分。")
        : ("该格环境因子未达友好阈值；短板是 " + worst.name + "（" + worstM + " vs 全县均 " + means[worst.key] + "），步行体验弱于友好格。")) + '</div>';
    var box = document.getElementById("cellnote"); if (box) { box.innerHTML = txt; box.style.display = "block"; }
  }
  function setLayer(key) {
    curLayer = key;
    if (mapLibreOk) applyCellsPaint();
    else if (mode === "detail" && curDetailAdcode) renderCellsSvg(curDetailAdcode);
    document.querySelectorAll("#layerbar .lb").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-k") === key); });
  }
  function onWeightInput() {
    FACTOR_META.forEach(function (m) { var el = document.getElementById("w_" + m.key); if (el) curW[m.key] = parseFloat(el.value) / 100; });
    var ad = cellsData[curDetailAdcode];
    if (ad) {
      ad.features.forEach(function (f) { f.properties.comp = compOf(f.properties); });
      if (mapLibreOk && map.getSource("cells-fill")) map.getSource("cells-fill").setData({ type: "FeatureCollection", features: ad.features });
      else if (mode === "detail") renderCellsSvg(curDetailAdcode);
      applyCellsPaint();
    }
    var wn = document.getElementById("wnote"); if (wn) wn.textContent = "权重已实时应用到「综合分」图层（友好区阈值不随权重变化）。";
  }
  function openMethod() { var m = document.getElementById("methodmodal"); if (m) m.style.display = "flex"; }
  function closeMethod() { var m = document.getElementById("methodmodal"); if (m) m.style.display = "none"; }

  function renderCellsSvg(adcode) {
    loadCounty(adcode).then(function (d) {
      if (mode !== "detail" || curDetailAdcode !== String(adcode)) return;
      if (!d || !d.cells || !d.cells.features || !d.cells.features.length) return;
      var built = buildCellFeatures(d); cellsData[adcode] = built;
      clearSvg();
      var z = DETAIL[adcode];
      built.features.forEach(function (f) {
        var g = f.geometry, ring = g.coordinates && g.coordinates[0]; if (!ring || !ring.length) return;
        var pts = ring.map(function (c) { var q = toXY(c[0], c[1]); return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ");
        var pg = document.createElementNS(NS, "polygon");
        pg.setAttribute("points", pts);
        var isMarked = markMode && marked[cellKey(f.properties)];
        var fill;
        if (isMarked) fill = "rgba(239,68,68,0.8)";
        else if (curLayer === "friendly") fill = f.properties.friendly ? "rgba(34,197,94,0.55)" : "rgba(100,116,139,0.05)";
        else { var key = curLayer === "score" ? "comp" : curLayer; fill = walkColor(f.properties[key]); }
        pg.setAttribute("fill", fill);
        pg.setAttribute("stroke", isMarked ? "rgba(239,68,68,0.95)" : "rgba(15,23,42,0.35)");
        pg.setAttribute("stroke-width", isMarked ? 0.8 : 0.3);
        pg.style.cursor = "pointer";
        pg.addEventListener("click", function () { if (markMode) toggleMark(f.properties); else showCellNote(f.properties, built); });
        svgG.appendChild(pg);
      });
      if (z) {
        var cp = toXY(z.center[0], z.center[1]);
        var cdot = document.createElementNS(NS, "circle");
        cdot.setAttribute("cx", cp[0]); cdot.setAttribute("cy", cp[1]); cdot.setAttribute("r", 6);
        cdot.setAttribute("fill", "rgba(249,115,22,0.95)"); cdot.setAttribute("stroke", "#fff"); cdot.setAttribute("stroke-width", 1.5);
        svgG.appendChild(cdot);
      }
      renderRoadsSvg(adcode);
    }).catch(function () {});
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
      document.getElementById("hint").textContent = "（离线示意图：未引入地图库）· 绿点=有连片友好区，灰点=已接入(暂无连片友好区)，点任意点下钻";
    }
  }
  boot();
})();
