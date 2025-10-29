
(function(){
  // ====== CONFIG ======
  const FILE_URL = '/assets/backend/h3_year.json'; // change if needed
  const START_CENTER = [51.5074, -0.1278];
  const START_ZOOM   = 9;

  const MIN_DRAW_ZOOM      = 9;
  const FILL_OPACITY       = 0.30;
  const DRAW_CHUNK_SIZE    = 1200;
  const VIEW_PAD           = 0.10;
  const SAFETY_MAX_RENDER  = 80000;
  const MAX_CELLS          = 5000;

  const MIN_H3_RES = 6;
  const MAX_BOUNDS = L.latLngBounds([50.8, -2], [52.2,  2]);
  // Persistent hotspots
  const DEFAULT_HS_ENABLED = false; // used if no #hsToggle present
  const DEFAULT_HS_PCT     = 0.05;  // used if no #hsPct present
  const HS_MIN_GLOBAL      = 25;    // ensure >= this many hotspots globally per resolution

  // Color gradient anchors (0..1)
  const GRAD_KNOTS = { mid: 0.30, high: 1.0 };
  const GRAD_COLORS = {
    low:  { r:0x2a, g:0x8f, b:0x5a }, // green
    mid:  { r:0xff, g:0xd4, b:0x00 }, // yellow
    high: { r:0xff, g:0x00, b:0x33 }  // red
  };

  // ====== DOM ======
  const badgeEl    = document.getElementById('badge');
  const hintEl     = document.querySelector('.hint');

  const yearRange  = document.getElementById('year');
  const yearVal    = document.getElementById('yearVal');
  const allYearsCk = document.getElementById('allYears');

  // Optional hotspot controls
  const hsToggle   = document.getElementById('hsToggle');
  const hsPctSel   = document.getElementById('hsPct');

  // Legend numbers in panel
  const lminEl = document.getElementById('lmin');
  const lmidEl = document.getElementById('lmid');
  const lmaxEl = document.getElementById('lmax');

  // Panel reference (used by the hamburger logic)
  const panel = document.getElementById('panel');

  // ====== MAP ======
  const map = L.map('map', {
  preferCanvas: true,
  worldCopyJump: true,
  minZoom: START_ZOOM,
  maxBounds: MAX_BOUNDS,
  maxBoundsViscosity: 1.0
}).setView(START_CENTER, START_ZOOM);

// Be explicit too:
map.setMaxBounds(MAX_BOUNDS);

L.tileLayer(
  'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=STADIA_KEY',
  {
    attribution: '&copy; OpenStreetMap &copy; Stadia Maps',
    maxZoom: 20,
    minZoom: START_ZOOM,
    noWrap: true,         // <-- add this
    bounds: MAX_BOUNDS    // <-- optional but keeps tile requests tidy
  }
).addTo(map);

  window.__map = map;

  if (L.control.fullscreen) {
    L.control.fullscreen({ position: 'topleft', title: 'Toggle fullscreen' }).addTo(map);
    map.on('enterFullscreen', () => setTimeout(() => map.invalidateSize(), 200));
    map.on('exitFullscreen',  () => setTimeout(() => map.invalidateSize(), 200));
  }


  const layerRoot = L.layerGroup().addTo(map);
  const canvasRenderer = L.canvas({ padding: 0.5 });
  const tip = L.tooltip({ sticky: true });

  // ====== HELPERS ======
  const setBadge = html => { if (badgeEl) badgeEl.innerHTML = html; };
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const mix = (a,b,t)=>({ r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) });
  function colorFor01(p){
    const x = clamp01(p);
    const k1 = GRAD_KNOTS.mid, k2 = GRAD_KNOTS.high;
    if (x <= k1){
      const t = (k1 <= 0) ? 1 : (x / k1);
      const c = mix(GRAD_COLORS.low, GRAD_COLORS.mid, t);
      return `rgb(${c.r},${c.g},${c.b})`;
    } else if (x <= k2){
      const t = (k2 - k1 <= 0) ? 1 : ((x - k1) / (k2 - k1));
      const c = mix(GRAD_COLORS.mid, GRAD_COLORS.high, t);
      return `rgb(${c.r},${c.g},${c.b})`;
    } else {
      const c = GRAD_COLORS.high;
      return `rgb(${c.r},${c.g},${c.b})`;
    }
  }
  function grayFor01(p){
    const x = clamp01(p);
    const v = Math.round(60 + x * (230 - 60));
    return `rgb(${v},${v},${v})`;
  }
  function paddedBounds(b){
    const dLat = (b.getNorth() - b.getSouth()) * VIEW_PAD;
    const dLng = (b.getEast() - b.getWest()) * VIEW_PAD;
    return L.latLngBounds([b.getSouth()-dLat, b.getWest()-dLng], [b.getNorth()+dLat, b.getEast()+dLng]);
  }
  function debounce(fn, ms){ let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
  const schedule = debounce(draw, 90);
  const formatCount = (n) => {
    if (!isFinite(n)) return '—';
    const r = Math.round(n);
    if (Math.abs(n - r) < 0.05) return r.toLocaleString();
    // Show one decimal when fractional (from child distribution)
    return n.toFixed(1);
  };

  // ====== CACHES ======
  let MAX_RES = null;
  const shapePool = new Map();        // id -> polygon
  const centerCache = new Map();      // h3 -> [lat,lng]
  const boundaryCache = new Map();    // h3 -> [[lat,lng]...]
  const parentCacheByRes = new Map(); // res -> Map(child->parent)
  const globalAggCache = new Map();   // `${yearKey}|${res}` -> {entries, byId}
  const hotspotCache   = new Map();   // `${yearKey}|${res}|${pct}|min${HS_MIN_GLOBAL}` -> Set(h3)

  function centerOf(id){
    let c = centerCache.get(id); if (c) return c;
    try { const [lat,lng] = h3.cellToLatLng(id); c=[lat,lng]; centerCache.set(id,c); return c; } catch { return null; }
  }
  function boundaryOf(id){
    let b = boundaryCache.get(id); if (b) return b;
    try { b = h3.cellToBoundary(id).map(([lat,lng]) => [lat,lng]); boundaryCache.set(id,b); return b; } catch { return null; }
  }
  function childToParent(id, res){
    let cache = parentCacheByRes.get(res);
    if (!cache){ cache = new Map(); parentCacheByRes.set(res, cache); }
    let p = cache.get(id);
    if (p) return p;
    try { p = h3.cellToParent(id, res); } catch { p = null; }
    if (p) cache.set(id, p);
    return p;
  }
  function targetResForZoom(zoom) {
  if (MAX_RES == null) return Math.min(MIN_H3_RES, 15); // safe default before data loads

  const steps = Math.max(0, Math.floor((18.1 - zoom) / 1.2));
  const rawRes = Math.max(0, MAX_RES - steps);

  // Do not render coarser than MIN_H3_RES, but never below the dataset’s MAX_RES floor if MAX_RES < MIN_H3_RES
  const floor = Math.min(MIN_H3_RES, MAX_RES);
  // Ensure we also never exceed MAX_RES
  return Math.min(MAX_RES, Math.max(floor, rawRes));
}

  // ====== DATA STORAGE ======
  // BASE_BY_YEAR[yearKey] = Array<[h3Id, count_at_MAX_RES]>
  const BASE_BY_YEAR = new Map();
  let YEARS = []; // sorted
  let LAST_UPDATED = null;

  function renderHint(){
    if (!hintEl) return;
    if (!LAST_UPDATED){
      hintEl.textContent = 'Last updated: —';
      return;
    }
    const s = String(LAST_UPDATED);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
    hintEl.textContent = `Last updated: ${m ? `${m[1]} ${m[2]}:${m[3]}` : s}`;
  }

  // ====== LOADER (robust) ======
  async function loadCells(url){
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} while loading ${url}`);

    let txt;
    try {
      // Prefer arrayBuffer to support gzip bytes even if no Content-Encoding header
      const buf = new Uint8Array(await res.arrayBuffer());
      try { txt = new TextDecoder().decode(pako.ungzip(buf)); }
      catch { txt = new TextDecoder().decode(buf); }
    } catch {
      txt = await res.text();
    }
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);

    // Try strict JSON
    let json;
    try {
      json = JSON.parse(txt);
    } catch {
      // Try bracket-wrap comma-separated objects
      try {
        const wrapped = `[${txt.trim().replace(/^,|,$/g, '')}]`;
        json = JSON.parse(wrapped);
      } catch {
        // Try NDJSON
        const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        json = lines.map(line => JSON.parse(line));
      }
    }

    const raw = Array.isArray(json) ? json
      : Array.isArray(json.data) ? json.data
      : Array.isArray(json.records) ? json.records
      : Array.isArray(json.rows) ? json.rows
      : (() => { throw new Error('Expected array or {data|records|rows:[...]}.'); })();

    // Normalize to [h3, year, count=1]
    const rows = [];
    for (const r of raw){
      const h = String(r.h3 || r.h || r.cell || r.id || '');
      const y = +(r.year ?? r.y ?? r.time_year ?? r.date_year);
      const c = Number.isFinite(+r.count) ? +r.count : 1;
      if (h && Number.isFinite(y)) rows.push([h, y, c]);
    }
    if (!rows.length) throw new Error('No valid rows with {h3, year} found.');

    // MAX_RES from data
    let mres = -1;
    for (const [h] of rows){
      try { mres = Math.max(mres, h3.getResolution(h)); } catch {}
    }
    MAX_RES = mres < 0 ? 0 : mres;

    // Aggregate per year at MAX_RES (lift coarser rows to MAX_RES by distributing counts to children)
    const aggByYear = new Map(); // year -> Map(h3 -> count)
    const addToYear = (y, h, c) => {
      let m = aggByYear.get(y);
      if (!m){ m = new Map(); aggByYear.set(y, m); }
      m.set(h, (m.get(h)||0) + c);
    };

    for (const [h,y,c] of rows){
      let r=-1; try { r = h3.getResolution(h); } catch {}
      if (r === MAX_RES){
        addToYear(y, h, c);
      } else if (r >= 0 && r < MAX_RES){
        let kids = [];
        try { kids = h3.cellToChildren(h, MAX_RES); } catch { kids = []; }
        if (kids.length){
          const share = c / kids.length;
          for (const k of kids) addToYear(y, k, share);
        }
      }
    }

    YEARS = Array.from(aggByYear.keys()).sort((a,b)=>a-b);
    for (const y of YEARS){
      const arr = Array.from(aggByYear.get(y), ([h, cnt]) => [h, cnt]);
      BASE_BY_YEAR.set(String(y), arr);
    }

    // Combined "ALL" year
    const all = new Map();
    for (const y of YEARS){
      for (const [h,c] of aggByYear.get(y)){
        all.set(h, (all.get(h)||0) + c);
      }
    }
    BASE_BY_YEAR.set('ALL', Array.from(all, ([h,c]) => [h,c]));

    // Optional meta timestamp
    try {
      const maybe = JSON.parse(txt);
      LAST_UPDATED = maybe?.meta?.updated_at || maybe?.updated_at || null;
    } catch { /* ignore */ }
  }

  // ====== AGGREGATION FOR RENDER RES ======
  // Returns { entries: [ [h3_at_res, count, {cnt}] ... ] } sorted desc by count
  function aggregateYearAtRes(yearKey, res){
    const key = `${yearKey}|${res}`;
    const cached = globalAggCache.get(key);
    if (cached) return cached;

    const base = BASE_BY_YEAR.get(yearKey) || [];
    const byId = new Map();
    for (let i=0; i<base.length; i++){
      const id = base[i][0], count = base[i][1];
      const parentId = (res >= MAX_RES) ? id : childToParent(id, res);
      if (!parentId) continue;
      byId.set(parentId, (byId.get(parentId)||0) + count);
    }
    const entries = Array.from(byId, ([pid, cnt]) => [pid, cnt, { cnt }]);
    entries.sort((a,b)=> b[1] - a[1]);

    const record = { byId, entries };
    globalAggCache.set(key, record);
    return record;
  }

  // ====== PERSISTENT HOTSPOTS (global per year & res) ======
  function getHotspots(yearKey, res, pct){
    const key = `${yearKey}|${res}|${pct.toFixed(4)}|min${HS_MIN_GLOBAL}`;
    const cached = hotspotCache.get(key);
    if (cached) return cached;

    const agg = aggregateYearAtRes(yearKey, res);
    const N = agg.entries.length;
    const topN = Math.max(1, Math.max(HS_MIN_GLOBAL, Math.ceil(N * pct)));
    const set = new Set();
    for (let i=0;i<Math.min(N, topN); i++) set.add(agg.entries[i][0]);
    hotspotCache.set(key, set);
    return set;
  }

  // ====== LEGEND NUMBERS ======
  function updateLegendNumbers(minCnt, midCnt, maxCnt){
    if (lminEl) lminEl.textContent = formatCount(minCnt);
    if (lmidEl) lmidEl.textContent = formatCount(midCnt);
    if (lmaxEl) lmaxEl.textContent = formatCount(maxCnt);
  }

  // ====== DRAW ======
  function draw(){
    if (!BASE_BY_YEAR.size) return;

    const zoom = map.getZoom();
    const inHotMode = hsToggle ? !!hsToggle.checked : DEFAULT_HS_ENABLED;
    const pct = hsPctSel ? parseFloat(hsPctSel.value || `${DEFAULT_HS_PCT}`) : DEFAULT_HS_PCT;

    const all = !!(allYearsCk && allYearsCk.checked);
    const ySel = all ? 'ALL' : String(+yearRange.value || YEARS[0] || '');

    if (zoom < MIN_DRAW_ZOOM){
      shapePool.forEach(l => l.remove());
      shapePool.clear();
      setBadge(`Year: <b>${ySel || '—'}</b> &nbsp; Shown: <b>0</b>${inHotMode ? ' &nbsp; Hotspots: <b>—</b>' : ''}`);
      // leave legend as-is when zoomed out
      return;
    }

    const pad = paddedBounds(map.getBounds());
    const renderRes = targetResForZoom(zoom);
    const agg = aggregateYearAtRes(ySel, renderRes);
    const entries = agg.entries;

    // --- Per-resolution MIN/MAX mapping (GLOBAL, not viewport) ---
    const countsDesc = entries.map(e => e[1]);
    const maxCnt = countsDesc.length ? countsDesc[0] : 1;
    const minAll = countsDesc.length ? countsDesc[countsDesc.length - 1] : 0;
    // prefer smallest positive as "green" to avoid zero-only skew
    let minPos = Infinity;
    for (let i=countsDesc.length-1; i>=0; i--){
      const v = countsDesc[i];
      if (v > 0 && v < minPos) minPos = v;
    }
    const minCnt = (minPos !== Infinity) ? minPos : minAll;

    // median (for legend mid number)
    const midIdx = Math.floor(countsDesc.length / 2);
    const midCnt = countsDesc.length ? countsDesc[midIdx] : 0;

    // Update panel legend numbers
    updateLegendNumbers(minCnt, midCnt, maxCnt);

    // Map min→0 (green), max→1 (red); flat → 0.5
    const to01 = (maxCnt > minCnt)
      ? (c => (c - minCnt) / (maxCnt - minCnt))
      : (_ => 0.5);

    // Persistent hotspots
    let hotSet = null;
    if (inHotMode) hotSet = getHotspots(ySel, renderRes, isFinite(pct) ? pct : DEFAULT_HS_PCT);

    // View filter
    const inView = [];
    for (let i=0;i<entries.length;i++){
      const id = entries[i][0];
      const cnt = entries[i][1];
      const meta = entries[i][2];
      const c = centerOf(id); if (!c) continue;
      const lat = c[0], lng = c[1];
      if (lat < pad.getSouth() || lat > pad.getNorth() ||
          lng < pad.getWest()  || lng > pad.getEast()) continue;
      inView.push([id, cnt, c, meta]);
    }

    // Selection: draw hotspots first
    const cap = Math.min(MAX_CELLS, SAFETY_MAX_RENDER);
    let selected;
    if (inHotMode && hotSet){
      const hot=[], rest=[];
      for (const d of inView) (hotSet.has(d[0]) ? hot : rest).push(d);
      selected = hot.concat(rest).slice(0, cap);
    } else {
      selected = inView.slice(0, cap);
    }

    // Remove stale
    const keep = new Set(selected.map(d => d[0]));
    shapePool.forEach((layer, key) => {
      if (!keep.has(key)) { layer.remove(); shapePool.delete(key); }
    });

    if (!selected.length){
      const hotTxt = inHotMode && hotSet ? ` &nbsp; Hotspots: <b>${hotSet.size}</b>` : '';
      setBadge(`Year: <b>${ySel}</b> &nbsp; Shown: <b>0</b>${hotTxt}`);
      return;
    }

    // Chunked draw
    let idx = 0;
    const step = () => {
      const lim = Math.min(idx + DRAW_CHUNK_SIZE, selected.length);
      for (; idx < lim; idx++){
        const [id, cnt, /*c*/, meta] = selected[idx];
        const p01 = clamp01(to01(cnt));
        const fill = (!inHotMode || (hotSet && hotSet.has(id))) ? colorFor01(p01) : grayFor01(p01);

        let layer = shapePool.get(id);
        if (!layer){
          const poly = boundaryOf(id); if (!poly) continue;
          layer = L.polygon(poly, {
            renderer: canvasRenderer,
            fill: true, fillOpacity: FILL_OPACITY,
            stroke: true, color: fill, opacity: 0.5, weight: 0.3, fillColor: fill
          });

          layer.__cnt = cnt;
          layer.on('mouseover', () => {
            const pos = layer.getBounds().getCenter();
            tip.setContent(`Collisions: <b>${formatCount(layer.__cnt)}</b>`);
            tip.setLatLng(pos);
            map.openTooltip(tip);
          });
          layer.on('mouseout', () => { map.closeTooltip(tip); });

          layer.addTo(layerRoot);
          shapePool.set(id, layer);
        } else {
          layer.setStyle({ fillColor: fill, color: fill });
          layer.__cnt = cnt;
          if (!layer._map) layer.addTo(layerRoot);
        }
      }
      if (idx < selected.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);

    // Badge
    const hotTxt = inHotMode && hotSet ? ` &nbsp; Hotspots: <b>${hotSet.size}</b>` : '';
    setBadge(`Year: <b>${ySel}</b> &nbsp; Shown: <b>${selected.length}</b>${hotTxt}`);
  }

  // ====== EVENTS ======
  map.on('moveend', schedule);
  map.on('zoomend', schedule);

  if (hsToggle) hsToggle.addEventListener('change', () => { hotspotCache.clear(); schedule(); });
  if (hsPctSel) hsPctSel.addEventListener('change', () => { hotspotCache.clear(); schedule(); });

  if (allYearsCk) allYearsCk.addEventListener('change', () => { globalAggCache.clear(); hotspotCache.clear(); schedule(); });
  if (yearRange){
    yearRange.addEventListener('input', () => {
      if (yearVal) yearVal.textContent = yearRange.value;
      globalAggCache.clear();
      hotspotCache.clear();
      schedule();
    });
  }

  // ====== BOOT ======
  (async function boot(){
    try{
      await loadCells(FILE_URL);

      // Initialize slider from data
      if (YEARS.length && yearRange){
        const minY = YEARS[0], maxY = YEARS[YEARS.length - 1];
        yearRange.min = minY; yearRange.max = maxY;
        if (!yearRange.value) yearRange.value = maxY;
        if (yearVal) yearVal.textContent = yearRange.value;
      }

      renderHint();
      draw();

      // ==== Mobile/desktop UI mode bootstrap (exact pattern from your script) ====
      const applyMode = () => (isMobilePreferred() ? enterMobileMode() : exitMobileMode());
      applyMode();
      window.addEventListener('resize', applyMode);
      const mq = window.matchMedia('(hover: none), (pointer: coarse)');
      if (mq.addEventListener) mq.addEventListener('change', applyMode);
      else if (mq.addListener) mq.addListener(applyMode); // older Safari
    } catch(err){
      console.error('[collision_year_map] load failed:', err);
      setBadge('Year: <b>—</b> &nbsp; Shown: <b>0</b>');
      if (hintEl) hintEl.textContent = 'Last updated: —';
    }
  })();

  // ==========================================================
  // PANEL + HAMBURGER LOGIC (copied style from your script)
  // ==========================================================
  let menuBtn = null;
  let isMobileMode = false;
  let panelOpen = true;  // on phones, start opened

  function makeHamburger(){
    if (menuBtn) return menuBtn;
    menuBtn = document.createElement('button');
    menuBtn.id = 'menuBtn';
    menuBtn.setAttribute('aria-label', 'Menu');
    menuBtn.setAttribute('aria-expanded', 'true');
    menuBtn.innerHTML = '<span></span><span></span><span></span>'; // 3 bars
    document.body.appendChild(menuBtn);
    return menuBtn;
  }

  function isMobilePreferred(){
    // Prefer input modality over width; catches phones & most tablets
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  }

  function setPanelOpen(open){
    panelOpen = !!open;
    if (!panel) return;
    panel.classList.toggle('mobile-hidden', !panelOpen);
    if (menuBtn) menuBtn.setAttribute('aria-expanded', String(panelOpen));
  }

  // Close when tapping/clicking anywhere outside panel & hamburger
  function handleGlobalPointer(e){
    if (!isMobileMode || !panelOpen) return;
    const t = e.target;
    if (panel && panel.contains(t)) return;
    if (menuBtn && menuBtn.contains(t)) return;
    setPanelOpen(false);
  }

  function enterMobileMode(){
    if (isMobileMode) return;
    isMobileMode = true;
    document.body.classList.add('mobile-ui');
    makeHamburger();
    setPanelOpen(true); // starts opened

    // Toggle on hamburger tap
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setPanelOpen(!panelOpen);
    });

    // Capture-level listeners to beat Leaflet/map handlers
    window.addEventListener('pointerdown', handleGlobalPointer, true);
    window.addEventListener('click', handleGlobalPointer, true);
    window.addEventListener('touchstart', handleGlobalPointer, { capture: true, passive: true });

    // Also listen on the Leaflet container (some browsers stop early on map)
    if (map && map.getContainer){
      const mc = map.getContainer();
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
      const mc = map.getContainer();
      mc.removeEventListener('pointerdown', handleGlobalPointer, true);
      mc.removeEventListener('click', handleGlobalPointer, true);
      mc.removeEventListener('touchstart', handleGlobalPointer, { capture: true });
    }

    if (menuBtn) menuBtn.style.display = 'none'; // hide hamburger on desktop
  }
})();
