// /assets/js/collisions-widget.js
(function () {
  const root = document.querySelector('.collisions-widget');
  if (!root) return;

  const dataUrl   = root.getAttribute('data-url')   || 'assets/backend/borough_collisions_records.json';
  const titleText = root.getAttribute('data-title') || 'Borough collisions';

  const svg = d3.select(root).select('#cw-chart');

  // ----- Ensure basic blocks exist (defensive) -----
  if (!root.querySelector('.cw-title')) {
    const title = document.createElement('div');
    title.className = 'cw-title';
    title.textContent = titleText;
    root.appendChild(title);
  }
  if (!root.querySelector('.cw-totals')) {
    const t = document.createElement('div');
    t.className = 'cw-totals';
    t.innerHTML = `
      <div class="cw-totals-label">Total</div>
      <div id="cw-total" class="cw-total">—</div>
      <div id="cw-total-delta" class="cw-total-delta">—</div>
    `;
    root.appendChild(t);
  }
  if (!root.querySelector('.cw-controls')) {
    const c = document.createElement('div');
    c.className = 'cw-controls';
    c.innerHTML = `
      <div class="cw-sort-wrap">
        <label class="cw-sort-label" for="cw-sort">Sort</label>
        <select id="cw-sort">
          <option value="current_desc">Current ↓</option>
          <option value="current_asc">Current ↑</option>
          <option value="delta_desc">Δ ↓</option>
          <option value="delta_asc">Δ ↑</option>
          <option value="name_asc">Name A–Z</option>
        </select>
      </div>
    `;
    root.appendChild(c);
  }
  if (!root.querySelector('.cw-legend')) {
    const l = document.createElement('div');
    l.className = 'cw-legend';
    l.innerHTML = `
      <span class="legend-item"><span class="swatch swatch-current"></span> Current</span>
      <span class="legend-item"><span class="swatch swatch-prev"></span> Previous</span>
      <span class="legend-item legend-delta-up">▲ Up</span>
      <span class="legend-item legend-delta-down">▼ Down</span>
    `;
    root.appendChild(l);
  }
  if (!root.querySelector('.cw-years')) {
    const y = document.createElement('div');
    y.className = 'cw-years';
    y.innerHTML = `
      <div class="cw-years-title">Year</div>
      <div id="cw-years-chips" class="cw-years-chips"></div>
    `;
    root.appendChild(y);
  }

  // ----- DOM refs (pre-header wrap) -----
  const titleEl    = root.querySelector('.cw-title');
  const totalsEl   = root.querySelector('.cw-totals');
  const controlsEl = root.querySelector('.cw-controls');
  const legendEl   = root.querySelector('.cw-legend');
  const yearsBoxEl = root.querySelector('.cw-years');
  const chipsWrap  = root.querySelector('#cw-years-chips');
  const sortSel    = root.querySelector('#cw-sort');

  // Header mask (visual continuity above chart)
  const headerMaskEl  = root.querySelector('.cw-header-mask') || (() => {
    const el = document.createElement('div');
    el.className = 'cw-header-mask';
    el.setAttribute('aria-hidden','true');
    root.prepend(el);
    return el;
  })();

  // ===== Wrap all header pieces into a single responsive container =====
  const header = root.querySelector('.cw-header') || (() => {
    const h = document.createElement('div');
    h.className = 'cw-header';
    root.prepend(h);
    return h;
  })();

  const row1 = document.createElement('div'); row1.className = 'cw-row cw-row-1';
  const row2 = document.createElement('div'); row2.className = 'cw-row cw-row-2';
  const row3 = document.createElement('div'); row3.className = 'cw-row cw-row-3';

  row1.appendChild(totalsEl);
  row1.appendChild(titleEl);
  row1.appendChild(controlsEl);
  row2.appendChild(legendEl);
  row3.appendChild(yearsBoxEl);

  header.appendChild(row1);
  header.appendChild(row2);
  header.appendChild(row3);

  // ----- D3 scaffolding -----
  const g        = svg.append('g');
  const gx       = g.append('g').attr('class', 'axis axis--x');
  const gy       = g.append('g').attr('class', 'axis axis--y');
  const xgridG   = g.append('g').attr('class', 'grid grid--x');
  const ygridG   = g.append('g').attr('class', 'grid grid--y');
  const prevBarsG= g.append('g');
  const barsG    = g.append('g');
  const labelsG  = g.append('g');

  const x = d3.scaleLinear();
  const y = d3.scaleBand().padding(0.12);

  // ----- Layout & timing -----
  const RIGHT_PAD_FRAC = 0.06; // 6% right pad
  const RIGHT_PAD_MIN  = 48;
  const DELTA_PAD      = 12;
  const DESKTOP_ROW_H  = 42;
  const MOBILE_ROW_H   = 36;
  const DUR            = 700;
  const EASE           = d3.easeCubicInOut;

  function isMobile(){ return (window.innerWidth || 1000) <= 640; }
  function rowH(){ return isMobile() ? MOBILE_ROW_H : DESKTOP_ROW_H; }

  // --- micro-debounce to coalesce rapid events ---
  function rafDebounce(fn){
    let raf = 0;
    return (...args) => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; fn(...args); });
    };
  }

  // --- measuring + wrapping helpers (for y-axis) ---
  const ctx = document.createElement('canvas').getContext('2d');
  function setMeasureFont(px) {
    ctx.font = `${px}px "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif`;
  }
  // Wrap to at most two lines; second line ellipsized if needed
  function wrapToTwoLines(text, fontPx, maxWidth){
    setMeasureFont(fontPx);
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    const measure = (s) => ctx.measureText(s).width;

    for (let i=0; i<words.length; i++){
      const next = line ? line + ' ' + words[i] : words[i];
      if (measure(next) <= maxWidth){
        line = next;
      } else {
        if (line) lines.push(line);
        else lines.push(words[i]);
        line = '';
        if (lines.length === 2) break;
        if (measure(words[i]) <= maxWidth) line = words[i];
        else {
          let w = words[i];
          while (w.length > 1 && measure(w + '…') > maxWidth) w = w.slice(0, -1);
          lines[lines.length-1] = w + '…';
          line = '';
        }
      }
    }
    if (lines.length < 2 && line) lines.push(line);
    if (words.length && lines.length === 2){
      while (ctx.measureText(lines[1] + '…').width > maxWidth && lines[1].length > 1){
        lines[1] = lines[1].slice(0, -1);
      }
      if (lines[1] && lines[1].slice(-1) !== '…' && lines.join(' ').trim() !== text.trim()){
        lines[1] += '…';
      }
    }
    const width = Math.max(0, ...lines.map(l => ctx.measureText(l).width));
    return { lines: lines.slice(0,2), width };
  }

  // Container width
  function containerW() {
    let w = root.clientWidth || root.offsetWidth || 0;
    if (!w && root.parentElement) w = root.parentElement.clientWidth || 0;
    return Math.max(320, w || 640);
  }

  // Chart top margin = header height + small gap (tight)
  const CHART_TOP = 30; // 8–12px is fine
function computeTopMargin() {
  return CHART_TOP;
}


  // Margin policy: reduce left first, then shrink y-axis font 13→11 if needed
  function targetLeftMargin(){
    return isMobile() ? 50 : 100;
  }

  let margin = { top: 110, right: 28, bottom: 24, left: targetLeftMargin() };

  function resize(nRows) {
    margin.top = computeTopMargin();

    if (headerMaskEl) {
      headerMaskEl.style.height = `0px`;
    }


    const width  = containerW();
    const innerW = width - margin.left - margin.right;
    const innerH = Math.max(1, nRows) * rowH();
    const height = innerH + margin.top + margin.bottom;

    svg.attr('width', width).attr('height', height)
       .attr('viewBox', `0 0 ${width} ${height}`)
       .attr('preserveAspectRatio', 'xMinYMin meet');

    g.attr('transform', `translate(${margin.left},${margin.top})`);
    gx.attr('transform', `translate(0,0)`);
    gy.attr('transform', `translate(0,0)`);

    return { innerW, innerH, width, height };
  }

  // -------- Responsive axes style helpers --------
  // X-axis (numbers)
  function chooseXAxisStyle(innerW){
    const fontPx = innerW < 420 ? 10 : (innerW < 640 ? 11 : 12);
    const ticks  = innerW < 420 ? 4  : (innerW < 640 ? 5  : 6);
    const fmt    = innerW < 420 ? d3.format('~s') : d3.format(',');
    const pad    = innerW < 480 ? 8 : 10;
    return { fontPx, ticks, fmt, pad };
  }
  // Y-axis tick padding (space between tick text & axis)
  function chooseYAxisStyle(innerW){
    const pad = innerW < 420 ? 8 : (innerW < 640 ? 10 : 12);
    return { pad };
  }
  // Value label padding responsive
  function valuePadFor(innerW){
    return innerW < 420 ? 8 : 10;
  }

  function updateAxes({ xMax, yDomain, innerW, innerH, yTickPad }) {
    const rightPad = Math.max(RIGHT_PAD_MIN, Math.round(innerW * RIGHT_PAD_FRAC));
    const drawW    = Math.max(1, innerW - rightPad);

    const HEADROOM = 0.02;
    x.domain([0, xMax * (1 + HEADROOM)]).range([0, drawW]).clamp(true);
    y.domain(yDomain).range([0, innerH]);

    const xa = chooseXAxisStyle(innerW);
    root.style.setProperty('--x-axis-font', `${xa.fontPx}px`);

    gx.transition().duration(DUR).ease(EASE)
      .call(d3.axisTop(x).ticks(xa.ticks).tickFormat(xa.fmt).tickPadding(xa.pad));
    gx.selectAll('text').style('font-size', `${xa.fontPx}px`);

    // y-axis with extra tick padding so labels don't hug bars/axis
    gy.call(d3.axisLeft(y).tickSizeOuter(0).tickPadding(yTickPad || 12, 14));

    xgridG
      .attr('transform', 'translate(0,0)')
      .transition().duration(DUR).ease(EASE)
      .call(d3.axisTop(x).ticks(xa.ticks).tickSize(-innerH).tickFormat(() => ''));

    ygridG.call(d3.axisLeft(y).tickSize(-innerW).tickFormat(() => ''));
  }

  // Wrap y-axis tick labels into two lines (tspan)
 function applyTickWrap(axisG, fontPx, maxWidth){
  axisG.selectAll('.tick text').each(function(d){
    const sel = d3.select(this);

    // keep whatever the axis set (negative x = padding)
    const padX   = +sel.attr('x') || 0;
    const anchor = sel.attr('text-anchor') || 'end';

    const name = String(d ?? sel.text());
    const { lines } = wrapToTwoLines(name, fontPx, maxWidth);

    sel.text(null);

    lines.forEach((line, i) => {
      sel.append('tspan')
        .text(line)
        .attr('x', padX)                 // <-- preserve padding
        .attr('dy', i === 0 ? '0' : '1.2em');
    });

    // keep anchor and size
    sel.attr('text-anchor', anchor)
       .attr('dy', lines.length > 1 ? '-0.6em' : '0.35em')
       .style('font-size', `${fontPx}px`);
  });
}


  // Fit policy (left margin first, then font 13→11)
  function chooseAxisFontAndMargin(names, yPad){
  // start from a slightly larger mobile baseline
  let left   = isMobile() ? 90 : 100;        // baseline left margin (was 50 on mobile)
  let fontPx = 12;                           // try 12 → 11
  const MIN_FONT = 11;
  const PAD = (yPad || 0);

  while (true) {
    const avail  = Math.max(24, left - (20 + PAD)); // space available for label text
    // measure widest wrapped label with current font and avail width
    let widest = 0;
    for (const n of names) {
      const { width } = wrapToTwoLines(n, fontPx, avail);
      if (width > widest) widest = width;
    }

    if (widest <= avail) {
      // fits: commit margin + fonts
      margin.left = left;
      root.style.setProperty('--axis-font',  `${fontPx}px`);
      root.style.setProperty('--label-font', `${Math.max(11, Math.min(12, fontPx - 1))}px`);
      root.style.setProperty('--delta-font', `${Math.max(11, Math.min(12, fontPx - 1))}px`);
      return { fontPx, avail };
    }

    // try smaller font first
    if (fontPx > MIN_FONT) {
      fontPx -= 1;
      continue;
    }

    // still doesn't fit at min font → widen left margin just enough (+buffer)
    const buffer = 8;
    const maxLeft = isMobile() ? 140 : 200;  // sane clamp so bars still have room
    const needed  = (widest - avail) + buffer;
    const next    = Math.min(left + needed, maxLeft);

    if (next === left) {
      // can't grow further; accept and return (will ellipsize)
      margin.left = left;
      root.style.setProperty('--axis-font',  `${fontPx}px`);
      root.style.setProperty('--label-font', `${Math.max(11, Math.min(12, fontPx - 1))}px`);
      root.style.setProperty('--delta-font', `${Math.max(11, Math.min(12, fontPx - 1))}px`);
      return { fontPx, avail };
    }
    left = next;
  }
}


  // smart value label placement (inside if space, else to the right)
  function valueLabelPos(d){
    const w = x(d.collisions);
    const innerW = (svg.node()?.clientWidth || 800) - margin.left - margin.right;
    const pad = valuePadFor(innerW);
    const inside = w >= (pad + 24);
    return {
      x: inside ? Math.max(0, w - pad) : (w + 6),
      anchor: inside ? 'end' : 'start'
    };
  }

  // ----- Sorting -----
  let currentSort = 'current_desc';
  function sortRows(rows) {
    switch (currentSort) {
      case 'delta_desc':   rows.sort((a, b) => d3.descending(a.delta, b.delta)); break;
      case 'delta_asc':    rows.sort((a, b) => d3.ascending(a.delta, b.delta));  break;
      case 'name_asc':     rows.sort((a, b) => d3.ascending(a.borough, b.borough)); break;
      case 'current_asc':  rows.sort((a, b) => d3.ascending(a.collisions, b.collisions)); break;
      case 'current_desc':
      default:             rows.sort((a, b) => d3.descending(a.collisions, b.collisions)); break;
    }
  }

  // ----- State -----
  let selectedYear = null;

  function buildRows(byYear, years, boroughs) {
    const theY = (selectedYear != null ? selectedYear : years[years.length - 1]);
    const idx  = years.indexOf(theY);
    const prev = idx > 0 ? years[idx - 1] : undefined;

    const curMap  = new Map((byYear.get(theY)     || []).map(d => [d.borough, +d.collisions]));
    const prevMap = prev !== undefined
      ? new Map((byYear.get(prev) || []).map(d => [d.borough, +d.collisions]))
      : new Map();

    return boroughs.map(b => {
      const cur = curMap.get(b)  ?? 0;
      const prv = prevMap.get(b) ?? 0;
      return { borough: b, collisions: cur, prev: prv, delta: cur - prv };
    });
  }

  function render(byYear, years, boroughs) {
    const rows = buildRows(byYear, years, boroughs);

    // totals (sum of current; Δ vs prev)
    const totalEl = root.querySelector('#cw-total');
    theDeltaEl = root.querySelector('#cw-total-delta'); // (scoped const not needed elsewhere)
    const deltaEl = theDeltaEl;

    const yVal   = (selectedYear != null ? selectedYear : years[years.length - 1]);
    const idx    = years.indexOf(yVal);
    const hasPrev= idx > 0;

    const total   = d3.sum(rows, d => d.collisions);
    const prevTot = hasPrev ? d3.sum(rows, d => d.prev) : 0;
    const dTot    = total - prevTot;
    const fmt     = d3.format(',');

    if (totalEl) totalEl.textContent = fmt(total);
    if (deltaEl) {
      if (!hasPrev) {
        deltaEl.textContent = '—';
        deltaEl.classList.remove('up', 'down');
        deltaEl.style.color = '';
      } else if (dTot === 0) {
        deltaEl.textContent = '–';
        deltaEl.classList.remove('up', 'down');
        deltaEl.style.color = '';
      } else {
        const up = dTot > 0;
        deltaEl.textContent = `${up ? '▲' : '▼'} ${fmt(Math.abs(dTot))}`;
        deltaEl.classList.toggle('up', up);
        deltaEl.classList.toggle('down', !up);
        deltaEl.style.color = up ? 'var(--up,#16a34a)' : 'var(--down,#dc2626)';
      }
    }

    // sort + layout
    sortRows(rows);
    const names = rows.map(d => d.borough);

    // Provisional widths for style decisions before resize()
    const widthProvisional  = containerW();
    const innerWProvisional = widthProvisional - targetLeftMargin() - margin.right;
    const yStyle = chooseYAxisStyle(innerWProvisional);

    // Choose margin + y-axis font using y pad
    const { fontPx, avail } = chooseAxisFontAndMargin(names, yStyle.pad);

    // Now size the SVG
    const { innerW, innerH } = resize(rows.length);
    const xMax = d3.max(rows, d => Math.max(d.collisions, d.prev)) || 0;

    // Axes with the y tick pad
    updateAxes({ xMax, yDomain: names, innerW, innerH, yTickPad: yStyle.pad });

    // Wrap y ticks to 2 lines
    applyTickWrap(gy, fontPx, avail);

    const t = svg.transition().duration(DUR).ease(EASE);

    // prev bars
    const prevBars = prevBarsG.selectAll('.prev-bar').data(rows, d => d.borough);
    prevBars.join(
      enter => enter.append('rect')
        .attr('class', 'prev-bar')
        .attr('x', 0)
        .attr('y', d => y(d.borough))
        .attr('height', y.bandwidth())
        .attr('width', 0)
        .call(enter => enter.transition(t)
          .attr('width', d => x(d.prev))
          .attr('y', d => y(d.borough))
        ),
      update => update.call(update => update.transition(t)
        .attr('y', d => y(d.borough))
        .attr('height', y.bandwidth())
        .attr('width', d => x(d.prev))
      ),
      exit => exit.call(exit => exit.transition(t).attr('width', 0).remove())
    );

    // current bars
    const bars = barsG.selectAll('.bar').data(rows, d => d.borough);
    bars.join(
      enter => enter.append('rect')
        .attr('class', 'bar')
        .attr('x', 0)
        .attr('y', d => y(d.borough))
        .attr('height', y.bandwidth())
        .attr('width', 0)
        .call(enter => enter.transition(t)
          .attr('width', d => x(d.collisions))
          .attr('y', d => y(d.borough))
        ),
      update => update.call(update => update.transition(t)
        .attr('y', d => y(d.borough))
        .attr('height', y.bandwidth())
        .attr('width', d => x(d.collisions))
      ),
      exit => exit.call(exit => exit.transition(t).attr('width', 0).remove())
    );

    // value labels (inside/outside current bar)
    const values = labelsG.selectAll('.value-label').data(rows, d => d.borough);
    values.join(
      enter => enter.append('text')
        .attr('class', 'value-label')
        .attr('x', d => valueLabelPos(d).x)
        .attr('y', d => (y(d.borough) ?? 0) + y.bandwidth() / 2)
        .attr('text-anchor', d => valueLabelPos(d).anchor)
        .text(d => fmt(d.collisions))
        .style('opacity', 0)
        .call(enter => enter.transition(t).style('opacity', 1)),
      update => update
        .text(d => fmt(d.collisions))
        .call(update => update.transition(t)
          .attr('x', d => valueLabelPos(d).x)
          .attr('y', d => (y(d.borough) ?? 0) + y.bandwidth() / 2)
          .attr('text-anchor', d => valueLabelPos(d).anchor)
        ),
      exit => exit.call(exit => exit.transition(t).style('opacity', 0).remove())
    );

    // delta labels
    const deltas = labelsG.selectAll('.delta').data(rows, d => d.borough);
    deltas.join(
      enter => enter.append('text')
        .attr('class', d => `delta ${d.delta >= 0 ? 'up' : 'down'}`)
        .attr('x', d => {
          const xPrev = x(d.prev);
          const xCurr = x(d.collisions);
          return (d.prev >= d.collisions) ? xPrev : (xCurr + DELTA_PAD);
        })
        .attr('y', d => (y(d.borough) ?? 0) + y.bandwidth() / 2)
        .attr('text-anchor', 'start')
        .text(d => d.delta === 0 ? '–' : `${d.delta > 0 ? '▲' : '▼'} ${d3.format(',')(Math.abs(d.delta))}`)
        .style('opacity', 0)
        .call(enter => enter.transition(t).style('opacity', 0.95)),
      update => update
        .attr('class', d => `delta ${d.delta >= 0 ? 'up' : 'down'}`)
        .text(d => d.delta === 0 ? '–' : `${d.delta > 0 ? '▲' : '▼'} ${d3.format(',')(Math.abs(d.delta))}`)
        .call(update => update.transition(t)
          .attr('x', d => {
            const xPrev = x(d.prev);
            const xCurr = x(d.collisions);
            return (d.prev >= d.collisions) ? xPrev : (xCurr + DELTA_PAD);
          })
          .attr('y', d => (y(d.borough) ?? 0) + y.bandwidth() / 2)
          .attr('text-anchor', 'start')
          .style('opacity', 0.95)
        ),
      exit => exit.call(exit => exit.transition(t).style('opacity', 0).remove())
    );
  }

  // ----- Data loader -----
  async function loadRecords(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} while loading ${url}`);
    let text = await res.text();
    if (text && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const json = JSON.parse(text);
    const arr = Array.isArray(json) ? json
      : Array.isArray(json.records) ? json.records
      : Array.isArray(json.data) ? json.data
      : Array.isArray(json.rows) ? json.rows
      : null;
    if (!arr) throw new Error('Expected an array or {records|data|rows: [...]}');

    const recs = arr.map(r => ({
      year: +r.year,
      borough: String(r.borough),
      collisions: +r.collisions
    })).filter(r => Number.isFinite(r.year) && r.borough && Number.isFinite(r.collisions));

    if (!recs.length) throw new Error('No valid records with keys year, borough, collisions.');
    return recs;
  }

  // ----- Caches -----
  let byYearCache, yearsCache, boroughsCache;

  // Safe re-render that recomputes margins & mask height
  const rerender = rafDebounce(() => {
    if (headerMaskEl) headerMaskEl.style.height = `0px`;
    if (byYearCache && yearsCache && boroughsCache) {
      render(byYearCache, yearsCache, boroughsCache);
    }
  });


  // ----- Init -----
  (async function init() {
    try {
      const records = await loadRecords(dataUrl);

      byYearCache   = d3.group(records, d => d.year);
      yearsCache    = Array.from(byYearCache.keys()).sort((a, b) => a - b);
      boroughsCache = Array.from(new Set(records.map(d => d.borough))).sort();

      if (!yearsCache.length) throw new Error('No years found in data.');
      selectedYear = yearsCache[yearsCache.length - 1];

      // build year chips (single-select)
      if (chipsWrap) {
        chipsWrap.innerHTML = '';
        yearsCache.forEach(y => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'cw-year-chip';
          btn.textContent = y;
          btn.setAttribute('aria-pressed', y === selectedYear ? 'true' : 'false');
          if (y === selectedYear) btn.classList.add('active');

          btn.addEventListener('click', () => {
            selectedYear = y;
            chipsWrap.querySelectorAll('.cw-year-chip').forEach(b => {
              const yy = +b.textContent;
              const on = (yy === selectedYear);
              b.classList.toggle('active', on);
              b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            rerender();
          });

          chipsWrap.appendChild(btn);
        });
      }

      if (sortSel) {
        sortSel.addEventListener('change', () => {
          currentSort = sortSel.value || 'current_desc';
          rerender();
        });
      }

      // initial render + observers
      rerender();
      window.addEventListener('resize', rerender);

      if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => rerender());
        ro.observe(root);
        ro.observe(header);
      }
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => rerender()).catch(() => {});
      }

    } catch (err) {
      console.error('[collisions-widget]', err);
      const el = document.createElement('div');
      el.className = 'cw-error';
      el.textContent = `Could not load data: ${err.message}`;
      root.prepend(el);
    }
  })();
})();
