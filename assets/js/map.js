// Run after DOM + deferred libs are ready
window.addEventListener('DOMContentLoaded', init);

function init(){
  // ======== TUNABLES (easy to tweak later) ========
  const FILE = '/assets/backend/h3_payload.json.gz';    // {"data":[[h3, p], ...], "meta": {"weather_datetime": "..."}}
  const MIN_DRAW_ZOOM   = 10;           // draw only at/above this zoom
  const MIN_MAP_ZOOM    = 10;           // hard limit: cannot zoom out beyond this
  const FILL_OPACITY    = 0.30;
  const DRAW_CHUNK_SIZE = 1500;
  const VIEW_PAD        = 0.12;
  const SAFETY_MAX_RENDER = 80000;
  const MAX_CELLS       = 5000;         // fixed cap on how many cells to render

  // Color gradient anchors (p in [0,1])
  const GRAD_KNOTS = {
    mid:  0.40,   // green → yellow up to here
    high: 0.80    // yellow → red up to here; clamp red above this
  };
  const GRAD_COLORS = {
    low:  { r:0x2a, g:0x8f, b:0x5a }, // #2a8f5a  (p = 0.00)
    mid:  { r:0xff, g:0xd4, b:0x00 }, // #ffd400  (p = mid)
    high: { r:0xff, g:0x00, b:0x33 }  // #ff0033  (p = high and above)
  };
  // ================================================

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
  const thrEl = document.getElementById('thr');
  const thrVal = document.getElementById('thrVal');
  const badge = document.getElementById('badge');
  const panel = document.getElementById('panel');
  const hintEl = document.querySelector('.hint');        // shows "Last updated: ..."

  // prevent map drag/scroll while using the panel, but keep inputs working
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);

  // Start with current min probability setting
  thrEl.value = thrEl.value || 0.0;
  thrVal.textContent = (+thrEl.value).toFixed(2);

  const onSliderChange = () => {
    thrVal.textContent = (+thrEl.value).toFixed(2);
    schedule(); // recompute aggregation with new threshold
  };
  thrEl.addEventListener('input', onSliderChange);
  thrEl.addEventListener('change', onSliderChange);

  function setBadge(thr, shown, res){
    badge.innerHTML = `p ≥ <b>${thr.toFixed(2)}</b> &nbsp; Shown: <b>${shown}</b>${res!=null ? ` &nbsp; res: <b>${res}</b>` : ''}`;
  }

  // ===== Hint formatting (main text exact; lightweight "ago") =====
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
  let lastUpdatedRaw = null;    // exact string from payload
  let lastUpdatedDate = null;   // parsed Date only for "ago"

  function renderHint(){
    if (!hintEl) return;
    const main = formatYMD_HHMM(lastUpdatedRaw);
    let ago = '';
    let cls = 'fresh';
    if (lastUpdatedDate instanceof Date && !isNaN(lastUpdatedDate)){
      const diff = Date.now() - lastUpdatedDate.getTime();
      ago = ` <span class="ago">(${formatAgoMs(diff)})</span>`;
      if (diff > 2 * 60 * 60 * 1000) cls = 'very-stale';      // > 2h
      else if (diff > 30 * 60 * 1000) cls = 'stale';          // > 30m
    }
    hintEl.classList.remove('fresh', 'stale', 'very-stale');
    hintEl.classList.add(cls);
    hintEl.innerHTML = `Last updated: ${main}${ago}`;
  }

  // ===== Gradient helpers (0 → mid → high) =====
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const mix = (a,b,t)=>({
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  });

  // Piecewise interpolation:
  // [0 .. mid]   : low → mid
  // (mid .. high]: mid → high
  //  > high      : clamp to high
  function colorFor(p){
    const x = clamp01(p);
    const k1 = GRAD_KNOTS.mid;
    const k2 = GRAD_KNOTS.high;
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

  // ===== Data & caches =====
  let DATA = []; // [[h3, p], ...]
  const centerCache = new Map();
  const boundaryCache = new Map();
  const shapePool = new Map();
  const tip = L.tooltip({ sticky: true });
  let lastLayer = null;

  // H3 resolution
  let BASE_RES = null; // detected from data

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

  // --------- Plain-mean aggregation at coarser resolution ----------
  // Returns Map(parentId -> {sum, cnt})
  function aggregateAtRes(res, thr) {
    const mapAgg = new Map();
    for (let i = 0; i < DATA.length; i++) {
      const id = DATA[i][0];
      const p  = DATA[i][1];
      if (p < thr) continue; // drop cells below slider before averaging
      let parentId;
      try { parentId = h3.cellToParent(id, res); } catch { continue; }
      let a = mapAgg.get(parentId);
      if (!a) { a = { sum: 0, cnt: 0 }; mapAgg.set(parentId, a); }
      a.sum += p; a.cnt += 1;
    }
    return mapAgg;
  }

  // Yield rows to render at a resolution: [id, pMean, center]
  // NOTE: applies threshold BEFORE aggregation so means are re-computed.
  function rowsAtResolution(res, padBounds, thr) {
    const out = [];
    if (res >= BASE_RES) {
      for (let i=0; i<DATA.length; i++) {
        const id = DATA[i][0];
        const p  = DATA[i][1];
        if (p < thr) continue; // drop low-prob cells at base res
        const c  = centerOf(id);
        if (!c) continue;
        if (!padBounds.contains(L.latLng(c[0], c[1]))) continue;
        out.push([id, p, c]);
      }
    } else {
      const agg = aggregateAtRes(res, thr);
      for (const [parentId, a] of agg.entries()) {
        if (a.cnt === 0) continue;                 // no survivors post-threshold
        const pMean = a.sum / a.cnt;               // *** plain mean ***
        const c = centerOf(parentId);
        if (!c) continue;
        if (!padBounds.contains(L.latLng(c[0], c[1]))) continue;
        out.push([parentId, pMean, c]);
      }
    }
    return out;
  }

  // ===== Load payload =====
  (async function load(){
    // Bust cache to ensure we get the latest meta datetime
    const res = await fetch(FILE, { cache: 'no-store' });
    const buf = new Uint8Array(await res.arrayBuffer());
    const txt = new TextDecoder().decode(pako.ungzip(buf));
    const payload = JSON.parse(txt); // {data:..., meta:{weather_datetime:"..."}}

    // Pull datetime; display exact + compute "ago"
    const raw = (payload?.meta?.weather_datetime) ?? (payload?.weather_datetime ?? null);
    lastUpdatedRaw = raw;
    lastUpdatedDate = raw ? new Date(raw) : null;  // only for "ago"
    renderHint();

    // Keep the "(ago)" fresh without refetching
    if (!window.__hintAgoTimer){
      window.__hintAgoTimer = setInterval(renderHint, 60 * 1000);
    }

    DATA = payload.data || [];

    // Detect base H3 resolution from first valid cell
    for (let i = 0; i < DATA.length; i++) {
      const id = DATA[i][0];
      try { BASE_RES = h3.getResolution(id); break; } catch {}
    }

    map.on('moveend', schedule);
    map.on('zoomend', schedule);
    schedule(); // initial draw
  })();

  // ===== Draw logic =====
  function draw(){
    const zoom = map.getZoom();
    if (zoom < MIN_DRAW_ZOOM){
      shapePool.forEach(l => l.remove());
      setBadge(+thrEl.value, 0, null);
      return;
    }

    const thr = +thrEl.value;
    const pad = paddedBounds(map.getBounds());
    const res = targetResForZoom(zoom);

    // Candidates at current render resolution (threshold applied inside)
    const inView = rowsAtResolution(res, pad, thr);

    // Sort desc by p
    inView.sort((a,b)=> b[1] - a[1]);

    // Cap rendered cells
    const selected = inView.slice(0, Math.min(MAX_CELLS, SAFETY_MAX_RENDER));

    // Remove stale layers
    const keep = new Set(selected.map(d => d[0]));
    shapePool.forEach((layer, key) => {
      if (!keep.has(key)) {
        layer.remove();
        shapePool.delete(key);
      }
    });

    if (!selected.length){ setBadge(thr, 0, res); return; }

    // Chunked draw
    let shown = 0, idx = 0;
    const step = () => {
      const lim = Math.min(idx + DRAW_CHUNK_SIZE, selected.length);
      for (; idx < lim; idx++){
        const [id, p] = selected[idx];
        const color = colorFor(p);

        let layer = shapePool.get(id);
        if (!layer){
          const poly = boundaryOf(id); if (!poly) continue;
          layer = L.polygon(poly, {
            renderer: canvasRenderer,
            fill: true,
            fillOpacity: FILL_OPACITY,
            fillColor: color,
            stroke: true,
            color: color,
            opacity: 0.5,
            weight: 0.3
          });

          // keep tooltip probability current for any res
          layer.__p = p;
          layer.on('mouseover', () => {
            const pos = layer.getBounds().getCenter();
            tip.setContent(`Probability: ${Number(layer.__p).toFixed(3)}`);
            tip.setLatLng(pos);
            map.openTooltip(tip);
            lastLayer = layer;
          });
          layer.on('mouseout', () => { if (lastLayer === layer) map.closeTooltip(tip); });

          layer.addTo(layerRoot);
          shapePool.set(id, layer);
        } else {
          layer.setStyle({ fillColor: color, color: color });
          layer.__p = p; // update live probability at current res
          if (!layer._map) layer.addTo(layerRoot);
        }
        shown++;
      }
      setBadge(thr, shown, res);
      if (idx < selected.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
