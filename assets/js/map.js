// Requires: Leaflet (global L). Optional fallback needs h3 and pako.
// Heavy data prep runs in a Web Worker to keep the page responsive.

window.addEventListener('DOMContentLoaded', init);

function init(){
  // ======== TUNABLES ========
  const FILE = '/assets/backend/predictions.json.gz'; // or .json served with Content-Encoding:gzip
  const MIN_DRAW_ZOOM   = 11;
  const MIN_MAP_ZOOM    = 11;

  // Global/master fill opacity (kept separate from color).
  // Per-cell gradient and per-resolution multipliers are applied AFTER this.
  const FILL_OPACITY    = 0.30;

  const DRAW_CHUNK_SIZE = 1200;
  const VIEW_PAD        = 0.10;
  const SAFETY_MAX_RENDER = 80000;
  const MAX_CELLS       = 5000;
  const MIN_H3_RES      = 6;   // do not render/aggregate below this H3 res

  // Color gradient anchors (p in [0,1])
  const GRAD_KNOTS = { mid: 0.45, high: 0.9 };
  const GRAD_COLORS = {
    low:  { r:0x2a, g:0x8f, b:0x5a },
    mid:  { r:0xff, g:0xd4, b:0x00 },
    high: { r:0xff, g:0x00, b:0x33 }
  };

  // Aggregation mix (0 = mean only; 1 = max only)
  const HIGHLIGHT_WEIGHT = 0.00;

  // ===== Optional smoothing config (applied ONLY when finest = 12) =====
  const OUTLIER_MODE   = 'threshold';
  const LOW_THRESH     = 0.05;
  const HIGH_THRESH    = 0.95;
  const LOW_PCTL       = 0.005;
  const HIGH_PCTL      = 0.995;
  const K_RING         = 1;
  const USE_LOGIT_MEAN = false;
  const SMOOTH_BASE_RES_ONLY = 12;

  // ===== Hotspot options (GLOBAL, persistent across pan) =====
  const HS_MIN_GLOBAL = 25; // ensure at least this many hotspots globally per resolution

  // ===== Opacity (SEPARATE from color) =====
  // Enable/disable the per-value opacity gradient.
  const OPACITY_GRADIENT_ENABLED = true;

  // Opacity anchors for p=0, p=mid, p=1
  const OPACITY_KNOTS  = { mid: 0.50 }; // where the middle anchor sits on [0,1]
  const OPACITY_LEVELS = {
    low:  0.60,  // opacity at p = 0
    mid:  1.00,  // opacity at p = mid
    high: 1.00   // opacity at p = 1
  };

  // Per-H3 resolution opacity multipliers (applied after global & gradient).
  // Add/adjust entries as needed; defaults to 1.0 when a res isn’t listed.
  const OPACITY_RES_FACTORS = {
    6: 1.40,
    7: 1.40,
    8: 1.20,
    9: 1.20,
    10: 1.10,
    11: 0.90,
    12: 0.90
  };

  // ===== Globals =====
  let map = null;
  let layerRoot = null;
  let canvasRenderer = null;

  // ===== UI elements (existing) =====
  const badge   = document.getElementById('badge');
  const panel   = document.getElementById('panel'); // unchanged panel; we aren't adding controls to it
  const hintEl  = document.querySelector('.hint');
  const hsToggle= document.getElementById('hsToggle');
  const hsPctSel= document.getElementById('hsPct');
  const overlay = document.getElementById('loadingOverlay');

  if (panel){
    L.DomEvent.disableClickPropagation(panel);
    L.DomEvent.disableScrollPropagation(panel);
  }
  const setBadge = (html) => { if (badge) badge.innerHTML = html; };

  // ===== Loading helpers =====
  function showLoading(msg){
    document.body.classList.add('is-loading');
    const m = overlay?.querySelector('.msg'); if (m && msg) m.textContent = msg;
  }
  function hideLoading(){
    document.body.classList.remove('is-loading');
    const m = overlay?.querySelector('.msg'); if (m) m.textContent = '';
  }

  // ===== Hint formatting =====
  const formatYMD_HHMM = (s) => {
    if (!s) return '—';
    const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
    return m ? `${m[1]} ${m[2]}:${m[3]}` : String(s);
  };
  const formatAgoMs = (ms) => {
    if (ms < 45 * 1000) return 'now';
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  };
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

  // ===== Color & Opacity helpers =====
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const mix = (a,b,t)=>({ r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) });

  function colorFor(p){
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
  function grayFor(p){
    const x = clamp01(p);
    const v = Math.round(60 + x * (230 - 60));
    return `rgb(${v},${v},${v})`;
  }

  function opacityGradientFor(p){
    if (!OPACITY_GRADIENT_ENABLED) return 1.0;
    const x = clamp01(p);
    const k = clamp01(OPACITY_KNOTS.mid);
    const o = OPACITY_LEVELS;
    if (x <= k){
      const t = (k <= 0) ? 1 : (x / k);
      return o.low + (o.mid - o.low) * t;
    } else {
      const t = ((1 - k) <= 0) ? 1 : ((x - k) / (1 - k));
      return o.mid + (o.high - o.mid) * t;
    }
  }
  function resFactorFor(res){
    const v = (OPACITY_RES_FACTORS && Object.prototype.hasOwnProperty.call(OPACITY_RES_FACTORS, res))
      ? OPACITY_RES_FACTORS[res] : 1.0;
    const n = +v;
    return isFinite(n) ? Math.max(0, Math.min(2, n)) : 1.0;
  }

  // ===== Data & caches =====
  let RAW_DATA = [];
  let DATA_BASE = [];
  let MAX_RES = null;

  const centerCache = new Map();
  const boundaryCache = new Map();
  const parentCacheByRes = new Map();
  const neighborsCache = new Map();
  const tip = L.tooltip({ sticky: true });
  const shapePool = new Map();

  //   globalAggCache[res] = { byId: Map, entries: [ [id, pWeighted, meta], ... ] }
  const globalAggCache = new Map();
  //   hotspotCache[res][key] = Set(ids)
  const hotspotCache = new Map();

  let hotspotPct = 0.01; // default from HTML

  // ===== H3 helpers (main thread only, used after worker result) =====
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
    try { p = h3.cellToParent(id, res); } catch (e) { p = null; }
    if (p) cache.set(id, p);
    return p;
  }
  function cellToChildrenCompat(id, res){
    try {
      if (typeof h3.cellToChildren === 'function') return h3.cellToChildren(id, res);
      if (typeof h3.h3ToChildren === 'function')   return h3.h3ToChildren(id, res);
    } catch (e) {}
    return [];
  }

  // ===== Utility =====
  function paddedBounds(b){
    const dLat = (b.getNorth() - b.getSouth()) * VIEW_PAD;
    const dLng = (b.getEast() - b.getWest()) * VIEW_PAD;
    return L.latLngBounds([b.getSouth()-dLat, b.getWest()-dLng], [b.getNorth()+dLat, b.getEast()+dLng]);
  }
  function debounce(fn, ms){ let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
  const schedule = debounce(draw, 100);

  // ===== Stats helpers =====
  const clamp = (v,a,b)=>Math.max(a, Math.min(b, v));
  const _logit   = p => Math.log(clamp(p, 1e-6, 1-1e-6)/(1-clamp(p, 1e-6, 1-1e-6)));
  const _sigmoid = z => 1/(1+Math.exp(-z));
  function pctls(arr, qs){
    const a = Float64Array.from(arr).sort();
    const n = a.length;
    return qs.map(q=>{
      if (n === 0) return NaN;
      const i = clamp(q*(n-1), 0, n-1);
      const lo = Math.floor(i), hi = Math.ceil(i), t = i - lo;
      return (1-t)*a[lo] + t*a[hi];
    });
  }
  function dedupeMedian(rows){
    const bins = new Map();
    for (let i=0;i<rows.length;i++){
      const [h,p] = rows[i]; if (p==null) continue;
      let arr = bins.get(h); if (!arr){ arr=[]; bins.set(h,arr); }
      arr.push(+p);
    }
    const out = new Map();
    bins.forEach((arr,h)=>{
      arr.sort((a,b)=>a-b);
      const m = arr.length&1 ? arr[(arr.length-1)/2] : 0.5*(arr[arr.length/2-1]+arr[arr.length/2]);
      out.set(h, m);
    });
    return out;
  }
  function neighborAverage(h, pLookup, isOutlier){
    const nbrs = getNeighbors(h);
    if (!nbrs.length) return null;
    const vals=[], favored=[];
    for (const n of nbrs){
      const v = pLookup.get(n);
      if (v == null) continue;
      vals.push(v);
      if (!isOutlier(v)) favored.push(v);
    }
    const use = favored.length ? favored : vals;
    if (!USE_LOGIT_MEAN){ let s=0; for (const v of use) s+=v; return s/use.length; }
    let s=0; for (const v of use) s+=_logit(v); return _sigmoid(s/use.length);
  }
  function getNeighbors(h){
    let n = neighborsCache.get(h);
    if (n) return n;
    const set = new Set();
    for (let k=1; k<=K_RING; k++){
      try {
        if (typeof h3.gridDisk === 'function') h3.gridDisk(h, k).forEach(x => set.add(x));
        else if (typeof h3.kRing === 'function') h3.kRing(h, k).forEach(x => set.add(x));
      } catch (e) {}
    }
    set.delete(h);
    n = [...set];
    neighborsCache.set(h, n);
    return n;
  }

  // ===== Global aggregation at arbitrary resolution (from MAX_RES base) =====
  function aggregateGloballyAtRes(res, thr=0){
    const cached = globalAggCache.get(res);
    if (cached) return cached;

    const byId = new Map(); // parentId -> {sum,cnt,max}
    for (let i=0; i<DATA_BASE.length; i++){
      const id = DATA_BASE[i][0];
      const p  = DATA_BASE[i][1];
      if (p < thr) continue;
      const parentId = (res >= MAX_RES) ? id : childToParent(id, res);
      if (!parentId) continue;
      let a = byId.get(parentId);
      if (!a) { a = { sum:0, cnt:0, max:-Infinity }; byId.set(parentId, a); }
      a.sum += p; a.cnt += 1; if (p > a.max) a.max = p;
    }
    const entries = [];
    byId.forEach((a, parentId) => {
      if (a.cnt === 0) return;
      const pMean = a.sum / a.cnt;
      const pMax  = a.max;
      const pWeighted = (1 - HIGHLIGHT_WEIGHT) * pMean + HIGHLIGHT_WEIGHT * pMax;
      entries.push([parentId, pWeighted, { pMean, pMax, cnt: a.cnt, pWeighted }]);
    });
    entries.sort((a,b)=> b[1] - a[1]);

    const record = { byId, entries };
    globalAggCache.set(res, record);
    return record;
  }

  // ===== Render resolution mapping =====
  function targetResForZoom(zoom) {
    if (MAX_RES == null) return 0;
    const steps = Math.max(0, Math.floor((17.9 - zoom) / 1.2));
    const tentative = Math.max(0, MAX_RES - steps);
    const minAllowed = Math.min(MIN_H3_RES, MAX_RES);
    return Math.max(minAllowed, Math.min(tentative, MAX_RES));
  }

  // ===== Cooperative yielding helpers =====
  const nextFrame = () => new Promise(requestAnimationFrame);
  async function yieldOften(i, step=2000) { if (i % step === 0) await nextFrame(); }

  // ===== Async base build (fallback path only) =====
  async function buildDataBaseAtMaxResAsync(rawRows){
    let maxRes = -1;
    for (let i=0; i<rawRows.length; i++){
      try {
        const r = h3.getResolution(rawRows[i][0]);
        if (r > maxRes) maxRes = r;
      } catch {}
      await yieldOften(i, 5000);
    }
    MAX_RES = maxRes < 0 ? 0 : maxRes;

    const out = [];
    for (let i=0; i<rawRows.length; i++){
      const id = rawRows[i][0];
      const p  = rawRows[i][1];
      if (id == null || p == null) { await yieldOften(i); continue; }

      let r = -1; try { r = h3.getResolution(id); } catch {}

      if (r === MAX_RES){
        out.push([id, +p]);
      } else if (r >= 0 && r < MAX_RES){
        const kids = cellToChildrenCompat(id, MAX_RES);
        for (const k of kids) out.push([k, +p]);
      }
      await yieldOften(i);
    }
    return out;
  }

  // ===== Load, compute, then bootstrap map =====
  (async function loadAndBoot(){
    try {
      showLoading('Boris-biking...');
      const res = await fetch(FILE, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();

      if (window.Worker){
        showLoading('Checking Brakes...');
        const worker = new Worker('/assets/js/data-worker.js');
        const options = {
          smoothAt: SMOOTH_BASE_RES_ONLY,
          lo: LOW_THRESH,
          hi: HIGH_THRESH,
        };
        const workerResult = await new Promise((resolve, reject) => {
          worker.onmessage = (e) => {
            const { type } = e.data || {};
            if (type === 'progress') {
              const m = overlay?.querySelector('.msg');
              if (m) m.textContent = e.data.msg;
            } else if (type === 'done') {
              resolve(e.data.payload);
              worker.terminate();
            } else if (type === 'error') {
              reject(new Error(e.data.error));
              worker.terminate();
            }
          };
          worker.postMessage({ buf, options }, [buf]); // transfer ArrayBuffer
        });

        lastUpdatedRaw  = workerResult.meta.weather_datetime;
        lastUpdatedDate = lastUpdatedRaw ? new Date(lastUpdatedRaw) : null;
        renderHint();
        if (!window.__hintAgoTimer){ window.__hintAgoTimer = setInterval(renderHint, 60 * 1000); }

        DATA_BASE = workerResult.DATA;
        MAX_RES   = workerResult.meta.MAX_RES;
      } else {
        // Fallback: main-thread with cooperative yielding
        showLoading('Parsing data…');
        let payload;
        try { payload = await (await fetch(FILE, { cache: 'no-store' })).json(); }
        catch {
          // Use global pako if available
          const u8 = new Uint8Array(buf);
          let txt;
          try { txt = new TextDecoder().decode(pako.ungzip(u8)); }
          catch { txt = new TextDecoder().decode(u8); }
          payload = JSON.parse(txt);
        }
        const raw = (payload?.meta?.weather_datetime) ?? (payload?.weather_datetime ?? null);
        lastUpdatedRaw = raw;
        lastUpdatedDate = raw ? new Date(raw) : null;
        renderHint();
        RAW_DATA = payload.data || [];

        showLoading('Preparing dataset…');
        DATA_BASE = await buildDataBaseAtMaxResAsync(RAW_DATA);
      }

      // Warm-up for initial zoom
      const START_CENTER = [51.5074, -0.1278];
      const START_ZOOM   = 10;
      const warmRes = targetResForZoom(START_ZOOM);
      showLoading('Warming up hotspots…');
      await nextFrame();
      aggregateGloballyAtRes(warmRes);
      await nextFrame();
      const pctInit = parseFloat(hsPctSel?.value || '0.01') || 0.01;
      getHotspotSet(warmRes, pctInit);

      // Create map
      showLoading('Starting map…');
      map = L.map('map', {
        preferCanvas: true,
        worldCopyJump: true,
        minZoom: MIN_MAP_ZOOM
      }).setView(START_CENTER, START_ZOOM);

      if (L.control.fullscreen) {
        L.control.fullscreen({ position: 'topleft', title: 'Toggle fullscreen' }).addTo(map);
        map.on('enterFullscreen', () => setTimeout(() => map.invalidateSize(), 200));
        map.on('exitFullscreen',  () => setTimeout(() => map.invalidateSize(), 200));
      }

      L.tileLayer(
        'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=STADIA_KEY',
        { attribution: '&copy; OpenStreetMap &copy; Stadia Maps', maxZoom: 20, minZoom: MIN_MAP_ZOOM,
          className: 'tiles-boost'
         },
      ).addTo(map);

      layerRoot = L.layerGroup().addTo(map);
      canvasRenderer = L.canvas({ padding: 0.5 });

      map.whenReady(() => {
        requestAnimationFrame(() => {
          map.invalidateSize();
          map.setMaxBounds(L.latLngBounds([50.8, -2], [52.2, 2]));
          map.options.maxBoundsViscosity = 0.0;

          draw();
          hideLoading();

          // ==== Mobile/desktop UI mode bootstrap ====
          const applyMode = () => (isMobilePreferred() ? enterMobileMode() : exitMobileMode());
          applyMode();
          window.addEventListener('resize', applyMode);
          const mq = window.matchMedia('(hover: none), (pointer: coarse)');
          if (mq.addEventListener) mq.addEventListener('change', applyMode);
          else if (mq.addListener) mq.addListener(applyMode); // older Safari
        });
      });

      // Events
      map.on('moveend', schedule);
      map.on('zoomend', schedule);
      if (hsToggle) hsToggle.addEventListener('change', schedule);
      if (hsPctSel) hsPctSel.addEventListener('change', () => {
        hotspotPct = parseFloat(hsPctSel.value || '0.01') || 0.01;
        schedule();
      });

    } catch (e) {
      console.error('Failed to initialize:', e);
      showLoading('Failed to load data.');
    }
  })();

  // ===== Hotspots (GLOBAL, persistent across pan) =====
  function getHotspotSet(res, pct){
    let perRes = hotspotCache.get(res);
    if (!perRes){ perRes = new Map(); hotspotCache.set(res, perRes); }
    const key = `${pct.toFixed(4)}|min${HS_MIN_GLOBAL}`;
    let set = perRes.get(key);
    if (set) return set;

    const agg = aggregateGloballyAtRes(res);
    const N = agg.entries.length;
    const topN = Math.max(1, Math.max(HS_MIN_GLOBAL, Math.ceil(N * pct)));
    set = new Set();
    for (let i=0;i<Math.min(topN, N);i++){
      set.add(agg.entries[i][0]); // id
    }
    perRes.set(key, set);
    return set;
  }

  // ===== Draw logic =====
  function draw(){
    if (!map) return;

    const zoom = map.getZoom();
    const hotspotMode = !!(hsToggle && hsToggle.checked);

    if (zoom < MIN_DRAW_ZOOM){
      shapePool.forEach(l => l.remove());
      shapePool.clear();
      setBadge(hotspotMode ? `Hotspots: <b>…</b>` : `Hotspots: <b>—</b>`);
      return;
    }

    const pad = paddedBounds(map.getBounds());
    let renderRes = targetResForZoom(zoom);

    let agg, entries, inView;
    for (;;) {
      agg = aggregateGloballyAtRes(renderRes);
      entries = agg.entries;
      inView = [];
      for (let i = 0; i < entries.length; i++){
        const id = entries[i][0];
        const c = centerOf(id); if (!c) continue;
        const [lat,lng] = c;
        if (lat >= pad.getSouth() && lat <= pad.getNorth() &&
            lng >= pad.getWest()  && lng <= pad.getEast()){
          inView.push([id, entries[i][1], c, entries[i][2]]);
          if (inView.length > MAX_CELLS * 1.25) break; // quick abort
        }
      }
      // If too many for this view, step down one resolution and try again
      if (inView.length > MAX_CELLS && renderRes > MIN_H3_RES) {
        renderRes -= 1;
        continue;
      }
      break;
    }

    const pct = hsPctSel ? parseFloat(hsPctSel.value || '0.01') : 0.01;
    let hotIds = null;

    if (hotspotMode) {
      hotIds = getHotspotSet(renderRes, pct);      // GLOBAL, persistent
      setBadge(`Hotspots: <b>${hotIds.size}</b>`);
    } else {
      setBadge(`Hotspots: <b>—</b>`);
    }

    const cap = Math.min(MAX_CELLS, SAFETY_MAX_RENDER);
    let selected;
    if (hotspotMode && hotIds) {
      const hot = [], rest = [];
      for (const d of inView) (hotIds.has(d[0]) ? hot : rest).push(d);
      selected = hot.concat(rest).slice(0, cap);
    } else {
      selected = inView.slice(0, cap);
    }

    const keep = new Set(selected.map(d => d[0]));
    shapePool.forEach((layer, key) => {
      if (!keep.has(key)) { layer.remove(); shapePool.delete(key); }
    });

    if (!selected.length) return;

    // Per-resolution multiplier for current render pass
    const perResMul = resFactorFor(renderRes);

    let idx = 0;
    const step = () => {
      const lim = Math.min(idx + DRAW_CHUNK_SIZE, selected.length);
      for (; idx < lim; idx++){
        const [id, score, /*center*/_, meta] = selected[idx];

        let fill;
        if (!hotspotMode) {
          fill = colorFor(score);
        } else {
          const isHot = hotIds && hotIds.has(id);
          fill = isHot ? colorFor(score) : grayFor(score);
        }

        // Opacity = global × gradient × per-resolution
        const opacGrad = opacityGradientFor(score);
        const opac = clamp01(FILL_OPACITY * opacGrad * perResMul);

        let layer = shapePool.get(id);
        if (!layer){
          const poly = boundaryOf(id); if (!poly) continue;
          layer = L.polygon(poly, {
            renderer: canvasRenderer,
            fill: true,
            fillOpacity: opac,          // gradient * per-res * global
            stroke: true,
            color: fill,
            opacity: 0.5,               // stroke opacity (unchanged)
            weight: 0.3,
            fillColor: fill
          });

          layer.__score = score;
          layer.__meta  = meta;
          layer.on('mouseover', () => {
            const m = layer.__meta || { pMean: layer.__score, pMax: layer.__score, cnt: 1, pWeighted: layer.__score };
            const pos = layer.getBounds().getCenter();
            tip.setContent(
              `Risk Score: <b>${m.pWeighted.toFixed(3)}</b><br>` +
              `Mean: ${m.pMean.toFixed(3)} &nbsp; Max: ${m.pMax.toFixed(3)}`
            );
            tip.setLatLng(pos);
            map.openTooltip(tip);
          });
          layer.on('mouseout', () => { map.closeTooltip(tip); });

          layer.addTo(layerRoot);
          shapePool.set(id, layer);
        } else {
          layer.setStyle({
            fillColor: fill,
            color: fill,
            fillOpacity: opac          // update per draw
          });
          layer.__score = score;
          layer.__meta  = meta;
          if (!layer._map) layer.addTo(layerRoot);
        }
      }
      if (idx < selected.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ===== Mobile Menu (hamburger) =====
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
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  }

  function setPanelOpen(open){
    panelOpen = !!open;
    if (!panel) return;
    panel.classList.toggle('mobile-hidden', !panelOpen);
    if (menuBtn) menuBtn.setAttribute('aria-expanded', String(panelOpen));
  }

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

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setPanelOpen(!panelOpen);
    });

    window.addEventListener('pointerdown', handleGlobalPointer, true);
    window.addEventListener('click', handleGlobalPointer, true);
    window.addEventListener('touchstart', handleGlobalPointer, { capture: true, passive: true });

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
}
