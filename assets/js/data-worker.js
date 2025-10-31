/* Web Worker that prepares the dataset off the main thread:
 * - ungzip / parse JSON
 * - expand cells to MAX_RES
 * - optional smoothing (threshold-based)
 */
self.importScripts('https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js');
self.importScripts('https://unpkg.com/h3-js@4.1.0/dist/h3-js.umd.js');

const clamp = (v,a,b)=>Math.max(a, Math.min(b, v));
function pctls(arr, qs){
  // typed array + numeric comparator for Safari
  const a = Float64Array.from(arr);
  Array.prototype.sort.call(a, (x,y)=>x-y);
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

// Safely detect gzip (0x1f 0x8b)
function looksGzip(u8){
  return u8 && u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
}
function decodeU8(u8){ return new TextDecoder().decode(u8); }

self.onmessage = async function (e) {
  const msg = e && e.data ? e.data : {};
  const buf = msg.buf;
  const options = msg.options || {};
  try {
    const u8 = new Uint8Array(buf || 0);
    let txt;
    if (looksGzip(u8)) {
      try { txt = decodeU8(pako.ungzip(u8)); }
      catch (err) { txt = decodeU8(u8); }
    } else {
      txt = decodeU8(u8);
    }
    const payload = JSON.parse(txt);

    const rawRows = (payload && payload.data) ? payload.data : [];
    // Find MAX_RES and expand to it
    let maxRes = -1;
    for (let i=0;i<rawRows.length;i++){
      try {
        const r = h3.getResolution(rawRows[i][0]);
        if (r > maxRes) maxRes = r;
      } catch (e) {}
      if (i % 5000 === 0) self.postMessage({ type:'progress', msg:`Queuing...` });
    }
    const MAX_RES = Math.max(0, maxRes);

    const DATA_BASE = [];
    for (let i=0;i<rawRows.length;i++){
      const id = rawRows[i][0], p = rawRows[i][1];
      if (id == null || p == null) continue;
      let r = -1; try { r = h3.getResolution(id); } catch (e) {}
      if (r === MAX_RES){
        DATA_BASE.push([id, +p]);
      } else if (r >= 0 && r < MAX_RES){
        const kids = cellToChildrenCompat(id, MAX_RES);
        for (let k=0;k<kids.length;k++) DATA_BASE.push([kids[k], +p]);
      }
      if (i % 5000 === 0) self.postMessage({ type:'progress', msg:`Watching Cyclist Jump Redlights...` });
    }

    // Optional smoothing at base
    let DATA = DATA_BASE;
    if ((options.smoothAt !== undefined && options.smoothAt !== null) && options.smoothAt === MAX_RES){
      // median dedupe
      const bins = new Map();
      for (let i=0;i<DATA_BASE.length;i++){
        const h = DATA_BASE[i][0], p = DATA_BASE[i][1];
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
      const lo = (options.lo !== undefined && options.lo !== null) ? options.lo : 0.05;
      const hi = (options.hi !== undefined && options.hi !== null) ? options.hi : 0.95;
      const isOut = function(p){ return (p < lo) || (p > hi); };

      const smoothed = new Map();
      let i=0;
      perH3.forEach((p,h)=>{
        smoothed.set(h, isOut(p) ? globalMedian : p);
        i++; if (i % 5000 === 0) self.postMessage({ type:'progress', msg:`Dodging E-bikes...` });
      });
      DATA = Array.from(smoothed, function(e) { return [e[0], e[1]]; });
    }

    self.postMessage({
      type: 'done',
      payload: {
        meta: {
          weather_datetime:
            (payload && payload.meta && payload.meta.weather_datetime) ?
              payload.meta.weather_datetime :
              ((payload && payload.weather_datetime) ? payload.weather_datetime : null),
          MAX_RES: MAX_RES
        },
        DATA: DATA
      }
    });
  } catch (err){
    self.postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
};
