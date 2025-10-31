(function(){
  // ====== CONFIG ======
  var FILE_URL = '/assets/backend/collision_dataset.json'; // NDJSON lines: {"h3":"...","datetime":"..."}
  var START_CENTER = [51.5074, -0.1278];
  var START_ZOOM   = 9;

  var MIN_DRAW_ZOOM      = 9;
  var FILL_OPACITY       = 0.30;
  var DRAW_CHUNK_SIZE    = 1200;
  var VIEW_PAD           = 0.10;
  var SAFETY_MAX_RENDER  = 80000;
  var MAX_CELLS          = 5000;

  var MIN_H3_RES = 6;
  var MAX_BOUNDS = L.latLngBounds([50.8, -2], [52.2, 2]);

  // Year slider semantics: when the slider shows Y, include [01/01/(Y-1), 01/01/Y)
  var YEAR_WINDOW_IS_PREV = true;

  // Persistent hotspots
  var DEFAULT_HS_ENABLED = false;
  var DEFAULT_HS_PCT     = 0.05;
  var HS_MIN_GLOBAL      = 25;

  // Colors
  var GRAD_KNOTS = { mid: 0.30, high: 1.0 };
  var GRAD_COLORS = {
    low:  { r:0x2a, g:0x8f, b:0x5a },
    mid:  { r:0xff, g:0xd4, b:0x00 },
    high: { r:0xff, g:0x00, b:0x33 }
  };

  // ====== DOM ======
  var badgeEl    = document.getElementById('badge');
  var hintEl     = document.querySelector('.hint');

  var yearRange  = document.getElementById('year');
  var yearVal    = document.getElementById('yearVal');
  var allYearsCk = document.getElementById('allYears');

  var useRange   = document.getElementById('useRange');
  var dateStartEl= document.getElementById('dateStart');
  var dateEndEl  = document.getElementById('dateEnd');
  var dateControls = document.getElementById('dateControls');

  var hsToggle   = document.getElementById('hsToggle');
  var hsPctSel   = document.getElementById('hsPct');

  var lminEl = document.getElementById('lmin');
  var lmidEl = document.getElementById('lmid');
  var lmaxEl = document.getElementById('lmax');

  var panel = document.getElementById('panel');

  // ====== MAP ======
  var map = L.map('map', {
    preferCanvas: true,
    worldCopyJump: true,
    minZoom: START_ZOOM,
    maxBounds: MAX_BOUNDS,
    maxBoundsViscosity: 1.0
  }).setView(START_CENTER, START_ZOOM);
  map.setMaxBounds(MAX_BOUNDS);

  L.tileLayer(
    'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=STADIA_KEY',
    {
      attribution: '&copy; OpenStreetMap &copy; Stadia Maps',
      maxZoom: 20,
      minZoom: START_ZOOM,
      noWrap: true,
      bounds: MAX_BOUNDS,
      className: 'tiles-boost'
    }
  ).addTo(map);

  if (L.control.fullscreen) {
    L.control.fullscreen({ position: 'topleft', title: 'Toggle fullscreen' }).addTo(map);
    map.on('enterFullscreen', function(){ setTimeout(function(){ map.invalidateSize(); }, 200); });
    map.on('exitFullscreen',  function(){ setTimeout(function(){ map.invalidateSize(); }, 200); });
  }

  var layerRoot = L.layerGroup().addTo(map);
  var canvasRenderer = L.canvas({ padding: 0.5 });
  var tip = L.tooltip({ sticky: true });

  // ====== HELPERS ======
  function setBadge(html){ if (badgeEl) badgeEl.innerHTML = html; }
  function clamp01(v){ return Math.max(0, Math.min(1, v)); }
  function mix(a,b,t){ return { r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) }; }
  function colorFor01(p){
    var x = clamp01(p);
    var k1 = GRAD_KNOTS.mid, k2 = GRAD_KNOTS.high;
    if (x <= k1){
      var t1 = (k1 <= 0) ? 1 : (x / k1);
      var c1 = mix(GRAD_COLORS.low, GRAD_COLORS.mid, t1);
      return 'rgb(' + c1.r + ',' + c1.g + ',' + c1.b + ')';
    } else if (x <= k2){
      var t2 = (k2 - k1 <= 0) ? 1 : ((x - k1) / (k2 - k1));
      var c2 = mix(GRAD_COLORS.mid, GRAD_COLORS.high, t2);
      return 'rgb(' + c2.r + ',' + c2.g + ',' + c2.b + ')';
    } else {
      var c3 = GRAD_COLORS.high;
      return 'rgb(' + c3.r + ',' + c3.g + ',' + c3.b + ')';
    }
  }
  function grayFor01(p){
    var x = clamp01(p);
    var v = Math.round(60 + x * (230 - 60));
    return 'rgb(' + v + ',' + v + ',' + v + ')';
  }
  function paddedBounds(b){
    var dLat = (b.getNorth() - b.getSouth()) * VIEW_PAD;
    var dLng = (b.getEast() - b.getWest()) * VIEW_PAD;
    return L.latLngBounds([b.getSouth()-dLat, b.getWest()-dLng], [b.getNorth()+dLat, b.getEast()+dLng]);
  }
  function debounce(fn, ms){
    var t;
    return function(){
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function(){ fn.apply(null, args); }, ms);
    };
  }
  var schedule = debounce(draw, 90);
  function fmtDate(ms){
    var d = new Date(ms); if (!isFinite(d)) return '—';
    var y = d.getUTCFullYear();
    var m = String(d.getUTCMonth()+1); if (m.length < 2) m = '0' + m;
    var dd = String(d.getUTCDate());   if (dd.length < 2) dd = '0' + dd;
    return y + '-' + m + '-' + dd;
  }
  function num(n){
    if (!isFinite(n)) return '—';
    var r = Math.round(n);
    if (Math.abs(n - r) < 0.05) return r.toLocaleString();
    return n.toFixed(1);
  }

  // ====== DATE MODULE (minimal, modular, with Year dropdown) ======
  var DateModule = (function(){
    var startEl, endEl, onChangeCb = function(){};
    var fpStart = null, fpEnd = null;
    var minYear = null, maxYear = null;

    function init(opts){
      startEl = opts.startEl; endEl = opts.endEl;
      minYear = opts.minYear; maxYear = opts.maxYear;
      onChangeCb = opts.onChange || function(){};

      var hasFP = !!window.flatpickr;
      if (hasFP){
        var base = {
          dateFormat: 'Y-m-d',
          allowInput: true,
          disableMobile: true,
          clickOpens: true,
          monthSelectorType: 'dropdown', // month dropdown
          onReady: function(sel, str, inst){ enhanceYearDropdown(inst); },
          onOpen:  function(sel, str, inst){ syncYearDropdown(inst); },
          onValueUpdate: function(sel, str, inst){ syncYearDropdown(inst); },
          onChange: function(){ onChangeCb(); }
        };
        try { fpStart = window.flatpickr(startEl, base); } catch(e){}
        try { fpEnd   = window.flatpickr(endEl,   base); } catch(e){}
      } else {
        // Native <input type=date> fallback
        try { startEl.setAttribute('type','date'); endEl.setAttribute('type','date'); } catch(e){}
        startEl.addEventListener('change', onChangeCb);
        endEl.addEventListener('change', onChangeCb);
      }
    }

    function enhanceYearDropdown(inst){
      if (!inst || !inst.calendarContainer) return;
      var container = inst.calendarContainer;
      // If already added, skip
      if (inst._yearSelect && container.contains(inst._yearSelect)) return;

      // Hide the default numeric year input (we keep it for API sync)
      if (inst.currentYearElement) inst.currentYearElement.style.display = 'none';

      // Build select
      var sel = document.createElement('select');
      sel.className = 'fp-year-select';
      var from = isFinite(minYear) ? minYear : (new Date().getUTCFullYear() - 50);
      var to   = isFinite(maxYear) ? maxYear : (new Date().getUTCFullYear() + 10);
      for (var y = from; y <= to; y++){
        var opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = String(y);
        sel.appendChild(opt);
      }
      sel.addEventListener('change', function(){
        var yv = parseInt(sel.value, 10);
        if (!isFinite(yv)) return;
        try { inst.changeYear(yv); } catch(e){}
      });

      // Insert near month controls
      var monthsWrap = container.querySelector('.flatpickr-months');
      if (monthsWrap){
        // Place at the end of the months header row
        monthsWrap.appendChild(sel);
        inst._yearSelect = sel;
        syncYearDropdown(inst);
      }
    }

    function syncYearDropdown(inst){
      if (!inst || !inst._yearSelect) return;
      var cur = inst.currentYear; // numeric
      var s = inst._yearSelect;
      if (String(s.value) !== String(cur)){
        // If current year is out of range, expand options
        var yNum = parseInt(cur, 10);
        if (isFinite(yNum)){
          var yMin = parseInt(s.options[0] && s.options[0].value, 10);
          var yMax = parseInt(s.options[s.options.length-1] && s.options[s.options.length-1].value, 10);
          if (!isFinite(yMin) || yNum < yMin){ addYearOptions(s, yNum, yMin, 'prepend'); }
          if (!isFinite(yMax) || yNum > yMax){ addYearOptions(s, yMax, yNum, 'append'); }
        }
        s.value = String(cur);
      }
    }

    function addYearOptions(selectEl, fromY, toY, mode){
      if (!isFinite(fromY) || !isFinite(toY)) return;
      if (fromY === null || toY === null) return;
      var step = (toY >= fromY) ? 1 : -1;
      for (var y = fromY + step; (step > 0 ? y <= toY : y >= toY); y += step){
        var opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = String(y);
        if (mode === 'prepend') selectEl.insertBefore(opt, selectEl.firstChild);
        else selectEl.appendChild(opt);
      }
    }

    function parse(v, isEnd){
      if (!v) return NaN;
      var s = String(v).trim();
      var d = new Date(s.length <= 10 ? (s + 'T00:00:00Z') : s);
      var t = d.getTime();
      if (isEnd && s.length <= 10) t += 24*60*60*1000; // end-exclusive for date-only
      return t;
    }

    function readRange(fallbackStart, fallbackEnd){
      var s = parse(startEl && startEl.value, false);
      var e = parse(endEl && endEl.value, true);
      if (!isFinite(s)) s = fallbackStart;
      if (!isFinite(e)) e = fallbackEnd;
      if (e < s){ var tmp=s; s=e; e=tmp; }
      return [s, e];
    }

    function setRange(startMs, endMs){
      function iso(t){ return new Date(t).toISOString().slice(0,10); }
      if (startEl) startEl.value = iso(startMs);
      if (endEl)   endEl.value   = iso(endMs - 1); // inclusive UX
      if (fpStart && fpStart.setDate) { try { fpStart.setDate(new Date(startMs), true); } catch(e){} }
      if (fpEnd   && fpEnd.setDate)   { try { fpEnd.setDate(new Date(endMs - 1), true); } catch(e){} }
      // Ensure dropdowns reflect new year
      if (fpStart) syncYearDropdown(fpStart);
      if (fpEnd)   syncYearDropdown(fpEnd);
    }

    return { init: init, readRange: readRange, setRange: setRange };
  })();

  // ====== CACHES ======
  var MAX_RES = null;
  var shapePool = new Map();
  var centerCache = new Map();
  var boundaryCache = new Map();
  var parentCacheByRes = new Map();
  var globalAggCache = new Map();   // key: start|end|res
  var hotspotCache   = new Map();   // key: start|end|res|pct|min

  function centerOf(id){
    var c = centerCache.get(id); if (c) return c;
    try {
      var pair = h3.cellToLatLng(id);
      c = [pair[0], pair[1]];
      centerCache.set(id, c);
      return c;
    } catch (e) { return null; }
  }
  function boundaryOf(id){
    var b = boundaryCache.get(id); if (b) return b;
    try {
      var raw = h3.cellToBoundary(id);
      b = raw.map(function(p){ return [p[0], p[1]]; });
      boundaryCache.set(id, b);
      return b;
    } catch (e) { return null; }
  }
  function childToParent(id, res){
    var cache = parentCacheByRes.get(res);
    if (!cache){ cache = new Map(); parentCacheByRes.set(res, cache); }
    var p = cache.get(id);
    if (p) return p;
    try { p = h3.cellToParent(id, res); } catch (e) { p = null; }
    if (p) cache.set(id, p);
    return p;
  }
  function targetResForZoom(zoom) {
    if (MAX_RES == null) return Math.min(MIN_H3_RES, 15);
    var steps = Math.max(0, Math.floor((18.1 - zoom) / 1.2));
    var rawRes = Math.max(0, MAX_RES - steps);
    var floor = Math.min(MIN_H3_RES, MAX_RES);
    return Math.min(MAX_RES, Math.max(floor, rawRes));
  }

  // ====== DATA ======
  // BASE_ALL rows: [h3_at_MAX_RES, ts_ms, count]
  var BASE_ALL = [];
  var ALL_MIN_TS = Infinity;
  var ALL_MAX_TS = -Infinity;
  var LAST_UPDATED = null;

  function renderHint(){
    if (!hintEl) return;
    if (!LAST_UPDATED){ hintEl.textContent = 'Last updated: —'; return; }
    var s = String(LAST_UPDATED);
    var m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
    hintEl.textContent = 'Last updated: ' + (m ? (m[1] + ' ' + m[2] + ':' + m[3]) : s);
    var ageMs = Date.now() - (new Date(LAST_UPDATED)).getTime();
    hintEl.classList.remove('fresh','stale','very-stale');
    if (isFinite(ageMs)){
      if (ageMs < 30*24*60*60*1000) hintEl.classList.add('fresh');
      else if (ageMs < 365*24*60*60*1000) hintEl.classList.add('stale');
      else hintEl.classList.add('very-stale');
    }
  }

  function loadCells(url){
    return fetch(url, { cache: 'no-store' }).then(function(res){
      if (!res.ok) throw new Error('HTTP ' + res.status + ' while loading ' + url);
      return res.arrayBuffer().then(function(ab){
        var txt;
        try {
          var ungz = pako.ungzip(new Uint8Array(ab));
          txt = new TextDecoder().decode(ungz);
        } catch (e) {
          try { txt = new TextDecoder().decode(new Uint8Array(ab)); }
          catch (e2) { return res.text().then(function(t){ return parseText(t); }); }
        }
        return parseText(txt);
      }).catch(function(){
        return res.text().then(function(t){ return parseText(t); });
      });
    });

    function parseText(txt){
      if (txt && txt.charCodeAt && txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1); // strip BOM

      var json;
      try { json = JSON.parse(txt); }
      catch (e){
        // NDJSON fallback
        var lines = txt.split(/\r?\n/).map(function(s){ return s.trim(); }).filter(function(s){ return !!s; });
        json = lines.map(function(line){ return JSON.parse(line); });
      }

      var raw = (Array.isArray(json) ? json
            : (json && Array.isArray(json.data)) ? json.data
            : (json && Array.isArray(json.records)) ? json.records
            : (json && Array.isArray(json.rows)) ? json.rows
            : null);
      if (!raw) throw new Error('Expected array or {data|records|rows:[...]}.');

      var rows = [];
      for (var i=0;i<raw.length;i++){
        var r = raw[i] || {};
        var h = String(r.h3 || r.h || r.cell || r.id || '');
        var dt = r.datetime || r.time || r.t || r.ts || null;
        var c = isFinite(+r.count) ? (+r.count) : 1;
        var ts = dt ? Date.parse(dt) : NaN;
        if (h && isFinite(ts)) rows.push([h, ts, c]);
      }
      if (!rows.length) throw new Error('No valid rows with {h3, datetime} found.');

      // Detect MAX_RES
      var mres = -1;
      for (var j=0;j<rows.length;j++){
        var hId = rows[j][0];
        try { mres = Math.max(mres, h3.getResolution(hId)); } catch (e) {}
      }
      MAX_RES = (mres < 0) ? 0 : mres;

      // Normalize to MAX_RES
      for (var k=0;k<rows.length;k++){
        var hcell = rows[k][0], ts = rows[k][1], cnt = rows[k][2];
        var rres = -1;
        try { rres = h3.getResolution(hcell); } catch (e) {}
        if (rres === MAX_RES){
          BASE_ALL.push([hcell, ts, cnt]);
        } else if (rres >= 0 && rres < MAX_RES){
          var kids = [];
          try { kids = h3.cellToChildren(hcell, MAX_RES); } catch (e2) { kids = []; }
          if (kids.length){
            var share = cnt / kids.length;
            for (var q=0;q<kids.length;q++) BASE_ALL.push([kids[q], ts, share]);
          }
        }
        if (isFinite(ts)) {
          if (ts < ALL_MIN_TS) ALL_MIN_TS = ts;
          if (ts > ALL_MAX_TS) ALL_MAX_TS = ts;
        }
      }

      // Optional meta timestamp inside JSON (ignored for NDJSON)
      try {
        var maybe = JSON.parse(txt);
        LAST_UPDATED = (maybe && maybe.meta && maybe.meta.updated_at) || (maybe && maybe.updated_at) || null;
      } catch (e3) {}

      if (!LAST_UPDATED && isFinite(ALL_MAX_TS)) LAST_UPDATED = new Date(ALL_MAX_TS).toISOString();

      return true;
    }
  }

  // ====== AGG ======
  function aggregateRangeAtRes(startMs, endMs, res){
    var key = String(startMs) + '|' + String(endMs) + '|' + String(res);
    var cached = globalAggCache.get(key);
    if (cached) return cached;

    var byId = new Map();
    for (var i=0;i<BASE_ALL.length;i++){
      var row = BASE_ALL[i];
      var idAtMax = row[0], ts = row[1], c = row[2];
      if (ts < startMs || ts >= endMs) continue; // end exclusive
      var parentId = (res >= MAX_RES) ? idAtMax : childToParent(idAtMax, res);
      if (!parentId) continue;
      byId.set(parentId, (byId.get(parentId)||0) + c);
    }
    var entries = Array.from(byId, function(x){ return x; }).map(function(pair){ return [pair[0], pair[1], { cnt: pair[1] }]; });
    entries.sort(function(a,b){ return b[1] - a[1]; });

    var rec = { byId: byId, entries: entries };
    globalAggCache.set(key, rec);
    return rec;
  }

  function getHotspots(startMs, endMs, res, pct){
    var key = String(startMs) + '|' + String(endMs) + '|' + String(res) + '|' + pct.toFixed(4) + '|min' + String(HS_MIN_GLOBAL);
    var cached = hotspotCache.get(key);
    if (cached) return cached;

    var agg = aggregateRangeAtRes(startMs, endMs, res);
    var N = agg.entries.length;
    var topN = Math.max(1, Math.max(HS_MIN_GLOBAL, Math.ceil(N * pct)));
    var set = new Set();
    for (var i=0;i<Math.min(N, topN); i++) set.add(agg.entries[i][0]);
    hotspotCache.set(key, set);
    return set;
  }

  function updateLegendNumbers(minCnt, midCnt, maxCnt){
    if (lminEl) lminEl.textContent = num(minCnt);
    if (lmidEl) lmidEl.textContent = num(midCnt);
    if (lmaxEl) lmaxEl.textContent = num(maxCnt);
  }

  // ====== MODE & RANGE ======
  function getActiveMode(){
    if (allYearsCk && allYearsCk.checked) return 'ALL';
    if (useRange && useRange.checked) return 'RANGE';
    return 'YEAR';
  }

  function yearWindowFor(y){
    if (YEAR_WINDOW_IS_PREV){
      var start = Date.UTC(y-1, 0, 1, 0, 0, 0, 0);
      var end   = Date.UTC(y,   0, 1, 0, 0, 0, 0);
      return [start, end];
    } else {
      var s = Date.UTC(y,   0, 1, 0, 0, 0, 0);
      var e = Date.UTC(y+1, 0, 1, 0, 0, 0, 0);
      return [s, e];
    }
  }

  function readSelectedRange(){
    var mode = getActiveMode();
    if (mode === 'ALL') return [ALL_MIN_TS, ALL_MAX_TS + 1];
    if (mode === 'YEAR'){
      var y = +yearRange.value || new Date(ALL_MAX_TS).getUTCFullYear();
      return yearWindowFor(y);
    }
    // RANGE mode
    var r = DateModule.readRange(ALL_MIN_TS, ALL_MAX_TS + 1);
    var s = r[0], e = r[1];
    if (s < ALL_MIN_TS) s = ALL_MIN_TS;
    if (e > ALL_MAX_TS + 1) e = ALL_MAX_TS + 1;
    return [s, e];
  }

  function applyModeUI(){
    var mode = getActiveMode();
    var disableYear = (mode !== 'YEAR');
    var disableRange = (mode !== 'RANGE');

    if (yearRange) yearRange.disabled = disableYear;
    if (yearVal) { if (disableYear) yearVal.classList.add('muted'); else yearVal.classList.remove('muted'); }

    if (dateStartEl) dateStartEl.disabled = disableRange;
    if (dateEndEl)   dateEndEl.disabled   = disableRange;
    if (dateControls) { if (disableRange) dateControls.classList.add('muted'); else dateControls.classList.remove('muted'); }
  }

  function syncYearSliderFromData(){
    var minYear = new Date(ALL_MIN_TS).getUTCFullYear();
    var maxYear = new Date(ALL_MAX_TS).getUTCFullYear();
    var sliderMin, sliderMax;
    if (YEAR_WINDOW_IS_PREV){
      sliderMin = minYear + 1; // need Y-1 to exist
      sliderMax = maxYear;
    } else {
      sliderMin = minYear;
      sliderMax = maxYear;
    }
    if (yearRange){
      yearRange.min = String(sliderMin);
      yearRange.max = String(sliderMax);
      if (!yearRange.value) yearRange.value = String(sliderMax);
      if (yearVal) yearVal.textContent = yearRange.value;
    }

    // Boot the date module with dataset year span
    DateModule.init({
      startEl: dateStartEl,
      endEl:   dateEndEl,
      minYear: minYear,
      maxYear: maxYear,
      onChange: function(){ globalAggCache.clear(); hotspotCache.clear(); schedule(); }
    });
  }

  function syncDateInputsToYear(){
    if (!yearRange || !dateStartEl || !dateEndEl) return;
    var y = +yearRange.value;
    var win = yearWindowFor(y);
    var s = win[0], e = win[1];
    DateModule.setRange(s, e);
  }

  // ====== DRAW ======
  map.on('moveend', schedule);
  map.on('zoomend', schedule);

  function draw(){
    if (!BASE_ALL.length) return;

    applyModeUI();

    var zoom = map.getZoom();
    var inHotMode = hsToggle ? !!hsToggle.checked : DEFAULT_HS_ENABLED;
    var pct = hsPctSel ? parseFloat(hsPctSel.value || String(DEFAULT_HS_PCT)) : DEFAULT_HS_PCT;

    var mode = getActiveMode();
    var range = readSelectedRange();
    var startMs = range[0], endMs = range[1];

    if (zoom < MIN_DRAW_ZOOM){
      shapePool.forEach(function(l){ l.remove(); });
      shapePool.clear();
      var header;
      if (mode === 'ALL') header = 'All years';
      else if (mode === 'YEAR') header = 'Year: <b>' + yearRange.value + '</b>';
      else header = 'Range: <b>' + fmtDate(startMs) + ' → ' + fmtDate(endMs-1) + '</b>';
      setBadge(header + ' &nbsp; Shown: <b>0</b>' + (inHotMode ? ' &nbsp; Hotspots: <b>—</b>' : ''));
      return;
    }

    var pad = paddedBounds(map.getBounds());
    var renderRes = targetResForZoom(zoom);
    var agg = aggregateRangeAtRes(startMs, endMs, renderRes);
    var entries = agg.entries;

    var countsDesc = entries.map(function(e){ return e[1]; });
    var maxCnt = countsDesc.length ? countsDesc[0] : 1;
    var minAll = countsDesc.length ? countsDesc[countsDesc.length - 1] : 0;
    var minPos = Infinity;
    for (var i=countsDesc.length-1; i>=0; i--){
      var v = countsDesc[i];
      if (v > 0 && v < minPos) minPos = v;
    }
    var minCnt = (minPos !== Infinity) ? minPos : minAll;
    var midIdx = Math.floor(countsDesc.length / 2);
    var midCnt = countsDesc.length ? countsDesc[midIdx] : 0;
    updateLegendNumbers(minCnt, midCnt, maxCnt);

    var to01 = (maxCnt > minCnt) ? function(c){ return (c - minCnt) / (maxCnt - minCnt); } : function(){ return 0.5; };

    var hotSet = null;
    if (inHotMode) hotSet = getHotspots(startMs, endMs, renderRes, isFinite(pct) ? pct : DEFAULT_HS_PCT);

    // Filter in view
    var inView = [];
    for (var j=0;j<entries.length;j++){
      var id = entries[j][0];
      var cnt = entries[j][1];
      var c = centerOf(id); if (!c) continue;
      var lat = c[0], lng = c[1];
      if (lat < pad.getSouth() || lat > pad.getNorth() || lng < pad.getWest() || lng > pad.getEast()) continue;
      inView.push([id, cnt]);
    }

    var cap = Math.min(MAX_CELLS, SAFETY_MAX_RENDER);
    var selected;
    if (inHotMode && hotSet){
      var hot=[], rest=[];
      for (var h=0; h<inView.length; h++){
        var d = inView[h];
        (hotSet.has(d[0]) ? hot : rest).push(d);
      }
      selected = hot.concat(rest).slice(0, cap);
    } else {
      selected = inView.slice(0, cap);
    }

    // Remove stale
    var keep = new Set(selected.map(function(d){ return d[0]; }));
    shapePool.forEach(function(layer, key){
      if (!keep.has(key)) { layer.remove(); shapePool.delete(key); }
    });

    if (!selected.length){
      var hotTxt0 = (inHotMode && hotSet) ? ' &nbsp; Hotspots: <b>' + hotSet.size + '</b>' : '';
      if (mode === 'ALL'){
        setBadge('All years &nbsp; Shown: <b>0</b>' + hotTxt0);
      } else if (mode === 'YEAR'){
        setBadge('Year: <b>' + yearRange.value + '</b> &nbsp; Shown: <b>0</b>' + hotTxt0);
      } else {
        setBadge('Range: <b>' + fmtDate(startMs) + ' → ' + fmtDate(endMs-1) + '</b> &nbsp; Shown: <b>0</b>' + hotTxt0);
      }
      return;
    }

    // Draw (chunked)
    var idx = 0;
    function step(){
      var lim = Math.min(idx + DRAW_CHUNK_SIZE, selected.length);
      for (; idx < lim; idx++){
        var id2 = selected[idx][0];
        var cnt2 = selected[idx][1];
        var p01 = clamp01(to01(cnt2));
        var fill = (!inHotMode || (hotSet && hotSet.has(id2))) ? colorFor01(p01) : grayFor01(p01);

        var layer = shapePool.get(id2);
        if (!layer){
          var poly = boundaryOf(id2); if (!poly) continue;
          layer = L.polygon(poly, {
            renderer: canvasRenderer,
            fill: true, fillOpacity: FILL_OPACITY,
            stroke: true, color: fill, opacity: 0.5, weight: 0.3, fillColor: fill
          });
          layer.__cnt = cnt2;
          layer.on('mouseover', function(ev){
            var lay = ev.target;
            var pos = lay.getBounds().getCenter();
            tip.setContent('Collisions: <b>' + num(lay.__cnt) + '</b>');
            tip.setLatLng(pos);
            map.openTooltip(tip);
          });
          layer.on('mouseout', function(){ map.closeTooltip(tip); });

          layer.addTo(layerRoot);
          shapePool.set(id2, layer);
        } else {
          layer.setStyle({ fillColor: fill, color: fill });
          layer.__cnt = cnt2;
          if (!layer._map) layer.addTo(layerRoot);
        }
      }
      if (idx < selected.length) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);

    var hotTxt = (inHotMode && hotSet) ? ' &nbsp; Hotspots: <b>' + hotSet.size + '</b>' : '';
    if (mode === 'ALL'){
      setBadge('All years &nbsp; Shown: <b>' + selected.length + '</b>' + hotTxt);
    } else if (mode === 'YEAR'){
      setBadge('Year: <b>' + yearRange.value + '</b> &nbsp; Shown: <b>' + selected.length + '</b>' + hotTxt);
    } else {
      setBadge('Range: <b>' + fmtDate(startMs) + ' → ' + fmtDate(endMs-1) + '</b> &nbsp; Shown: <b>' + selected.length + '</b>' + hotTxt);
    }
  }

  // ====== EVENTS/UI ======
  function makeHamburger(){
    var btn = document.getElementById('menuBtn');
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = 'menuBtn';
    btn.setAttribute('aria-label', 'Menu');
    btn.setAttribute('aria-expanded', 'true');
    btn.innerHTML = '<span></span><span></span><span></span>';
    document.body.appendChild(btn);
    return btn;
  }

  var isMobileMode = false;
  var panelOpen = true; // in mobile, start opened
  var menuBtn = null;

  function setPanelOpen(open){
    panelOpen = !!open;
    if (!panel) return;
    panel.classList.toggle('mobile-hidden', !panelOpen);
    if (menuBtn) menuBtn.setAttribute('aria-expanded', String(panelOpen));
  }

  function isMobilePreferred(){
    var prefers = false;
    if (window.matchMedia){
      var mq = window.matchMedia('(hover: none), (pointer: coarse)');
      prefers = mq && mq.matches;
    }
    return prefers || (window.innerWidth <= 900);
  }

  function handleGlobalPointer(e){
    if (!isMobileMode || !panelOpen) return;
    var t = e.target;
    if (panel && panel.contains(t)) return;
    if (menuBtn && menuBtn.contains(t)) return;
    setPanelOpen(false);
  }

  function enterMobileMode(){
    if (isMobileMode) return;
    isMobileMode = true;
    document.body.classList.add('mobile-ui');

    menuBtn = makeHamburger();
    setPanelOpen(true);

    menuBtn.addEventListener('click', function(ev){
      ev.stopPropagation();
      setPanelOpen(!panelOpen);
    });

    // Capture-level listeners to beat Leaflet handlers
    window.addEventListener('pointerdown', handleGlobalPointer, true);
    window.addEventListener('click', handleGlobalPointer, true);
    window.addEventListener('touchstart', handleGlobalPointer, { capture: true, passive: true });

    if (map && map.getContainer){
      var mc = map.getContainer();
      mc.addEventListener('pointerdown', handleGlobalPointer, true);
      mc.addEventListener('click', handleGlobalPointer, true);
      mc.addEventListener('touchstart', handleGlobalPointer, { capture: true, passive: true });
    }
  }

  function exitMobileMode(){
    if (!isMobileMode) return;
    isMobileMode = false;
    document.body.classList.remove('mobile-ui');
    setPanelOpen(true); // desktop: panel always visible

    window.removeEventListener('pointerdown', handleGlobalPointer, true);
    window.removeEventListener('click', handleGlobalPointer, true);
    window.removeEventListener('touchstart', handleGlobalPointer, { capture: true });

    if (map && map.getContainer){
      var mc = map.getContainer();
      mc.removeEventListener('pointerdown', handleGlobalPointer, true);
      mc.removeEventListener('click', handleGlobalPointer, true);
      mc.removeEventListener('touchstart', handleGlobalPointer, { capture: true });
    }

    if (menuBtn) menuBtn.style.display = 'none';
  }

  function applyUiMode(){
    if (isMobilePreferred()) enterMobileMode(); else exitMobileMode();
    setTimeout(function(){ map.invalidateSize(); }, 100);
  }

  if (hsToggle) hsToggle.addEventListener('change', function(){ hotspotCache.clear(); schedule(); });
  if (hsPctSel) hsPctSel.addEventListener('change', function(){ hotspotCache.clear(); schedule(); });

  if (allYearsCk) allYearsCk.addEventListener('change', function(){
    globalAggCache.clear(); hotspotCache.clear();
    applyModeUI(); schedule();
  });

  if (yearRange){
    yearRange.addEventListener('input', function(){
      if (yearVal) yearVal.textContent = yearRange.value;
      syncDateInputsToYear();
      globalAggCache.clear(); hotspotCache.clear(); schedule();
    });
  }

  if (useRange){
    useRange.addEventListener('change', function(){
      globalAggCache.clear(); hotspotCache.clear();
      applyModeUI(); schedule();
    });
  }

  if (dateStartEl) dateStartEl.addEventListener('change', function(){ globalAggCache.clear(); hotspotCache.clear(); schedule(); });
  if (dateEndEl)   dateEndEl.addEventListener('change',   function(){ globalAggCache.clear(); hotspotCache.clear(); schedule(); });

  // ====== BOOT ======
  (function boot(){
    loadCells(FILE_URL).then(function(){
      syncYearSliderFromData();
      syncDateInputsToYear();

      // Mobile/desktop UI switching
      applyUiMode();
      window.addEventListener('resize', applyUiMode);
      if (window.matchMedia){
        var mq = window.matchMedia('(hover: none), (pointer: coarse)');
        if (mq && mq.addEventListener) mq.addEventListener('change', applyUiMode);
        else if (mq && mq.addListener) mq.addListener(applyUiMode); // Safari fallback
      }

      renderHint();
      applyModeUI();
      draw();
    }).catch(function(err){
      console.error('[collision_time_map] load failed:', err);
      setBadge('Shown: <b>0</b>');
      if (hintEl) hintEl.textContent = 'Last updated: —';
    });
  })();

  // Expose for debug
  window.__collisionMap = { redraw: draw };

  // Const used in helpers
  var VIEW_PAD = 0.10;
})();
