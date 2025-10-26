// /assets/js/map_year.js
// Collisions by Year with resolution-aware GRADIENT colors and H3 aggregation.
// Tooltip shows only "Collisions: N". Legend updates per current render H3 res.
// NEW: When "All years" is toggled, color thresholds scale by number of years,
//      so colors stay consistent (RES_BANDS × years_count).

// Run after DOM + deferred libs are ready
window.addEventListener('DOMContentLoaded', init);

function init(){
  // ===== Config =====
  const FILE_CANDIDATES = [
    '/assets/backend/h3_year.json.gz', // preferred (gzip)
    '/assets/backend/h3_year.json'     // fallback (plain json)
  ];
  const MIN_DRAW_ZOOM      = 10;   // draw only at/above this zoom
  const MIN_MAP_ZOOM       = 10;   // hard limit: cannot zoom out beyond this
  const FILL_OPACITY       = 0.30;
  const DRAW_CHUNK_SIZE    = 1500;
  const VIEW_PAD           = 0.12;
  const SAFETY_MAX_RENDER  = 80000;
  const MAX_CELLS          = 5000; // fixed cap on how many cells to render

  // ===== Resolution-specific bands (counts → thresholds per render H3 resolution) =====
  // Meaning: for H3 res R, green..yellow band is 1..t1, yellow..red band is t1+..t2, and >=t2 is saturated red.
  // When "All years" is ON, these thresholds are multiplied by the number of years displayed.
  const RES_BANDS = {
    12: { t1: 2,   t2: 3   },
    11: { t1: 2,   t2: 5   },
    10: { t1: 5,   t2: 10  },
     9: { t1: 10,  t2: 30  },
     8: { t1: 30,  t2: 100 },
     7: { t1: 50,  t2: 300 },
     6: { t1: 300, t2: 1000 }
  };

  // Colors for gradient endpoints
  const COL_GREEN = { r:42,  g:143, b:90  }; // #2a8f5a
  const COL_YELLW = { r:255, g:212, b:0   }; // #ffd400
  const COL_RED   = { r:255, g:0,   b:51  }; // #ff0033

  // ===== Map setup =====
  const START_CENTER = [51.5074, -0.1278]; // London (lat, lng)
  const START_ZOOM   = 10;                 // starting zoom

  const map = L.map('map', {
    preferCanvas: true,
    worldCopyJump: true,
    minZoom: MIN_MAP_ZOOM
  }).setView(START_CENTER, START_ZOOM);

  // Fullscreen control (requires leaflet.fullscreen)
  L.control.fullscreen({ position: 'topleft', title: 'Toggle fullscreen' }).addTo(map);
  map.on('enterFullscreen', () => setTimeout(() => map.invalidateSize(), 200));
  map.on('exitFullscreen',  () => setTimeout(() => map.invalidateSize(), 200));

  // Basemap (Stadia Maps - replace STADIA_KEY)
  L.tileLayer(
    'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=STADIA_KEY',
    {
      attribution: '&copy; OpenStreetMap &copy; Stadia Maps',
      maxZoom: 20, minZoom: MIN_MAP_ZOOM
    }
  ).addTo(map);

  const layerRoot = L.layerGroup().addTo(map);
  const canvasRenderer = L.canvas({ padding: 0.5 });

  // --- Lock panning to the starting view bounds ---
  map.whenReady(() => {
    const startBounds = map.getBounds();
    map.setMaxBounds(startBounds);
    map.options.maxBoundsViscosity = 1.0;
  });

  // ===== UI =====
  const yearEl   = document.getElementById('year');
  const yearVal  = document.getElementById('yearVal');
  const allYearsEl = document.getElementById('allYears');
  const badge    = document.getElementById('badge');
  const panel    = document.getElementById('panel');
  const hintEl   = document.querySelector('.hint');

  const lmin = document.getElementById('lmin');
  const lmid = document.getElementById('lmid');
  const lmax = document.getElementById('lmax');

  // prevent map drag/scroll while using the panel, but keep inputs working
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);

  function setBadge(yearText, shown, res){
    badge.innerHTML = `Year: <b>${yearText}</b> &nbsp; Shown: <b>${shown}</b>${res!=null ? ` &nbsp; res: <b>${res}</b>` : ''}`;
  }

  // ===== Hint formatting =====
  function formatYMD_HHMM(s){
    if (!s) return '—';
    const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
    return m ? `${m[1]} ${m[2]}:${m[3]}` : String(s);
  }
  function formatAgoMs(ms){
    if (ms < 45 * 1000) return 'now';
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }
  let lastUpdatedRaw = null;
  let lastUpdatedDate = null;

  function renderHint(){
    if (!hintEl) return;
    const main = formatYMD_HHMM(lastUpdatedRaw);
    let ago = '';
    let cls = 'fresh';
    if (lastUpdatedDate instanceof Date && !isNaN(lastUpdatedDate)){
      const diff = Date.now() - lastUpdatedDate.getTime();
      ago = ` <span class="ago">(${formatAgoMs(diff)})</span>`;
      if (diff > 2 * 60 * 60 * 1000) cls = 'very-stale';
      else if (diff > 30 * 60 * 1000) cls = 'stale';
    }
    hintEl.classList.remove('fresh', 'stale', 'very-stale');
    hintEl.classList.add(cls);
    hintEl.innerHTML = `Last updated: ${main}${ago}`;
  }

  // ===== Data & caches =====
  // yearCounts: Map<number|"ALL", Map<h3Id, count>>
  const yearCounts = new Map();
  const yearMax = new Map();   // per key ("ALL" or year) -> max count in any base cell

  let yearMin = null, yearMaxVal = null; // slider bounds
  let BASE_RES = null;                   // detected from data
  let YEARS_LIST = [];                   // sorted unique years we have

  const centerCache = new Map();
  const boundaryCache = new Map();
  const shapePool = new Map();
  const tip = L.tooltip({ sticky: true });
  let lastLayer = null;

  function centerOf(id){
    let c = centerCache.get(id); if (c) return c;
    try { const [lat, lng] = h3.cellToLatLng(id); c=[lat,lng]; centerCache.set(id,c); return c; } catch { return null; }
  }
  function boundaryOf(id){
    let b = boundaryCache.get(id); if (b) return b;
    try { b = h3.cellToBoundary(id).map(([lat,lng]) => [lat,lng]); boundaryCache.set(id,b); return b; } catch { return null; }
  }
  function paddedBounds(b){
    const dLat = (b.getNorth() - b.getSouth()) * VIEW_PAD;
    const dLng = (b.getEast() - b.getWest()) * VIEW_PAD;
    return L.latLngBounds([b.getSouth()-dLat, b.getWest()-dLng], [b.getNorth()+dLat, b.getEast()+dLng]);
  }
  const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
  const schedule = debounce(draw, 100);

  // ===== Resolution helpers =====
  function targetResForZoom(zoom) {
    if (BASE_RES == null) return 0;
    const steps = Math.max(0, Math.floor((18 - zoom) / 1.2)); // mapping from zoom to parent res
    const res = Math.max(0, BASE_RES - steps * 1);
    return res;
  }

  function thresholdsForRes(res){
    if (RES_BANDS[res]) return RES_BANDS[res];
    const keys = Object.keys(RES_BANDS).map(Number).sort((a,b)=>a-b);
    if (keys.length === 0) return { t1: 1, t2: 2 };
    // pick nearest defined res
    let best = keys[0], bestDiff = Math.abs(res - keys[0]);
    for (const k of keys){
      const d = Math.abs(res - k);
      if (d < bestDiff){ best = k; bestDiff = d; }
    }
    return RES_BANDS[best];
  }

  // Scale thresholds by a multiplier (used for "All years")
  function thresholdsForResScaled(res, mult){
    const { t1, t2 } = thresholdsForRes(res);
    const m = Math.max(1, Math.floor(mult) || 1);
    return { t1: t1 * m, t2: t2 * m };
  }

  // --- Gradient color: interpolate GREEN→YELLOW→RED based on (count, scaled thresholds)
  function mix(a,b,t){
    return {
      r: Math.round(a.r + (b.r - a.r) * t),
      g: Math.round(a.g + (b.g - a.g) * t),
      b: Math.round(a.b + (b.b - a.b) * t)
    };
  }
  // Map count to t∈[0,1] with piecewise mapping:
  //  [1 .. t1]  -> [0 .. 0.5]  (green→yellow)
  // (t1 .. t2]  -> (0.5 .. 1]  (yellow→red), clamp >t2 to 1
  function tForCount(v, t1, t2){
    if (v <= 1) return 0; // minimal green for 1
    if (v <= t1) {
      const den = Math.max(1, t1 - 1);
      return 0.5 * (v - 1) / den;
    }
    if (v <= t2) {
      const den = Math.max(1, t2 - t1);
      return 0.5 + 0.5 * (v - t1) / den;
    }
    return 1;
  }
  function colorForCountGradient(v, res, multYears){
    if (v <= 0 || !Number.isFinite(v)) return 'transparent';
    const { t1, t2 } = thresholdsForResScaled(res, multYears);
    const t = tForCount(v, t1, t2);
    // interpolate across two segments: [0..0.5]: green→yellow, (0.5..1]: yellow→red
    if (t <= 0.5){
      const tt = t / 0.5; // 0..1
      const c = mix(COL_GREEN, COL_YELLW, tt);
      return `rgb(${c.r},${c.g},${c.b})`;
    } else {
      const tt = (t - 0.5) / 0.5; // 0..1
      const c = mix(COL_YELLW, COL_RED, tt);
      return `rgb(${c.r},${c.g},${c.b})`;
    }
  }

  // ---- Build rows to render at a resolution: [id, count, center]
  function rowsAtResolutionCounts(yearKey, res, padBounds){
    const baseMap = yearCounts.get(yearKey);
    if (!baseMap) return [];

    const out = [];
    if (res >= BASE_RES){
      for (const [id, cnt] of baseMap.entries()){
        if (cnt <= 0) continue;
        const c = centerOf(id); if (!c) continue;
        if (!padBounds.contains(L.latLng(c[0], c[1]))) continue;
        out.push([id, cnt, c]);
      }
    } else {
      const agg = new Map(); // parentId -> sum count
      for (const [id, cnt] of baseMap.entries()){
        if (cnt <= 0) continue;
        let parentId;
        try { parentId = h3.cellToParent(id, res); } catch { continue; }
        agg.set(parentId, (agg.get(parentId) || 0) + cnt);
      }
      for (const [parentId, cnt] of agg.entries()){
        if (cnt <= 0) continue;
        const c = centerOf(parentId); if (!c) continue;
        if (!padBounds.contains(L.latLng(c[0], c[1]))) continue;
        out.push([parentId, cnt, c]);
      }
    }
    return out;
  }

  // ===== Load payload =====
  (async function load(){
    let payload = null, rawText = null;

    for (const FILE of FILE_CANDIDATES){
      try{
        const res = await fetch(FILE, { cache: 'no-store' });
        if (!res.ok) continue;
        const buf = new Uint8Array(await res.arrayBuffer());
        // Try gzip first; fallback to plain text
        try {
          rawText = new TextDecoder().decode(pako.ungzip(buf));
        } catch {
          rawText = new TextDecoder().decode(buf);
        }
        payload = JSON.parse(rawText);
        break;
      }catch{ /* try next */ }
    }
    if (!payload) {
      console.error('Failed to load h3_year data.');
      return;
    }

    // Optional meta datetime
    const raw = (payload?.meta?.weather_datetime) ?? (payload?.weather_datetime ?? null);
    lastUpdatedRaw = raw; lastUpdatedDate = raw ? new Date(raw) : null; renderHint();
    if (!window.__hintAgoTimer) window.__hintAgoTimer = setInterval(renderHint, 60 * 1000);

    // Accept either: payload = [ {h3,year}, ... ] or {data: [...]}
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload.data) ? payload.data : []);
    let firstH3 = null;

    for (const r of rows){
      let h = null, y = null;
      if (r && typeof r === 'object'){
        if ('h3' in r && 'year' in r){ h = String(r.h3); y = +r.year; }
        else if (Array.isArray(r)){ // tolerate [h3, year] or [year, h3]
          if (typeof r[0] === 'string' && r.length >= 2){ h = r[0]; y = +r[1]; }
          else if (typeof r[1] === 'string'){ h = r[1]; y = +r[0]; }
        }
      } else if (Array.isArray(r)){
        if (typeof r[0] === 'string'){ h = r[0]; y = +r[1]; }
      }
      if (!h || !Number.isFinite(y)) continue;

      if (!firstH3) firstH3 = h;

      let ym = yearCounts.get(y);
      if (!ym){ ym = new Map(); yearCounts.set(y, ym); }
      ym.set(h, (ym.get(h) || 0) + 1);

      // Build ALL
      let am = yearCounts.get('ALL');
      if (!am){ am = new Map(); yearCounts.set('ALL', am); }
      am.set(h, (am.get(h) || 0) + 1);
    }

    // Detect base H3 resolution
    if (firstH3){
      try { BASE_RES = h3.getResolution(firstH3); } catch {}
    }

    // Slider bounds + year list
    YEARS_LIST = [...yearCounts.keys()].filter(v => v !== 'ALL').sort((a,b)=>a-b);
    yearMin = YEARS_LIST[0]; yearMaxVal = YEARS_LIST[YEARS_LIST.length - 1];

    // Compute per-year maxima (meta only)
    for (const [yk, m] of yearCounts.entries()){
      let mx = 0;
      for (const v of m.values()) if (v > mx) mx = v;
      yearMax.set(yk, mx);
    }

    // Init UI values
    yearEl.min = yearMin; yearEl.max = yearMaxVal; yearEl.step = 1; 
    yearEl.value = yearMaxVal;
    yearVal.textContent = String(yearMaxVal);

    // Legend initial (based on current zoom/res)
    updateLegendForRes(targetResForZoom(map.getZoom()), getYearMultiplier());

    // Bind UI handlers
    yearEl.addEventListener('input', () => {
      if (!allYearsEl.checked) {
        yearVal.textContent = String(+yearEl.value);
        schedule();
      }
    });
    yearEl.addEventListener('change', () => {
      if (!allYearsEl.checked) schedule();
    });
    allYearsEl.addEventListener('change', () => {
      const on = allYearsEl.checked;
      yearEl.disabled = on;
      yearVal.textContent = on ? 'All' : String(+yearEl.value);
      schedule();
    });

    // Redraw on map move/zoom
    map.on('moveend', schedule);
    map.on('zoomend', schedule);

    // First draw
    schedule();
  })();

  // Multiplier to scale thresholds:
  // - Single year → 1
  // - All years → total number of distinct years we have data for
  function getYearMultiplier(){
    return allYearsEl && allYearsEl.checked ? Math.max(1, YEARS_LIST.length) : 1;
  }

  // ===== Legend update for current resolution =====
  function updateLegendForRes(res, mult){
    const { t1, t2 } = thresholdsForResScaled(res, mult);

    const bar = document.querySelector('.legend-bar');
    if (bar){
      // Smooth gradient: green → yellow → red
      bar.style.background =
        `linear-gradient(90deg, `+
        `rgb(${COL_GREEN.r},${COL_GREEN.g},${COL_GREEN.b}) 0%, `+
        `rgb(${COL_YELLW.r},${COL_YELLW.g},${COL_YELLW.b}) 50%, `+
        `rgb(${COL_RED.r},${COL_RED.g},${COL_RED.b}) 100%)`;
    }

    const legendTitle = document.querySelector('.legend > div:first-child');
    if (legendTitle){
      const suffix = mult > 1 ? ` (scaled ×${mult} for all-years)` : '';
      legendTitle.textContent =
        `Collisions per cell — gradient @ res ${res}${suffix} (1→${t1} green→yellow, ${t1+1}→${t2} yellow→red, ≥${t2} red)`;
    }

    if (lmin) lmin.textContent = '1';
    if (lmid) lmid.textContent = String(t1);
    if (lmax) lmax.textContent = `${t2}+`;
  }

  // ===== Draw logic =====
  function draw(){
    const zoom = map.getZoom();
    const res = targetResForZoom(zoom);
    const multYears = getYearMultiplier();
    updateLegendForRes(res, multYears);

    if (zoom < MIN_DRAW_ZOOM){
      shapePool.forEach(l => l.remove());
      setBadge(allYearsEl.checked ? 'All' : String(+yearEl.value), 0, null);
      return;
    }

    const key = allYearsEl.checked ? 'ALL' : +yearEl.value;

    const pad = paddedBounds(map.getBounds());

    // Candidates at current render resolution
    const inView = rowsAtResolutionCounts(key, res, pad);

    // Sort desc by count
    inView.sort((a,b)=> b[1] - a[1]);

    // Cap rendered cells
    const selected = inView.slice(0, Math.min(MAX_CELLS, SAFETY_MAX_RENDER));

    // Remove stale layers
    const keep = new Set(selected.map(d => d[0]));
    shapePool.forEach((layer, id) => {
      if (!keep.has(id)) { layer.remove(); shapePool.delete(id); }
    });

    if (!selected.length){ setBadge(key, 0, res); return; }

    // Chunked draw
    let shown = 0, idx = 0;
    const step = () => {
      const lim = Math.min(idx + DRAW_CHUNK_SIZE, selected.length);
      for (; idx < lim; idx++){
        const [id, cnt] = selected[idx];
        const color = colorForCountGradient(cnt, res, multYears);

        let layer = shapePool.get(id);
        if (!layer){
          const poly = boundaryOf(id); if (!poly) continue;
          layer = L.polygon(poly, {
            renderer: canvasRenderer,
            fill: true,
            fillOpacity: FILL_OPACITY,
            stroke: true,
            color: color,
            opacity: 0.5,
            weight: 0.3,
            fillColor: color
          });

          layer.__cnt = cnt;
          layer.on('mouseover', () => {
            const pos = layer.getBounds().getCenter();
            // Tooltip WITHOUT any "aggregated" text — as requested
            tip.setContent(`Collisions: ${Number(layer.__cnt)}`);
            tip.setLatLng(pos);
            map.openTooltip(tip);
            lastLayer = layer;
          });
          layer.on('mouseout', () => { if (lastLayer === layer) map.closeTooltip(tip); });

          layer.addTo(layerRoot);
          shapePool.set(id, layer);
        } else {
          layer.setStyle({ fillColor: color, color: color });
          layer.__cnt = cnt; // update live count at current res
          if (!layer._map) layer.addTo(layerRoot);
        }
        shown++;
      }
      setBadge(key, shown, res);
      if (idx < selected.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
