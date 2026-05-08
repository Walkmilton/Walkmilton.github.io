/* ==========================================================================
   Holyrood 2026 — Live Results Dashboard
   ==========================================================================
   Single-page vanilla-JS app. No build step.
   ========================================================================== */

const PARTIES = ['SNP', 'LAB', 'CON', 'LD', 'GRN', 'REF', 'OTH'];
const PARTY_NAMES = {
  SNP: 'SNP', LAB: 'Labour', CON: 'Conservative',
  LD:  'Lib Dem', GRN: 'Greens', REF: 'Reform', OTH: 'Other'
};
const PARTY_COLORS = {
  SNP: '#FFC700', LAB: '#E4003B', CON: '#0087DC',
  LD:  '#FAA61A', GRN: '#5DBB46', REF: '#12B6CF', OTH: '#8a93a3'
};
const REGIONS = [
  'Central Scotland', 'Glasgow', 'Highlands and Islands', 'Lothian',
  'Mid Scotland and Fife', 'North East Scotland', 'South Scotland', 'West Scotland'
];
const TOTAL_SEATS = 129;
const CONSTITUENCY_SEATS = 73;
const LIST_SEATS = 56;
const LIST_PER_REGION = 7;
const MAJORITY = 65;
const STORAGE_KEY = 'holyrood2026.v2';
const LIVE_KEY = 'holyrood2026.live';

// Default live source — pre-fills the URL in the live-mode modal so visitors
// just hit Start to begin polling. Live mode is OFF by default; users must
// click Start. Visitors who set their own URL keep their override. Reset
// wipes the override and restores this default. Set to '' to disable.
const DEFAULT_LIVE_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT0LlK4skK6VFwKSsyzkh9pwD9blUO3D8lCk8YFQIdD2KjUBSgHhrCFohcAuBsOkne1mIspJfycjr3D/pub?output=csv';
const DEFAULT_LIVE_INTERVAL_SEC = 30;

/* ---------------- State ---------------- */
const state = {
  topo: null,
  results2021: { constituencies: [], regions: [], scotland: null },
  predictions: null,
  byConstituency: {},
  byRegion: {},

  entered: { constituencies: {}, regions: {} },
  mode: 'declared',
  modalSeat: null,        // currently-open constituency modal (name)
  modalRegion: null,      // currently-open region modal (name)
  table: { sortKey: 'name', sortDir: 'asc', filter: '' },
  theme: 'dark',
  tvMode: false,
  soundOn: false,
  spcMapView: 'geo',     // 'geo' | 'hex'
  hexLayout: null,
  lastUpdated: null,

  // Year-view: 'live' (= 2026 entered/projected) or one of 1999, 2003, 2007, 2011, 2016, 2021
  viewYear: 'live',
  historical: null,
  declarationSchedule: null,

  watchlist: [],          // array of constituency names
  declarations: [],       // [{ name, ts, winner, prevWinner, swing, isFlip }]
  notables: null,
  coalitionMode: 2,       // 2 = pairs only, 3 = include 3-party combos

  // Live polling
  live: {
    url: '',
    intervalSec: 30,
    running: false,
    timer: null,
    lastFetch: null,
    lastResult: null,   // { added, updated, errors: [] }
    lastError: null,
  },
};

/* ---------------- Util ---------------- */
const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const fmt = n => Number.isFinite(n) ? n.toLocaleString('en-GB') : '—';
const fmtPct = (n, d=1) => Number.isFinite(n) ? n.toFixed(d) + '%' : '—';
const fmtSigned = (n, d=1) => {
  if (!Number.isFinite(n)) return '—';
  const s = n > 0 ? '+' : '';
  return s + n.toFixed(d);
};

function partyColor(p) { return PARTY_COLORS[p] || PARTY_COLORS.OTH; }
function totals(o) { return PARTIES.reduce((a, p) => a + (o[p] || 0), 0); }
function pctOf(o) {
  const t = totals(o);
  if (t <= 0) return zeroParties();
  const out = {};
  for (const p of PARTIES) out[p] = ((o[p] || 0) / t) * 100;
  return out;
}
function zeroParties() { return Object.fromEntries(PARTIES.map(p => [p, 0])); }
function copyParties(o) { return Object.fromEntries(PARTIES.map(p => [p, o[p] || 0])); }
function winnerOf(o) {
  let bestP = null, bestV = -Infinity;
  for (const p of PARTIES) {
    const v = o[p] || 0;
    if (v > bestV) { bestV = v; bestP = p; }
  }
  return bestV > 0 ? bestP : null;
}
function topTwo(o) {
  const sorted = PARTIES.map(p => [p, o[p] || 0]).sort((a, b) => b[1] - a[1]);
  return [sorted[0], sorted[1]];
}

function showToast(msg, ms=2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------------- d'Hondt ---------------- */
function dhondtAllocate(listVotes, constituencyWins, seats = LIST_PER_REGION) {
  const result = zeroParties();
  const eligible = PARTIES.filter(p => (listVotes[p] || 0) > 0);
  if (eligible.length === 0) return result;
  for (let i = 0; i < seats; i++) {
    let bestP = null, bestQ = -1;
    for (const p of eligible) {
      const q = (listVotes[p] || 0) / ((constituencyWins[p] || 0) + (result[p] || 0) + 1);
      if (q > bestQ) { bestQ = q; bestP = p; }
    }
    if (!bestP) break;
    result[bestP] += 1;
  }
  return result;
}

/* ---------------- Data load ---------------- */
async function loadData() {
  const [topo, c21, r21, s21, pred] = await Promise.all([
    fetch('data/maps.topo.json').then(r => r.json()),
    fetch('data/results_2021_constituencies.json').then(r => r.json()),
    fetch('data/results_2021_regions.json').then(r => r.json()),
    fetch('data/results_2021_scotland.json').then(r => r.json()),
    fetch('data/predictions_2026.json').then(r => r.json()).catch(() => null),
  ]);
  state.topo = topo;
  state.results2021.constituencies = c21;
  state.results2021.regions = r21;
  state.results2021.scotland = s21;
  state.predictions = pred;
  for (const c of c21) state.byConstituency[c.name] = c;
  for (const r of r21) state.byRegion[r.name] = r;
  // Notables (optional)
  try {
    state.notables = await fetch('data/notables_2026.json').then(r => r.json());
  } catch (e) { state.notables = null; }
  // Hex layout (optional)
  try {
    state.hexLayout = await fetch('data/hex_layout.json').then(r => r.json());
  } catch (e) { state.hexLayout = null; }
  // Expected declaration schedule (optional)
  try {
    const sched = await fetch('data/declaration_schedule.json').then(r => r.json());
    state.declarationSchedule = {};
    state.declarationScheduleRegions = {};
    state.declarationScheduleSource = sched._meta && sched._meta.source;
    for (const c of (sched.constituencies || [])) {
      state.declarationSchedule[c.name] = c;
    }
    for (const r of (sched.regions || [])) {
      state.declarationScheduleRegions[r.name] = r;
    }
  } catch (e) { state.declarationSchedule = null; state.declarationScheduleRegions = null; }
  // Historical elections — load all 6 in parallel
  state.historical = {};
  await Promise.all([1999, 2003, 2007, 2011, 2016, 2021].map(async y => {
    try {
      state.historical[y] = await fetch(`data/historical/history_${y}.json`).then(r => r.json());
    } catch (e) {}
  }));
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data.entered) state.entered = Object.assign(state.entered, data.entered);
      if (data.mode) state.mode = data.mode;
      if (data.lastUpdated) state.lastUpdated = data.lastUpdated;
      if (data.theme) state.theme = data.theme;
      if (Array.isArray(data.watchlist)) state.watchlist = data.watchlist;
      if (Array.isArray(data.declarations)) state.declarations = data.declarations;
      if (typeof data.tvMode === 'boolean') state.tvMode = data.tvMode;
      if (typeof data.soundOn === 'boolean') state.soundOn = data.soundOn;
    }
    const t = localStorage.getItem(STORAGE_KEY + '.theme');
    if (t) state.theme = t;
  } catch (e) { console.warn('storage load failed', e); }
}

function persist() {
  try {
    state.lastUpdated = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      entered: state.entered, mode: state.mode, lastUpdated: state.lastUpdated, theme: state.theme,
      watchlist: state.watchlist, declarations: state.declarations.slice(-200),
      tvMode: state.tvMode, soundOn: state.soundOn,
    }));
    localStorage.setItem(STORAGE_KEY + '.theme', state.theme);
  } catch (e) { console.warn('storage save failed', e); }
}

/* ---------------- Projection logic ----------------
 * Projected mode uses Ballot Box Scotland's poll-of-polls vote shares as the
 * "expected" Scotland-wide vote shares. Swing per party = BBS share − 2021
 * share. We apply that swing to undeclared seats. This anchors the projection
 * to a stable polling baseline rather than letting it lurch with each early
 * declaration.
 *
 * If predictions data is missing we fall back to the old behaviour
 * (swing learned from declared seats — classic UNS).
 */
function computeBBSSwing(kind = 'constituency') {
  const baseline = state.results2021.scotland;
  const pred = state.predictions && state.predictions.national_projection;
  if (!pred || !baseline) return zeroParties();
  const baseShares = kind === 'list' ? baseline.list_vote_pct : baseline.constituency_vote_pct;
  const predShares = kind === 'list' ? pred.list_vote_pct : pred.constituency_vote_pct;
  if (!baseShares || !predShares) return zeroParties();
  const swing = zeroParties();
  for (const p of PARTIES) {
    swing[p] = (predShares[p] || 0) - (baseShares[p] || 0);
  }
  return swing;
}

// Observed swing from already-declared constituencies (for the National Swing card).
function computeObservedSwing() {
  const declared = Object.entries(state.entered.constituencies);
  if (declared.length === 0) return zeroParties();
  const swing = zeroParties();
  let n = 0;
  for (const [name, rec] of declared) {
    const baseline = state.byConstituency[name];
    if (!baseline || !baseline.vote_pct) continue;
    const cur = pctOf(rec.votes);
    for (const p of PARTIES) {
      swing[p] += (cur[p] - (baseline.vote_pct[p] || 0));
    }
    n++;
  }
  if (n === 0) return zeroParties();
  for (const p of PARTIES) swing[p] /= n;
  return swing;
}

// Backwards-compatibility alias used by the per-seat dial / projection code.
// Returns the swing currently driving projections.
function computeUNSwing() {
  // Prefer BBS swing when predictions are available; else fall back to observed.
  if (state.predictions && state.predictions.national_projection) {
    return computeBBSSwing('constituency');
  }
  return computeObservedSwing();
}

function projectConstituency(name, swing) {
  const b = state.byConstituency[name];
  if (!b || !b.vote_pct) return null;
  const projected = {};
  for (const p of PARTIES) projected[p] = Math.max(0, (b.vote_pct[p] || 0) + swing[p]);
  return { winner: winnerOf(projected), projected: true, vote_pct: projected };
}

function computeSeats() {
  // Historical year override — return that year's totals + per-seat detail if we have it
  if (isHistoricalView()) {
    const h = getHistoricalRecord();
    if (h) return computeHistoricalSeats(h);
  }
  const useProj = state.mode === 'projected';
  const swing = useProj ? computeUNSwing() : null;
  const listSwing = useProj
    ? (state.predictions && state.predictions.national_projection
        ? computeBBSSwing('list')
        : swing)
    : null;

  const perConstituency = {};
  const constituencyByParty = zeroParties();
  let declaredCount = 0;

  for (const c of state.results2021.constituencies) {
    const name = c.name;
    const entered = state.entered.constituencies[name];
    if (entered) {
      const winner = winnerOf(entered.votes);
      perConstituency[name] = { winner, declared: true, vote_pct: pctOf(entered.votes), votes: entered.votes };
      if (winner) constituencyByParty[winner] += 1;
      declaredCount++;
    } else if (useProj) {
      const proj = projectConstituency(name, swing);
      if (proj && proj.winner) {
        perConstituency[name] = { winner: proj.winner, declared: false, projected: true, vote_pct: proj.vote_pct };
        constituencyByParty[proj.winner] += 1;
      } else {
        perConstituency[name] = { winner: null, declared: false };
      }
    } else {
      perConstituency[name] = { winner: null, declared: false };
    }
  }

  const perRegion = {};
  const listByParty = zeroParties();
  let regionCount = 0;
  let listAllocated = 0;

  for (const region of REGIONS) {
    const enteredR = state.entered.regions[region];
    let listVotes;
    let hasData = false;

    if (enteredR && totals(enteredR.listVotes) > 0) {
      listVotes = enteredR.listVotes;
      hasData = true;
      regionCount++;
    } else if (useProj) {
      const baseline = state.byRegion[region];
      if (baseline && baseline.list_votes) {
        const baseTotal = totals(baseline.list_votes);
        const baseShares = pctOf(baseline.list_votes);
        const projShares = {};
        for (const p of PARTIES) projShares[p] = Math.max(0, baseShares[p] + (listSwing[p] || 0));
        listVotes = {};
        for (const p of PARTIES) listVotes[p] = projShares[p] * baseTotal / 100;
        hasData = true;
      }
    }

    const consWinsThisReg = zeroParties();
    for (const c of state.results2021.constituencies) {
      if (c.region !== region) continue;
      const w = perConstituency[c.name] && perConstituency[c.name].winner;
      if (w) consWinsThisReg[w] += 1;
    }

    let seats = zeroParties();
    if (hasData) {
      seats = dhondtAllocate(listVotes, consWinsThisReg, LIST_PER_REGION);
      listAllocated += Object.values(seats).reduce((a, b) => a + b, 0);
    }
    perRegion[region] = {
      listVotes: listVotes || zeroParties(),
      listSeats: seats,
      listLeader: hasData ? winnerOf(listVotes) : null,
      hasData,
      consWins: consWinsThisReg,
    };
    for (const p of PARTIES) listByParty[p] += seats[p];
  }

  const totalByParty = {};
  for (const p of PARTIES) totalByParty[p] = constituencyByParty[p] + listByParty[p];

  let leadParty = null, leadSeats = -1;
  for (const p of PARTIES) {
    if (totalByParty[p] > leadSeats) { leadParty = p; leadSeats = totalByParty[p]; }
  }

  return {
    constituencyByParty, listByParty, totalByParty,
    perConstituency, perRegion,
    leadParty, leadSeats,
    declaredCount, regionCount, listAllocated,
    swing: swing || computeObservedSwing(), // declared-only mode shows observed
    listSwing,
  };
}

/* ---------------- Parliament hemicycle diagram ----------------
 * Classic semi-circular dot-per-MSP visualisation. Each row is an arc;
 * outer rows hold more seats. Seats are sorted left → right by political
 * position (GRN, SNP, LAB, LD, OTH, CON, REF) and rendered as coloured dots.
 * A dashed line marks the 65-seat majority threshold.
 */
const HEMICYCLE_PARTY_ORDER = ['GRN','SNP','LAB','LD','OTH','CON','REF'];

function renderHemicycle(s) {
  const el = $('#hemicycle');
  if (!el) return;
  const totals = s.totalByParty;

  // Build seat list left-to-right by party; pad with nulls for unallocated
  const seats = [];
  for (const p of HEMICYCLE_PARTY_ORDER) {
    for (let i = 0; i < totals[p]; i++) seats.push(p);
  }
  while (seats.length < TOTAL_SEATS) seats.push(null);

  // Wikipedia-style parliament-diagram algorithm: constant linear arc-length
  // spacing across all rows, so the visual is evenly packed (no sparse inner
  // ring). Pick a row count, then iterate to find the spacing that fits 129.
  const ROWS = 9;
  const rMin = 100;
  const rMax = 245;
  const radii = [];
  for (let r = 0; r < ROWS; r++) {
    radii.push(rMin + (rMax - rMin) * r / (ROWS - 1));
  }
  const sumR = radii.reduce((a, b) => a + b, 0);
  // Linear spacing satisfies: sum_r round(pi * R_r / spacing) = TOTAL_SEATS
  // First-pass estimate, then nudge until exact:
  let spacing = Math.PI * sumR / TOTAL_SEATS;
  let rowSeats;
  for (let attempt = 0; attempt < 40; attempt++) {
    rowSeats = radii.map(R => Math.round(Math.PI * R / spacing));
    const sumN = rowSeats.reduce((a, b) => a + b, 0);
    if (sumN === TOTAL_SEATS) break;
    spacing *= sumN / TOTAL_SEATS;
  }
  // Final correction if rounding still off — adjust outermost row
  let assigned = rowSeats.reduce((a, b) => a + b, 0);
  if (assigned !== TOTAL_SEATS) {
    rowSeats[ROWS - 1] += (TOTAL_SEATS - assigned);
  }

  // Layout
  const W = 760, H = 295;
  const cx = W / 2, cy = H - 12;
  const dotR = 6.5;

  // Enumerate all positions (row, angularPos) → (x, y).
  // Add a small inset at each end so dots don't kiss the edges.
  const positions = [];
  for (let r = 0; r < ROWS; r++) {
    const radius = radii[r];
    const N = rowSeats[r];
    for (let i = 0; i < N; i++) {
      const angularPos = (i + 0.5) / N;       // 0 = far left, 1 = far right
      const angle = Math.PI - angularPos * Math.PI;
      positions.push({
        x: cx + radius * Math.cos(angle),
        y: cy - radius * Math.sin(angle),
        angularPos,
        row: r,
      });
    }
  }
  // Sort positions by angular position so left-to-right colouring works
  positions.sort((a, b) => a.angularPos - b.angularPos || a.row - b.row);

  // Assign parties in left-to-right order
  positions.forEach((pos, idx) => { pos.party = seats[idx]; });

  // Build SVG
  const dots = positions.map(pos => {
    if (!pos.party) {
      return `<circle class="seat-dot empty" cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${dotR}"></circle>`;
    }
    return `<circle class="seat-dot" cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${dotR}" fill="${partyColor(pos.party)}"><title>${PARTY_NAMES[pos.party]}</title></circle>`;
  }).join('');

  // Majority line at angularPos = 0.5 (i.e. straight up from cx)
  const majTopY = cy - rMax - 12;
  const majBotY = cy - rMin + 4;
  const majLine = `<line class="maj-line" x1="${cx}" y1="${majTopY}" x2="${cx}" y2="${majBotY}"/>
    <text class="maj-label" x="${cx}" y="${majTopY - 6}" text-anchor="middle">Majority · 65</text>`;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    ${dots}
    ${majLine}
  </svg>`;
}

/* ---------------- Confidence interval on projection ----------------
 * Bootstrap-style uncertainty band on the projected seat totals.
 *
 * If BBS predictions are available, the central projection is anchored to
 * those polling shares. We add Gaussian noise (σ ≈ 2pp per party) per
 * replicate to represent polling uncertainty, then re-project.
 *
 * Otherwise we fall back to bootstrapping the per-seat swings observed in
 * declared constituencies (the old UNS-from-declared model).
 *
 * Returns { perParty: { SNP: {lo, hi, median} }, n, declared }
 * or null if not applicable (declared-only mode, or all 73 seats declared).
 */
function computeProjectionCI(opts = {}) {
  const N = opts.replicates || 200;
  if (state.mode !== 'projected') return null;
  const declared = Object.entries(state.entered.constituencies);
  if (declared.length >= CONSTITUENCY_SEATS) return null;  // already 100% — no uncertainty

  const useBBS = !!(state.predictions && state.predictions.national_projection);

  // For BBS mode we don't need declared swings; for fallback UNS we do.
  let declaredSwings = [];
  if (!useBBS) {
    if (declared.length === 0) return null;
    for (const [name, rec] of declared) {
      const baseline = state.byConstituency[name];
      if (!baseline || !baseline.vote_pct) continue;
      const cur = pctOf(rec.votes);
      const sw = {};
      for (const p of PARTIES) sw[p] = (cur[p] || 0) - (baseline.vote_pct[p] || 0);
      declaredSwings.push(sw);
    }
    if (!declaredSwings.length) return null;
  }

  // Pre-compute BBS swings (constituency + list) once for the loop below
  const bbsConstSwing = useBBS ? computeBBSSwing('constituency') : null;
  const bbsListSwing = useBBS ? computeBBSSwing('list') : null;
  // Per-party Gaussian noise σ in percentage points — typical polling MoE.
  const SIGMA = 2.0;
  function gauss() {
    // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  const undeclaredCons = state.results2021.constituencies.filter(c =>
    !state.entered.constituencies[c.name]
  );
  const declaredSet = new Set(declared.map(([name]) => name));

  // For each region, the constituency wins from declared seats (fixed)
  const declaredConsWinsByRegion = {};
  for (const r of REGIONS) declaredConsWinsByRegion[r] = zeroParties();
  for (const [name, rec] of declared) {
    const baseline = state.byConstituency[name];
    if (!baseline) continue;
    const w = winnerOf(rec.votes);
    if (w) declaredConsWinsByRegion[baseline.region][w]++;
  }

  // For each region, list-vote handling: if region's list votes were entered,
  // use those (no resampling); otherwise apply UNS to baseline.
  const enteredRegions = {};
  for (const r of REGIONS) {
    const erec = state.entered.regions[r];
    if (erec && totals(erec.listVotes) > 0) {
      enteredRegions[r] = erec.listVotes;
    }
  }

  // Pre-collect baseline list-vote totals + shares per region for speed
  const regionBaseline = {};
  for (const r of REGIONS) {
    const b = state.byRegion[r];
    if (b && b.list_votes) {
      regionBaseline[r] = {
        total: totals(b.list_votes),
        shares: pctOf(b.list_votes),
      };
    }
  }

  // Pre-group undeclared cons by region
  const undeclaredByRegion = {};
  for (const r of REGIONS) undeclaredByRegion[r] = [];
  for (const c of undeclaredCons) undeclaredByRegion[c.region].push(c);

  const samples = { };
  for (const p of PARTIES) samples[p] = new Array(N);

  for (let rep = 0; rep < N; rep++) {
    // Build a sampled mean swing — depending on mode
    const sampledMean = zeroParties();
    const sampledListMean = zeroParties();
    if (useBBS) {
      for (const p of PARTIES) {
        sampledMean[p] = bbsConstSwing[p] + gauss() * SIGMA;
        sampledListMean[p] = bbsListSwing[p] + gauss() * SIGMA;
      }
    } else {
      for (let i = 0; i < declaredSwings.length; i++) {
        const idx = (Math.random() * declaredSwings.length) | 0;
        const sw = declaredSwings[idx];
        for (const p of PARTIES) sampledMean[p] += sw[p];
      }
      for (const p of PARTIES) {
        sampledMean[p] /= declaredSwings.length;
        sampledListMean[p] = sampledMean[p];
      }
    }

    // Constituency seats: declared + projected with this swing
    const consWinsByRegion = {};
    for (const r of REGIONS) consWinsByRegion[r] = copyParties(declaredConsWinsByRegion[r]);
    const constByParty = zeroParties();
    for (const r of REGIONS) {
      for (const p of PARTIES) constByParty[p] += consWinsByRegion[r][p];
    }
    for (const c of undeclaredCons) {
      const proj = {};
      for (const p of PARTIES) proj[p] = Math.max(0, (c.vote_pct[p] || 0) + sampledMean[p]);
      const w = winnerOf(proj);
      if (w) {
        constByParty[w]++;
        consWinsByRegion[c.region][w]++;
      }
    }

    // List seats: per region, d'Hondt
    const listByParty = zeroParties();
    for (const r of REGIONS) {
      let lv;
      if (enteredRegions[r]) {
        lv = enteredRegions[r];
      } else if (regionBaseline[r]) {
        const projShares = {};
        for (const p of PARTIES) projShares[p] = Math.max(0, regionBaseline[r].shares[p] + sampledListMean[p]);
        lv = {};
        for (const p of PARTIES) lv[p] = projShares[p] * regionBaseline[r].total / 100;
      } else continue;
      const seats = dhondtAllocate(lv, consWinsByRegion[r], LIST_PER_REGION);
      for (const p of PARTIES) listByParty[p] += seats[p];
    }

    for (const p of PARTIES) samples[p][rep] = constByParty[p] + listByParty[p];
  }

  // Percentiles
  const perParty = {};
  for (const p of PARTIES) {
    const sorted = samples[p].slice().sort((a, b) => a - b);
    const lo = sorted[Math.floor(N * 0.05)];
    const hi = sorted[Math.floor(N * 0.95) - 1] || sorted[N - 1];
    const median = sorted[Math.floor(N / 2)];
    perParty[p] = { lo, hi, median };
  }
  return { perParty, n: N, declared: declared.length };
}

/* ---------------- Historical seats projection ---------------- */
function computeHistoricalSeats(h) {
  const constituencyByParty = copyParties(h.scotland.constituency_seats);
  const listByParty = copyParties(h.scotland.list_seats);
  const totalByParty = copyParties(h.scotland.seat_totals);
  let leadParty = winnerOf(totalByParty);

  // Per-constituency detail (only for 2011/2016/2021)
  const perConstituency = {};
  if (h.constituencies && h.constituencies.length) {
    for (const c of h.constituencies) {
      perConstituency[c.name] = {
        winner: c.winner, declared: true, vote_pct: c.vote_pct, votes: null,
      };
    }
  }
  // Fill in null records for any constituency missing in this election
  for (const c of state.results2021.constituencies) {
    if (!perConstituency[c.name]) {
      perConstituency[c.name] = { winner: null, declared: false };
    }
  }

  // Per-region detail
  const perRegion = {};
  for (const r of REGIONS) {
    let listSeats = zeroParties();
    let listVotes = zeroParties();
    let listLeader = null;
    let hasData = false;
    if (h.regions) {
      const rec = h.regions.find(x => x.name === r);
      if (rec) {
        listSeats = copyParties(rec.list_seats_won);
        listVotes = copyParties(rec.list_votes);
        listLeader = winnerOf(listVotes);
        hasData = true;
      }
    }
    perRegion[r] = {
      listVotes, listSeats, listLeader, hasData,
      consWins: zeroParties(),
    };
  }

  return {
    constituencyByParty, listByParty, totalByParty,
    perConstituency, perRegion,
    leadParty, leadSeats: totalByParty[leadParty] || 0,
    declaredCount: (h.constituencies || []).length,
    regionCount: (h.regions || []).length,
    listAllocated: PARTIES.reduce((a, p) => a + listByParty[p], 0),
    swing: zeroParties(),
    listSwing: null,
    historical: true, year: h.year,
  };
}

/* ---------------- Hero, status, comparison table ---------------- */
function renderHeroAndStatus(s) {
  const leadEl = $('#lead-party');
  const detailEl = $('#lead-detail');
  const majlineEl = $('#lead-majline');
  const hasBBS = !!(state.predictions && state.predictions.national_projection);
  $('#hero-mode-label').textContent = state.mode === 'projected'
    ? (hasBBS ? 'Projected from BBS poll-of-polls' : 'Projected (UNS from declared)')
    : 'Declared only';

  const allZero = PARTIES.every(p => s.totalByParty[p] === 0);
  if (allZero) {
    leadEl.textContent = '—';
    leadEl.style.color = 'var(--text-1)';
    detailEl.textContent = state.mode === 'projected'
      ? 'Enter at least one declared result to seed the projection'
      : 'No results entered yet';
    majlineEl.textContent = '65 needed for majority';
  } else {
    leadEl.textContent = PARTY_NAMES[s.leadParty];
    leadEl.style.color = partyColor(s.leadParty);
    const margin = s.leadSeats - MAJORITY;
    let detail;
    if (margin >= 0) detail = `Majority government on ${s.leadSeats} seats (+${margin})`;
    else if (margin >= -10) detail = `Largest party on ${s.leadSeats} seats (${Math.abs(margin)} short of majority)`;
    else detail = `Largest party on ${s.leadSeats} seats — minority territory`;
    detailEl.textContent = detail;
    majlineEl.textContent = state.mode === 'projected'
      ? `Projection covers all 73 const + 56 list = 129`
      : `${s.declaredCount} of 73 declared`;
  }

  // Compute CI (only meaningful in projected mode with declared seats)
  const ci = computeProjectionCI();

  // Render hemicycle
  renderHemicycle(s);

  // Legend pills with optional CI band
  const legend = $('#seatbar-legend');
  legend.innerHTML = '';
  const baseline = state.results2021.scotland.seat_totals;
  for (const p of PARTIES) {
    const seats = s.totalByParty[p];
    const baseSeats = baseline[p] || 0;
    const diff = seats - baseSeats;
    const pill = document.createElement('span');
    pill.className = 'seat-pill';
    let arrow = '', cls = 'flat';
    if (diff > 0) { arrow = '+' + diff; cls = 'up'; }
    else if (diff < 0) { arrow = String(diff); cls = 'down'; }
    else { arrow = '±0'; cls = 'flat'; }
    let ciHtml = '';
    if (ci && ci.perParty[p]) {
      const { lo, hi } = ci.perParty[p];
      const tooltipSource = (state.predictions && state.predictions.national_projection)
        ? `90% range from ±2pp polling noise on BBS shares`
        : `90% bootstrap range from ${ci.declared} declared seats`;
      if (lo !== hi) ciHtml = `<span class="ci" title="${tooltipSource}">${lo}–${hi}</span>`;
    }
    pill.innerHTML = `
      <span class="swatch" style="background:${partyColor(p)}"></span>
      <span class="num">${PARTY_NAMES[p]}</span>
      <span class="num mono">${seats}</span>${ciHtml}
      <span class="delta ${cls}">${arrow}</span>`;
    legend.appendChild(pill);
  }

  $('#stat-declared').textContent = s.declaredCount;
  $('#stat-regions').textContent = s.regionCount;
  $('#stat-list-seats').textContent = s.listAllocated || '—';
  $('#progress-bar').style.width = (s.declaredCount / CONSTITUENCY_SEATS * 100) + '%';
  $('#stat-updated').textContent = state.lastUpdated
    ? new Date(state.lastUpdated).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : 'never';
}

function renderCompareTable(s) {
  const tbody = $('#compare-table tbody');
  tbody.innerHTML = '';
  const baseline = state.results2021.scotland;
  const totalCons = zeroParties();
  for (const [name, rec] of Object.entries(state.entered.constituencies)) {
    for (const p of PARTIES) totalCons[p] += rec.votes[p] || 0;
  }
  const consShares = totals(totalCons) > 0 ? pctOf(totalCons) : null;
  const totalList = zeroParties();
  for (const r of REGIONS) {
    const rec = state.entered.regions[r];
    if (rec) for (const p of PARTIES) totalList[p] += rec.listVotes[p] || 0;
  }
  const listShares = totals(totalList) > 0 ? pctOf(totalList) : null;

  for (const p of PARTIES) {
    const baseSeats = baseline.seat_totals[p] || 0;
    const nowSeats = s.totalByParty[p];
    const diff = nowSeats - baseSeats;
    const cls = diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat');
    const arr = diff > 0 ? `+${diff}` : (diff < 0 ? String(diff) : '±0');
    const cVote = consShares ? fmtPct(consShares[p]) : (state.mode === 'projected' ? '<i class="dim">proj</i>' : '<span class="dim">—</span>');
    const lVote = listShares ? fmtPct(listShares[p]) : (state.mode === 'projected' ? '<i class="dim">proj</i>' : '<span class="dim">—</span>');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="party-cell"><span class="sw" style="background:${partyColor(p)}"></span>${PARTY_NAMES[p]}</td>
      <td class="num">${baseSeats}</td>
      <td class="num"><b>${nowSeats}</b></td>
      <td class="num delta ${cls}">${arr}</td>
      <td class="num">${cVote}</td>
      <td class="num">${lVote}</td>`;
    tbody.appendChild(tr);
  }
  const tr = document.createElement('tr');
  tr.style.borderTop = '1px solid var(--line)';
  const totSeats = PARTIES.reduce((a, p) => a + s.totalByParty[p], 0);
  tr.innerHTML = `
    <td class="muted">Total</td>
    <td class="num muted">129</td>
    <td class="num muted">${totSeats}</td>
    <td class="num muted">${TOTAL_SEATS - totSeats === 0 ? 'full' : `${TOTAL_SEATS - totSeats} unfilled`}</td>
    <td class="num muted">${consShares ? '100' : '—'}</td>
    <td class="num muted">${listShares ? '100' : '—'}</td>`;
  tbody.appendChild(tr);
}

/* ---------------- National Swing bars ---------------- */
function renderNationalSwing(s) {
  const wrap = $('#swing-bars');
  if (state.mode === 'projected') {
    const hasBBS = !!(state.predictions && state.predictions.national_projection);
    $('#swing-mode-label').textContent = hasBBS
      ? 'BBS poll-of-polls vs 2021'
      : `Observed swing from ${s.declaredCount}/73 declared`;
  } else {
    $('#swing-mode-label').textContent = `Observed swing from ${s.declaredCount}/73 declared`;
  }

  const swing = s.swing || zeroParties();
  // Compute scale — symmetric ±max(|swing|), min ±5
  const maxAbs = Math.max(5, ...PARTIES.map(p => Math.abs(swing[p])));
  // Order parties by largest absolute swing first for a punchier visual
  const ordered = PARTIES.slice().sort((a, b) => Math.abs(swing[b]) - Math.abs(swing[a]));

  wrap.innerHTML = ordered.map(p => {
    const v = swing[p];
    const cls = v > 0.05 ? 'up' : (v < -0.05 ? 'down' : 'flat');
    const sign = v > 0.05 ? '+' : (v < -0.05 ? '' : '±');
    const widthPct = (Math.abs(v) / maxAbs) * 50;
    const leftPct = v >= 0 ? 50 : (50 - widthPct);
    return `
      <div class="swing-row">
        <div class="lab">
          <span class="sw" style="background:${partyColor(p)}"></span>
          <span class="name">${PARTY_NAMES[p]}</span>
        </div>
        <div class="track">
          <div class="center"></div>
          <div class="bar" style="left:${leftPct}%; width:${widthPct}%; background:${partyColor(p)};"></div>
        </div>
        <div class="val ${cls}">${sign}${Math.abs(v).toFixed(1)}</div>
      </div>`;
  }).join('');

  // Add a faint axis label under the first bar
  if (wrap.firstElementChild) {
    const lab = document.createElement('div');
    lab.style.cssText = 'display:grid; grid-template-columns: 100px 1fr 70px; gap: 12px; font-size: 10px; color: var(--text-3); margin-top: 6px; font-family: JetBrains Mono, monospace;';
    lab.innerHTML = `<span></span><span style="display:flex; justify-content: space-between;"><span>−${maxAbs.toFixed(0)}pp</span><span>0</span><span>+${maxAbs.toFixed(0)}pp</span></span><span></span>`;
    wrap.appendChild(lab);
  }
}

/* ---------------- Key Seats ---------------- */
function renderKeySeats(s) {
  const grid = $('#keyseats-grid');
  if (!state.predictions || !state.predictions.marginals) {
    grid.innerHTML = '<div class="muted" style="font-size:13px;">No predictions data available.</div>';
    return;
  }
  const src = state.predictions.source || 'Ballot Box Scotland';
  $('#keyseats-source').textContent = `Source: ${src.split(';')[0]}`;
  grid.innerHTML = state.predictions.marginals.map(m => {
    const baseline = state.byConstituency[m.name];
    const region = baseline ? baseline.region : '—';
    const rec = s.perConstituency[m.name];
    const currentWinner = rec && rec.winner;
    const declared = rec && rec.declared;
    const projectedFromUNS = rec && rec.projected;

    // Decide STATUS and ACCENT party
    // - declared    → real result entered for this seat (highest confidence)
    // - projected   → either UNS-projected from declared seats, or (no declared yet) the BBS prediction
    // - pending     → no info at all
    let status, accentParty, predDisplay;
    if (declared) {
      status = 'declared';
      accentParty = currentWinner;
      const flipNow = currentWinner !== m.winner_2021;
      predDisplay = `<span class="pred ${flipNow ? 'flip' : 'hold'}">
        <span class="verb">${flipNow ? 'GAIN' : 'HOLD'}</span>
        <span class="pred-sw" style="background:${partyColor(currentWinner)}"></span>${PARTY_NAMES[currentWinner]}</span>`;
    } else if (projectedFromUNS) {
      status = 'projected';
      accentParty = currentWinner;
      const flipNow = currentWinner !== m.winner_2021;
      predDisplay = `<span class="pred ${flipNow ? 'flip' : 'hold'}">
        <span class="verb">${flipNow ? 'PROJ. GAIN' : 'PROJ. HOLD'}</span>
        <span class="pred-sw" style="background:${partyColor(currentWinner)}"></span>${PARTY_NAMES[currentWinner]}</span>`;
    } else if (m.predicted_2026) {
      status = 'projected';
      accentParty = m.predicted_2026;
      const flip2026 = m.predicted_2026 !== m.winner_2021;
      predDisplay = `<span class="pred ${flip2026 ? 'flip' : 'hold'}">
        <span class="verb">${flip2026 ? 'POLL GAIN' : 'POLL HOLD'}</span>
        <span class="pred-sw" style="background:${partyColor(m.predicted_2026)}"></span>${PARTY_NAMES[m.predicted_2026]}</span>`;
    } else {
      status = 'pending';
      accentParty = m.winner_2021;
      predDisplay = `<span class="pred"><span class="verb">PENDING</span></span>`;
    }

    const statusLabel = status === 'declared' ? 'DECLARED'
                      : status === 'projected' ? 'PROJECTION'
                      : 'PENDING';

    const notable = notableFor(m.name);
    const notableBadge = notable
      ? `<span class="notable-badge" title="${(notable.watch_for || '').replace(/"/g, '&quot;')}">★ ${notable.title}</span>` : '';
    const starred = isStarred(m.name);
    return `
      <div class="keyseat-card status-${status}" data-seat="${m.name}" style="--card-accent: ${partyColor(accentParty)};">
        <div class="card-header">
          <div>
            <div class="name">${m.name} ${notableBadge}</div>
            <div class="reg">${region}</div>
          </div>
          <div style="display:flex; gap:4px; align-items:center;">
            <button class="star-btn ${starred ? 'starred' : ''}" data-star="${m.name}" title="${starred ? 'Unpin' : 'Pin'} this seat">${starred ? '★' : '☆'}</button>
            <span class="status-badge ${status}">${statusLabel}</span>
          </div>
        </div>
        <div class="row">
          <span class="sw" style="background:${partyColor(m.winner_2021)}"></span>
          <span class="who">${PARTY_NAMES[m.winner_2021]} <span style="color:var(--text-3); font-size:10px;">— '21 winner</span></span>
          <span class="pct">${fmtPct(m.winner_2021_pct)}</span>
        </div>
        <div class="row">
          <span class="sw" style="background:${partyColor(m.runner_up_2021)}"></span>
          <span class="who">${PARTY_NAMES[m.runner_up_2021]} <span style="color:var(--text-3); font-size:10px;">— challenger</span></span>
          <span class="pct">${fmtPct(m.runner_up_2021_pct)}</span>
        </div>
        <div class="maj">
          <span>Maj: ${fmtPct(m.majority_2021_pct)}</span>
          ${predDisplay}
        </div>
      </div>`;
  }).join('');
  // Click card → open seat modal; click star → toggle pin without opening
  grid.querySelectorAll('.keyseat-card').forEach(c => {
    c.addEventListener('click', e => {
      if (e.target.closest('button[data-star]')) return;
      openSeatModal(c.dataset.seat);
    });
  });
  grid.querySelectorAll('button[data-star]').forEach(b => {
    b.addEventListener('click', e => { e.stopPropagation(); toggleStar(b.dataset.star); });
  });
}

/* ---------------- All Seats Table ---------------- */
function buildAllSeatsRows(s) {
  const rows = [];
  for (const c of state.results2021.constituencies) {
    const baseline = c;
    const rec = s.perConstituency[c.name];
    const w21 = baseline.winner;
    const m21 = baseline.vote_pct ? (() => {
      const sorted = PARTIES.map(p => [p, baseline.vote_pct[p] || 0]).sort((a, b) => b[1] - a[1]);
      return sorted[0][1] - sorted[1][1];
    })() : null;
    const wnow = rec && rec.winner;
    const pctNow = rec && rec.vote_pct ? rec.vote_pct[wnow] : null;
    const swing = (rec && rec.vote_pct && baseline.vote_pct && wnow)
      ? ((rec.vote_pct[wnow] || 0) - (baseline.vote_pct[wnow] || 0))
      : null;
    let status = 'pending';
    if (rec && rec.declared) status = 'declared';
    else if (rec && rec.projected) status = 'projected';
    rows.push({
      kind: 'CON', name: c.name, region: c.region,
      w21, m21, wnow, pctnow: pctNow, swing, status,
      flip: wnow && wnow !== w21,
    });
  }
  for (const r of REGIONS) {
    const baseline = state.byRegion[r];
    const rec = s.perRegion[r];
    const w21 = baseline ? winnerOf(baseline.list_votes) : null;
    const m21 = baseline ? (() => {
      const t = totals(baseline.list_votes);
      const sorted = PARTIES.map(p => [p, ((baseline.list_votes[p] || 0) / t * 100)]).sort((a, b) => b[1] - a[1]);
      return sorted[0][1] - sorted[1][1];
    })() : null;
    const wnow = rec && rec.listLeader;
    const pctNow = rec && rec.hasData ? pctOf(rec.listVotes)[wnow] : null;
    const swing = (rec && rec.hasData && baseline && wnow)
      ? (pctOf(rec.listVotes)[wnow] - pctOf(baseline.list_votes)[wnow])
      : null;
    let status = 'pending';
    const enteredR = state.entered.regions[r];
    if (enteredR && totals(enteredR.listVotes) > 0) status = 'declared';
    else if (rec && rec.hasData) status = 'projected';
    rows.push({
      kind: 'REG', name: r, region: r,
      w21, m21, wnow, pctnow: pctNow, swing, status,
      flip: wnow && wnow !== w21,
    });
  }
  return rows;
}

function renderAllSeatsTable(s) {
  const rows = buildAllSeatsRows(s);
  const f = (state.table.filter || '').toLowerCase().trim();
  let visible = f
    ? rows.filter(r => r.name.toLowerCase().includes(f) || r.region.toLowerCase().includes(f) || (r.w21 || '').toLowerCase().includes(f))
    : rows;

  // Sort
  const dir = state.table.sortDir === 'asc' ? 1 : -1;
  const k = state.table.sortKey;
  visible.sort((a, b) => {
    let av = a[k], bv = b[k];
    // Map kind for nicer order: CON first then REG
    if (k === 'kind') { av = a.kind; bv = b.kind; }
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });

  $('#seats-count').textContent = `${visible.length} of ${rows.length} rows`;

  const tbody = $('#seats-table tbody');
  tbody.innerHTML = visible.map(r => {
    const w21Pill = r.w21
      ? `<span class="party-pill"><span class="sw" style="background:${partyColor(r.w21)}"></span>${PARTY_NAMES[r.w21]}</span>`
      : '<span class="muted">—</span>';
    const wnowPill = r.wnow
      ? `<span class="party-pill"><span class="sw" style="background:${partyColor(r.wnow)}"></span>${PARTY_NAMES[r.wnow]}</span>${r.flip ? ' <span style="color:var(--warn); font-size:10px; font-weight:700;">⇆</span>' : ''}`
      : '<span class="muted">—</span>';
    const swingCell = r.swing != null
      ? `<span class="swing-cell ${r.swing > 0 ? 'up' : (r.swing < 0 ? 'down' : '')}">${fmtSigned(r.swing)}</span>`
      : '<span class="muted">—</span>';
    const statusBadge = r.status === 'declared'
      ? '<span class="badge dec">declared</span>'
      : (r.status === 'projected'
          ? '<span class="badge proj">projected</span>'
          : '<span class="badge pend">pending</span>');
    return `<tr data-name="${r.name}" data-kind="${r.kind}" class="${r.flip ? 'row-flip' : ''}">
      <td><span class="row-kind">${r.kind === 'CON' ? 'Const.' : 'Region'}</span></td>
      <td><b>${r.name}</b></td>
      <td class="muted">${r.region === r.name ? '—' : r.region}</td>
      <td>${w21Pill}</td>
      <td class="num">${r.m21 != null ? fmtPct(r.m21) : '—'}</td>
      <td>${wnowPill}</td>
      <td class="num">${r.pctnow != null ? fmtPct(r.pctnow) : '—'}</td>
      <td class="num">${swingCell}</td>
      <td class="status-cell">${statusBadge}</td>
    </tr>`;
  }).join('');
  // Click row → open modal
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      if (tr.dataset.kind === 'CON') openSeatModal(tr.dataset.name);
      else openRegionModal(tr.dataset.name);
    });
  });
  // Mark sort indicator
  $$('#seats-table thead th').forEach(th => {
    const k2 = th.dataset.sort;
    th.classList.toggle('active', k2 === k);
    if (k2 === k) {
      th.dataset.dir = state.table.sortDir;
    }
  });
}

/* ---------------- Maps ---------------- */
let projectionFns = {};
// Attach pan/zoom behaviour to an SVG. All map content goes inside a single
// transform group so wheel/drag/double-click only changes that group, not
// the whole SVG (so SVG-relative things like overlays still work). Returns
// the zoom group + the d3.zoom behaviour so we can reset programmatically.
const _zoomBehaviours = {};
function attachZoom(svgSelector) {
  const svg = d3.select(svgSelector);
  // Single child group for all zoomable content.
  let zoomG = svg.select('g.zoom-g');
  if (zoomG.empty()) zoomG = svg.append('g').attr('class', 'zoom-g');

  const zoom = d3.zoom()
    .scaleExtent([1, 8])
    .filter((event) => {
      // Allow wheel + drag + dblclick. Block right-click, ctrl-click, and
      // touch events that originate on a clickable feature so seat modals
      // still open. d3.zoom by default ignores touchstart on non-passive
      // listeners which can fight scroll on mobile — keep the default.
      if (event.type === 'mousedown' && event.button !== 0) return false;
      return !event.ctrlKey || event.type === 'wheel';
    })
    .on('zoom', (e) => {
      zoomG.attr('transform', e.transform);
    });

  svg.call(zoom);
  // Double-click already zooms in by default; preserve that.
  _zoomBehaviours[svgSelector] = { svg, zoom, zoomG };
  return zoomG;
}

function resetMapZoom(svgSelector) {
  const z = _zoomBehaviours[svgSelector];
  if (!z) return;
  z.svg.transition().duration(400).call(z.zoom.transform, d3.zoomIdentity);
}

// Zoom by a multiplier (1.5 = zoom in, 1/1.5 = zoom out). Smoothly animated.
// Anchors the zoom on the visible centre of the SVG so it feels like a
// natural zoom-in-place rather than drifting toward (0,0).
function zoomMapBy(svgSelector, factor) {
  const z = _zoomBehaviours[svgSelector];
  if (!z) return;
  z.svg.transition().duration(200).call(z.zoom.scaleBy, factor);
}

function setupMaps() {
  const spc = topojson.feature(state.topo, state.topo.objects.spc);
  const sper = topojson.feature(state.topo, state.topo.objects.sper);

  const svgSpc = d3.select('#map-spc');
  const svgSper = d3.select('#map-sper');
  const W = 600, H = 620;

  const projection = d3.geoMercator().fitExtent([[8, 8], [W - 8, H - 8]], spc);
  const path = d3.geoPath(projection);
  projectionFns.spc = path;

  const projectionR = d3.geoMercator().fitExtent([[8, 8], [W - 8, H - 8]], spc);
  const pathR = d3.geoPath(projectionR);
  projectionFns.sper = pathR;

  // Wrap both maps in zoom groups
  const zoomGSpc = attachZoom('#map-spc');
  const zoomGSper = attachZoom('#map-sper');

  const cg = zoomGSpc.append('g').attr('class', 'cg');
  cg.selectAll('path')
    .data(spc.features)
    .join('path')
    .attr('class', 'map-feat empty')
    .attr('d', path)
    .attr('data-name', d => d.properties.NAME)
    .on('mouseenter', (e, d) => onConstituencyHover(e, d))
    .on('mousemove', positionTooltip)
    .on('mouseleave', hideTooltip)
    .on('click', (e, d) => openSeatModal(d.properties.NAME));

  const rgOnSpc = zoomGSpc.append('g').attr('class', 'rg-overlay');
  rgOnSpc.selectAll('path')
    .data(sper.features)
    .join('path')
    .attr('d', path)
    .attr('fill', 'none')
    .attr('stroke', '#0a0e14')
    .attr('stroke-width', 1.6)
    .attr('pointer-events', 'none');

  // Neutral grey region polygons — colour comes from the dot panels instead
  const rg = zoomGSper.append('g').attr('class', 'rg');
  rg.selectAll('path')
    .data(sper.features)
    .join('path')
    .attr('class', 'region-poly-base')
    .attr('d', pathR)
    .attr('data-name', d => d.properties.NAME)
    .on('mouseenter', (e, d) => onRegionHover(e, d))
    .on('mousemove', positionTooltip)
    .on('mouseleave', hideTooltip)
    .on('click', (e, d) => openRegionModal(d.properties.NAME));

  // Compute centroid + dot-panel anchor for each region; central belt
  // regions get manual offsets so their panels don't overlap.
  // Offsets are in viewBox pixels relative to region centroid.
  const REGION_PANEL_OFFSET = {
    'Highlands and Islands':  [  0,  10],
    'North East Scotland':    [ 30,   0],
    'Mid Scotland and Fife':  [-50,   0],
    'South Scotland':         [  0,  20],
    'Central Scotland':       [ 95, -10],
    'Glasgow':                [-90,  35],
    'Lothian':                [110,  60],
    'West Scotland':          [-90, -20],
  };
  state.regionPanelAnchors = {};
  for (const f of sper.features) {
    const name = f.properties.NAME;
    const [cx, cy] = pathR.centroid(f);
    const [dx, dy] = REGION_PANEL_OFFSET[name] || [0, 0];
    state.regionPanelAnchors[name] = {
      centroid: [cx, cy],
      panel: [cx + dx, cy + dy],
    };
  }
}

/* ---------------- Hex grid map ---------------- */
function setupHexMap() {
  if (!state.hexLayout) return;
  const svg = d3.select('#map-spc-hex');
  svg.selectAll('*').remove();

  const W = 600, H = 620;
  const cells = Object.entries(state.hexLayout); // [name, [col, row]]
  if (!cells.length) return;
  const cols = cells.map(([, p]) => p[0]);
  const rows = cells.map(([, p]) => p[1]);
  const maxCol = Math.max(...cols), maxRow = Math.max(...rows);

  // Pointy-top hex sizing — odd-r offset
  // Available pixel area: W × H with margin
  const margin = 18;
  const availW = W - margin * 2;
  const availH = H - margin * 2;
  const sizeX = availW / (maxCol + 1.5);   // hex width
  const sizeY = availH / (maxRow + 1) / 0.866;
  const size = Math.min(sizeX, sizeY) * 0.55;
  const hexW = size * Math.sqrt(3);
  const hexH = size * 2;
  const offsetY = hexH * 0.75;

  // Total layout dimensions to centre
  const totalW = (maxCol + 1.5) * hexW;
  const totalH = (maxRow + 1) * offsetY + hexH * 0.25;
  const offX = (W - totalW) / 2 + hexW * 0.5;
  const offY = (H - totalH) / 2 + hexH * 0.5;

  function hexPath(cx, cy, s) {
    // Pointy-top hex
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 3 * i + Math.PI / 6;  // 30°, 90°, 150°, 210°, 270°, 330°
      pts.push([cx + s * Math.cos(angle), cy + s * Math.sin(angle)]);
    }
    return 'M' + pts.map(p => p.join(',')).join('L') + 'Z';
  }
  function pos(col, row) {
    const x = offX + col * hexW + (row % 2) * (hexW / 2);
    const y = offY + row * offsetY;
    return [x, y];
  }

  // Wrap hex content in a zoom group + attach pan/zoom behaviour.
  const zoomG = attachZoom('#map-spc-hex');
  const g = zoomG.append('g').attr('class', 'hex-g');
  cells.forEach(([name, [col, row]]) => {
    const [x, y] = pos(col, row);
    const path = g.append('path')
      .attr('class', 'hex-cell empty')
      .attr('d', hexPath(x, y, size))
      .attr('data-name', name)
      .on('mouseenter', e => onConstituencyHoverByName(e, name))
      .on('mousemove', positionTooltip)
      .on('mouseleave', hideTooltip)
      .on('click', () => openSeatModal(name));

    // Label — short abbreviation
    const abbr = abbrevSeat(name);
    g.append('text')
      .attr('class', 'hex-label')
      .attr('x', x).attr('y', y + 2)
      .text(abbr);
  });
}

function abbrevSeat(name) {
  // Try 3-letter codes that distinguish similar seats
  const SHORT = {
    'Glasgow Anniesland': 'GLA-A',
    'Glasgow Cathcart': 'GLA-C',
    'Glasgow Kelvin': 'GLA-K',
    'Glasgow Maryhill and Springburn': 'GLA-M',
    'Glasgow Pollok': 'GLA-P',
    'Glasgow Provan': 'GLA-Pr',
    'Glasgow Shettleston': 'GLA-S',
    'Glasgow Southside': 'GLA-So',
    'Edinburgh Central': 'EDI-C',
    'Edinburgh Eastern': 'EDI-E',
    'Edinburgh Northern and Leith': 'EDI-N',
    'Edinburgh Pentlands': 'EDI-Pe',
    'Edinburgh Southern': 'EDI-So',
    'Edinburgh Western': 'EDI-W',
    'Aberdeen Central': 'ABE-C',
    'Aberdeen Donside': 'ABE-D',
    'Aberdeen South and North Kincardine': 'ABE-S',
    'Aberdeenshire East': 'ABS-E',
    'Aberdeenshire West': 'ABS-W',
    'Angus North and Mearns': 'ANG-N',
    'Angus South': 'ANG-S',
    'Dundee City East': 'DUN-E',
    'Dundee City West': 'DUN-W',
    'Falkirk East': 'FAL-E',
    'Falkirk West': 'FAL-W',
    'Cunninghame North': 'CUN-N',
    'Cunninghame South': 'CUN-S',
    'Renfrewshire North and West': 'REN-N',
    'Renfrewshire South': 'REN-S',
    'Perthshire North': 'PER-N',
    'Perthshire South and Kinross-shire': 'PER-S',
    'Mid Fife and Glenrothes': 'MID-F',
    'Midlothian North and Musselburgh': 'MID-N',
    'Midlothian South, Tweeddale and Lauderdale': 'MID-S',
    'North East Fife': 'NE-F',
    'Na h-Eileanan an Iar': 'EIL',
  };
  if (SHORT[name]) return SHORT[name];
  // Default: first 3 letters of first word
  return name.split(/[\s,]/)[0].slice(0, 4).toUpperCase();
}

function onConstituencyHoverByName(e, name) {
  const feature = { properties: { NAME: name } };
  onConstituencyHover(e, feature);
}

function paintHexMap(s) {
  d3.selectAll('#map-spc-hex .hex-cell').each(function() {
    const name = this.getAttribute('data-name');
    const rec = s.perConstituency[name];
    const node = d3.select(this);
    if (!rec || !rec.winner) {
      node.attr('class', 'hex-cell empty').style('fill', null);
      return;
    }
    const cls = rec.declared ? 'hex-cell' : 'hex-cell proj';
    node.attr('class', cls).style('fill', partyColor(rec.winner));
  });
}

function setSpcMapView(view) {
  state.spcMapView = view;
  $('#map-spc-geo-wrap').style.display = view === 'geo' ? '' : 'none';
  $('#map-spc-hex-wrap').style.display = view === 'hex' ? '' : 'none';
  $$('#map-spc-toggle button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}

function paintMaps(s) {
  paintHexMap(s);
  d3.selectAll('#map-spc .cg path').each(function(d) {
    const name = d.properties.NAME;
    const rec = s.perConstituency[name];
    const node = d3.select(this);
    if (!rec || !rec.winner) {
      node.attr('class', 'map-feat empty').style('fill', null);
      return;
    }
    const cls = rec.declared ? 'map-feat' : 'map-feat proj';
    node.attr('class', cls).style('fill', partyColor(rec.winner));
  });
  // Region polygons stay neutral; dot panels carry the seat info.
  paintRegionDots(s);
}

/**
 * Render the per-region list-seat dot panels.
 * Each region gets a small floating panel: region label on top, then 7 dots
 * (4 + 3 layout) coloured by the party that won each list seat.
 *
 * Allocation order: HEMICYCLE_PARTY_ORDER (left-to-right political ordering)
 * so the panels read consistently with the hemicycle.
 */
function paintRegionDots(s) {
  // Render into the zoom group so dots pan/zoom with the map polygons.
  const svg = d3.select('#map-sper');
  let zoomG = svg.select('g.zoom-g');
  if (zoomG.empty()) zoomG = svg;     // fallback for tests
  zoomG.select('g.region-overlay').remove();
  if (!state.regionPanelAnchors) return;

  const layer = zoomG.append('g').attr('class', 'region-overlay');

  for (const region of REGIONS) {
    const anchor = state.regionPanelAnchors[region];
    if (!anchor) continue;
    const rec = s.perRegion[region];
    const [px, py] = anchor.panel;
    const [cx, cy] = anchor.centroid;

    // Build dot list — sorted by political position so chips read consistently
    const dots = [];
    if (rec && rec.hasData) {
      for (const p of HEMICYCLE_PARTY_ORDER) {
        const n = (rec.listSeats && rec.listSeats[p]) || 0;
        for (let i = 0; i < n; i++) dots.push(p);
      }
    }
    while (dots.length < LIST_PER_REGION) dots.push(null);

    // Layout: 2 rows of 4 + 3 (4 on top, 3 centred below)
    const dotR = 5.2;
    const spacing = 13;
    const titleH = 12;
    const padX = 10;
    const padY = 6;
    const panelW = 4 * spacing + padX;
    const panelH = titleH + 2 * spacing + padY;
    const x0 = px - panelW / 2;
    const y0 = py - panelH / 2;

    // Leader line from panel edge to centroid (only for offset panels)
    if (Math.hypot(px - cx, py - cy) > 12) {
      layer.append('line')
        .attr('class', 'region-leader')
        .attr('x1', cx).attr('y1', cy)
        .attr('x2', px).attr('y2', py);
    }

    // Background pill
    layer.append('rect')
      .attr('class', 'region-panel-bg')
      .attr('x', x0).attr('y', y0)
      .attr('width', panelW).attr('height', panelH)
      .attr('rx', 6).attr('ry', 6);

    // Region label inside the panel
    const shortName = region.replace('Highlands and Islands', 'H. & Islands').replace('Mid Scotland and Fife', 'Mid & Fife').replace('North East Scotland', 'NE Scotland').replace('Central Scotland', 'Central').replace('South Scotland', 'South').replace('West Scotland', 'West');
    layer.append('text')
      .attr('class', 'region-panel-title')
      .attr('x', px)
      .attr('y', y0 + titleH)
      .text(shortName);

    // Dot rows: 4 on top, 3 centred below
    const rows = [dots.slice(0, 4), dots.slice(4, 7)];
    rows.forEach((rowDots, rowIdx) => {
      const rowOffsetX = (4 - rowDots.length) * spacing / 2;
      const rowY = y0 + titleH + 6 + rowIdx * (dotR * 2 + 2);
      rowDots.forEach((p, i) => {
        const dx = x0 + padX / 2 + (i + 0.5) * spacing + rowOffsetX;
        const isProj = !!(rec && rec.hasData && !(state.entered.regions[region] && totals(state.entered.regions[region].listVotes) > 0));
        layer.append('circle')
          .attr('class', p ? 'region-seat-dot' : 'region-seat-dot empty')
          .attr('cx', dx).attr('cy', rowY)
          .attr('r', dotR)
          .attr('fill', p ? partyColor(p) : null)
          .attr('opacity', isProj ? 0.65 : 1);
      });
    });

    // Make the whole panel clickable to open the region modal
    layer.append('rect')
      .attr('x', x0).attr('y', y0)
      .attr('width', panelW).attr('height', panelH)
      .attr('fill', 'transparent')
      .style('cursor', 'pointer')
      .on('mouseenter', e => onRegionHoverByName(e, region))
      .on('mousemove', positionTooltip)
      .on('mouseleave', hideTooltip)
      .on('click', () => openRegionModal(region));
  }
}

function onRegionHoverByName(e, name) {
  const feature = { properties: { NAME: name } };
  onRegionHover(e, feature);
}

/* ---------------- Tooltip ---------------- */
function showTooltip(html, e) {
  const t = $('#tooltip');
  t.innerHTML = html;
  t.classList.add('show');
  positionTooltip(e);
}
function hideTooltip() { $('#tooltip').classList.remove('show'); }
function positionTooltip(e) {
  const t = $('#tooltip');
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  const tw = t.offsetWidth, th = t.offsetHeight;
  if (x + tw > window.innerWidth - 6) x = e.clientX - tw - pad;
  if (y + th > window.innerHeight - 6) y = e.clientY - th - pad;
  t.style.left = x + 'px';
  t.style.top = y + 'px';
}
function onConstituencyHover(e, d) {
  const name = d.properties.NAME;
  const baseline = state.byConstituency[name];
  const seats = computeSeats();
  const rec = seats.perConstituency[name];
  const region = baseline ? baseline.region : '';
  let html = `<h4>${name}</h4><div class="reg">${region} region</div>`;
  if (rec && rec.declared) html += `<div class="row"><span>Status</span><b style="color:var(--good)">DECLARED</b></div>`;
  else if (rec && rec.projected) html += `<div class="row"><span>Status</span><b style="color:var(--warn)">Projected (UNS)</b></div>`;
  else html += `<div class="row"><span>Status</span><b>Not yet declared</b></div>`;
  if (rec && rec.winner) html += `<div class="row"><span class="ptag"><span class="sw" style="background:${partyColor(rec.winner)}"></span>Leader</span><b>${PARTY_NAMES[rec.winner]}</b></div>`;
  if (rec && rec.vote_pct) {
    const sorted = PARTIES.map(p => [p, rec.vote_pct[p]]).filter(([,v]) => v > 0.5).sort((a, b) => b[1] - a[1]);
    for (const [p, v] of sorted) html += `<div class="row"><span class="ptag"><span class="sw" style="background:${partyColor(p)}"></span>${PARTY_NAMES[p]}</span><b>${fmtPct(v)}</b></div>`;
  }
  if (baseline) html += `<div class="meta">2021: <b style="color:${partyColor(baseline.winner)}">${PARTY_NAMES[baseline.winner]} hold</b> · turnout ${baseline.turnout_pct ?? '—'}%<br/><span style="color:var(--text-3)">Click to enter or edit results</span></div>`;
  showTooltip(html, e);
}
function onRegionHover(e, d) {
  const name = d.properties.NAME;
  const seats = computeSeats();
  const rec = seats.perRegion[name];
  const baseline = state.byRegion[name];
  let html = `<h4>${name}</h4><div class="reg">7 list seats</div>`;
  if (rec && rec.hasData) {
    const isDecl = !!(state.entered.regions[name] && totals(state.entered.regions[name].listVotes) > 0);
    html += `<div class="row"><span>Status</span><b style="color:${isDecl ? 'var(--good)' : 'var(--warn)'}">${isDecl ? 'List declared' : 'Projected'}</b></div>`;
    html += `<div class="row"><span class="ptag"><span class="sw" style="background:${partyColor(rec.listLeader)}"></span>List leader</span><b>${PARTY_NAMES[rec.listLeader]}</b></div>`;
    const shares = pctOf(rec.listVotes);
    const sorted = PARTIES.map(p => [p, shares[p], rec.listSeats[p]]).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]);
    for (const [p, v, n] of sorted) html += `<div class="row"><span class="ptag"><span class="sw" style="background:${partyColor(p)}"></span>${PARTY_NAMES[p]}</span><b>${fmtPct(v)} · ${n} list</b></div>`;
  } else {
    html += `<div class="row"><span>Status</span><b>No list votes entered</b></div>`;
    if (baseline && baseline.list_seats_won) {
      html += `<div class="meta">2021 list seats:<br/>` +
        PARTIES.filter(p => baseline.list_seats_won[p]).map(p => `${PARTY_NAMES[p]} ${baseline.list_seats_won[p]}`).join(' · ') + `</div>`;
    }
  }
  showTooltip(html, e);
}

/* ---------------- Per-seat modal (rich) ---------------- */
function openSeatModal(name) {
  const baseline = state.byConstituency[name];
  if (!baseline) return;
  state.modalSeat = name;
  const back = $('#seat-modal-back');
  $('#seat-modal-name-text').textContent = name;
  $('#seat-modal-region').textContent = `${baseline.region} region · turnout 2021: ${baseline.turnout_pct ?? '—'}%`;
  // Star state
  const starBtn = $('#seat-modal-star');
  if (starBtn) {
    const starred = isStarred(name);
    starBtn.textContent = starred ? '★' : '☆';
    starBtn.classList.toggle('starred', starred);
    starBtn.title = starred ? 'Remove from watch list' : 'Add to watch list';
    starBtn.onclick = () => { toggleStar(name); openSeatModal(name); };
  }
  // Notable callout
  const notable = notableFor(name);
  const noteEl = $('#seat-modal-notable');
  if (noteEl) {
    if (notable) {
      noteEl.innerHTML = `<div class="notable-callout">
        <div class="ntitle">★ ${notable.title}</div>
        <div class="nbody">${notable.watch_for}</div>
      </div>`;
    } else {
      noteEl.innerHTML = '';
    }
  }

  const entered = state.entered.constituencies[name];
  // Pre-fill the inline entry form inside the modal
  $$('#seat-modal-back .vote-grid input').forEach(i => {
    const p = i.dataset.party;
    i.value = entered ? (entered.votes[p] || '') : '';
  });

  renderSeatModalCompare(name);

  back.classList.add('show');
  setTimeout(() => $$('#seat-modal-back .vote-grid input')[0]?.focus(), 50);
}
function closeSeatModal() { $('#seat-modal-back').classList.remove('show'); state.modalSeat = null; }

function renderSeatModalCompare(name) {
  const baseline = state.byConstituency[name];
  const entered = state.entered.constituencies[name];
  const baseSh = baseline.vote_pct || zeroParties();
  const [top1, top2] = topTwo(baseSh);

  // 2021 panel
  const t21 = $('#seat-modal-2021 tbody');
  const sorted21 = PARTIES.map(p => [p, baseSh[p] || 0]).sort((a, b) => b[1] - a[1]);
  t21.innerHTML = sorted21.map(([p, v]) => {
    const isWin = p === top1[0];
    const isRun = p === top2[0];
    const badge = isWin ? '<span class="badge win">Won</span>' : (isRun ? '<span class="badge run">Runner-up</span>' : '');
    return `<div class="row ${isWin ? 'winner' : ''}">
      <div class="who"><span class="sw" style="background:${partyColor(p)}"></span>${PARTY_NAMES[p]} ${badge}</div>
      <div class="pct">${fmtPct(v)}</div>
      <div class="change"></div>
    </div>`;
  }).join('');

  // Now panel
  const tnow = $('#seat-modal-now tbody');
  const headerLabel = $('#seat-modal-now-label');
  let nowSh = null;
  let nowDeclared = false;
  if (entered) {
    nowSh = pctOf(entered.votes);
    nowDeclared = true;
    headerLabel.textContent = 'Declared';
    headerLabel.style.color = 'var(--good)';
  } else if (state.mode === 'projected') {
    const swing = computeUNSwing();
    const proj = projectConstituency(name, swing);
    nowSh = proj ? proj.vote_pct : null;
    headerLabel.textContent = 'Projected';
    headerLabel.style.color = 'var(--warn)';
  } else {
    headerLabel.textContent = 'Pending';
    headerLabel.style.color = 'var(--text-3)';
  }
  if (!nowSh) {
    tnow.innerHTML = `<div style="padding:18px 0; text-align:center; color:var(--text-3); font-size:12px;">No current data — enter votes below or switch to Projected mode</div>`;
  } else {
    const [n1, n2] = topTwo(nowSh);
    const sortedNow = PARTIES.map(p => [p, nowSh[p] || 0]).sort((a, b) => b[1] - a[1]);
    tnow.innerHTML = sortedNow.map(([p, v]) => {
      const change = (v || 0) - (baseSh[p] || 0);
      const cls = change > 0.05 ? 'up' : (change < -0.05 ? 'down' : '');
      const isWin = p === n1[0];
      const isRun = p === n2[0];
      const badge = isWin ? '<span class="badge win">Win</span>' : (isRun ? '<span class="badge run">Runner-up</span>' : '');
      return `<div class="row ${isWin ? 'winner' : ''}">
        <div class="who"><span class="sw" style="background:${partyColor(p)}"></span>${PARTY_NAMES[p]} ${badge}</div>
        <div class="pct">${fmtPct(v)}</div>
        <div class="change ${cls}">${fmtSigned(change)}</div>
      </div>`;
    }).join('');
  }

  // Sky-style dial swingometer for the 2-party headline contest
  renderSeatDial(name);

  // Swingometer for this seat (per-party shifts)
  const swEl = $('#seat-modal-swingometer');
  if (!nowSh) {
    swEl.innerHTML = `<div class="muted" style="font-size:12px; text-align:center;">Swing chart appears once results are entered or projection is on.</div>`;
  } else {
    const swings = PARTIES.map(p => [p, (nowSh[p] || 0) - (baseSh[p] || 0)]);
    const maxAbs = Math.max(3, ...swings.map(([, v]) => Math.abs(v)));
    swings.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    swEl.innerHTML = `
      <h4>Swing in ${name} (vs 2021)</h4>
      <div class="swing-bars" style="margin-top: 4px;">
        ${swings.map(([p, v]) => {
          const cls = v > 0.05 ? 'up' : (v < -0.05 ? 'down' : 'flat');
          const sign = v > 0.05 ? '+' : (v < -0.05 ? '' : '±');
          const widthPct = (Math.abs(v) / maxAbs) * 50;
          const leftPct = v >= 0 ? 50 : (50 - widthPct);
          return `<div class="swing-row">
            <div class="lab"><span class="sw" style="background:${partyColor(p)}"></span><span class="name">${PARTY_NAMES[p]}</span></div>
            <div class="track"><div class="center"></div><div class="bar" style="left:${leftPct}%; width:${widthPct}%; background:${partyColor(p)};"></div></div>
            <div class="val ${cls}">${sign}${Math.abs(v).toFixed(1)}</div>
          </div>`;
        }).join('')}
      </div>`;
  }
}

/* ---------------- Sky-style 2-party dial swingometer ---------------- */
/**
 * Render a semi-circle swingometer for the top-two 2021 parties in this seat.
 *  - Left half coloured for the 2021 winner.
 *  - Right half coloured for the 2021 runner-up.
 *  - Tipping line marks the swing required for the seat to flip.
 *  - Needle points to the actual two-party swing in current/projected results.
 *
 * Two-party swing convention (UK psephology):
 *   swing FROM A TO B  =  ((curB% − curA%) − (oldB% − oldA%)) / 2
 *   positive swing = movement toward B (the runner-up).
 *   The seat flips when swing > tippingSwing = (oldA% − oldB%) / 2.
 */
function renderSeatDial(seatName) {
  const el = $('#seat-modal-dial');
  if (!el) return;
  const baseline = state.byConstituency[seatName];
  if (!baseline || !baseline.vote_pct) {
    el.innerHTML = '<div class="muted" style="font-size:12px;">No 2021 baseline for this seat.</div>';
    return;
  }
  const baseSh = baseline.vote_pct;
  const sorted = PARTIES.map(p => [p, baseSh[p] || 0]).sort((a, b) => b[1] - a[1]);
  const [winnerParty, winnerPct] = sorted[0];
  const [runnerParty, runnerPct] = sorted[1];
  const tippingSwing = (winnerPct - runnerPct) / 2;

  // Get current shares (declared > projected > none)
  const entered = state.entered.constituencies[seatName];
  let nowSh = null;
  let isProjected = false;
  if (entered) {
    nowSh = pctOf(entered.votes);
  } else if (state.mode === 'projected') {
    const swing = computeUNSwing();
    const proj = projectConstituency(seatName, swing);
    if (proj) { nowSh = proj.vote_pct; isProjected = true; }
  }

  let currentSwing = null;
  let stillWinner = true;
  if (nowSh) {
    const cw = nowSh[winnerParty] || 0;
    const cr = nowSh[runnerParty] || 0;
    currentSwing = ((cr - cw) - (runnerPct - winnerPct)) / 2;
    stillWinner = currentSwing < tippingSwing;
  }

  // Auto-scale: at least ±10pp; scale needs to comfortably fit the needle
  const scale = Math.max(10, Math.ceil(Math.max(
    Math.abs(currentSwing || 0) + 2,
    Math.abs(tippingSwing) + 2,
    8
  ) / 5) * 5);

  // SVG layout
  const W = 460, H = 250;
  const cx = W / 2, cy = H - 38;
  const rOuter = 165;
  const rInner = 80;

  const ang = pp => (pp / scale) * (Math.PI / 2);  // -π/2 .. +π/2
  const pos = (pp, radius) => ({
    x: cx + radius * Math.sin(ang(pp)),
    y: cy - radius * Math.cos(ang(pp)),
  });

  // Two arc paths — winner (left) and runner-up (right)
  const arcGen = d3.arc().innerRadius(rInner).outerRadius(rOuter);
  const winnerArc = arcGen({ startAngle: -Math.PI / 2, endAngle: 0 });
  const runnerArc = arcGen({ startAngle: 0, endAngle: Math.PI / 2 });

  // Tick marks every 5pp
  const ticks = [];
  for (let pp = -scale; pp <= scale; pp += 5) ticks.push(pp);

  // Needle endpoint clamped to scale
  const needleSwing = currentSwing == null ? null
    : Math.max(-scale, Math.min(scale, currentSwing));

  // Verdict text + colour
  let verdictHtml = '';
  let verdictClass = 'verdict';
  if (currentSwing == null) {
    verdictHtml = `<span class="verdict" style="color: var(--text-2);">Awaiting result</span>`;
  } else if (stillWinner) {
    verdictHtml = `<span class="verdict" style="color: ${partyColor(winnerParty)};">${PARTY_NAMES[winnerParty]} HOLD</span>`;
  } else {
    verdictHtml = `<span class="verdict" style="color: ${partyColor(runnerParty)};">${PARTY_NAMES[runnerParty]} GAIN</span>`;
  }

  // Build the SVG
  const svg = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="dial-bg" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.05)"/>
          <stop offset="100%" stop-color="rgba(0,0,0,0.05)"/>
        </linearGradient>
      </defs>

      <!-- Two coloured arc halves -->
      <g transform="translate(${cx},${cy})">
        <path d="${winnerArc}" fill="${partyColor(winnerParty)}" opacity="0.78"/>
        <path d="${runnerArc}" fill="${partyColor(runnerParty)}" opacity="0.78"/>
        <path d="${winnerArc}" fill="url(#dial-bg)"/>
        <path d="${runnerArc}" fill="url(#dial-bg)"/>
      </g>

      <!-- Tick marks (drawn before labels so labels overlay nicely) -->
      ${ticks.map(pp => {
        const inner = pos(pp, rOuter - 4);
        const outer = pos(pp, rOuter + 4);
        const lab = pos(pp, rOuter + 16);
        return `<line class="scale-tick" x1="${inner.x}" y1="${inner.y}" x2="${outer.x}" y2="${outer.y}"/>
          <text class="scale-label" x="${lab.x}" y="${lab.y + 3}" text-anchor="middle">${pp > 0 ? '+' + pp : pp}</text>`;
      }).join('')}

      <!-- Curved party labels — bold white with strong dark stroke for contrast -->
      <text class="arc-label" x="${pos(-scale * 0.55, (rOuter + rInner) / 2).x}" y="${pos(-scale * 0.55, (rOuter + rInner) / 2).y + 4}" text-anchor="middle">${PARTY_NAMES[winnerParty].toUpperCase()} HOLD</text>
      <text class="arc-label" x="${pos(scale * 0.55, (rOuter + rInner) / 2).x}" y="${pos(scale * 0.55, (rOuter + rInner) / 2).y + 4}" text-anchor="middle">${PARTY_NAMES[runnerParty].toUpperCase()} GAIN</text>

      <!-- Tipping-point line + marker (no inline label — value is in the footer) -->
      ${(() => {
        const a = pos(tippingSwing, rInner - 6);
        const b = pos(tippingSwing, rOuter + 6);
        const markerPos = pos(tippingSwing, rOuter + 6);
        return `<line class="tip-line" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>
          <circle class="tip-marker" cx="${markerPos.x}" cy="${markerPos.y}" r="4"/>`;
      })()}

      ${needleSwing != null ? (() => {
        const tip = pos(needleSwing, rOuter - 14);
        const badgeColor = stillWinner ? partyColor(winnerParty) : partyColor(runnerParty);
        return `
          <!-- Needle -->
          <line class="seat-needle" x1="${cx}" y1="${cy}" x2="${tip.x}" y2="${tip.y}"/>
          <circle class="seat-needle-hub" cx="${cx}" cy="${cy}" r="8"/>

          <!-- Big swing-value badge above the dial -->
          <g class="swing-badge" transform="translate(${cx}, 22)">
            <rect x="-46" y="-18" width="92" height="36" rx="6" fill="${badgeColor}" stroke="${badgeColor}" stroke-width="1"/>
            <text class="label" x="0" y="-2" text-anchor="middle">SWING</text>
            <text x="0" y="14" text-anchor="middle">${fmtSigned(needleSwing, 1)}</text>
          </g>
        `;
      })() : (() => {
        // Empty state badge — neutral, sits in same place as the swing badge
        return `
          <g transform="translate(${cx}, 22)">
            <rect x="-78" y="-16" width="156" height="32" rx="6" fill="var(--bg-3)" stroke="var(--line)" stroke-width="1"/>
            <text class="empty-msg" x="0" y="5" text-anchor="middle">awaiting result</text>
          </g>
        `;
      })()}
    </svg>
  `;

  // 2021 vs Now footer
  const footHtml = `
    <div class="dial-foot">
      <div class="col">
        <h5>2021 result</h5>
        <div class="pty"><span class="sw" style="background:${partyColor(winnerParty)}"></span>${PARTY_NAMES[winnerParty]}<span class="v">${fmtPct(winnerPct, 1)}</span></div>
        <div class="pty"><span class="sw" style="background:${partyColor(runnerParty)}"></span>${PARTY_NAMES[runnerParty]}<span class="v">${fmtPct(runnerPct, 1)}</span></div>
        <div class="muted" style="font-size:11px; margin-top:2px;">Maj: ${fmtPct(winnerPct - runnerPct, 1)}</div>
      </div>
      <div class="col center">
        <h5>Tipping point</h5>
        <div class="verdict-big" style="color: var(--text-1);">${fmtSigned(tippingSwing, 1)} pp</div>
        <div class="muted" style="font-size:10px;">two-party swing required to flip</div>
      </div>
      <div class="col right">
        <h5>${nowSh ? (isProjected ? 'Projected now' : 'Declared now') : 'Now'}</h5>
        ${nowSh ? `
          <div class="pty"><span class="sw" style="background:${partyColor(winnerParty)}"></span>${PARTY_NAMES[winnerParty]}<span class="v">${fmtPct(nowSh[winnerParty] || 0, 1)}</span></div>
          <div class="pty"><span class="sw" style="background:${partyColor(runnerParty)}"></span>${PARTY_NAMES[runnerParty]}<span class="v">${fmtPct(nowSh[runnerParty] || 0, 1)}</span></div>
          <div class="verdict-big" style="color: ${stillWinner ? partyColor(winnerParty) : partyColor(runnerParty)}; margin-top: 2px;">${stillWinner ? PARTY_NAMES[winnerParty] + ' hold' : PARTY_NAMES[runnerParty] + ' GAIN'}</div>
        ` : '<div class="muted" style="font-size:11px;">Awaiting result…</div>'}
      </div>
    </div>
  `;

  // Note if a different party is now actually leading (e.g. Reform overtaking the 2021 runner-up)
  let alertHtml = '';
  if (nowSh) {
    const sortedNow = PARTIES.map(p => [p, nowSh[p] || 0]).sort((a, b) => b[1] - a[1]);
    const [n1, n2] = sortedNow;
    if (n1[0] !== winnerParty && n1[0] !== runnerParty) {
      alertHtml = `<div style="margin-top: 10px; padding: 8px 12px; background: rgba(255,181,71,0.12); border: 1px solid rgba(255,181,71,0.3); border-radius: 8px; font-size: 12px; color: var(--warn);"><b>${PARTY_NAMES[n1[0]]} now leading here</b> — overtaking both 2021 top-two parties. Two-party dial doesn't capture the full story; see the per-party panel below.</div>`;
    } else if (n2[0] !== winnerParty && n2[0] !== runnerParty) {
      alertHtml = `<div style="margin-top: 10px; padding: 8px 12px; background: rgba(255,181,71,0.10); border: 1px solid rgba(255,181,71,0.25); border-radius: 8px; font-size: 12px; color: var(--text-2);">Note: <b>${PARTY_NAMES[n2[0]]}</b> is now in second place, displacing ${PARTY_NAMES[runnerParty]}.</div>`;
    }
  }

  el.innerHTML = `
    <div class="dial-head">
      <h4>Two-party swingometer · ${PARTY_NAMES[winnerParty]} ↔ ${PARTY_NAMES[runnerParty]}</h4>
      ${verdictHtml}
    </div>
    ${svg}
    ${footHtml}
    ${alertHtml}
  `;
}

function saveSeatModal() {
  if (!state.modalSeat) return;
  const votes = zeroParties();
  let any = false;
  $$('#seat-modal-back .vote-grid input').forEach(i => {
    const p = i.dataset.party;
    const v = parseFloat(i.value);
    if (Number.isFinite(v) && v > 0) { votes[p] = v; any = true; }
  });
  if (!any) { showToast('Enter at least one vote count'); return; }
  recordDeclaration(state.modalSeat, votes, 'manual');
  state.entered.constituencies[state.modalSeat] = { votes };
  persist();
  rerender();
  showToast(`Saved ${state.modalSeat} → ${PARTY_NAMES[winnerOf(votes)]}`);
  renderSeatModalCompare(state.modalSeat);  // refresh modal in place
}
function clearSeatModal() {
  if (!state.modalSeat) return;
  delete state.entered.constituencies[state.modalSeat];
  persist();
  rerender();
  closeSeatModal();
  showToast(`Cleared ${state.modalSeat}`);
}

/* ---------------- Region modal ---------------- */
function openRegionModal(regionName) {
  state.modalRegion = regionName;
  $('#region-modal-title').textContent = `${regionName} — list votes`;
  const baseline = state.byRegion[regionName];
  const entered = state.entered.regions[regionName];
  const baseTotal = baseline ? totals(baseline.list_votes) : 0;
  $('#region-modal-help').innerHTML = baseline
    ? `2021 list leader: <b style="color:${partyColor(winnerOf(baseline.list_votes))}">${PARTY_NAMES[winnerOf(baseline.list_votes)]}</b> · ${fmt(baseTotal)} list ballots cast in 2021`
    : '';
  $$('#region-modal-back .vote-grid input').forEach(i => {
    const p = i.dataset.rparty;
    i.value = entered ? (entered.listVotes[p] || '') : '';
  });
  $('#region-modal-back').classList.add('show');
}
function closeRegionModal() { $('#region-modal-back').classList.remove('show'); state.modalRegion = null; }
function saveRegionListVotes() {
  if (!state.modalRegion) return;
  const lv = zeroParties();
  let any = false;
  $$('#region-modal-back .vote-grid input').forEach(i => {
    const p = i.dataset.rparty;
    const v = parseFloat(i.value);
    if (Number.isFinite(v) && v > 0) { lv[p] = v; any = true; }
  });
  if (!any) { showToast('Enter at least one list vote count'); return; }
  state.entered.regions[state.modalRegion] = { listVotes: lv };
  persist();
  closeRegionModal();
  rerender();
  showToast(`Saved ${state.modalRegion} list votes`);
}
function clearRegionListVotes() {
  if (!state.modalRegion) return;
  delete state.entered.regions[state.modalRegion];
  persist();
  closeRegionModal();
  rerender();
}

/* ---------------- Declared list (sidebar of entry card) ---------------- */
function renderDeclaredList(s) {
  const list = $('#declared-list');
  const declared = Object.entries(state.entered.constituencies);
  if (declared.length === 0 && Object.keys(state.entered.regions).length === 0) {
    list.innerHTML = `<div class="muted" style="font-size:12px; padding:8px 4px;">No results entered yet. Click any constituency on the map, in the table, or in the key seats below.</div>`;
    return;
  }
  let html = '';
  if (declared.length) {
    html += `<div class="tiny" style="margin-bottom:6px; padding-left:4px;">Constituencies (${declared.length})</div>`;
    declared
      .map(([name, rec]) => ({ name, rec, w: winnerOf(rec.votes), pct: pctOf(rec.votes) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(({ name, rec, w, pct }) => {
        const baseline = state.byConstituency[name];
        const wasW = baseline ? baseline.winner : null;
        const flip = wasW && wasW !== w ? `<span style="color:${partyColor(w)}; font-size:11px;">⇆ from ${wasW}</span>` : '';
        html += `<div class="item" data-name="${name}">
          <span class="swatch" style="background:${partyColor(w)}"></span>
          <span class="name">${name} ${flip}</span>
          <span class="pct">${fmtPct(pct[w], 0)}</span>
          <button class="x" data-clear="${name}" title="Clear this entry">×</button>
        </div>`;
      });
  }
  const regionsDeclared = Object.entries(state.entered.regions);
  if (regionsDeclared.length) {
    html += `<div class="tiny" style="margin:10px 0 6px; padding-left:4px;">Regions list votes (${regionsDeclared.length})</div>`;
    for (const [name, rec] of regionsDeclared) {
      const w = winnerOf(rec.listVotes);
      html += `<div class="item" data-region="${name}">
        <span class="swatch" style="background:${partyColor(w)}"></span>
        <span class="name">${name} — ${PARTY_NAMES[w]} leads</span>
        <button class="x" data-clear-region="${name}" title="Clear this region">×</button>
      </div>`;
    }
  }
  list.innerHTML = html;
  list.querySelectorAll('button[data-clear]').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      delete state.entered.constituencies[b.dataset.clear];
      persist(); rerender();
    });
  });
  list.querySelectorAll('button[data-clear-region]').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      delete state.entered.regions[b.dataset.clearRegion];
      persist(); rerender();
    });
  });
  list.querySelectorAll('.item[data-name]').forEach(it => {
    it.addEventListener('click', () => openSeatModal(it.dataset.name));
  });
  list.querySelectorAll('.item[data-region]').forEach(it => {
    it.addEventListener('click', () => openRegionModal(it.dataset.region));
  });
}

/* ---------------- Entry form (the inline one above declared list) ---------------- */
function buildEntryDropdowns() {
  const regSel = $('#entry-region');
  const conSel = $('#entry-constituency');
  regSel.innerHTML = '<option value="">— pick region —</option>' +
    REGIONS.map(r => `<option value="${r}">${r}</option>`).join('');
  conSel.innerHTML = '<option value="">— pick constituency —</option>' +
    state.results2021.constituencies
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(c => `<option value="${c.name}">${c.name}</option>`)
      .join('');
  regSel.addEventListener('change', () => {
    const r = regSel.value;
    const opts = state.results2021.constituencies
      .filter(c => !r || c.region === r)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(c => `<option value="${c.name}">${c.name}</option>`).join('');
    conSel.innerHTML = '<option value="">— pick constituency —</option>' + opts;
    updateEntryContext();
  });
  conSel.addEventListener('change', updateEntryContext);
}

function updateEntryContext() {
  const c = $('#entry-constituency').value;
  const ctx = $('#entry-context');
  if (!c) { ctx.textContent = ''; return; }
  const baseline = state.byConstituency[c];
  const entered = state.entered.constituencies[c];
  if (entered) {
    const w = winnerOf(entered.votes);
    ctx.innerHTML = `<span style="color:${partyColor(w)}">●</span> Already entered — winner: <b>${PARTY_NAMES[w]}</b>. Re-saving will overwrite.`;
    $$('#entry-form .vote-grid input').forEach(i => {
      const p = i.dataset.party;
      i.value = entered.votes[p] || '';
    });
  } else {
    if (baseline) {
      const w21 = baseline.winner;
      ctx.innerHTML = `2021: <span style="color:${partyColor(w21)}">●</span> ${PARTY_NAMES[w21]} hold (${fmtPct(baseline.vote_pct[w21])}). Turnout ${baseline.turnout_pct ?? '?'}%`;
    } else { ctx.textContent = ''; }
    $$('#entry-form .vote-grid input').forEach(i => i.value = '');
  }
}

function saveConstituencyResult() {
  const name = $('#entry-constituency').value;
  if (!name) { showToast('Pick a constituency'); return; }
  const votes = zeroParties();
  let any = false;
  $$('#entry-form .vote-grid input').forEach(i => {
    const p = i.dataset.party;
    const v = parseFloat(i.value);
    if (Number.isFinite(v) && v > 0) { votes[p] = v; any = true; }
  });
  if (!any) { showToast('Enter at least one vote count'); return; }
  recordDeclaration(name, votes, 'manual');
  state.entered.constituencies[name] = { votes };
  persist();
  rerender();
  showToast(`Saved ${name} → ${PARTY_NAMES[winnerOf(votes)]}`);
  $('#entry-constituency').value = '';
  $$('#entry-form .vote-grid input').forEach(i => i.value = '');
  updateEntryContext();
}
function clearEntryForm() {
  $$('#entry-form .vote-grid input').forEach(i => i.value = '');
}

/* ---------------- Live mode (Google Sheet polling) ---------------- */

// Minimal RFC-4180 CSV parser. Handles quoted fields, embedded commas, doubled quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { cell += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cell += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && next === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(x => x.trim() !== '')) rows.push(row);
        row = [];
      } else { cell += c; }
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    if (row.some(x => x.trim() !== '')) rows.push(row);
  }
  return rows;
}

// Normalise a Google Sheets URL into one that returns CSV. We accept several formats.
function normaliseSheetUrl(url) {
  url = (url || '').trim();
  if (!url) return null;
  // "Publish to web" CSV: keep as-is, ensure output=csv
  if (/docs\.google\.com\/spreadsheets\/d\/e\/[\w-]+\/pub/.test(url)) {
    if (!/[?&]output=csv/.test(url)) url += (url.includes('?') ? '&' : '?') + 'output=csv';
    return url;
  }
  // Long-form sheet URL — convert to /export?format=csv
  const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
  if (m) {
    const id = m[1];
    let gid = '0';
    const gm = url.match(/[#&?]gid=(\d+)/);
    if (gm) gid = gm[1];
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  }
  // Already a direct CSV link or non-Google source — pass through
  return url;
}

// Build a name → canonical-name lookup that's tolerant of case + whitespace + punctuation.
function buildNameLookup() {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const lookup = { CON: {}, REG: {} };
  for (const c of state.results2021.constituencies) {
    lookup.CON[norm(c.name)] = c.name;
  }
  for (const r of REGIONS) {
    lookup.REG[norm(r)] = r;
  }
  return { lookup, norm };
}

// Parse a CSV from the sheet, return { results, errors }.
// Expected header row: Type,Name,SNP,LAB,CON,LD,GRN,REF,OTH (any order; case-insensitive)
function parseLiveSheet(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { results: [], errors: ['Sheet has no rows.'] };

  // Header
  const header = rows[0].map(h => h.trim());
  const headerLower = header.map(h => h.toLowerCase());
  const idxType = headerLower.indexOf('type');
  const idxName = headerLower.indexOf('name');
  if (idxType < 0 || idxName < 0) {
    return { results: [], errors: [`Sheet must have "Type" and "Name" columns. Got: ${header.join(', ')}`] };
  }
  const partyIdx = {};
  for (const p of PARTIES) {
    const i = headerLower.indexOf(p.toLowerCase());
    if (i >= 0) partyIdx[p] = i;
  }
  if (Object.keys(partyIdx).length === 0) {
    return { results: [], errors: ['Sheet must have at least one party column (SNP, LAB, CON, LD, GRN, REF, OTH).'] };
  }

  const { lookup, norm } = buildNameLookup();
  const results = [];
  const errors = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rawType = (row[idxType] || '').trim().toUpperCase();
    const rawName = (row[idxName] || '').trim();
    if (!rawType && !rawName) continue;     // blank row
    const type = rawType.startsWith('R') ? 'REG' : (rawType.startsWith('C') ? 'CON' : null);
    if (!type) {
      errors.push(`Row ${r + 1}: unknown type "${rawType}" (expected CON or REG)`);
      continue;
    }
    const canonical = lookup[type][norm(rawName)];
    if (!canonical) {
      errors.push(`Row ${r + 1}: name "${rawName}" not recognised as a ${type === 'CON' ? 'constituency' : 'region'}`);
      continue;
    }
    const votes = zeroParties();
    let any = false;
    for (const p of PARTIES) {
      const i = partyIdx[p];
      if (i == null) continue;
      const raw = (row[i] || '').toString().trim().replace(/[, ]/g, '');
      if (raw === '') continue;
      const v = parseFloat(raw);
      if (Number.isFinite(v) && v >= 0) {
        votes[p] = v;
        if (v > 0) any = true;
      } else {
        errors.push(`Row ${r + 1} (${rawName}): invalid number "${raw}" for ${p}`);
      }
    }
    if (any) results.push({ type, name: canonical, votes });
  }
  return { results, errors };
}

// Apply parsed rows into state. Returns {added, updated, removed}.
function applyLiveResults(parsed) {
  let added = 0, updated = 0;
  const seenCons = new Set(), seenRegs = new Set();
  for (const r of parsed.results) {
    if (r.type === 'CON') {
      seenCons.add(r.name);
      const cur = state.entered.constituencies[r.name];
      const nextStr = JSON.stringify(r.votes);
      const curStr = cur ? JSON.stringify(cur.votes) : null;
      const isNewOrChanged = !cur || curStr !== nextStr;
      if (!cur) added++;
      else if (curStr !== nextStr) updated++;
      state.entered.constituencies[r.name] = { votes: r.votes };
      if (isNewOrChanged) recordDeclaration(r.name, r.votes, 'live');
    } else if (r.type === 'REG') {
      seenRegs.add(r.name);
      const cur = state.entered.regions[r.name];
      const nextStr = JSON.stringify(r.votes);
      const curStr = cur ? JSON.stringify(cur.listVotes) : null;
      if (!cur) added++;
      else if (curStr !== nextStr) updated++;
      state.entered.regions[r.name] = { listVotes: r.votes };
    }
  }
  // Note: we DON'T remove rows that disappeared from the sheet — too dangerous if
  // the sheet is briefly empty. User can hit Reset to clear.
  return { added, updated, total: parsed.results.length };
}

async function fetchLiveSheet(url, opts = {}) {
  const cacheBust = opts.cacheBust !== false;
  const u = cacheBust ? url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now() : url;
  const res = await fetch(u, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  return parseLiveSheet(text);
}

async function liveTick() {
  const url = normaliseSheetUrl(state.live.url);
  if (!url) return;
  try {
    const parsed = await fetchLiveSheet(url);
    const summary = applyLiveResults(parsed);
    state.live.lastFetch = Date.now();
    state.live.lastResult = { ...summary, errors: parsed.errors };
    state.live.lastError = null;
    saveLive();
    rerender();
    updateLiveStatus();
    if (summary.added + summary.updated > 0) {
      showToast(`Live: ${summary.added} new · ${summary.updated} updated`);
    }
  } catch (e) {
    console.warn('live tick failed', e);
    state.live.lastError = e.message;
    state.live.lastResult = null;
    updateLiveStatus();
  }
}

// Minimum poll interval used when the tab is in the background. Browsers
// throttle setInterval/setTimeout in hidden tabs anyway (Chrome floors at
// ~1 minute after a few minutes hidden), so we explicitly slow to 60s to
// stay within that envelope and conserve bandwidth.
const HIDDEN_MIN_INTERVAL_SEC = 60;

// Self-rescheduling setTimeout — more robust than setInterval for tabs
// that get backgrounded. Each tick schedules the next one based on
// current visibility.
function scheduleLiveTick() {
  if (state.live.timer) { clearTimeout(state.live.timer); state.live.timer = null; }
  if (!state.live.running) return;
  const baseSec = state.live.intervalSec;
  const sec = document.hidden
    ? Math.max(HIDDEN_MIN_INTERVAL_SEC, baseSec)
    : baseSec;
  state.live.timer = setTimeout(async () => {
    if (!state.live.running) return;
    try { await liveTick(); } catch (e) { /* liveTick handles its own errors */ }
    scheduleLiveTick();
  }, sec * 1000);
}

function startLive() {
  const url = normaliseSheetUrl(state.live.url);
  if (!url) { showToast('Add a Google Sheet URL first'); return; }
  stopLive();
  state.live.running = true;
  saveLive();
  liveTick();          // immediate first fetch
  scheduleLiveTick();  // then auto-reschedule
  updateLiveStatus();
}

function stopLive() {
  if (state.live.timer) { clearTimeout(state.live.timer); state.live.timer = null; }
  state.live.running = false;
  saveLive();
  updateLiveStatus();
}

function saveLive() {
  try {
    localStorage.setItem(LIVE_KEY, JSON.stringify({
      url: state.live.url, intervalSec: state.live.intervalSec, running: state.live.running,
    }));
  } catch (e) {}
}

function loadLive() {
  try {
    const raw = localStorage.getItem(LIVE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.url) state.live.url = d.url;
    if (d.intervalSec) state.live.intervalSec = d.intervalSec;
    if (d.running) state.live.running = true; // we'll auto-start below
  } catch (e) {}
}

function updateLiveStatus() {
  const btn = $('#live-btn');
  const dot = $('#live-dot');
  const lab = $('#live-label');
  const status = $('#live-status');
  const last = $('#live-last-result');

  btn.classList.remove('on', 'error');
  if (state.live.lastError && state.live.running) btn.classList.add('error');
  else if (state.live.running) btn.classList.add('on');

  let labelText;
  if (!state.live.running) labelText = 'Live: off';
  else if (state.live.lastError) labelText = 'Live: error';
  else if (state.live.lastFetch) {
    const ago = Math.round((Date.now() - state.live.lastFetch) / 1000);
    labelText = `Live · ${ago}s ago`;
  } else labelText = 'Live: starting…';
  lab.textContent = labelText;

  if (status) {
    if (!state.live.running) status.textContent = 'Not polling';
    else if (state.live.lastError) status.innerHTML = `<span style="color: var(--bad);">Error: ${state.live.lastError}</span>`;
    else if (state.live.lastFetch) {
      const ago = Math.round((Date.now() - state.live.lastFetch) / 1000);
      status.innerHTML = `<span style="color: var(--good);">● Polling</span> · last fetch ${ago}s ago`;
    } else status.textContent = 'Polling, awaiting first response…';
  }
  if (last) {
    if (state.live.lastResult) {
      const r = state.live.lastResult;
      let html = `Last fetch: <b>${r.total}</b> rows`;
      if (r.added) html += ` · <span style="color:var(--good);">+${r.added} new</span>`;
      if (r.updated) html += ` · <span style="color:var(--accent);">${r.updated} updated</span>`;
      if (r.errors && r.errors.length) html += ` · <span style="color:var(--warn);">${r.errors.length} warning${r.errors.length > 1 ? 's' : ''}</span>`;
      last.innerHTML = html;
      // Detail tooltip
      if (r.errors && r.errors.length) last.title = r.errors.slice(0, 8).join('\n') + (r.errors.length > 8 ? `\n…and ${r.errors.length - 8} more` : '');
      else last.title = '';
    } else if (state.live.lastError) {
      last.textContent = '';
    }
  }
}

// Tick the status label every second so the "Xs ago" stays fresh
setInterval(() => { if (state.live.running || state.live.lastFetch) updateLiveStatus(); }, 1000);

// Pause polling when tab is hidden, resume on focus
// When the tab becomes visible again, fetch immediately + return to the
// fast cadence. When it goes hidden, just let the next scheduled tick
// adopt the slower (≥60s) interval automatically.
document.addEventListener('visibilitychange', () => {
  if (!state.live.running) return;
  if (!document.hidden) liveTick();
  scheduleLiveTick();
});

function openLiveModal() {
  $('#live-url').value = state.live.url || '';
  $('#live-interval').value = String(state.live.intervalSec);
  $('#live-start').style.display = state.live.running ? 'none' : '';
  $('#live-stop').style.display = state.live.running ? '' : 'none';
  updateLiveStatus();
  $('#live-modal-back').classList.add('show');
}
function closeLiveModal() { $('#live-modal-back').classList.remove('show'); }

async function testLiveConnection() {
  const url = normaliseSheetUrl($('#live-url').value);
  if (!url) { showToast('Enter a URL first'); return; }
  $('#live-status').innerHTML = '<span class="muted">Testing…</span>';
  try {
    const parsed = await fetchLiveSheet(url, { cacheBust: true });
    const ok = parsed.results.length;
    const errs = parsed.errors.length;
    $('#live-status').innerHTML = `<span style="color: var(--good);">✓ Sheet reachable</span> · ${ok} valid row${ok === 1 ? '' : 's'}${errs ? ` · <span style="color: var(--warn);">${errs} warning${errs === 1 ? '' : 's'}</span>` : ''}`;
    if (errs) {
      const detail = parsed.errors.slice(0, 5).join('\n');
      console.warn('Live sheet warnings:\n' + parsed.errors.join('\n'));
      showToast(`${errs} row${errs > 1 ? 's' : ''} skipped — see Status field for details`);
    } else {
      showToast(`Sheet OK — ${ok} valid row${ok === 1 ? '' : 's'}`);
    }
  } catch (e) {
    $('#live-status').innerHTML = `<span style="color: var(--bad);">✗ ${e.message}</span>`;
    showToast('Connection failed: ' + e.message);
  }
}

/* ---------------- Year-view (historical) ---------------- */
function isHistoricalView() { return state.viewYear !== 'live'; }
function getHistoricalRecord() {
  if (!isHistoricalView()) return null;
  return (state.historical && state.historical[state.viewYear]) || null;
}
function applyHistoricalAttribute() {
  const html = document.documentElement;
  if (isHistoricalView()) html.dataset.historical = state.viewYear;
  else delete html.dataset.historical;
}

/* ---------------- Path to majority ---------------- */
/**
 * For each party, compute the seats they'd need to flip (ranked by smallest
 * required swing) to reach 65 — the "path to majority". Uses the current
 * vote-share state per constituency: declared if entered, projected if
 * projection mode is on, otherwise 2021 baseline.
 *
 * Required swing for party P to win seat S = (winnerPct - PPct) / 2
 * (the standard two-party swing-from-winner calculation).
 *
 * Returns: { SNP: { current, needed, targets: [{name, swingNeeded, currentWinner, currentRunnerPct}], hasMajority }, ... }
 */
function computePathToMajority(s) {
  const out = {};
  for (const p of PARTIES) {
    const current = s.totalByParty[p] || 0;
    out[p] = {
      current,
      needed: Math.max(0, MAJORITY - current),
      hasMajority: current >= MAJORITY,
      targets: [],
    };
  }

  // For each constituency, look at current vote shares + winner. If a party
  // is NOT the winner, compute swing needed for them to overtake.
  for (const c of state.results2021.constituencies) {
    const rec = s.perConstituency[c.name];
    if (!rec || !rec.winner || !rec.vote_pct) continue;
    const winner = rec.winner;
    const winnerPct = rec.vote_pct[winner] || 0;
    for (const p of PARTIES) {
      if (p === winner) continue;
      const pPct = rec.vote_pct[p] || 0;
      if (pPct === 0) continue;
      const swingNeeded = (winnerPct - pPct) / 2;
      // Only consider seats where the swing is reasonable (< 25 pp).
      // Beyond that the seat is effectively unreachable.
      if (swingNeeded > 25) continue;
      out[p].targets.push({
        name: c.name,
        region: c.region,
        currentWinner: winner,
        winnerPct,
        challengerPct: pPct,
        swingNeeded,
        flippedAlready: false,  // not flipped yet — they still need to take it
      });
    }
  }
  // Sort targets by swing needed
  for (const p of PARTIES) {
    out[p].targets.sort((a, b) => a.swingNeeded - b.swingNeeded);
  }
  return out;
}

function renderPathToMajority(s) {
  const grid = $('#path-grid');
  if (!grid) return;
  // Skip in historical view (no path to majority is meaningful — it's already happened)
  if (isHistoricalView()) {
    grid.innerHTML = `<div class="muted" style="text-align:center; padding: 14px; font-size:13px;">Path-to-majority is for live results only — not shown for historical years.</div>`;
    return;
  }
  const data = computePathToMajority(s);

  // Show only parties that are within a sane distance of majority OR already there.
  const interesting = PARTIES.filter(p => {
    const d = data[p];
    return d.hasMajority || (d.current >= 5 && d.needed > 0 && d.needed <= 50);
  });

  if (!interesting.length) {
    grid.innerHTML = `<div class="muted" style="text-align:center; padding: 14px; font-size:13px;">No party is in striking distance of a majority yet.</div>`;
    return;
  }

  grid.innerHTML = interesting.map(p => {
    const d = data[p];
    const accent = partyColor(p);
    if (d.hasMajority) {
      return `<div class="path-card majority" style="--card-accent:${accent}">
        <div class="head">
          <span class="pname" style="color:${accent}">${PARTY_NAMES[p]}</span>
          <span class="pcount">${d.current} seats</span>
        </div>
        <div class="summary">✓ Has majority — <b>${d.current - MAJORITY + 1}</b> over the line.</div>
      </div>`;
    }
    const need = d.needed;
    const top = d.targets.slice(0, Math.max(need + 2, 8));
    const targetEls = top.map(t => {
      const flippedHere = false;
      return `<div class="target ${flippedHere ? 'flipped' : ''}" data-seat="${t.name}">
        <div class="name"><span class="sw" style="background:${partyColor(t.currentWinner)}"></span>${t.name} <span style="color:var(--text-3); font-size:10px; margin-left:4px;">(${PARTY_NAMES[t.currentWinner]} ${fmtPct(t.winnerPct, 0)})</span></div>
        <div class="swing-need">${t.swingNeeded.toFixed(1)}pp</div>
      </div>`;
    }).join('');
    const summary = top.length >= need
      ? `Needs <b>${need}</b> more — top <b>${need}</b> targets average <b>${(top.slice(0, need).reduce((a,b)=>a+b.swingNeeded,0) / need).toFixed(1)}pp</b> swing required.`
      : `Needs <b>${need}</b> more but only <b>${top.length}</b> realistic targets in reach.`;
    const noRouteCls = top.length < need ? 'no-route' : '';
    const moreCount = d.targets.length - top.length;
    return `<div class="path-card ${noRouteCls}" style="--card-accent:${accent}">
      <div class="head">
        <span class="pname" style="color:${accent}">${PARTY_NAMES[p]}</span>
        <span class="pcount">${d.current} → 65 (${need} short)</span>
      </div>
      <div class="summary">${summary}</div>
      ${targetEls}
      ${moreCount > 0 ? `<div class="more">+${moreCount} more reachable seats</div>` : ''}
    </div>`;
  }).join('');

  grid.querySelectorAll('.target[data-seat]').forEach(el => {
    el.addEventListener('click', () => openSeatModal(el.dataset.seat));
  });
}

/* ---------------- Expected declaration schedule ---------------- */
function renderExpectedNext(s) {
  const el = $('#expected-next');
  if (!el) return;
  if (!state.declarationSchedule || isHistoricalView()) {
    el.innerHTML = '';
    return;
  }
  // Find the next 3 expected — in time order, that aren't already declared
  const now = Date.now();
  const upcoming = Object.values(state.declarationSchedule)
    .filter(c => !state.entered.constituencies[c.name])
    .map(c => ({ ...c, ts: new Date(c.expected_time).getTime() }))
    .filter(c => c.ts > now - 30 * 60 * 1000)  // include things due in last 30 min
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 3);

  if (upcoming.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<div class="label">Next expected declarations</div>` + upcoming.map(c => {
    const d = new Date(c.ts);
    const isFri = d.getDay() === 5;
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const day = isFri ? '' : (d.getDay() === 6 ? 'Sat ' : '');
    return `<div class="expected-item" data-name="${c.name}">
      <div class="time">${day}${time}</div>
      <div class="name">${c.name}${c.note ? `<span class="nnote">· ${c.note}</span>` : ''}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('.expected-item').forEach(it => {
    it.addEventListener('click', () => openSeatModal(it.dataset.name));
  });
}

/* ---------------- Full declaration schedule ---------------- */
const TIER_LABELS = {
  early:     'Early afternoon (12:00–14:30)',
  mid:       'Mid afternoon (14:30–16:00)',
  late:      'Late afternoon (16:00–18:00)',
  very_late: 'Last to declare (after 18:00)',
};
const TIER_ORDER = ['early', 'mid', 'late', 'very_late'];

function fmtScheduledTime(iso) {
  const d = new Date(iso);
  const day = d.getDay() === 6 ? 'Sat ' : '';
  return day + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function renderDeclarationSchedule(s) {
  const el = $('#schedule-grid');
  const filterEl = $('#schedule-filter');
  if (!el || !state.declarationSchedule) return;

  const filter = (filterEl && filterEl.value) || 'all';   // 'all' | 'pending' | 'declared'
  const constituencies = Object.values(state.declarationSchedule);
  const regions = Object.values(state.declarationScheduleRegions || {});

  const enriched = [];
  for (const c of constituencies) {
    const isDeclared = !!state.entered.constituencies[c.name];
    if (filter === 'pending' && isDeclared) continue;
    if (filter === 'declared' && !isDeclared) continue;
    enriched.push({ ...c, kind: 'CON', declared: isDeclared });
  }
  for (const r of regions) {
    const isDeclared = !!(state.entered.regions[r.name] && totals(state.entered.regions[r.name].listVotes) > 0);
    if (filter === 'pending' && isDeclared) continue;
    if (filter === 'declared' && !isDeclared) continue;
    enriched.push({ ...r, kind: 'REG', declared: isDeclared });
  }

  // Group by tier
  const byTier = { early: [], mid: [], late: [], very_late: [] };
  for (const item of enriched) {
    const t = item.tier || 'mid';
    (byTier[t] || byTier.mid).push(item);
  }
  for (const t of TIER_ORDER) {
    byTier[t].sort((a, b) => (a.expected_time || '').localeCompare(b.expected_time || '') || a.name.localeCompare(b.name));
  }

  // Counts shown in header
  const totalDeclared = constituencies.filter(c => state.entered.constituencies[c.name]).length;
  const totalRegionsDeclared = regions.filter(r => state.entered.regions[r.name] && totals(state.entered.regions[r.name].listVotes) > 0).length;
  $('#schedule-count').textContent = `${totalDeclared}/${constituencies.length} constituencies · ${totalRegionsDeclared}/${regions.length} regions declared`;

  // Build HTML
  let html = '';
  for (const tier of TIER_ORDER) {
    const rows = byTier[tier];
    if (!rows.length) continue;
    html += `<div class="schedule-tier">
      <div class="schedule-tier-head">${TIER_LABELS[tier]} <span class="muted">· ${rows.length}</span></div>
      <div class="schedule-list">`;
    for (const item of rows) {
      const time = fmtScheduledTime(item.expected_time);
      const note = item.note ? `<span class="schedule-note">${item.note}</span>` : '';
      const kindBadge = item.kind === 'REG' ? '<span class="schedule-kind">List</span>' : '';
      const statusBadge = item.declared
        ? '<span class="schedule-status declared">✓ Declared</span>'
        : '<span class="schedule-status pending">Pending</span>';
      html += `<div class="schedule-row ${item.declared ? 'is-declared' : ''}" data-name="${item.name}" data-kind="${item.kind}">
        <span class="schedule-time">${time}</span>
        <span class="schedule-name"><b>${item.name}</b>${kindBadge} ${note}</span>
        ${statusBadge}
      </div>`;
    }
    html += '</div></div>';
  }
  if (!html) {
    html = `<div class="muted" style="text-align:center; padding:14px; font-size:13px;">No items match this filter.</div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.schedule-row').forEach(row => {
    row.addEventListener('click', () => {
      if (row.dataset.kind === 'REG') openRegionModal(row.dataset.name);
      else openSeatModal(row.dataset.name);
    });
  });
}

/* ---------------- Story so far (auto-headline) ---------------- */
function buildStorySoFar(s) {
  if (isHistoricalView()) {
    const h = getHistoricalRecord();
    if (!h) return '';
    const totals = h.scotland.seat_totals;
    const lead = winnerOf(totals);
    const margin = totals[lead] - MAJORITY;
    const desc = margin >= 0
      ? `won a majority government on ${totals[lead]} seats`
      : `was the largest party on ${totals[lead]} seats but ${Math.abs(margin)} short of a majority`;
    return `<span class="story-tag">${state.viewYear}</span> <b>${PARTY_NAMES[lead]}</b> ${desc}. Other parties: ${PARTIES.filter(p => p !== lead && totals[p]).map(p => `${PARTY_NAMES[p]} ${totals[p]}`).join(' · ')}.`;
  }

  const declared = s.declaredCount;
  const lead = s.leadParty;
  const totals = s.totalByParty;
  if (!lead || PARTIES.every(p => totals[p] === 0)) {
    return `<span class="story-tag">Story so far</span> Counts haven't started — projection mode shows the BBS poll-of-polls picture.`;
  }
  const baseline = state.results2021.scotland.seat_totals;
  const flipsByParty = {};
  let totalFlips = 0;
  for (const [name, rec] of Object.entries(state.entered.constituencies)) {
    const w = winnerOf(rec.votes);
    const w21 = state.byConstituency[name]?.winner;
    if (w && w21 && w !== w21) {
      flipsByParty[w] = (flipsByParty[w] || 0) + 1;
      totalFlips++;
    }
  }
  const sentences = [];
  if (declared === 0 && state.mode === 'projected') {
    sentences.push(`No constituencies declared yet — these numbers are projected from the latest BBS poll-of-polls.`);
  } else if (declared > 0) {
    sentences.push(`With <b>${declared} of 73</b> constituencies declared, <b style="color:${partyColor(lead)}">${PARTY_NAMES[lead]}</b> ${totals[lead] >= MAJORITY ? `have a majority on <b>${totals[lead]} seats</b>` : `are the largest party on <b>${totals[lead]} seats</b>`}${totals[lead] < MAJORITY ? `, ${MAJORITY - totals[lead]} short of a majority` : ''}.`);
  } else {
    sentences.push(`<b style="color:${partyColor(lead)}">${PARTY_NAMES[lead]}</b> projected to win <b>${totals[lead]} seats</b>${totals[lead] < MAJORITY ? `, ${MAJORITY - totals[lead]} short of majority` : ''}.`);
  }
  if (totalFlips > 0) {
    const flipNarr = Object.entries(flipsByParty)
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${PARTY_NAMES[p]} <b>+${n}</b>`)
      .join(' · ');
    sentences.push(`Constituency gains so far: ${flipNarr}.`);
  }
  // Reform breakthrough?
  if (totals.REF > 0 && (baseline.REF || 0) === 0) {
    sentences.push(`<b style="color:${partyColor('REF')}">Reform on ${totals.REF}</b> — their first seats in the Scottish Parliament.`);
  }
  // Notable cabinet/leader watch — check declared seats against notables
  if (state.notables && state.notables.constituencies) {
    const notableEvents = [];
    for (const [name, rec] of Object.entries(state.entered.constituencies)) {
      const note = state.notables.constituencies[name];
      if (!note) continue;
      const winner = winnerOf(rec.votes);
      const w21 = state.byConstituency[name]?.winner;
      if (winner && w21 && winner !== w21) {
        notableEvents.push(`${name}: <b>${PARTY_NAMES[winner]} GAIN</b> (${note.title})`);
      }
    }
    if (notableEvents.length) {
      sentences.push(`Notable: ${notableEvents.slice(0, 3).join(' · ')}.`);
    }
  }
  // Coalition status — only suggest politically realistic pairings.
  // Cross-divide combos (SNP+LAB, SNP+CON, GRN+CON etc) are ruled out; we
  // prefer Likely tier (track record: SNP+GRN, LAB+LD, CON+REF) over Possible.
  if (declared >= 30 && totals[lead] < MAJORITY) {
    let best = null;
    for (const p of PARTIES) {
      if (p === lead || !totals[p]) continue;
      const realism = coalitionRealism([lead, p]);
      if (realism.tier === 'cross') continue;            // skip cross-divide
      const sum = totals[lead] + totals[p];
      if (sum < MAJORITY) continue;
      const tierRank = COALITION_TIER_ORDER[realism.tier];
      if (!best ||
          tierRank < best.tierRank ||
          (tierRank === best.tierRank && sum > best.sum)) {
        best = { partner: p, sum, tier: realism.tier, tierRank };
      }
    }
    if (best) {
      const label = best.tier === 'likely' ? 'Likely' : 'Possible';
      sentences.push(`${label} majority coalition: <b style="color:${partyColor(lead)}">${PARTY_NAMES[lead]}</b> + <b style="color:${partyColor(best.partner)}">${PARTY_NAMES[best.partner]}</b> = <b>${best.sum} seats</b>.`);
    } else {
      // No realistic majority partner — flag the impasse rather than invent one
      sentences.push(`No realistic 2-party majority — minority government or extended negotiation likely.`);
    }
  }
  return `<span class="story-tag">Story so far</span> ${sentences.join(' ')}`;
}

function renderStorySoFar(s) {
  const el = $('#story-so-far');
  if (!el) return;
  el.innerHTML = buildStorySoFar(s);
}

/* ---------------- Smart paste vote entry ---------------- */
function openPasteModal() {
  $('#paste-input').value = '';
  $('#paste-preview').style.display = 'none';
  $('#paste-apply').style.display = 'none';
  $('#paste-status').textContent = '';
  // Populate constituency dropdown
  const sel = $('#paste-constituency');
  sel.innerHTML = '<option value="">— auto-detect or pick constituency —</option>' +
    state.results2021.constituencies
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(c => `<option value="${c.name}">${c.name}</option>`).join('');
  $('#paste-modal-back').classList.add('show');
  setTimeout(() => $('#paste-input').focus(), 50);
}
function closePasteModal() { $('#paste-modal-back').classList.remove('show'); }

const PARTY_KEYWORDS = {
  SNP: ['snp', 'scottish national', 'national party'],
  LAB: ['labour', 'lab ', 'lab.', 'co-op'],
  CON: ['conservative', 'tory', 'tories', 'unionist', 'cons '],
  LD:  ['liberal democrat', 'lib dem', 'libdem', 'lib-dem', 'lib dems'],
  GRN: ['green'],
  REF: ['reform'],
  OTH: ['alba', 'independent', 'ind ', 'ssp', 'workers party', 'tusc', 'family party'],
};

function parsePasteText(text) {
  const lines = text.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
  const result = zeroParties();
  let detectedName = null;

  // Try to detect constituency name in first non-numeric line
  for (const line of lines.slice(0, 4)) {
    if (/\d/.test(line)) continue;
    // Look for known constituency names
    for (const c of state.results2021.constituencies) {
      if (line.toLowerCase().includes(c.name.toLowerCase())) {
        detectedName = c.name;
        break;
      }
    }
    if (detectedName) break;
  }

  // Now scan all lines for party + number pairs
  for (const line of lines) {
    const lower = line.toLowerCase();
    // Pull out the largest number on the line
    const numMatches = line.match(/(\d{1,3}(?:[,\s]\d{3})+|\d{4,})/g);
    if (!numMatches) continue;
    const num = parseInt(numMatches[numMatches.length - 1].replace(/[,\s]/g, ''), 10);
    if (!Number.isFinite(num)) continue;

    // Find which party this line is about
    let matchedParty = null;
    let bestKeywordPos = Infinity;
    for (const p of PARTIES) {
      for (const kw of PARTY_KEYWORDS[p]) {
        const idx = lower.indexOf(kw);
        if (idx >= 0 && idx < bestKeywordPos) {
          bestKeywordPos = idx;
          matchedParty = p;
        }
      }
    }
    if (matchedParty && num > 0) {
      // Take the largest number for this party (in case multiple lines mention same party)
      result[matchedParty] = Math.max(result[matchedParty], num);
    }
  }
  return { votes: result, detectedName };
}

let pasteState = { votes: null, name: null };
function runPaste() {
  const text = $('#paste-input').value.trim();
  if (!text) { $('#paste-status').textContent = 'Paste some text first'; return; }
  const parsed = parsePasteText(text);
  const overrideName = $('#paste-constituency').value;
  const finalName = overrideName || parsed.detectedName;
  pasteState = { votes: parsed.votes, name: finalName };

  const tot = totals(parsed.votes);
  const found = PARTIES.filter(p => parsed.votes[p] > 0).length;
  if (tot === 0) {
    $('#paste-status').innerHTML = `<span style="color:var(--bad);">No vote counts found.</span>`;
    $('#paste-preview').style.display = 'none';
    $('#paste-apply').style.display = 'none';
    return;
  }
  $('#paste-status').innerHTML = `<span style="color:var(--good);">✓ Found ${found} parties · ${fmt(tot)} total ballots</span>`;
  if (parsed.detectedName && !overrideName) {
    $('#paste-status').innerHTML += ` · detected: <b>${parsed.detectedName}</b>`;
  }
  // Preview
  const sortedNow = PARTIES.map(p => [p, parsed.votes[p] || 0]).sort((a, b) => b[1] - a[1]);
  $('#paste-preview').style.display = 'block';
  $('#paste-preview').innerHTML = sortedNow.filter(([, v]) => v > 0).map(([p, v]) => `
    <div class="row">
      <div class="pname"><span class="sw" style="background:${partyColor(p)}"></span>${PARTY_NAMES[p]}</div>
      <div class="v">${fmt(v)} (${fmtPct(v / tot * 100, 1)})</div>
    </div>`).join('') + (finalName ? `<div style="margin-top:8px; color:var(--text-2); font-size:12px;">Will be applied to <b>${finalName}</b>.</div>` : `<div style="margin-top:8px; color:var(--bad); font-size:12px;">Pick a constituency from the dropdown above to apply.</div>`);
  $('#paste-apply').style.display = finalName ? '' : 'none';
}

function applyPaste() {
  if (!pasteState.votes || !pasteState.name) return;
  recordDeclaration(pasteState.name, pasteState.votes, 'manual');
  state.entered.constituencies[pasteState.name] = { votes: pasteState.votes };
  persist();
  rerender();
  showToast(`Applied paste to ${pasteState.name} → ${PARTY_NAMES[winnerOf(pasteState.votes)]}`);
  closePasteModal();
}

/* ---------------- Watchlist ---------------- */
function isStarred(name) { return state.watchlist.includes(name); }
function toggleStar(name) {
  if (!name) return;
  const i = state.watchlist.indexOf(name);
  if (i >= 0) state.watchlist.splice(i, 1);
  else state.watchlist.push(name);
  persist();
  rerender();
}
function renderWatchlist(s) {
  const section = $('#watchlist-section');
  const strip = $('#watchlist-strip');
  const count = $('#watchlist-count');
  if (!state.watchlist.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  count.textContent = `${state.watchlist.length} seat${state.watchlist.length === 1 ? '' : 's'} pinned`;
  strip.innerHTML = state.watchlist.map(name => {
    const baseline = state.byConstituency[name];
    if (!baseline) return '';
    const rec = s.perConstituency[name];
    const winner = rec && rec.winner;
    const accent = winner ? partyColor(winner) : 'var(--line)';
    let statusTag, status;
    if (rec && rec.declared) { statusTag = 'DECLARED'; status = 'declared'; }
    else if (rec && rec.projected) { statusTag = 'PROJECTED'; status = 'projected'; }
    else { statusTag = 'PENDING'; status = 'pending'; }
    let bottomRow = '';
    if (winner && rec.vote_pct) {
      const flip = baseline.winner && baseline.winner !== winner ? `<span style="color:var(--warn); font-size:10px; margin-left:4px;">⇆ ${baseline.winner} → ${winner}</span>` : '';
      bottomRow = `<div class="row"><span class="sw" style="background:${partyColor(winner)}"></span><span class="who">${PARTY_NAMES[winner]}${flip}</span><span class="pct">${fmtPct(rec.vote_pct[winner], 1)}</span></div>`;
    } else {
      bottomRow = `<div class="row"><span style="color: var(--text-3); font-size: 11px;">awaiting result · 2021: ${PARTY_NAMES[baseline.winner]}</span></div>`;
    }
    return `<div class="watch-item" data-name="${name}" style="--card-accent:${accent}">
      <span class="status-tag ${status}">${statusTag}</span>
      <div class="name">${name}</div>
      <div class="meta">${baseline.region}</div>
      ${bottomRow}
      <button class="unstar" data-unstar="${name}" title="Remove from watch list">×</button>
    </div>`;
  }).join('');
  strip.querySelectorAll('.watch-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('button.unstar')) return;
      openSeatModal(el.dataset.name);
    });
  });
  strip.querySelectorAll('button[data-unstar]').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      toggleStar(b.dataset.unstar);
    });
  });
}

/* ---------------- Coalition arithmetic ---------------- */
function generateCombos(parties, k) {
  const out = [];
  const recur = (start, picked) => {
    if (picked.length === k) { out.push(picked.slice()); return; }
    for (let i = start; i < parties.length; i++) {
      picked.push(parties[i]);
      recur(i + 1, picked);
      picked.pop();
    }
  };
  recur(0, []);
  return out;
}
/**
 * Score a coalition for political plausibility, not just arithmetic.
 *
 * Scottish politics is divided primarily along the constitutional axis
 * (independence vs union), and parties almost never cross that line in
 * formal coalitions. Within each bloc, certain pairs have a track record
 * (Bute House Agreement; the 1999–2007 Lab–LD coalition).
 *
 * Returns { tier, label, note }:
 *   tier: 'likely' | 'possible' | 'cross'
 *   label: short human-readable
 *   note: tooltip text explaining the tier
 */
const PRO_INDY_BLOC = new Set(['SNP', 'GRN']);
const PRO_UNION_BLOC = new Set(['LAB', 'CON', 'LD', 'REF']);
// Pairs with recent cooperation history or strong ideological alignment.
const TRACK_RECORD_PAIRS = [
  ['SNP', 'GRN'],   // Bute House Agreement 2021–2024
  ['LAB', 'LD'],    // Lab–LD coalition 1999–2007
  ['CON', 'REF'],   // Right-wing alignment / unionist right
];
function pairHasTrackRecord(combo, [a, b]) {
  return combo.includes(a) && combo.includes(b);
}
function coalitionRealism(combo) {
  const indy = combo.filter(p => PRO_INDY_BLOC.has(p));
  const union = combo.filter(p => PRO_UNION_BLOC.has(p));
  if (indy.length > 0 && union.length > 0) {
    return {
      tier: 'cross',
      label: 'Cross-divide',
      note: 'Bridges the constitutional divide (pro-indy + pro-union). Almost no precedent in Scottish politics.',
    };
  }
  for (const pair of TRACK_RECORD_PAIRS) {
    if (pairHasTrackRecord(combo, pair)) {
      return {
        tier: 'likely',
        label: 'Likely',
        note: 'Includes a pair with recent cooperation track record.',
      };
    }
  }
  return {
    tier: 'possible',
    label: 'Possible',
    note: 'Same constitutional bloc, but no recent coalition history.',
  };
}

const COALITION_TIER_ORDER = { likely: 0, possible: 1, cross: 2 };

function renderCoalitions(s) {
  const grid = $('#coalition-grid');
  const totals = s.totalByParty;
  const allocated = PARTIES.reduce((a, p) => a + totals[p], 0);
  $('#coalition-help').textContent = allocated === 0
    ? '65 for majority · ranked by political plausibility'
    : `${allocated} of 129 seats allocated · 65 for majority · ranked by plausibility`;

  if (allocated === 0) {
    grid.innerHTML = `<div class="muted" style="font-size:13px; padding: 12px 4px; text-align:center;">No seats allocated yet — try Projected mode or import dummy data.</div>`;
    return;
  }

  const sizes = state.coalitionMode === 3 ? [1, 2, 3] : [1, 2];
  const combos = [];
  for (const k of sizes) {
    for (const c of generateCombos(PARTIES, k)) {
      const seats = c.reduce((a, p) => a + totals[p], 0);
      if (c.some(p => totals[p] === 0)) continue; // every party in the combo must have ≥1 seat
      if (seats < 5) continue;
      combos.push({ c, seats, realism: coalitionRealism(c) });
    }
  }
  // Sort by realism tier first (Likely → Possible → Cross-divide), then by seats descending.
  combos.sort((a, b) => {
    const t = COALITION_TIER_ORDER[a.realism.tier] - COALITION_TIER_ORDER[b.realism.tier];
    if (t !== 0) return t;
    return b.seats - a.seats;
  });
  // Keep top 18 — enough to see Likely + Possible without an overwhelming wall of Cross-divide.
  const top = combos.slice(0, 18);

  grid.innerHTML = top.map(({ c, seats, realism }) => {
    const margin = seats - MAJORITY;
    const seatsCls = margin >= 0 ? 'majority' : (margin >= -10 ? 'close' : 'short');
    const verdict = margin >= 0 ? `+${margin} maj` : `${margin} short`;
    const combo = c.map((p, i) => {
      const sw = `<span class="sw" style="background:${partyColor(p)}"></span>`;
      const pchip = `<span class="pchip">${sw}${PARTY_NAMES[p]} <b>${totals[p]}</b></span>`;
      return i === 0 ? pchip : `<span class="plus">+</span>${pchip}`;
    }).join('');
    const realismChip = `<span class="realism-chip realism-${realism.tier}" title="${realism.note}">${realism.label}</span>`;
    return `<div class="coalition-row ${seatsCls} realism-row-${realism.tier}">
      <div class="combo">${combo} ${realismChip}</div>
      <div class="seats">${seats}</div>
      <div class="verdict">${margin >= 0 ? '✓ MAJORITY · ' + verdict : verdict}</div>
    </div>`;
  }).join('');

  $('#coalition-toggle').textContent = state.coalitionMode === 3 ? 'Show only 2-party' : 'Show 3-party combos';
}

/* ---------------- Recent declarations feed + sound + flash ---------------- */
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { _audioCtx = null; }
  }
  return _audioCtx;
}
function playDing(opts = {}) {
  if (!state.soundOn) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  // Soft two-note arpeggio: C5 → E5 (or higher for flips)
  const notes = opts.flip ? [659.25, 880, 1318.5] : [523.25, 659.25];
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t + i * 0.08);
    g.gain.linearRampToValueAtTime(opts.flip ? 0.16 : 0.10, t + i * 0.08 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.08 + 0.30);
    osc.connect(g).connect(ctx.destination);
    osc.start(t + i * 0.08);
    osc.stop(t + i * 0.08 + 0.32);
  });
}

function flashSeat(name) {
  // Briefly highlight the polygon on the constituency map
  d3.selectAll('#map-spc .cg path')
    .filter(function (d) { return d && d.properties && d.properties.NAME === name; })
    .each(function () {
      this.classList.remove('flash');
      void this.getBoundingClientRect();   // force reflow to restart animation
      this.classList.add('flash');
    });
}

/**
 * Record a declaration event. Called whenever a constituency is added/changed
 * via manual entry, modal save, or live sheet pull.
 *  - kind: 'manual' | 'live' | 'import'
 */
function recordDeclaration(name, votes, kind = 'manual') {
  const baseline = state.byConstituency[name];
  if (!baseline) return;
  const winner = winnerOf(votes);
  const prevWinner = baseline.winner;
  const isFlip = prevWinner && winner && prevWinner !== winner;
  const ts = Date.now();
  // Replace any prior declaration entry for this name (most recent only)
  state.declarations = state.declarations.filter(d => d.name !== name);
  state.declarations.push({ name, ts, winner, prevWinner, isFlip, kind });
  // Keep buffer sensible
  if (state.declarations.length > 200) state.declarations.shift();
  if (kind !== 'import') {
    flashSeat(name);
    playDing({ flip: isFlip });
    if (isFlip) showToast(`${name}: ${PARTY_NAMES[winner]} GAIN from ${PARTY_NAMES[prevWinner]}`);
  }
}

function renderRecentFeed(s) {
  const feed = $('#recent-feed');
  if (!state.declarations.length) {
    feed.innerHTML = `<div class="recent-empty">Declarations will appear here as you enter results, import a file, or live-sheet rows arrive.</div>`;
    return;
  }
  const items = state.declarations.slice().sort((a, b) => b.ts - a.ts).slice(0, 30);
  feed.innerHTML = items.map(d => {
    const baseline = state.byConstituency[d.name];
    const time = new Date(d.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const sw = `<span class="sw" style="background:${partyColor(d.winner)}"></span>`;
    const sub = baseline ? baseline.region : '';
    const badge = d.isFlip
      ? `<span class="badge-flip">${PARTY_NAMES[d.prevWinner]} → ${PARTY_NAMES[d.winner]}</span>`
      : `<span class="badge-hold">HOLD</span>`;
    return `<div class="feed-item" data-name="${d.name}">
      <div class="time">${time}</div>
      <div class="body-cell">
        <div class="top">${sw}<b>${d.name}</b></div>
        <div class="sub">${sub}</div>
      </div>
      ${badge}
    </div>`;
  }).join('');
  feed.querySelectorAll('.feed-item').forEach(it => {
    it.addEventListener('click', () => openSeatModal(it.dataset.name));
  });
}

/* ---------------- TV / big-screen mode ---------------- */
function applyTvMode() {
  document.documentElement.classList.toggle('tv-mode', !!state.tvMode);
  const btn = $('#tv-btn');
  if (btn) btn.classList.toggle('primary', !!state.tvMode);
}
function toggleTvMode() {
  state.tvMode = !state.tvMode;
  applyTvMode(); persist();
  showToast(state.tvMode ? 'TV mode on (press T to exit)' : 'TV mode off');
}

/* ---------------- Sound toggle ---------------- */
function applySoundIcon() {
  $('#sound-icon-on').style.display  = state.soundOn ? '' : 'none';
  $('#sound-icon-off').style.display = state.soundOn ? 'none' : '';
}
function toggleSound() {
  state.soundOn = !state.soundOn;
  applySoundIcon(); persist();
  if (state.soundOn) {
    // Resume audio context on user gesture
    const ctx = getAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    playDing();
    showToast('Declaration sounds: on');
  } else {
    showToast('Declaration sounds: off');
  }
}

/* ---------------- Notable contests ---------------- */
function notableFor(name, kind = 'constituency') {
  if (!state.notables) return null;
  const bag = kind === 'constituency' ? state.notables.constituencies : state.notables.regions;
  return bag ? bag[name] : null;
}

/* ---------------- Theme ---------------- */
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $('#theme-icon-dark').style.display = state.theme === 'dark' ? '' : 'none';
  $('#theme-icon-light').style.display = state.theme === 'light' ? '' : 'none';
}
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(); persist();
}

/* ---------------- Main rerender ---------------- */
function rerender() {
  const s = computeSeats();
  applyHistoricalAttribute();
  renderHeroAndStatus(s);
  paintMaps(s);
  renderCompareTable(s);
  renderDeclaredList(s);
  renderNationalSwing(s);
  renderKeySeats(s);
  renderAllSeatsTable(s);
  renderWatchlist(s);
  renderCoalitions(s);
  renderRecentFeed(s);
  renderExpectedNext(s);
  renderStorySoFar(s);
  renderPathToMajority(s);
  renderDeclarationSchedule(s);
  if (state.modalSeat) renderSeatModalCompare(state.modalSeat);
}

/* ---------------- Wire up controls ---------------- */
function wire() {
  // Mode toggle
  $$('#mode-toggle button').forEach(b => {
    b.addEventListener('click', () => {
      $$('#mode-toggle button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.mode = b.dataset.mode;
      persist(); rerender();
    });
  });
  $$('#mode-toggle button').forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode));

  // Entry
  $('#entry-save').addEventListener('click', saveConstituencyResult);
  $('#entry-clear').addEventListener('click', clearEntryForm);

  // Region modal
  $('#region-modal-close').addEventListener('click', closeRegionModal);
  $('#region-modal-cancel').addEventListener('click', closeRegionModal);
  $('#region-modal-save').addEventListener('click', saveRegionListVotes);
  $('#region-modal-clear').addEventListener('click', clearRegionListVotes);
  $('#region-modal-back').addEventListener('click', e => { if (e.target === e.currentTarget) closeRegionModal(); });

  // Seat modal
  $('#seat-modal-close').addEventListener('click', closeSeatModal);
  $('#seat-modal-cancel').addEventListener('click', closeSeatModal);
  $('#seat-modal-save').addEventListener('click', saveSeatModal);
  $('#seat-modal-clear').addEventListener('click', clearSeatModal);
  $('#seat-modal-back').addEventListener('click', e => { if (e.target === e.currentTarget) closeSeatModal(); });

  // All-seats table sort + filter
  $$('#seats-table thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (state.table.sortKey === k) {
        state.table.sortDir = state.table.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.table.sortKey = k;
        // numeric defaults
        state.table.sortDir = (['m21','pctnow','swing'].includes(k)) ? 'desc' : 'asc';
      }
      renderAllSeatsTable(computeSeats());
    });
  });
  $('#seats-filter').addEventListener('input', e => {
    state.table.filter = e.target.value;
    renderAllSeatsTable(computeSeats());
  });

  // Theme toggle
  $('#theme-btn').addEventListener('click', toggleTheme);

  // Year-view selector
  $('#view-year').addEventListener('change', e => {
    state.viewYear = e.target.value;
    rerender();
  });

  // Smart paste
  $('#entry-paste').addEventListener('click', openPasteModal);
  $('#paste-modal-close').addEventListener('click', closePasteModal);
  $('#paste-modal-cancel').addEventListener('click', closePasteModal);
  $('#paste-modal-back').addEventListener('click', e => { if (e.target === e.currentTarget) closePasteModal(); });
  $('#paste-parse').addEventListener('click', runPaste);
  $('#paste-apply').addEventListener('click', applyPaste);
  $('#paste-input').addEventListener('input', () => { $('#paste-status').textContent = ''; });
  $('#paste-constituency').addEventListener('change', () => { if (pasteState.votes) runPaste(); });

  // TV mode
  $('#tv-btn').addEventListener('click', toggleTvMode);

  // Map view toggle (geographic vs hex)
  $$('#map-spc-toggle button').forEach(b => {
    b.addEventListener('click', () => {
      setSpcMapView(b.dataset.view);
      paintMaps(computeSeats());
    });
  });

  // Zoom toolbar buttons (+ / − / ⟲) on each map.
  // Resolves which SVG to act on based on the data-* attribute.
  function resolveSvg(which) {
    if (which === 'spc') return state.spcMapView === 'hex' ? '#map-spc-hex' : '#map-spc';
    if (which === 'sper') return '#map-sper';
    return null;
  }
  $$('.map-ctrl-btn').forEach(b => {
    b.addEventListener('click', () => {
      if (b.dataset.zoomIn)  { const sel = resolveSvg(b.dataset.zoomIn);  if (sel) zoomMapBy(sel, 1.5); }
      if (b.dataset.zoomOut) { const sel = resolveSvg(b.dataset.zoomOut); if (sel) zoomMapBy(sel, 1 / 1.5); }
      if (b.dataset.reset)   { const sel = resolveSvg(b.dataset.reset);   if (sel) resetMapZoom(sel); }
    });
  });

  // Sound toggle
  $('#sound-btn').addEventListener('click', toggleSound);

  // Coalition mode toggle
  $('#coalition-toggle').addEventListener('click', () => {
    state.coalitionMode = state.coalitionMode === 3 ? 2 : 3;
    rerender();
  });

  // Schedule filter
  const schedFilter = $('#schedule-filter');
  if (schedFilter) {
    schedFilter.addEventListener('change', () => renderDeclarationSchedule(computeSeats()));
  }

  // Press T to toggle TV mode (handy when projecting)
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 't' || e.key === 'T') toggleTvMode();
  });

  // Live mode
  $('#live-btn').addEventListener('click', openLiveModal);
  $('#live-modal-close').addEventListener('click', closeLiveModal);
  $('#live-modal-cancel').addEventListener('click', closeLiveModal);
  $('#live-modal-back').addEventListener('click', e => { if (e.target === e.currentTarget) closeLiveModal(); });
  $('#live-url').addEventListener('input', e => { state.live.url = e.target.value; saveLive(); });
  $('#live-interval').addEventListener('change', e => {
    state.live.intervalSec = parseInt(e.target.value, 10) || 30;
    saveLive();
    if (state.live.running) startLive(); // restart with new interval
  });
  $('#live-test').addEventListener('click', testLiveConnection);
  $('#live-start').addEventListener('click', () => {
    startLive();
    $('#live-start').style.display = 'none';
    $('#live-stop').style.display = '';
    showToast('Live mode started');
  });
  $('#live-stop').addEventListener('click', () => {
    stopLive();
    $('#live-start').style.display = '';
    $('#live-stop').style.display = 'none';
    showToast('Live mode stopped');
  });

  // Export / import / reset
  $('#export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({
      version: 1, exportedAt: new Date().toISOString(),
      entered: state.entered, mode: state.mode,
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `holyrood2026-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    showToast('Exported entries to JSON');
  });
  $('#import-file').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (d.entered) state.entered = d.entered;
        if (d.mode) state.mode = d.mode;
        persist(); rerender();
        showToast('Imported entries');
      } catch (err) { showToast('Failed to parse JSON'); }
    };
    r.readAsText(f); e.target.value = '';
  });
  $('#reset-btn').addEventListener('click', () => {
    const msg = [
      'Reset the dashboard to a brand-new state? This will wipe ALL local data:',
      '',
      '  • all entered constituency + region results',
      '  • the recent declarations log',
      '  • your watch list',
      '  • the saved Google Sheet URL + live-mode settings',
      '  • theme + TV mode + sound preferences',
      '  • the year-view selection',
      '',
      'This cannot be undone. Export entries first if you want a backup.',
    ].join('\n');
    if (!confirm(msg)) return;

    // Stop any running live polling so timers don't re-write storage after reset
    try { stopLive(); } catch (e) {}

    // Wipe every key this dashboard owns. Anything starting with our prefix.
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('holyrood2026.') || k === STORAGE_KEY || k === LIVE_KEY)) {
          toRemove.push(k);
        }
      }
      toRemove.forEach(k => localStorage.removeItem(k));
    } catch (e) {
      console.warn('Could not clear localStorage:', e);
    }

    // Reload — simplest way to guarantee a fully clean state across all
    // in-memory caches (D3 paint state, audio context, scheduled timers, etc.)
    showToast('Resetting…');
    setTimeout(() => location.reload(), 400);
  });

  // Esc closes any modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (state.modalSeat) closeSeatModal();
      if (state.modalRegion) closeRegionModal();
    }
  });
}

/* ---------------- Boot ---------------- */
async function boot() {
  await loadData();
  loadFromStorage();
  loadLive();

  // Pre-fill the default live URL for visitors who haven't set their own,
  // so the live-mode modal opens with the URL already populated. We do NOT
  // auto-start polling — the user has to click "Start live mode" to begin.
  if (DEFAULT_LIVE_URL && !state.live.url) {
    state.live.url = DEFAULT_LIVE_URL;
    state.live.intervalSec = state.live.intervalSec || DEFAULT_LIVE_INTERVAL_SEC;
    // state.live.running stays as loaded — false for new visitors,
    // true only if they had it running last session.
  }

  applyTheme();
  applyTvMode();
  applySoundIcon();
  buildEntryDropdowns();
  setupMaps();
  setupHexMap();
  wire();
  rerender();
  updateLiveStatus();
  // Only restart polling if the user explicitly had it running last session.
  // New visitors stay paused until they click Start.
  if (state.live.running && state.live.url) {
    startLive();
  }
  console.log('[Holyrood 2026] Ready.', {
    constituencies: state.results2021.constituencies.length,
    regions: state.results2021.regions.length,
    predictions: !!state.predictions,
  });
}

boot().catch(e => {
  console.error(e);
  document.body.innerHTML = `<div style="padding:40px; color: #ff8aa8; font-family: monospace;">
    Failed to boot: ${e.message}<br/>
    Make sure you're serving via a local web server, not opening file:// directly.<br/>
    Try: <code>cd "Election Dashboard" && python3 -m http.server 8000</code>
    then open <a href="http://localhost:8000">http://localhost:8000</a>
  </div>`;
});
