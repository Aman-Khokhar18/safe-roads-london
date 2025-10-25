// Run after DOM + deferred libs are ready
window.addEventListener('DOMContentLoaded', init);

function init(){
  // ===== Config =====
  const FILE = 'h3_payload.json.gz';    // {"data":[[h3, p], ...]} with p ∈ [0,1]
  const MIN_DRAW_ZOOM   = 7;
  const CIRCLE_ZOOM_MAX = 12;
  const CIRCLE_PIX_R    = 6;
  const FILL_OPACITY    = 0.30;
  const DRAW_CHUNK_SIZE = 1500;
  const VIEW_PAD        = 0.12;
  const SAFETY_MAX_RENDER = 80000;

  // ===== Map setup =====
  const map = L.map('map', { preferCanvas: true, worldCopyJump: true }).setView([20, 78], 5);
  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; OpenStreetMap & CARTO', maxZoom: 20 }
  ).addTo(map);
  const layerRoot = L.layerGroup().addTo(map);
  const canvasRenderer = L.canvas({ padding: 0.5 });

  // ===== UI =====
  const thrEl = document.getElementById('thr');
  const thrVal = document.getElementById('thrVal');
  const minEl = document.getElementById('mincells');
  const minVal = document.getElementById('mincellsVal');
  const badge = document.getElementById('badge');
  const panel = document.getElementById('panel');

  // prevent map drag/scroll while using the panel, but keep inputs working
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);

  const onSliderChange = () => { thrVal.textContent = (+thrEl.value).toFixed(2); minVal.textContent = minEl.value; schedule(); };
  thrEl.addEventListener('input', onSliderChange);
  thrEl.addEventListener('change', onSliderChange);
  minEl.addEventListener('input', onSliderChange);
  minEl.addEventListener('change', onSliderChange);

  function setBadge(thr, shown){ badge.innerHTML = `p ≥ <b>${thr.toFixed(2)}</b> &nbsp; Shown: <b>${shown}</b>`; }

// ===== Color mapping: 0→green → 0.5→yellow → 1.0→red (continuous) =====
const GREEN = {r:0x00, g:0xa6, b:0x51};
const YELLW = {r:0xff, g:0xd4, b:0x00};
const RED   = {r:0xff, g:0x00, b:0x33};
const clamp01 = v => Math.max(0, Math.min(1, v));
const mix = (a,b,t)=>({ r:Math.round(a.r+(b.r-a.r)*t), g:Math.round(a.g+(b.g-a.g)*t), b:Math.round(a.b+(b.b-a.b)*t) });

function colorFor(p){
  const x = clamp01(p);
  if (x <= 0.5) {
    // 0..0.5: green -> yellow
    const t = x / 0.5;
    const c = mix(GREEN, YELLW, t);
    return `rgb(${c.r},${c.g},${c.b})`;
  } else {
    // 0.5..1: yellow -> red
    const t = (x - 0.5) / 0.5;
    const c = mix(YELLW, RED, t);
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

  // ===== Load payload =====
  (async function load(){
    const res = await fetch(FILE);
    const buf = new Uint8Array(await res.arrayBuffer());
    const txt = new TextDecoder().decode(pako.ungzip(buf)); // works even without Content-Encoding
    const payload = JSON.parse(txt);                         // {data:[[h3,p],...]}
    DATA = payload.data || [];

    // Fit initial bounds from a sample
    if (DATA.length){
      let S=90,N=-90,W=180,E=-180;
      const n = Math.min(5000, DATA.length);
      for (let i=0;i<n;i++){
        const [id] = DATA[i];
        try{
          const [lat,lng] = h3.cellToLatLng(id);
          if (lat<S) S=lat; if (lat>N) N=lat; if (lng<W) W=lng; if (lng>E) E=lng;
        }catch{}
      }
      if (N>S && E>W) map.fitBounds([[S,W],[N,E]], { padding: [20,20] });
    }

    map.on('moveend', schedule);
    map.on('zoomend', schedule);
    schedule(); // initial draw
  })();

  // ===== Draw logic (probability threshold + cap max cells) =====
  function draw(){
    if (map.getZoom() < MIN_DRAW_ZOOM){
      shapePool.forEach(l => l.remove());
      setBadge(+thrEl.value, 0);
      return;
    }
    const thr = +thrEl.value;
    const maxCells = +minEl.value;  // (formerly "mincells") now acts as a cap
    const useCircles = map.getZoom() <= CIRCLE_ZOOM_MAX;
    const pad = paddedBounds(map.getBounds());

    // Filter candidates in view
    const inView = [];
    for (let i=0;i<DATA.length;i++){
      const id = DATA[i][0];
      const p  = DATA[i][1];
      const c  = centerOf(id);
      if (!c) continue;
      if (!pad.contains(L.latLng(c[0], c[1]))) continue;
      inView.push([id, p, c]);
    }

    // Sort by probability (desc)
    inView.sort((a,b)=> b[1] - a[1]);

    // Strict threshold (do NOT relax below thr)
    const passing = [];
    for (let i=0; i<inView.length; i++){
      const row = inView[i];
      if (row[1] >= thr) passing.push(row);
      if (passing.length >= SAFETY_MAX_RENDER) break;
    }

    // Cap the number of rendered cells
    const selected = passing.slice(0, Math.min(maxCells, SAFETY_MAX_RENDER));

    // Remove stale layers
    const keep = new Set(selected.map(d => d[0]));
    shapePool.forEach((layer, key) => { if (!keep.has(key)) layer.remove(); });

    if (!selected.length){ setBadge(thr, 0); return; }

    // Chunked drawing (unchanged except uses `selected`)
    let shown = 0, idx = 0;
    const step = () => {
      const lim = Math.min(idx + DRAW_CHUNK_SIZE, selected.length);
      for (; idx < lim; idx++){
        const [id, p, center] = selected[idx];
        const color = colorFor(p);
        let layer = shapePool.get(id);
        if (!layer){
          if (useCircles){
            layer = L.circleMarker(center, {
              renderer: canvasRenderer, radius: CIRCLE_PIX_R,
              fill: true, fillOpacity: FILL_OPACITY, fillColor: color, stroke: false
            });
          } else {
            const poly = boundaryOf(id); if(!poly) continue;
            layer = L.polygon(poly, {
              renderer: canvasRenderer,
              fill: true, fillOpacity: FILL_OPACITY, fillColor: color, stroke: false
            });
          }
          layer.on('mouseover', () => {
            const pos = layer.getBounds ? layer.getBounds().getCenter() : layer.getLatLng();
            tip.setContent(`H3: ${id}<br>p: ${p.toFixed(3)}`);
            tip.setLatLng(pos);
            map.openTooltip(tip);
            lastLayer = layer;
          });
          layer.on('mouseout', () => { if (lastLayer === layer) map.closeTooltip(tip); });

          layer.addTo(layerRoot);
          shapePool.set(id, layer);
        } else {
          if (useCircles && layer.setLatLng) layer.setLatLng(center);
          layer.setStyle({ fillColor: color });
          if (!layer._map) layer.addTo(layerRoot);
        }
        shown++;
      }
      setBadge(thr, shown);
      if (idx < selected.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
