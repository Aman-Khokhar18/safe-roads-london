/* Web Worker that prepares the dataset off the main thread:
 * - ungzip / parse JSON
 * - expand cells to MAX_RES
 * - optional smoothing (threshold-based)
 */
self.importScripts('https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js');
self.importScripts('https://unpkg.com/h3-js@4.1.0/dist/h3-js.umd.js');

const clamp = (v,a,b)=>Math.max(a, Math.min(b, v));
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

function cellToChildrenCompat(id, res){
  try {
    if (typeof h3.cellToChildren === 'function') return h3.cellToChildren(id, res);
    if (typeof h3.h3ToChildren === 'function')   return h3.h3ToChildren(id, res);
  } catch (e) {}
  return [];
}

self.onmessage = async (e) => {
  const { buf, options } = e.data || {};
  try {
    let txt;
    try { txt = new TextDecoder().decode(pako.ungzip(new Uint8Array(buf))); }
    catch { txt = new TextDecoder().decode(new Uint8Array(buf)); }
    const payload = JSON.parse(txt);

    const rawRows = payload.data || [];
    // Find MAX_RES and expand to it
    let maxRes = -1;
    for (let i=0;i<rawRows.length;i++){
      try {
        const r = h3.getResolution(rawRows[i][0]);
        if (r > maxRes) maxRes = r;
      } catch {}
      if (i % 5000 === 0) self.postMessage({ type:'progress', msg:`Queuing...` });
    }
    const MAX_RES = Math.max(0, maxRes);

    const DATA_BASE = [];
    for (let i=0;i<rawRows.length;i++){
      const id = rawRows[i][0], p = rawRows[i][1];
      if (id == null || p == null) continue;
      let r = -1; try { r = h3.getResolution(id); } catch {}
      if (r === MAX_RES){
        DATA_BASE.push([id, +p]);
      } else if (r >= 0 && r < MAX_RES){
        const kids = cellToChildrenCompat(id, MAX_RES);
        for (const k of kids) DATA_BASE.push([k, +p]);
      }
      if (i % 5000 === 0) self.postMessage({ type:'progress', msg:`Watching Cyclist Jumping Redlights...` });
    }

    // Optional smoothing at base
    let DATA = DATA_BASE;
    if (options?.smoothAt === MAX_RES){
      // median dedupe
      const bins = new Map();
      for (const [h,p] of DATA_BASE){
        let arr = bins.get(h); if (!arr){ arr=[]; bins.set(h, arr); }
        arr.push(+p);
      }
      const perH3 = new Map();
      bins.forEach((arr,h)=>{
        arr.sort((a,b)=>a-b);
        const m = arr.length&1 ? arr[(arr.length-1)/2] : 0.5*(arr[arr.length/2-1]+arr[arr.length/2]);
        perH3.set(h, m);
      });
      const allP = Array.from(perH3.values());
      const globalMedian = pctls(allP, [0.5])[0];
      const lo = options?.lo ?? 0.05, hi = options?.hi ?? 0.95;
      const isOut = p => (p < lo) || (p > hi);

      const smoothed = new Map();
      let i=0;
      perH3.forEach((p,h)=>{
        if (!isOut(p)) { smoothed.set(h,p); }
        else {
          // For simplicity we snap outliers to global median; (neighbor-average could be added if needed)
          smoothed.set(h, globalMedian);
        }
        i++; if (i % 5000 === 0) self.postMessage({ type:'progress', msg:`Deliveroo-dodging...` });
      });
      DATA = Array.from(smoothed, ([h,p]) => [h,p]);
    }

    self.postMessage({
      type: 'done',
      payload: {
        meta: {
          weather_datetime: payload?.meta?.weather_datetime ?? payload?.weather_datetime ?? null,
          MAX_RES
        },
        DATA
      }
    });
  } catch (err){
    self.postMessage({ type: 'error', error: String(err?.message || err) });
  }
};
