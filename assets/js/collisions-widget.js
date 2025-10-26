(function(){
  const root = document.querySelector('.collisions-widget');
  if(!root) return;

  const dataUrl = root.getAttribute('data-url') || 'assets/backend/borough_collisions_records.json';
  const initialYearAttr = root.getAttribute('data-initial-year');
  const titleText = root.getAttribute('data-title') || 'Borough collisions';

  const svg = d3.select(root).select('#cw-chart');

  // ===== layout tuning =====
  // Reserve a little space on the right so bars don't hit the edge
  const RIGHT_PAD_FRAC = 0.06; // ≈6% of chart width
  const RIGHT_PAD_MIN  = 48;   // at least 48px

  // ---- ensure title (center), totals (top-left), legend (under slider) ----
  function ensureUI(){
    // Centered title
    if(!root.querySelector('.cw-title')){
      const title = document.createElement('div');
      title.className = 'cw-title';
      title.textContent = titleText;
      Object.assign(title.style, {
        position:'absolute',
        top:'8px',
        left:'0',
        right:'0',
        textAlign:'center',
        fontSize:'16px',
        fontWeight:'600',
        color:'var(--ink, #111111)',
        background:'rgba(255,255,255,.96)',
        border:'1px solid var(--line, #e6e8ec)',
        borderRadius:'10px',
        padding:'6px 10px',
        margin:'0 auto',
        width:'max-content',
        maxWidth:'90%',
        zIndex:2
      });
      root.appendChild(title);
    }

    // Totals (top-left): number + delta (no bar)
    if(!root.querySelector('.cw-totals')){
      const totals = document.createElement('div');
      totals.className = 'cw-totals';
      totals.setAttribute('role','status');
      totals.setAttribute('aria-live','polite');
      totals.innerHTML = `
        <span class="cw-totals-label">Total collisions</span>
        <span id="cw-total" class="cw-total">—</span>
        <span id="cw-total-delta" class="cw-total-delta">—</span>
      `;
      Object.assign(totals.style, {
        position:'absolute', top:'8px', left:'12px',
        display:'inline-flex', alignItems:'baseline', gap:'10px',
        background:'rgba(255,255,255,.96)',
        border:'1px solid var(--line, #e6e8ec)',
        borderRadius:'12px',
        padding:'8px 10px',
        zIndex:2,
        fontSize:'13px',
        color:'var(--ink-2, #2a2f36)'
      });
      root.appendChild(totals);
    }

    // Legend (under slider)
    if(!root.querySelector('.cw-legend')){
      const legend = document.createElement('div');
      legend.className = 'cw-legend';
      legend.setAttribute('role','note');
      legend.setAttribute('aria-label','Legend');
      legend.innerHTML = `
        <span class="legend-item" style="display:inline-flex;align-items:center;gap:6px;">
          <span class="swatch swatch-current" aria-hidden="true"
                style="display:inline-block;width:12px;height:12px;border-radius:2px;border:1px solid var(--line);background:var(--bar,#003f5c);"></span>
          Current year
        </span>
        <span class="legend-item" style="display:inline-flex;align-items:center;gap:6px;">
          <span class="swatch swatch-prev" aria-hidden="true"
                style="display:inline-block;width:12px;height:12px;border-radius:2px;border:1px solid var(--line);background:var(--prev,#ffa600);"></span>
          Previous year
        </span>
        <span class="legend-item" style="display:inline-flex;align-items:center;gap:6px;">
          <span class="legend-delta-up" aria-hidden="true" style="color:var(--up,#16a34a)">▲</span> Up /
          <span class="legend-delta-down" aria-hidden="true" style="color:var(--down,#dc2626)">▼</span> Down
        </span>
      `;
      Object.assign(legend.style, {
        position:'absolute', right:'10px',
        background:'rgba(255,255,255,.96)',
        border:'1px solid var(--line, #e6e8ec)',
        borderRadius:'999px',
        padding:'6px 10px',
        display:'inline-flex',
        alignItems:'center',
        gap:'12px',
        flexWrap:'wrap',
        fontSize:'13px',
        color:'var(--ink-2,#2a2f36)',
        zIndex:1
      });
      root.appendChild(legend);
    }
  }
  ensureUI();

  // references
  const titleEl    = root.querySelector('.cw-title');
  const totalsEl   = root.querySelector('.cw-totals');
  const legendEl   = root.querySelector('.cw-legend');
  const controlsEl = root.querySelector('.cw-controls');

  // place legend right under the slider
  function positionLegend(){
    if(!legendEl || !controlsEl) return;
    const ctrlRect = controlsEl.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const offsetTop = (ctrlRect.bottom - rootRect.top) + 8; // 8px gap
    legendEl.style.top = `${Math.max(8, Math.round(offsetTop))}px`;
  }

  // compute how much vertical space top UI occupies & push chart below it
  function computeTopMargin(){
    const els = [titleEl, totalsEl, controlsEl, legendEl].filter(Boolean);
    const rootRect = root.getBoundingClientRect();
    let maxBottom = 0;
    for(const el of els){
      const r = el.getBoundingClientRect();
      const bottom = r.bottom - rootRect.top;
      maxBottom = Math.max(maxBottom, bottom);
    }
    return Math.max(36, Math.ceil(maxBottom + 10));
  }

  // ---- layout ----
  let margin = { top: 36, right: 28, bottom: 24, left: 120 }; // top is dynamic
  const rowHeight = 40;
  const DUR = 700, EASE = d3.easeCubicInOut;

  const g = svg.append('g');
  const gx = g.append('g').attr('class', 'axis axis--x');
  const gy = g.append('g').attr('class', 'axis axis--y');
  const xgridG = g.append('g').attr('class', 'grid grid--x');
  const ygridG = g.append('g').attr('class', 'grid grid--y');
  const prevBarsG = g.append('g');
  const barsG = g.append('g');
  const labelsG = g.append('g');

  const x = d3.scaleLinear();
  const y = d3.scaleBand().padding(0.12);

  const VALUE_IN_PAD = 12;
  const DELTA_PAD = 12;

  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = '12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, "Noto Sans", Arial';
  function calcLeftMargin(names){
    const max = names.reduce((m, s) => Math.max(m, ctx.measureText(s).width), 0);
    return Math.min(320, Math.max(130, Math.ceil(max) + 28));
  }

  function containerW(){
    let w = root.clientWidth || root.offsetWidth || 0;
    if (!w) w = (root.parentElement && (root.parentElement.clientWidth || root.parentElement.clientWidth)) || 640;
    return Math.max(360, w);
  }

  function resize(nRows){
    positionLegend();
    margin.top = computeTopMargin();

    const width = containerW();
    const innerW = width - margin.left - margin.right;
    const innerH = Math.max(1, nRows) * rowHeight;
    const height = innerH + margin.top + margin.bottom;

    svg.attr('width', width).attr('height', height);
    g.attr('transform', `translate(${margin.left},${margin.top})`);
    gx.attr('transform', `translate(0,0)`);
    gy.attr('transform', `translate(0,0)`);
    return { innerW, innerH };
  }

  function updateAxes({ xMax, yDomain, innerW, innerH }){
    // Reserve space on the right so bars don't hit the edge
    const rightPad = Math.max(RIGHT_PAD_MIN, Math.round(innerW * RIGHT_PAD_FRAC));
    const drawW = Math.max(1, innerW - rightPad);

    // small breathing space on the domain; clamp keeps labels inside
    const HEADROOM = 0.02;
    x.domain([0, xMax * (1 + HEADROOM)]).range([0, drawW]).clamp(true);
    y.domain(yDomain).range([0, innerH]);

    gx.transition().duration(DUR).ease(EASE)
      .call(d3.axisTop(x).ticks(6).tickFormat(d3.format(',')));

    gy.transition().duration(DUR).ease(EASE)
      .call(d3.axisLeft(y).tickSizeOuter(0));

    xgridG
      .attr('transform', 'translate(0,0)')
      .transition().duration(DUR).ease(EASE)
      .call(d3.axisTop(x).ticks(6).tickSize(-innerH).tickFormat(() => ''));

    ygridG
      .transition().duration(DUR).ease(EASE)
      .call(d3.axisLeft(y).tickSize(-innerW).tickFormat(() => ''));
  }

  function render(year, byYear, years, allBoroughs){
    // current & previous maps
    const prevYear = years[years.indexOf(year) - 1];
    const curMap  = new Map((byYear.get(year)     || []).map(d => [d.borough, +d.collisions]));
    const prevMap = new Map((byYear.get(prevYear) || []).map(d => [d.borough, +d.collisions]));

    // rows stable across years
    const rows = allBoroughs.map(b => {
      const cur = curMap.get(b)  ?? 0;
      const prv = prevMap.get(b) ?? 0;
      return { borough: b, year, collisions: cur, prev: prv, delta: cur - prv };
    });

    // --- Total counter + delta ---
    const totalEl = root.querySelector('#cw-total');
    const deltaEl = root.querySelector('#cw-total-delta');
    const hasPrev = years.indexOf(year) > 0;

    const total   = d3.sum(rows, d => d.collisions);
    const prevTot = hasPrev ? d3.sum(rows, d => d.prev) : 0;
    const dTot    = total - prevTot;

    const fmt = d3.format(',');
    if (totalEl) totalEl.textContent = fmt(total);
    if (deltaEl){
      if (!hasPrev){
        deltaEl.textContent = '—';
        deltaEl.classList.remove('up','down');
        deltaEl.style.color = '';
      } else if (dTot === 0){
        deltaEl.textContent = '–';
        deltaEl.classList.remove('up','down');
        deltaEl.style.color = '';
      } else {
        const up = dTot > 0;
        deltaEl.textContent = `${up ? '▲' : '▼'} ${fmt(Math.abs(dTot))}`;
        deltaEl.classList.toggle('up', up);
        deltaEl.classList.toggle('down', !up);
        deltaEl.style.color = up ? 'var(--up,#16a34a)' : 'var(--down,#dc2626)';
      }
    }

    // sort by current desc
    rows.sort((a,b) => d3.descending(a.collisions, b.collisions));

    // adapt left margin for labels
    margin.left = calcLeftMargin(rows.map(d => d.borough));

    const { innerW, innerH } = resize(rows.length);
    const xMax = d3.max(rows, d => Math.max(d.collisions, d.prev)) || 0;
    updateAxes({ xMax, yDomain: rows.map(d => d.borough), innerW, innerH });

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

    // inside-bar values
    const values = labelsG.selectAll('.value-label').data(rows, d => d.borough);
    values.join(
      enter => enter.append('text')
        .attr('class', 'value-label')
        .attr('x', d => Math.max(0, x(d.collisions) - VALUE_IN_PAD))
        .attr('y', d => (y(d.borough) ?? 0) + y.bandwidth()/2)
        .attr('text-anchor', 'end')
        .text(d => fmt(d.collisions))
        .style('opacity', 0)
        .call(enter => enter.transition(t).style('opacity', 1)),
      update => update
        .text(d => fmt(d.collisions))
        .call(update => update.transition(t)
          .attr('x', d => Math.max(0, x(d.collisions) - VALUE_IN_PAD))
          .attr('y', d => (y(d.borough) ?? 0) + y.bandwidth()/2)
          .attr('text-anchor', 'end')
        ),
      exit => exit.call(exit => exit.transition(t).style('opacity', 0).remove())
    );

    // deltas vs prev
    const deltas = labelsG.selectAll('.delta').data(rows, d => d.borough);
    deltas.join(
      enter => enter.append('text')
        .attr('class', d => `delta ${d.delta >= 0 ? 'up' : 'down'}`)
        .attr('x', d => {
          const xPrev = x(d.prev);
          const xCurr = x(d.collisions);
          return (d.prev >= d.collisions) ? xPrev : (xCurr + DELTA_PAD);
        })
        .attr('y', d => (y(d.borough) ?? 0) + y.bandwidth()/2)
        .attr('text-anchor', 'start')
        .text(d => d.delta === 0 ? '–' : `${d.delta > 0 ? '▲' : '▼'} ${fmt(Math.abs(d.delta))}`)
        .style('opacity', 0)
        .call(enter => enter.transition(t).style('opacity', 0.95)),
      update => update
        .attr('class', d => `delta ${d.delta >= 0 ? 'up' : 'down'}`)
        .text(d => d.delta === 0 ? '–' : `${d.delta > 0 ? '▲' : '▼'} ${fmt(Math.abs(d.delta))}`)
        .call(update => update.transition(t)
          .attr('x', d => {
            const xPrev = x(d.prev);
            const xCurr = x(d.collisions);
            return (d.prev >= d.collisions) ? xPrev : (xCurr + DELTA_PAD);
          })
          .attr('y', d => (y(d.borough) ?? 0) + y.bandwidth()/2)
          .attr('text-anchor', 'start')
          .style('opacity', 0.95)
        ),
      exit => exit.call(exit => exit.transition(t).style('opacity', 0).remove())
    );
  }

  // ---- data loader ----
  async function loadRecords(url){
    const res = await fetch(url, { cache: 'no-store' });
    if(!res.ok) throw new Error(`HTTP ${res.status} while loading ${url}`);
    let text = await res.text();
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const json = JSON.parse(text);
    const arr = Array.isArray(json) ? json
      : Array.isArray(json.records) ? json.records
      : Array.isArray(json.data) ? json.data
      : Array.isArray(json.rows) ? json.rows
      : null;
    if(!arr) throw new Error('Expected an array or {records|data|rows: [...]}');

    const recs = arr.map(r => ({
      year: +r.year,
      borough: String(r.borough),
      collisions: +r.collisions
    })).filter(r => Number.isFinite(r.year) && r.borough && Number.isFinite(r.collisions));

    if(!recs.length) throw new Error('No valid records with keys year, borough, collisions.');
    return recs;
  }

  // caches for re-render
  let byYearCache, yearsCache, boroughsCache;

  (async function init(){
    const records = await loadRecords(dataUrl);

    byYearCache = d3.group(records, d => d.year);
    yearsCache = Array.from(byYearCache.keys()).sort((a,b)=>a-b);
    boroughsCache = Array.from(new Set(records.map(d => d.borough))).sort();
    if(!yearsCache.length) throw new Error('No years found in data.');

    // Slider
    const range = root.querySelector('#cw-year');
    const label = root.querySelector('#cw-year-label');
    const minY = d3.min(yearsCache), maxY = d3.max(yearsCache);
    const startY = initialYearAttr ? Math.min(Math.max(+initialYearAttr, minY), maxY) : minY;

    range.min = minY; range.max = maxY; range.value = startY; label.textContent = startY;

    // first layout + render
    positionLegend();
    render(startY, byYearCache, yearsCache, boroughsCache);

    // responsive
    window.addEventListener('resize', () => {
      positionLegend();
      render(+range.value, byYearCache, yearsCache, boroughsCache);
    });

    range.addEventListener('input', () => {
      const ySel = +range.value;
      label.textContent = ySel;
      render(ySel, byYearCache, yearsCache, boroughsCache);
    });
  })().catch(err => {
    console.error('[collisions-widget]', err);
    const el = document.createElement('div');
    el.className = 'cw-error';
    el.textContent = `Could not load data: ${err.message}`;
    root.prepend(el);
  });
})();
