// 县城步行友好 · 宏观图优先 + 下钻架构
// 渲染策略：SVG 离线图（带四省真实轮廓）【永远先渲染，保证不空白】；
//          若腾讯 JS API 鉴权成功（地图 idle 事件触发）则升级为矢量底图，否则留在离线图并提示。
// 数据已内联到 data_bundle.js（window.APP_DATA），不依赖任何网络请求。
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var KEY = (window.APP_CONFIG && window.APP_CONFIG.TENCENT_MAP_KEY) || "";
  var scripts = document.getElementsByTagName("script");
  for (var i = 0; i < scripts.length; i++) {
    if (scripts[i].src && scripts[i].src.indexOf("map.qq.com/api/gljs") >= 0) {
      scripts[i].src = scripts[i].src.replace("__KEY__", KEY);
    }
  }

  // WGS-84 -> GCJ-02（仅腾讯底图需要）
  var a = 6378245.0, ee = 0.00669342162296594323;
  function tlat(lng, lat) {
    var r = Math.PI / 180;
    var ret = -100 + 2*lng + 3*lat + 0.2*lat*lat + 0.1*lng*lat + 0.2*Math.sqrt(Math.abs(lng));
    ret += (20*Math.sin(6*lng*r) + 20*Math.sin(2*lng*r)) * 2/3;
    ret += (20*Math.sin(lat*r) + 40*Math.sin(lat/3*r)) * 2/3;
    ret += (160*Math.sin(lat/12*r) + 320*Math.sin(lat*r/30)) * 2/3;
    return ret;
  }
  function tlng(lng, lat) {
    var r = Math.PI / 180;
    var ret = 300 + lng + 2*lat + 0.1*lng*lng + 0.1*lng*lat + 0.1*Math.sqrt(Math.abs(lng));
    ret += (20*Math.sin(6*lng*r) + 20*Math.sin(2*lng*r)) * 2/3;
    ret += (20*Math.sin(lat*r) + 40*Math.sin(lat/3*r)) * 2/3;
    ret += (160*Math.sin(lat/12*r) + 320*Math.sin(lat*r/30)) * 2/3;
    return ret;
  }
  function wgs2gcj(lat, lng) {
    var dlat = tlat(lng - 105, lat - 35), dlng = tlng(lng - 105, lat - 35);
    var rlat = lat / 180 * Math.PI, magic = 1 - ee*Math.sin(rlat)*Math.sin(rlat), sq = Math.sqrt(magic);
    dlat = (dlat*180) / ((a*(1-ee))/(magic*sq)*Math.PI);
    dlng = (dlng*180) / (a/sq*Math.cos(rlat)*Math.PI);
    return [lat + dlat, lng + dlng];
  }

  var COUNTIES = [], DETAIL = {}, DETAIL_LIST = [], PROVINCES = [];
  var USE_TENCENT = false, mode = "overview", curProv = "全部";
  var pendingUpgrade = false;

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
    var q = z.quality || {}, total = (q.ways||0)+(q.pois||0)+(q.buildings||0);
    var warn = total < 120
      ? '<div class="warn">⚠ 该县 OSM 数据偏稀疏（路'+(q.ways||0)+'/POI'+(q.pois||0)+'/建'+(q.buildings||0)+'），低分可能反映地图未补全。</div>'
      : "";
    document.getElementById("detailcard").innerHTML =
      '<h2>' + z.name + '</h2>' +
      '<div class="meta">' + z.province + ' · ' + (z.parent||"") + '</div>' +
      '<div class="kv">' +
        '<div class="b"><div class="k">最大连片</div><div class="v">' + z.size + '<span style="font-size:10px;color:#94a3b8"> 格</span></div></div>' +
        '<div class="b"><div class="k">连片均分</div><div class="v">' + (z.score_avg||0) + '</div></div>' +
        '<div class="b"><div class="k">县城好走度</div><div class="v">' + (z.score_mean||0) + '</div></div>' +
        '<div class="b"><div class="k">可比均分</div><div class="v">' + (z.comparable_score!=null?z.comparable_score:"—") + '<span style="font-size:10px;color:#94a3b8"> /100</span></div></div>' +
        '<div class="b"><div class="k">同省排名</div><div class="v">' + (z.province_rank?("#"+z.province_rank):"—") + '</div></div>' +
        '<div class="b"><div class="k">全省名</div><div class="v">' + (z.global_rank?("#"+z.global_rank):"—") + '</div></div>' +
      '</div>' + warn;
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
  }

  // ===================== 入口分发 =====================
  function renderOverview() {
    if (USE_TENCENT) renderOverviewTencent(); else renderOverviewSvg();
  }
  function enterDetail(adcode) {
    mode = "detail";
    document.body.classList.add("detail");
    if (USE_TENCENT) enterDetailTencent(adcode); else drawDetailSvg(adcode);
  }
  function backToOverview() {
    mode = "overview";
    document.body.classList.remove("detail");
    if (USE_TENCENT) backToOverviewTencent();
    else { setProj(116.5, 34, 17); renderOverviewSvg(); }
    if (pendingUpgrade) { pendingUpgrade = false; applyTencentUpgrade(); }
  }

  // ===================== 腾讯底图路径 =====================
  var map, circleLayer, polys = [];
  function cellRect(c, w, h) {
    var pts = [[c[0]-w,c[1]-h],[c[0]+w,c[1]-h],[c[0]+w,c[1]+h],[c[0]-w,c[1]+h]];
    return pts.map(function (p) { var g = wgs2gcj(p[1], p[0]); return new TMap.LatLng(g[0], g[1]); });
  }
  function renderOverviewTencent() {
    var geoms = visible().map(function (c) {
      var g = wgs2gcj(c.wgs[1], c.wgs[0]);
      return { id: String(c.adcode), center: new TMap.LatLng(g[0], g[1]), radius: 1500,
               styleId: DETAIL[c.adcode] ? "on" : "off", properties: { name: c.name } };
    });
    if (!circleLayer) {
      circleLayer = new TMap.MultiCircle({
        map: map, geometries: geoms,
        styles: {
          on:  new TMap.CircleStyle({ color: "rgba(22,163,74,0.85)", borderColor: "#bbf7d0", borderWidth: 1, showBorder: true }),
          off: new TMap.CircleStyle({ color: "rgba(148,163,184,0.35)", borderColor: "rgba(148,163,184,0.5)", borderWidth: 1, showBorder: true })
        }
      });
      circleLayer.on("click", function (e) {
        var ad = e.geometry.id;
        if (DETAIL[ad]) enterDetail(ad); else { var c = byAdcode(ad); flash(c ? c.name : ""); }
      });
      circleLayer.on("mouseover", function (e) {
        try {
          var p = map.projectToContainer(e.geometry.center);
          var t = document.getElementById("tip");
          t.textContent = e.geometry.properties.name;
          t.style.left = p.x + "px"; t.style.top = p.y + "px"; t.style.display = "block";
        } catch (err) {}
      });
      circleLayer.on("mouseout", function () { document.getElementById("tip").style.display = "none"; });
    } else {
      circleLayer.setGeometries(geoms);
    }
  }
  function enterDetailTencent(adcode) {
    var z = DETAIL[adcode]; if (!z) return;
    if (circleLayer) circleLayer.setMap(null);
    clearPolys();
    var paths = z.cells.map(function (cell) { return cellRect(cell.c, cell.w, cell.h); });
    var poly = new TMap.MultiPolygon({
      map: map,
      geometries: paths.map(function (path, idx) { return { id: z.id + "_" + idx, styleId: "g", paths: path }; }),
      styles: { g: new TMap.PolygonStyle({ color: "rgba(22,163,74,0.5)", borderColor: "#16a34a", borderWidth: 1 }) }
    });
    polys.push(poly);
    var g = wgs2gcj(z.center[1], z.center[0]);
    var ctr = new TMap.MultiCircle({
      map: map,
      geometries: [{ id: "ctr", center: new TMap.LatLng(g[0], g[1]), radius: 400, styleId: "ctr" }],
      styles: { ctr: new TMap.CircleStyle({ color: "rgba(249,115,22,0.9)", borderColor: "#fff", borderWidth: 1, showBorder: true }) }
    });
    polys.push(ctr);
    map.panTo(new TMap.LatLng(g[0], g[1]));
    map.setZoom(14);
    showCard(z);
  }
  function clearPolys() { polys.forEach(function (p) { try { map.remove(p); } catch (e) {} }); polys = []; }
  function backToOverviewTencent() {
    clearPolys();
    if (circleLayer) circleLayer.setMap(map);
    map.setZoom(7); map.panTo(new TMap.LatLng(34, 116.5));
  }

  // ===================== 内联 SVG 离线路径（带四省轮廓） =====================
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
    // 经纬网（每 2°）
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
      var p = toXY(c.wgs[0], c.wgs[1]); // wgs=[lng,lat]
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
  }

  // ===================== 腾讯升级（非阻塞，失败留离线图） =====================
  function applyTencentUpgrade() {
    USE_TENCENT = true;
    if (svg) svg.style.display = "none";
    document.body.classList.remove("detail"); mode = "overview";
    renderOverviewTencent();
    document.getElementById("hint").textContent = "腾讯底图已加载 · 绿点=已有数据，点绿点下钻 · 灰点=收集中";
  }
  function tryUpgradeTencent() {
    var upgraded = false;
    try {
      map = new TMap.Map(document.getElementById("map"), {
        center: new TMap.LatLng(34, 116.5), zoom: 7,
        baseMap: { type: "vector", features: ["base", "building3d"] }
      });
    } catch (e) {
      console.warn("Tencent map init threw, stay SVG:", e);
      document.getElementById("hint").textContent = "（腾讯底图鉴权失败，已用离线示意图）· 绿点=已有数据，点绿点下钻 · 灰点=收集中";
      return;
    }
    function done() {
      if (upgraded || USE_TENCENT) return;
      upgraded = true;
      if (mode === "overview") applyTencentUpgrade();
      else pendingUpgrade = true; // 用户已在详情，返回时再升级
    }
    if (map.on) { try { map.on("idle", done); map.on("tilesloaded", done); } catch (e) {} }
    // 4s 内未就绪（多半鉴权失败）→ 留在离线图并说明
    setTimeout(function () {
      if (!upgraded && !USE_TENCENT) {
        document.getElementById("hint").textContent = "（腾讯底图鉴权失败，已用离线示意图）· 绿点=已有数据，点绿点下钻 · 灰点=收集中";
      }
    }, 4000);
  }

  // ===================== 启动 =====================
  var DATA = window.APP_DATA || { counties: [], zones: [], provinces: [] };
  COUNTIES = DATA.counties || [];
  DETAIL_LIST = DATA.zones || [];
  PROVINCES = DATA.provinces || [];
  DETAIL_LIST.forEach(function (z) { DETAIL[z.id] = z; });

  function boot() {
    if (COUNTIES.length === 0) {
      document.getElementById("hint").textContent = "数据为空：请重新生成 data_bundle.js";
      return;
    }
    // 1) 离线图立刻可见（绝不空白）
    ensureSvg(); setProj(116.5, 34, 17); renderOverviewSvg();
    buildChips(); buildDir(); bindUi();
    document.getElementById("hint").textContent = "绿点=已有数据，点绿点下钻 · 灰点=收集中";
    // 2) 可选：腾讯底图升级（需 key 鉴权通过）。默认关闭——鉴权失败反而会切到空白地图破坏显示。
    //    把 config.local.js 里 USE_TENCENT_BASEMAP 设为 true 且 key 在该域名鉴权通过时，才会启用真实底图。
    var useTb = window.APP_CONFIG && window.APP_CONFIG.USE_TENCENT_BASEMAP;
    if (useTb && typeof TMap !== "undefined") tryUpgradeTencent();
    else document.getElementById("hint").textContent = "（离线示意图）· 绿点=已有数据，点绿点下钻 · 灰点=收集中";
  }
  boot();
})();
