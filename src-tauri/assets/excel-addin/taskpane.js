// ── CodeForge AI — Excel Add-in Task Pane ────────────────────────────────────
// Uses a 2D XLOOKUP-style approach: scans for header row + label column,
// builds a lookup table {metric → {period → value}}, then does exact lookups.

const HUB_URL      = "ws://127.0.0.1:7471";
const RECONNECT_MS = 3000;

let ws           = null;
let isConnected  = false;
let isStreaming  = false;
let currentAiEl = null;

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $chat      = () => document.getElementById("chat");
const $question  = () => document.getElementById("question");
const $askBtn    = () => document.getElementById("askBtn");
const $statusDot = () => document.getElementById("statusDot");
const $statusTxt = () => document.getElementById("statusText");
const $subHint   = () => document.getElementById("subHint");
const $empty     = () => document.getElementById("emptyState");

function setConnected(v) {
  isConnected = v;
  $statusDot().className = "status-dot" + (v ? " connected" : "");
  $statusTxt().textContent = v ? "Connected" : "Disconnected";
  updateAskBtn();
}
function updateAskBtn() {
  const hasText = $question().value.trim().length > 0;
  $askBtn().disabled = !isConnected || isStreaming || !hasText;
  $subHint().textContent = !isConnected ? "⚠️ Open CodeForge app first"
    : isStreaming ? "Answering…"
    : "Select cells in Excel, then ask a question";
}
function hideEmpty() { const e = $empty(); if (e) e.remove(); }
function addMessage(text, type) {
  hideEmpty();
  const d = document.createElement("div");
  d.className = "msg " + type;
  d.textContent = text;
  $chat().appendChild(d);
  $chat().scrollTop = $chat().scrollHeight;
  return d;
}
function startAiMessage() {
  hideEmpty();
  const d = document.createElement("div");
  d.className = "msg ai";
  d.innerHTML = '<span class="cursor"></span>';
  $chat().appendChild(d);
  $chat().scrollTop = $chat().scrollHeight;
  currentAiEl = d;
  return d;
}
function appendToken(t) {
  if (!currentAiEl) startAiMessage();
  const cursor = currentAiEl.querySelector(".cursor");
  currentAiEl.insertBefore(document.createTextNode(t), cursor);
  $chat().scrollTop = $chat().scrollHeight;
}
function finishAiMessage() {
  if (currentAiEl) {
    const c = currentAiEl.querySelector(".cursor");
    if (c) c.remove();
    currentAiEl = null;
  }
  isStreaming = false;
  updateAskBtn();
}

// ── Normalise for fuzzy matching ──────────────────────────────────────────────
function norm(s) {
  return String(s ?? "").toLowerCase().replace(/[\s\-_\.&\/\\,]/g, "");
}

// ── Parse cell value → number ─────────────────────────────────────────────────
// Handles: 1234  "1,234"  "(184)" → -184  "-" → null
function toNum(v) {
  if (typeof v === "number") return v;
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (s === "-" || s === "") return null;
  // Accounting negative: (184) or (1,234)
  const neg = s.match(/^\(([0-9,]+\.?[0-9]*)\)$/);
  if (neg) { const n = parseFloat(neg[1].replace(/,/g, "")); return isNaN(n) ? null : -n; }
  const n = parseFloat(s.replace(/[,$ ₹]/g, ""));
  return isNaN(n) ? null : n;
}

// ── Period / label detection ──────────────────────────────────────────────────
// Convert Excel date serial number → JS Date
// Excel epoch = Jan 1 1900 (with its famous 1900 leap year bug handled by -25568 not -25569)
function excelSerialToDate(serial) {
  return new Date((serial - 25569) * 86400 * 1000);
}

// Excel date serial range for years 1990–2099 (approx 32874 – 72687)
function isExcelDateSerial(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 32874 && v <= 72687;
}

// Extract a display label from any period-like value
// Returns a string like "2013", "FY23", "Mar-23", or null
function toPeriodLabel(v) {
  if (v === null || v === undefined || v === "") return null;
  // Excel date serial → extract year (e.g. 41334 → "2013")
  if (isExcelDateSerial(v)) {
    return String(excelSerialToDate(v).getUTCFullYear());
  }
  const s = String(v).trim();
  if (!s) return null;
  // Plain 4-digit year as number or string
  if (/^(19|20)\d{2}$/.test(s)) return s;
  // Period strings: FY23, Q1-23, Mar-23, H1-22, etc.
  if (/^FY[\-\s]?\d{2,4}$/i.test(s)) return s;
  if (/^Q[1-4][\-\s]?\d{2,4}$/i.test(s)) return s;
  if (/^H[12][\-\s]?\d{2,4}$/i.test(s)) return s;
  if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\-\s]?\d{2,4}$/i.test(s)) return s;
  return null;
}

function isYearLike(v) {
  if (isExcelDateSerial(v)) return true;
  if (typeof v === "number") return v >= 1990 && v <= 2099 && Number.isInteger(v);
  return /^(19|20)\d{2}$/.test(String(v ?? "").trim());
}

function isPeriodLike(v) {
  return toPeriodLabel(v) !== null;
}

function isTextLabel(v) {
  const s = String(v ?? "").trim();
  return s.length > 0 && toNum(v) === null && !isPeriodLike(v);
}

// ── XLOOKUP-style table builder ───────────────────────────────────────────────
// Scans the 2D values array to find:
//   headerRow  — the row whose cells are mostly period labels (years, quarters)
//   labelCol   — the column whose cells are mostly text metric names
// Then builds a lookup table: { normalisedMetric → { normalisedPeriod → value } }
// Also stores raw labels for display.

function buildLookupTable(values) {
  if (!values || values.length < 2) return null;
  const nRows = values.length;
  const nCols = values[0] ? values[0].length : 0;
  if (nCols < 2) return null;

  // Count period-like values in each ROW and each COLUMN
  const rowPeriodCount = values.map(row => row.filter(v => isPeriodLike(v)).length);
  const colPeriodCount = Array.from({ length: nCols }, (_, c) =>
    values.filter(r => isPeriodLike(r[c])).length
  );

  const maxRowPeriods = Math.max(...rowPeriodCount);
  const maxColPeriods = Math.max(...colPeriodCount);

  // Decide orientation:
  // HORIZONTAL — years in a ROW (most common: Year | 2013 | 2014 | ...)
  // VERTICAL   — years in a COLUMN (transposed: Year, 2013, 2014 down col A)
  const useHorizontal = maxRowPeriods >= maxColPeriods;

  if (useHorizontal) {
    // ── HORIZONTAL: find which ROW has years, which COL has labels ──
    let headerRowIdx = rowPeriodCount.indexOf(maxRowPeriods);

    // Find label column (most text labels below header row)
    const dataSlice = values.slice(headerRowIdx + 1);
    let labelColIdx = 0;
    let bestLabelCount = 0;
    for (let c = 0; c < Math.min(4, nCols); c++) {
      const cnt = dataSlice.filter(r => isTextLabel(r[c])).length;
      if (cnt > bestLabelCount) { bestLabelCount = cnt; labelColIdx = c; }
    }

    // Collect period columns from header row
    // Use toPeriodLabel() so Excel date serials become "2013", "2014" etc.
    const headerRow = values[headerRowIdx];
    const periodCols = [];
    for (let c = 0; c < nCols; c++) {
      if (c === labelColIdx) continue;
      const label = toPeriodLabel(headerRow[c]);
      if (label) {
        periodCols.push({ colIdx: c, raw: label, normed: norm(label) });
      }
    }
    if (periodCols.length === 0) return null;

    // Build table
    const table = {};
    for (let r = headerRowIdx + 1; r < nRows; r++) {
      const rawLabel = String(values[r][labelColIdx] ?? "").trim();
      if (!rawLabel) continue;
      const nLabel = norm(rawLabel);
      if (!table[nLabel]) table[nLabel] = { _raw: rawLabel, _allValues: [], _periods: [] };
      for (const p of periodCols) {
        const val = toNum(values[r][p.colIdx]);
        if (val !== null) {
          table[nLabel][p.normed] = val;
          table[nLabel][p.raw]    = val;
          table[nLabel]._allValues.push(val);
          if (!table[nLabel]._periods.includes(p.raw)) table[nLabel]._periods.push(p.raw);
        }
      }
    }
    return { table, periods: periodCols.map(p => p.raw), orientation: "horizontal" };

  } else {
    // ── VERTICAL: years in a COLUMN, metrics in a ROW ──
    let headerColIdx = colPeriodCount.indexOf(maxColPeriods);

    // Find label row (most text labels beside header col)
    const dataSlice = values.map(r => r.filter((_, c) => c !== headerColIdx));
    let labelRowIdx = 0;
    let bestLabelCount = 0;
    for (let r = 0; r < Math.min(4, nRows); r++) {
      const cnt = values[r].filter((v, c) => c !== headerColIdx && isTextLabel(v)).length;
      if (cnt > bestLabelCount) { bestLabelCount = cnt; labelRowIdx = r; }
    }

    // Collect period rows — convert date serials to year strings
    const periodRows = [];
    for (let r = 0; r < nRows; r++) {
      if (r === labelRowIdx) continue;
      const label = toPeriodLabel(values[r][headerColIdx]);
      if (label) {
        periodRows.push({ rowIdx: r, raw: label, normed: norm(label) });
      }
    }
    if (periodRows.length === 0) return null;

    // Metric labels are in labelRowIdx, columns are metrics
    const table = {};
    for (let c = 0; c < nCols; c++) {
      if (c === headerColIdx) continue;
      const rawLabel = String(values[labelRowIdx][c] ?? "").trim();
      if (!rawLabel) continue;
      const nLabel = norm(rawLabel);
      if (!table[nLabel]) table[nLabel] = { _raw: rawLabel, _allValues: [], _periods: [] };
      for (const p of periodRows) {
        const val = toNum(values[p.rowIdx][c]);
        if (val !== null) {
          table[nLabel][p.normed] = val;
          table[nLabel][p.raw]    = val;
          table[nLabel]._allValues.push(val);
          if (!table[nLabel]._periods.includes(p.raw)) table[nLabel]._periods.push(p.raw);
        }
      }
    }
    return { table, periods: periodRows.map(p => p.raw), orientation: "vertical" };
  }
}

// ── Metric label aliases ──────────────────────────────────────────────────────
const ALIASES = {
  // ── Income Statement ───────────────────────────────────────────────────────
  revenue:          ["revenue","totalrevenue","netsales","sales","netrevenue","turnover",
                     "revenuefromoperations","revenuefromoperationsnet","totalrevenuefromoperations",
                     "incomefromoperations"],
  cogs:             ["cogs","costofgoodssold","costofgoods","costofsales","costofrevenue",
                     "materialcost","rawmaterialcost","costofmaterialsconsumed",
                     "purchasesrawmaterials"],
  grossprofit:      ["grossprofit","gp"],
  ebitda:           ["ebitda"],
  ebit:             ["ebit","operatingprofit","pbit","profitbeforeinterestandtax"],
  interestexpense:  ["interestexpense","financecharges","financecosts","interestcost",
                     "borrowingcosts","interestpaid","financialcharges"],
  depreciation:     ["depreciation","depreciationandamortization","da"],
  pbt:              ["pbt","profitbeforetax","profitbeforeexceptionalitemsandtax",
                     "profitbeforeexceptional"],
  tax:              ["tax","taxexpense","incometax","taxprovision"],
  pat:              ["pat","netprofit","netincome","profitaftertax","profitfortheyear",
                     "profitforthecurrentyear","netprofitloss"],
  eps:              ["eps","earningspershare","basiceps","dilutedeps"],
  // ── Balance Sheet ──────────────────────────────────────────────────────────
  totalassets:      ["totalassets","assets","totalasset"],
  fixedassets:      ["fixedassets","netfixedassets","tangibleassets","ppe",
                     "propertyplantequipment","netblock"],
  currentassets:    ["currentassets","totalcurrentassets"],
  cash:             ["cash","cashandcashequivalents","cashandequivalents","cashandbank"],
  inventory:        ["inventory","inventories","stock","stockintrade"],
  receivables:      ["receivables","tradereceivables","accountsreceivable","debtors",
                     "sundrydebtors"],
  currentliabilities:["currentliabilities","totalcurrentliabilities"],
  payables:         ["payables","tradepayables","accountspayable","creditors","sundrycreditors"],
  totaldebt:        ["totaldebt","debt","borrowings","totalborrowings","totalloans",
                     "longtermborrowings","longtermandshorttermborrowings"],
  equity:           ["equity","totalequity","shareholdersequity","shareholdersfund","networth",
                     "totalnetworth","bookvalue","totalshareholdersfund","reservesandsurplus"],
  sharesoutstanding:["sharesoutstanding","numberofshares","equityshares","paidupcapital"],
  capitalemployed:  ["capitalemployed","totalcapitalemployed"],
  // ── Cash Flow ──────────────────────────────────────────────────────────────
  operatingcashflow:["operatingcashflow","cashflowfromoperations","cffo","cfo",
                     "netcashfromoperatingactivities"],
  capex:            ["capex","capitalexpenditure","purchaseoffixedassets","additionstofixedassets"],
  freecashflow:     ["freecashflow","fcf"],
  expenses:         ["expenses","totalexpenses","operatingexpenses"],
};

// Expand a query through aliases — returns all norm strings to check
function expandQuery(q) {
  const all = new Set([q]);
  // Direct alias group match
  for (const [key, alts] of Object.entries(ALIASES)) {
    const inGroup = alts.includes(q) || q === norm(key);
    if (inGroup) { alts.forEach(a => all.add(a)); all.add(norm(key)); break; }
  }
  return [...all];
}

// Look up a metric label in the table (with fuzzy + alias matching)
function findInTable(table, metricQuery) {
  const q = norm(metricQuery);
  const candidates = expandQuery(q);

  // 1. Exact norm match
  for (const c of candidates) {
    if (table[c]) return table[c];
  }
  // 2. Table key contains candidate or candidate contains table key
  for (const c of candidates) {
    const key = Object.keys(table).find(k => k.includes(c) || c.includes(k));
    if (key) return table[key];
  }
  // 3. Original query substring match
  const key = Object.keys(table).find(k => k.includes(q) || q.includes(k));
  if (key) return table[key];

  return null;
}

// Find the best period match in a row entry
function findPeriodValue(entry, periodQuery) {
  if (!entry) return null;
  const q = norm(String(periodQuery));

  // Direct norm match
  if (entry[q] !== undefined) return entry[q];

  // Raw key match
  if (entry[periodQuery] !== undefined) return entry[periodQuery];

  // Contains match across all keys
  for (const [k, v] of Object.entries(entry)) {
    if (k.startsWith("_")) continue;
    if (norm(k).includes(q) || q.includes(norm(k))) return v;
  }

  // Year short form: "2023" matches "fy2023", "fy23"
  if (/^(19|20)\d{2}$/.test(String(periodQuery))) {
    const short = String(periodQuery).slice(2); // "23" from "2023"
    for (const [k, v] of Object.entries(entry)) {
      if (k.startsWith("_")) continue;
      const nk = norm(k);
      if (nk.includes(short) || nk.includes(String(periodQuery))) return v;
    }
  }
  return null;
}

// ── Extract period from question ──────────────────────────────────────────────
function extractPeriod(question) {
  const patterns = [
    /\b(FY[\-\s]?\d{2,4})\b/i, /\b(Q[1-4][\-\s]?\d{2,4})\b/i,
    /\b(H[12][\-\s]?\d{2,4})\b/i,
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\-\s]?\d{2,4}\b/i,
    /\b(20\d{2})\b/, /\b(19\d{2})\b/,
  ];
  for (const p of patterns) { const m = question.match(p); if (m) return (m[1]||m[0]).trim(); }
  return null;
}

// ── Format number ─────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null) return "?";
  const abs = Math.abs(n);
  if (abs >= 1e7)  return (n/1e7).toFixed(2) + " Cr";
  if (abs >= 1e5)  return (n/1e5).toFixed(2) + " L";
  if (abs >= 1000) return n.toLocaleString("en-IN");
  return parseFloat(n.toFixed(2)).toString();
}

// ── Financial ratio definitions ───────────────────────────────────────────────
const RATIOS = [
  // ── Profitability ──────────────────────────────────────────────────────────
  {
    names: ["grossmargin","gm","grossprofit%","grossprofitratio"],
    label: "Gross Margin",
    formula: "Gross Margin = (Revenue − COGS) / Revenue × 100",
    unit: "%",
    compute(t,p) {
      const rev = getVal(t,"revenue",p), cogs = getVal(t,"cogs",p);
      if (rev==null||cogs==null) return null;
      const r = ((rev-cogs)/rev)*100;
      return { result:r, working:`(${fmt(rev)} − ${fmt(cogs)}) / ${fmt(rev)} × 100 = ${r.toFixed(2)}%` };
    }
  },
  {
    names: ["operatingmargin","ebitmargin","operatingprofitratio","opm"],
    label: "Operating Margin (EBIT Margin)",
    formula: "Operating Margin = EBIT / Revenue × 100",
    unit: "%",
    compute(t,p) {
      const rev = getVal(t,"revenue",p), ebit = getVal(t,"ebit",p);
      if (rev==null||ebit==null) return null;
      const r = (ebit/rev)*100;
      return { result:r, working:`${fmt(ebit)} / ${fmt(rev)} × 100 = ${r.toFixed(2)}%` };
    }
  },
  {
    names: ["ebitdamargin","ebitdaasapercentage"],
    label: "EBITDA Margin",
    formula: "EBITDA Margin = EBITDA / Revenue × 100",
    unit: "%",
    compute(t,p) {
      const rev = getVal(t,"revenue",p), e = getVal(t,"ebitda",p);
      if (rev==null||e==null) return null;
      const r = (e/rev)*100;
      return { result:r, working:`${fmt(e)} / ${fmt(rev)} × 100 = ${r.toFixed(2)}%` };
    }
  },
  {
    names: ["netmargin","netprofitmargin","npm","patmargin","profitmargin"],
    label: "Net Profit Margin",
    formula: "Net Profit Margin = PAT / Revenue × 100",
    unit: "%",
    compute(t,p) {
      const rev = getVal(t,"revenue",p), pat = getVal(t,"pat",p);
      if (rev==null||pat==null) return null;
      const r = (pat/rev)*100;
      return { result:r, working:`${fmt(pat)} / ${fmt(rev)} × 100 = ${r.toFixed(2)}%` };
    }
  },
  {
    names: ["roe","returnonequity","returnonnettangibleassets"],
    label: "Return on Equity (ROE)",
    formula: "ROE = PAT / Shareholders Equity × 100",
    unit: "%",
    compute(t,p) {
      const pat = getVal(t,"pat",p), eq = getVal(t,"equity",p);
      if (pat==null||eq==null) return null;
      const r = (pat/eq)*100;
      return { result:r, working:`${fmt(pat)} / ${fmt(eq)} × 100 = ${r.toFixed(2)}%` };
    }
  },
  {
    names: ["roa","returnonassets"],
    label: "Return on Assets (ROA)",
    formula: "ROA = PAT / Total Assets × 100",
    unit: "%",
    compute(t,p) {
      const pat = getVal(t,"pat",p), assets = getVal(t,"totalassets",p);
      if (pat==null||assets==null) return null;
      const r = (pat/assets)*100;
      return { result:r, working:`${fmt(pat)} / ${fmt(assets)} × 100 = ${r.toFixed(2)}%` };
    }
  },
  {
    names: ["roce","returnoncapitalemployed"],
    label: "Return on Capital Employed (ROCE)",
    formula: "ROCE = EBIT / Capital Employed × 100  |  Capital Employed = Total Assets − Current Liabilities",
    unit: "%",
    compute(t,p) {
      const ebit = getVal(t,"ebit",p);
      let ce = getVal(t,"capitalemployed",p);
      if (ce==null) {
        const ta = getVal(t,"totalassets",p), cl = getVal(t,"currentliabilities",p);
        if (ta==null||cl==null) return null;
        ce = ta - cl;
      }
      if (ebit==null||ce==null||ce===0) return null;
      const r = (ebit/ce)*100;
      return { result:r, working:`${fmt(ebit)} / ${fmt(ce)} × 100 = ${r.toFixed(2)}%` };
    }
  },
  {
    names: ["eps","earningspershare"],
    label: "Earnings Per Share (EPS)",
    formula: "EPS = PAT / Shares Outstanding",
    unit: "₹",
    compute(t,p) {
      const pat = getVal(t,"pat",p), shares = getVal(t,"sharesoutstanding",p);
      if (pat==null||shares==null||shares===0) return null;
      const r = pat/shares;
      return { result:r, working:`${fmt(pat)} / ${fmt(shares)} = ₹${r.toFixed(2)}` };
    }
  },
  // ── Liquidity ──────────────────────────────────────────────────────────────
  {
    names: ["currentratio","workingratio"],
    label: "Current Ratio",
    formula: "Current Ratio = Current Assets / Current Liabilities",
    unit: "x",
    compute(t,p) {
      const ca = getVal(t,"currentassets",p), cl = getVal(t,"currentliabilities",p);
      if (ca==null||cl==null||cl===0) return null;
      const r = ca/cl;
      return { result:r, working:`${fmt(ca)} / ${fmt(cl)} = ${r.toFixed(2)}x` };
    }
  },
  {
    names: ["quickratio","acidtestratio","liquidratio"],
    label: "Quick Ratio",
    formula: "Quick Ratio = (Current Assets − Inventory) / Current Liabilities",
    unit: "x",
    compute(t,p) {
      const ca = getVal(t,"currentassets",p), inv = getVal(t,"inventory",p), cl = getVal(t,"currentliabilities",p);
      if (ca==null||cl==null||cl===0) return null;
      const quick = ca - (inv||0);
      const r = quick/cl;
      return { result:r, working:`(${fmt(ca)} − ${fmt(inv||0)}) / ${fmt(cl)} = ${r.toFixed(2)}x` };
    }
  },
  {
    names: ["cashratio"],
    label: "Cash Ratio",
    formula: "Cash Ratio = Cash & Equivalents / Current Liabilities",
    unit: "x",
    compute(t,p) {
      const cash = getVal(t,"cash",p), cl = getVal(t,"currentliabilities",p);
      if (cash==null||cl==null||cl===0) return null;
      const r = cash/cl;
      return { result:r, working:`${fmt(cash)} / ${fmt(cl)} = ${r.toFixed(2)}x` };
    }
  },
  // ── Leverage / Solvency ────────────────────────────────────────────────────
  {
    names: ["deratio","d/e","debttoequity","debtequity","leverageratio","financialleverage"],
    label: "Debt-to-Equity Ratio (D/E)",
    formula: "D/E Ratio = Total Debt / Shareholders Equity",
    unit: "x",
    compute(t,p) {
      const debt = getVal(t,"totaldebt",p), eq = getVal(t,"equity",p);
      if (debt==null||eq==null||eq===0) return null;
      const r = debt/eq;
      return { result:r, working:`${fmt(debt)} / ${fmt(eq)} = ${r.toFixed(2)}x` };
    }
  },
  {
    names: ["debtratio","debttotalassetsratio"],
    label: "Debt Ratio",
    formula: "Debt Ratio = Total Debt / Total Assets",
    unit: "x",
    compute(t,p) {
      const debt = getVal(t,"totaldebt",p), assets = getVal(t,"totalassets",p);
      if (debt==null||assets==null||assets===0) return null;
      const r = debt/assets;
      return { result:r, working:`${fmt(debt)} / ${fmt(assets)} = ${r.toFixed(2)}x` };
    }
  },
  {
    names: ["interestcoverage","icr","interestcoverageratio","timesinterestearned"],
    label: "Interest Coverage Ratio (ICR)",
    formula: "ICR = EBIT / Interest Expense",
    unit: "x",
    compute(t,p) {
      const ebit = getVal(t,"ebit",p), interest = getVal(t,"interestexpense",p);
      if (ebit==null||interest==null||interest===0) return null;
      const r = ebit/interest;
      return { result:r, working:`${fmt(ebit)} / ${fmt(interest)} = ${r.toFixed(2)}x` };
    }
  },
  {
    names: ["debtservicecoverage","dscr"],
    label: "Debt Service Coverage Ratio (DSCR)",
    formula: "DSCR = EBITDA / Interest Expense",
    unit: "x",
    compute(t,p) {
      const ebitda = getVal(t,"ebitda",p), interest = getVal(t,"interestexpense",p);
      if (ebitda==null||interest==null||interest===0) return null;
      const r = ebitda/interest;
      return { result:r, working:`${fmt(ebitda)} / ${fmt(interest)} = ${r.toFixed(2)}x` };
    }
  },
  // ── Efficiency ─────────────────────────────────────────────────────────────
  {
    names: ["assetturnover","assetturnoverratio","totalassetturnover"],
    label: "Asset Turnover Ratio",
    formula: "Asset Turnover = Revenue / Total Assets",
    unit: "x",
    compute(t,p) {
      const rev = getVal(t,"revenue",p), assets = getVal(t,"totalassets",p);
      if (rev==null||assets==null||assets===0) return null;
      const r = rev/assets;
      return { result:r, working:`${fmt(rev)} / ${fmt(assets)} = ${r.toFixed(2)}x` };
    }
  },
  {
    names: ["inventoryturnover","inventoryturnoverratio","stockturnover"],
    label: "Inventory Turnover Ratio",
    formula: "Inventory Turnover = COGS / Inventory",
    unit: "x",
    compute(t,p) {
      const cogs = getVal(t,"cogs",p), inv = getVal(t,"inventory",p);
      if (cogs==null||inv==null||inv===0) return null;
      const r = cogs/inv;
      return { result:r, working:`${fmt(cogs)} / ${fmt(inv)} = ${r.toFixed(2)}x` };
    }
  },
  {
    names: ["daysinventory","dio","daysinventoryoutstanding","inventorydays"],
    label: "Days Inventory Outstanding (DIO)",
    formula: "DIO = (Inventory / COGS) × 365",
    unit: "days",
    compute(t,p) {
      const inv = getVal(t,"inventory",p), cogs = getVal(t,"cogs",p);
      if (inv==null||cogs==null||cogs===0) return null;
      const r = (inv/cogs)*365;
      return { result:r, working:`(${fmt(inv)} / ${fmt(cogs)}) × 365 = ${r.toFixed(1)} days` };
    }
  },
  {
    names: ["receivablesturnover","debtorturnover","receivablesturnoverratio"],
    label: "Receivables Turnover Ratio",
    formula: "Receivables Turnover = Revenue / Trade Receivables",
    unit: "x",
    compute(t,p) {
      const rev = getVal(t,"revenue",p), rec = getVal(t,"receivables",p);
      if (rev==null||rec==null||rec===0) return null;
      const r = rev/rec;
      return { result:r, working:`${fmt(rev)} / ${fmt(rec)} = ${r.toFixed(2)}x` };
    }
  },
  {
    names: ["dayssalesoutstanding","dso","debtorcollectionperiod","receivabledays"],
    label: "Days Sales Outstanding (DSO)",
    formula: "DSO = (Trade Receivables / Revenue) × 365",
    unit: "days",
    compute(t,p) {
      const rec = getVal(t,"receivables",p), rev = getVal(t,"revenue",p);
      if (rec==null||rev==null||rev===0) return null;
      const r = (rec/rev)*365;
      return { result:r, working:`(${fmt(rec)} / ${fmt(rev)}) × 365 = ${r.toFixed(1)} days` };
    }
  },
  {
    names: ["payablesturnover","creditorsturnover","payablesturnoverratio"],
    label: "Payables Turnover Ratio",
    formula: "Payables Turnover = COGS / Trade Payables",
    unit: "x",
    compute(t,p) {
      const cogs = getVal(t,"cogs",p), pay = getVal(t,"payables",p);
      if (cogs==null||pay==null||pay===0) return null;
      const r = cogs/pay;
      return { result:r, working:`${fmt(cogs)} / ${fmt(pay)} = ${r.toFixed(2)}x` };
    }
  },
  {
    names: ["dayspayableoutstanding","dpo","creditordays","payabledays"],
    label: "Days Payable Outstanding (DPO)",
    formula: "DPO = (Trade Payables / COGS) × 365",
    unit: "days",
    compute(t,p) {
      const pay = getVal(t,"payables",p), cogs = getVal(t,"cogs",p);
      if (pay==null||cogs==null||cogs===0) return null;
      const r = (pay/cogs)*365;
      return { result:r, working:`(${fmt(pay)} / ${fmt(cogs)}) × 365 = ${r.toFixed(1)} days` };
    }
  },
  {
    names: ["cashconversioncycle","ccc","netoperatingcycle"],
    label: "Cash Conversion Cycle (CCC)",
    formula: "CCC = DIO + DSO − DPO",
    unit: "days",
    compute(t,p) {
      const inv  = getVal(t,"inventory",p),   cogs = getVal(t,"cogs",p);
      const rec  = getVal(t,"receivables",p), rev  = getVal(t,"revenue",p);
      const pay  = getVal(t,"payables",p);
      if (!inv||!cogs||!rec||!rev||!pay||cogs===0||rev===0||cogs===0) return null;
      const dio = (inv/cogs)*365, dso = (rec/rev)*365, dpo = (pay/cogs)*365;
      const r = dio + dso - dpo;
      return { result:r, working:`DIO(${dio.toFixed(1)}) + DSO(${dso.toFixed(1)}) − DPO(${dpo.toFixed(1)}) = ${r.toFixed(1)} days` };
    }
  },
  // ── Growth ─────────────────────────────────────────────────────────────────
  {
    names: ["yoygrowth","yoy","yearonyear","yearoveryear","revenuegrowth","salesgrowth","growthrate"],
    label: "YoY Growth",
    formula: "YoY Growth = (Current Year − Prior Year) / |Prior Year| × 100",
    unit: "%",
    compute(t,p) {
      const entry = findInTable(t,"revenue") || Object.values(t).find(e => e._periods.length >= 2);
      if (!entry||entry._periods.length < 2) return null;
      let ci, pi;
      if (p) {
        ci = entry._periods.findIndex(pr => norm(pr).includes(norm(p))||norm(p).includes(norm(pr)));
        if (ci < 1) return null;
        pi = ci - 1;
      } else { ci = entry._periods.length-1; pi = ci-1; }
      const curr = findPeriodValue(entry, entry._periods[ci]);
      const prior = findPeriodValue(entry, entry._periods[pi]);
      if (curr==null||prior==null||prior===0) return null;
      const r = ((curr-prior)/Math.abs(prior))*100;
      return { result:r, working:`(${fmt(curr)} − ${fmt(prior)}) / ${fmt(Math.abs(prior))} × 100 = ${r.toFixed(2)}% (${entry._periods[pi]} → ${entry._periods[ci]})` };
    }
  },
  // ── Cash Flow ──────────────────────────────────────────────────────────────
  {
    names: ["freecashflow","fcf"],
    label: "Free Cash Flow (FCF)",
    formula: "FCF = Operating Cash Flow − CapEx",
    unit: "",
    compute(t,p) {
      const ocf = getVal(t,"operatingcashflow",p), capex = getVal(t,"capex",p);
      if (ocf==null||capex==null) return null;
      const r = ocf - Math.abs(capex);
      return { result:r, working:`${fmt(ocf)} − ${fmt(Math.abs(capex))} = ${fmt(r)}` };
    }
  },
  {
    names: ["workingcapital"],
    label: "Working Capital",
    formula: "Working Capital = Current Assets − Current Liabilities",
    unit: "",
    compute(t,p) {
      const ca = getVal(t,"currentassets",p), cl = getVal(t,"currentliabilities",p);
      if (ca==null||cl==null) return null;
      const r = ca - cl;
      return { result:r, working:`${fmt(ca)} − ${fmt(cl)} = ${fmt(r)}` };
    }
  },
];

// Helper: get value from table for a metric+period (or sum all periods if period=null)
function getVal(table, metric, period) {
  const entry = findInTable(table, metric);
  if (!entry) return null;
  if (period) return findPeriodValue(entry, period);
  // No period → sum all values
  return entry._allValues.length > 0 ? entry._allValues.reduce((a,b)=>a+b,0) : null;
}

// ── Main compute function ─────────────────────────────────────────────────────
function computeAnswer(table, question) {
  const q      = norm(question);
  const period = extractPeriod(question);

  // 1. Ratio detection
  for (const ratio of RATIOS) {
    if (ratio.names.some(n => q.includes(norm(n)))) {
      const res = ratio.compute(table, period);
      if (res) return { type:"ratio", label:ratio.label, period:period||"all", working:res.working, result:res.result, unit:ratio.unit };
      return { type:"missing", label:ratio.label };
    }
  }

  // 2. Direct lookup: metric + period
  if (period) {
    const entry = findInTable(table, q.replace(/\d/g,"").trim()) || findInTable(table, q);
    if (entry) {
      const val = findPeriodValue(entry, period);
      if (val !== null) {
        // Find the actual period key that matched
        const matchedPeriod = entry._periods.find(pr =>
          norm(pr).includes(norm(period)) || norm(period).includes(norm(pr))
        ) || period;
        return { type:"lookup", label:entry._raw, period:matchedPeriod, value:val };
      }
    }
  }

  // 3. All-period values for a metric (sum / trend)
  const entry = findInTable(table, q.replace(/\d/g,"").trim()) || findInTable(table, q);
  if (entry && entry._allValues.length > 0) {
    return { type:"trend", label:entry._raw, periods:entry._periods, values:entry._allValues,
             total:entry._allValues.reduce((a,b)=>a+b,0) };
  }

  return null;
}

// ── Build prompt payload ──────────────────────────────────────────────────────
function buildPrompt(table, periods, question, computed, sheetName) {
  // Compact data: one line per metric showing only periods that have values
  let dataStr = `Sheet: ${sheetName}\nPeriods available: ${periods.join(", ")}\n\n`;
  for (const [, entry] of Object.entries(table)) {
    if (entry._allValues.length === 0) continue;
    const vals = entry._periods.map(p => `${p}=${fmt(entry[p]||entry[norm(p)])}`).join("  ");
    dataStr += `${entry._raw}: ${vals}\n`;
  }

  let computedStr = "";
  if (computed) {
    if (computed.type === "ratio") {
      computedStr = `\nPRE-COMPUTED RESULT:\n${computed.label} (${computed.period}): ${computed.working}\n`;
    } else if (computed.type === "lookup") {
      computedStr = `\nPRE-COMPUTED RESULT:\n${computed.label} for ${computed.period} = ${fmt(computed.value)}\n`;
    } else if (computed.type === "trend") {
      const bd = computed.periods.map((p,i) => `${p}: ${fmt(computed.values[i])}`).join(", ");
      computedStr = `\nPRE-COMPUTED RESULT:\n${computed.label} — ${bd}\nTotal: ${fmt(computed.total)}\n`;
    } else if (computed.type === "missing") {
      computedStr = `\nNOTE: Required values for ${computed.label} not found in selected range.\n`;
    }
  }
  return { dataStr, computedStr };
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
  try { ws = new WebSocket(HUB_URL); } catch { setTimeout(connect, RECONNECT_MS); return; }
  ws.onopen = () => { ws.send(JSON.stringify({ type:"hello", editor:"excel" })); setConnected(true); };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case "token": if (msg.content) appendToken(msg.content); break;
      case "done":  finishAiMessage(); break;
      case "error": finishAiMessage(); addMessage("⚠️ "+(msg.message||"Error"), "error"); break;
    }
  };
  ws.onclose = () => { setConnected(false); if (isStreaming) finishAiMessage(); setTimeout(connect, RECONNECT_MS); };
  ws.onerror = () => ws.close();
}

// ── Ask ───────────────────────────────────────────────────────────────────────
async function ask() {
  const question = $question().value.trim();
  if (!question || !isConnected || isStreaming) return;

  try {
    await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      const sheet = context.workbook.worksheets.getActiveWorksheet();
      range.load(["values", "rowCount", "columnCount", "address"]);
      sheet.load("name");
      await context.sync();

      const values = range.values;
      if (!values || values.length < 2) {
        addMessage("⚠️ Select at least 2 rows (header row + data rows).", "error");
        return;
      }

      // Build XLOOKUP-style lookup table
      const lookup = buildLookupTable(values);
      if (!lookup) {
        // Debug: show first row values to help diagnose
        const firstRow = values[0].slice(0, 6).map(v => `"${v}"`).join(", ");
        addMessage(`⚠️ No year/period headers found. First row values: [${firstRow}...]`, "error");
        return;
      }

      const { table, periods } = lookup;
      const metricCount = Object.keys(table).length;

      // Show selection preview
      const first = periods[0], last = periods[periods.length - 1];
      addMessage(
        `📋 ${metricCount} metrics | ${periods.length} periods (${first} → ${last}) | ${range.address}`,
        "status-msg"
      );

      // Compute answer in JS
      const computed = computeAnswer(table, question);

      if (computed && computed.type !== "missing") {
        addMessage(`✅ JS resolved: ${computed.type === "lookup" ? computed.label+" for "+computed.period+" = "+fmt(computed.value) : computed.label}`, "status-msg");
      } else if (computed?.type === "missing") {
        addMessage(`⚠️ ${computed.label}: values not found in selection`, "status-msg");
      } else {
        addMessage(`🤖 Sending to AI`, "status-msg");
      }

      addMessage(question, "user");
      $question().value = "";
      $question().style.height = "";
      updateAskBtn();
      isStreaming = true;
      updateAskBtn();
      startAiMessage();

      const { dataStr, computedStr } = buildPrompt(table, periods, question, computed, sheet.name);
      ws.send(JSON.stringify({
        type: "excel_query",
        question,
        dataStr,
        computedStr,
        hasComputed: computed !== null && computed.type !== "missing",
      }));
    });
  } catch (err) {
    isStreaming = false;
    updateAskBtn();
    addMessage("⚠️ Error: " + err.message, "error");
  }
}

// ── UI ────────────────────────────────────────────────────────────────────────
function handleKey(e) { if (e.key==="Enter"&&!e.shiftKey){e.preventDefault();ask();} }
function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 90) + "px";
  updateAskBtn();
}
Office.onReady(() => { connect(); $question().addEventListener("input", updateAskBtn); });
