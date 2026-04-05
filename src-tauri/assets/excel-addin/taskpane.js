// ── CodeForge AI — Excel Add-in ───────────────────────────────────────────────
const HUB_URL      = "ws://127.0.0.1:7471";
const RECONNECT_MS = 3000;

let ws             = null;
let isConnected    = false;
let isStreaming    = false;
let currentAiEl   = null;
let mode           = "ask";
let pendingFormula = null;
let formulaTarget  = null;
let pendingRange   = null;
let pendingMacro   = null;      // stores extracted VBA code waiting to be copied
let macroHistory   = [];        // conversation history for multi-turn macro refinement

// ── DOM ───────────────────────────────────────────────────────────────────────
const $chat      = () => document.getElementById("chat");
const $question  = () => document.getElementById("question");
const $askBtn    = () => document.getElementById("askBtn");
const $statusDot = () => document.getElementById("statusDot");
const $statusTxt = () => document.getElementById("statusText");
const $subHint   = () => document.getElementById("subHint");
const $empty     = () => document.getElementById("emptyState");

// ── Mode ──────────────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  document.getElementById("modeAsk").classList.toggle("active",     m === "ask");
  document.getElementById("modeFormula").classList.toggle("active", m === "formula");
  document.getElementById("modeMacro").classList.toggle("active",   m === "macro");
  document.getElementById("modeBuild").classList.toggle("active",   m === "build");

  if (m === "ask")     { $askBtn().textContent = "Ask";      $question().placeholder = "e.g. What is revenue for 2023?"; }
  if (m === "formula") { $askBtn().textContent = "Generate"; $question().placeholder = "e.g. VLOOKUP employee name from Sheet2 using ID in column A"; }
  if (m === "macro")   { $askBtn().textContent = "Generate Macro"; $question().placeholder = "e.g. Highlight all cells above 1000 in red"; }
  if (m === "build")   { $askBtn().textContent = "Run"; $question().placeholder = "e.g. Create a table, bold headers, freeze row 1 and auto-fit columns"; }

  const icon  = document.getElementById("emptyIcon");
  const title = document.getElementById("emptyTitle");
  const sub   = document.getElementById("emptySub");
  if (m === "ask") {
    icon.textContent  = "📊";
    title.textContent = "Ask about your data";
    sub.textContent   = "Select cells in Excel, then ask a question below.";
  } else if (m === "formula") {
    icon.textContent  = "✏️";
    title.textContent = "Generate a formula";
    sub.textContent   = "Select the target cell or range. AI sees all sheets — works with VLOOKUP, XLOOKUP, cross-sheet references.";
  } else if (m === "macro") {
    icon.textContent  = "🔧";
    title.textContent = "Generate a VBA Macro";
    sub.textContent   = "Describe what you want the macro to do. AI will think first, then build it.";
    macroHistory      = [];
  } else {
    icon.textContent  = "🏗️";
    title.textContent = "Build & format your sheet";
    sub.textContent   = "Select your data, then describe what to do — create tables, filters, charts, formatting and more.";
  }
  updateAskBtn();
}

function setConnected(v) {
  isConnected = v;
  $statusDot().className = "status-dot" + (v ? " connected" : "");
  $statusTxt().textContent = v ? "Connected" : "Disconnected";
  updateAskBtn();
}
function updateAskBtn() {
  const hasText = $question().value.trim().length > 0;
  $askBtn().disabled = !isConnected || isStreaming || !hasText;
  if (!isConnected)           $subHint().textContent = "⚠️ Open CodeForge app first";
  else if (isStreaming)       $subHint().textContent = mode === "macro" ? "Thinking…" : mode === "build" ? "Planning actions…" : "Answering…";
  else if (mode === "ask")    $subHint().textContent = "Select cells in Excel, then ask a question";
  else if (mode === "formula")$subHint().textContent = "Select target cell(s), then describe the formula — can reference other sheets";
  else if (mode === "build")  $subHint().textContent = "Select your data range, describe what to do — table, filter, format, chart…";
  else                        $subHint().textContent = macroHistory.length ? "Answer the questions above, then click Generate Macro" : "Describe your macro idea";
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
    const cursor = currentAiEl.querySelector(".cursor");
    if (cursor) cursor.remove();

    if (mode === "formula") {
      const text     = currentAiEl.textContent.trim();
      const allForms = [...text.matchAll(/=\S[^\n\r]*/g)].map(m => m[0].trim());
      if (allForms.length > 0) {
        pendingFormula = allForms;   // array of formulas
        formulaTarget  = pendingRange;
        const preview  = allForms.length > 1
          ? `${allForms[0]}  … (+${allForms.length - 1} more)`
          : allForms[0];
        const btn = document.createElement("button");
        btn.className   = "insert-btn";
        btn.textContent = `⬆ Insert into ${formulaTarget}: ${preview}`;
        btn.onclick     = insertFormula;
        currentAiEl.appendChild(btn);
      }
    }

    if (mode === "macro") {
      const text = currentAiEl.textContent.trim();
      macroHistory.push({ role: "assistant", content: text });
      const vbaMatch = text.match(/(?:Sub|Function)\s+\w[\s\S]*?End\s+(?:Sub|Function)/i);
      if (vbaMatch) {
        pendingMacro = vbaMatch[0].trim();
        const btn = document.createElement("button");
        btn.className   = "insert-btn";
        btn.textContent = "📋 Copy & Install Macro";
        btn.onclick     = copyAndInstallMacro;
        currentAiEl.appendChild(btn);
        macroHistory = [];
      }
    }

    if (mode === "build") {
      const raw  = currentAiEl.textContent.trim();
      // Replace streaming text with a "running" indicator while we execute
      currentAiEl.innerHTML = '<div class="build-thinking"><div class="build-spinner"></div><span>Applying actions…</span></div>';
      const savedEl = currentAiEl;
      currentAiEl   = null;
      isStreaming    = false;
      updateAskBtn();
      // Parse and execute asynchronously
      (async () => {
        try {
          const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
          const parsed  = JSON.parse(cleaned);
          const actions = Array.isArray(parsed) ? parsed : (parsed.actions || []);
          if (!actions.length) throw new Error("No actions found in AI response");
          await executeBuildActions(actions, savedEl);
        } catch (e) {
          savedEl.innerHTML = `<span style="color:#fca5a5">⚠️ ${e.message}</span>`;
        }
      })();
      return;
    }

    currentAiEl = null;
  }
  isStreaming = false;
  updateAskBtn();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function norm(s) {
  return String(s ?? "").toLowerCase().replace(/[\s\-_\.&\/\\,()]/g, "");
}
function toNum(v) {
  if (typeof v === "number") return v;
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (s === "-" || s === "") return null;
  const neg = s.match(/^\(([0-9,]+\.?[0-9]*)\)$/);
  if (neg) { const n = parseFloat(neg[1].replace(/,/g, "")); return isNaN(n) ? null : -n; }
  const n = parseFloat(s.replace(/[,$ ₹]/g, ""));
  return isNaN(n) ? null : n;
}
function fmt(n) {
  if (n == null) return "?";
  const abs = Math.abs(n);
  if (abs >= 1e7)  return (n/1e7).toFixed(2) + " Cr";
  if (abs >= 1e5)  return (n/1e5).toFixed(2) + " L";
  if (abs >= 1000) return n.toLocaleString("en-IN");
  return parseFloat(n.toFixed(2)).toString();
}
function colLetter(idx) {
  let letter = "", n = idx + 1;
  while (n > 0) { const r = (n-1)%26; letter = String.fromCharCode(65+r)+letter; n = Math.floor((n-1)/26); }
  return letter;
}

// ── Period detection ──────────────────────────────────────────────────────────
function excelSerialToDate(s) { return new Date((s - 25569) * 86400 * 1000); }
function isExcelDateSerial(v) { return typeof v==="number" && Number.isInteger(v) && v>=32874 && v<=72687; }
function toPeriodLabel(v) {
  if (v === null || v === undefined || v === "") return null;
  if (isExcelDateSerial(v)) return String(excelSerialToDate(v).getUTCFullYear());
  const s = String(v).trim();
  if (/^(19|20)\d{2}$/.test(s)) return s;
  if (/^FY[\-\s]?\d{2,4}$/i.test(s)) return s;
  if (/^Q[1-4][\-\s]?\d{2,4}$/i.test(s)) return s;
  if (/^H[12][\-\s]?\d{2,4}$/i.test(s)) return s;
  if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\-\s]?\d{2,4}$/i.test(s)) return s;
  return null;
}
function isPeriodLike(v) { return toPeriodLabel(v) !== null; }
function isTextLabel(v) {
  const s = String(v ?? "").trim();
  return s.length > 0 && toNum(v) === null && !isPeriodLike(v);
}

// ── XLOOKUP table builder ─────────────────────────────────────────────────────
function buildLookupTable(values) {
  if (!values || values.length < 2) return null;
  const nRows = values.length, nCols = values[0]?.length || 0;
  if (nCols < 2) return null;

  const rowPeriodCount = values.map(row => row.filter(v => isPeriodLike(v)).length);
  const colPeriodCount = Array.from({length: nCols}, (_, c) => values.filter(r => isPeriodLike(r[c])).length);
  const maxRow = Math.max(...rowPeriodCount), maxCol = Math.max(...colPeriodCount);
  const horizontal = maxRow >= maxCol;

  if (horizontal) {
    const headerRowIdx = rowPeriodCount.indexOf(maxRow);
    const dataSlice    = values.slice(headerRowIdx + 1);
    let labelColIdx = 0, best = 0;
    for (let c = 0; c < Math.min(4, nCols); c++) {
      const cnt = dataSlice.filter(r => isTextLabel(r[c])).length;
      if (cnt > best) { best = cnt; labelColIdx = c; }
    }
    const periodCols = [];
    for (let c = 0; c < nCols; c++) {
      if (c === labelColIdx) continue;
      const label = toPeriodLabel(values[headerRowIdx][c]);
      if (label) periodCols.push({ colIdx: c, raw: label, normed: norm(label) });
    }
    if (periodCols.length === 0) return null;

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
    return { table, periods: periodCols.map(p => p.raw) };

  } else {
    const headerColIdx = colPeriodCount.indexOf(maxCol);
    let labelRowIdx = 0, best = 0;
    for (let r = 0; r < Math.min(4, nRows); r++) {
      const cnt = values[r].filter((v, c) => c !== headerColIdx && isTextLabel(v)).length;
      if (cnt > best) { best = cnt; labelRowIdx = r; }
    }
    const periodRows = [];
    for (let r = 0; r < nRows; r++) {
      if (r === labelRowIdx) continue;
      const label = toPeriodLabel(values[r][headerColIdx]);
      if (label) periodRows.push({ rowIdx: r, raw: label, normed: norm(label) });
    }
    if (periodRows.length === 0) return null;

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
    return { table, periods: periodRows.map(p => p.raw) };
  }
}

// ── Lookup helpers ────────────────────────────────────────────────────────────
function findInTable(table, query) {
  const q = norm(query);
  // Exact match
  if (table[q]) return table[q];
  // Substring match
  const key = Object.keys(table).find(k => k.includes(q) || q.includes(k));
  return key ? table[key] : null;
}
function findPeriodValue(entry, periodQuery) {
  if (!entry) return null;
  const q = norm(String(periodQuery));
  if (entry[q] !== undefined) return entry[q];
  if (entry[periodQuery] !== undefined) return entry[periodQuery];
  for (const [k, v] of Object.entries(entry)) {
    if (k.startsWith("_")) continue;
    if (norm(k).includes(q) || q.includes(norm(k))) return v;
  }
  if (/^(19|20)\d{2}$/.test(String(periodQuery))) {
    const short = String(periodQuery).slice(2);
    for (const [k, v] of Object.entries(entry)) {
      if (k.startsWith("_")) continue;
      if (norm(k).includes(short)) return v;
    }
  }
  return null;
}
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

// ── Direct lookup ─────────────────────────────────────────────────────────────
function tryLookup(table, question) {
  const period = extractPeriod(question);
  const q      = norm(question);

  if (period) {
    // Strip digits to get the metric name, try both forms
    const metricQ = q.replace(/\d/g, "").trim();
    const entry   = findInTable(table, metricQ) || findInTable(table, q);
    if (entry) {
      const val = findPeriodValue(entry, period);
      if (val !== null) {
        const matchedPeriod = entry._periods.find(pr =>
          norm(pr).includes(norm(period)) || norm(period).includes(norm(pr))
        ) || period;
        return { type: "found", label: entry._raw, period: matchedPeriod, value: val };
      }
    }
  }

  // No period — return trend for a metric
  const entry = findInTable(table, q.replace(/\d/g,"").trim()) || findInTable(table, q);
  if (entry && entry._allValues.length > 0) {
    return { type: "trend", label: entry._raw, periods: entry._periods, values: entry._allValues };
  }

  return null;
}

// ── Token estimator ───────────────────────────────────────────────────────────
function estimateTokens(question, found) {
  const q = question.toLowerCase().trim();
  if (q.startsWith("explain"))                          return 1500;
  if (mode === "formula")                               return 120;
  if (found?.type === "found")                          return 200;
  if (q.includes("compare") || q.includes("vs") ||
      q.includes("trend")   || q.includes("growth"))   return 800;
  return 600;
}

// ── Build data string for AI ──────────────────────────────────────────────────
function buildDataStr(table, periods, sheetName) {
  let s = `Sheet: ${sheetName} | Periods: ${periods.join(", ")}\n\n`;
  for (const entry of Object.values(table)) {
    if (entry._allValues.length === 0) continue;
    const vals = entry._periods.map(p => `${p}=${fmt(entry[p] || entry[norm(p)])}`).join("  ");
    s += `${entry._raw}: ${vals}\n`;
  }
  return s;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
  try { ws = new WebSocket(HUB_URL); } catch { setTimeout(connect, RECONNECT_MS); return; }
  ws.onopen  = () => { ws.send(JSON.stringify({ type:"hello", editor:"excel" })); setConnected(true); };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case "token": if (msg.content) appendToken(msg.content); break;
      case "done":  finishAiMessage(); break;
      case "error": finishAiMessage(); addMessage("⚠️ " + (msg.message || "Error"), "error"); break;
    }
  };
  ws.onclose = () => { setConnected(false); if (isStreaming) finishAiMessage(); setTimeout(connect, RECONNECT_MS); };
  ws.onerror = () => ws.close();
}

// ── Ask mode ──────────────────────────────────────────────────────────────────
async function askQuestion() {
  const question = $question().value.trim();
  if (!question || !isConnected || isStreaming) return;

  try {
    await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      const sheet = context.workbook.worksheets.getActiveWorksheet();
      range.load(["values", "address"]);
      sheet.load("name");
      await context.sync();

      const values = range.values;
      if (!values || values.length < 2) {
        addMessage("⚠️ Select at least 2 rows including the header row.", "error");
        return;
      }

      const lookup = buildLookupTable(values);
      if (!lookup) {
        addMessage("⚠️ Could not find period headers (years/quarters) in selection.", "error");
        return;
      }

      const { table, periods } = lookup;
      const count  = Object.keys(table).length;
      const found  = tryLookup(table, question);
      const tokens = estimateTokens(question, found);

      // Compact status line
      addMessage(`📋 ${count} rows · ${periods[0]} → ${periods[periods.length-1]}`, "status-msg");

      addMessage(question, "user");
      $question().value = "";
      $question().style.height = "";
      updateAskBtn();
      isStreaming = true;
      updateAskBtn();
      startAiMessage();

      const dataStr = buildDataStr(table, periods, sheet.name);

      // Build computed string only if we found a direct value
      let computedStr = "";
      if (found?.type === "found") {
        computedStr = `\nLOOKED UP: ${found.label} (${found.period}) = ${fmt(found.value)}\n`;
      } else if (found?.type === "trend") {
        const bd = found.periods.map((p,i) => `${p}: ${fmt(found.values[i])}`).join(", ");
        computedStr = `\nLOOKED UP: ${found.label} — ${bd}\n`;
      }

      ws.send(JSON.stringify({
        type:            "excel_query",
        question,
        dataStr,
        computedStr,
        hasComputed:     found !== null,
        suggestedTokens: tokens,
      }));
    });
  } catch (err) {
    isStreaming = false;
    updateAskBtn();
    addMessage("⚠️ " + err.message, "error");
  }
}

// ── Gather schema from all sheets (for cross-sheet formula context) ───────────
async function gatherSheetsSchema(context) {
  const sheets = context.workbook.worksheets;
  const wb     = context.workbook;
  sheets.load("items/name");
  wb.load("name");
  await context.sync();

  const activeSheet = context.workbook.worksheets.getActiveWorksheet();
  activeSheet.load("name");
  await context.sync();
  const activeSheetName = activeSheet.name;

  const schema = [];
  // Cap at 8 sheets to avoid timeout
  for (const sheet of sheets.items.slice(0, 8)) {
    try {
      const usedRange = sheet.getUsedRangeOrNullObject();
      usedRange.load(["rowCount", "columnCount"]);
      await context.sync();
      if (usedRange.isNullObject) continue;

      const rowCount = usedRange.rowCount;
      const colCount = Math.min(usedRange.columnCount, 16);

      // Header rows (first 2 rows) — enough to detect multi-row headers
      const headerRange = sheet.getRangeByIndexes(0, 0, Math.min(2, rowCount), colCount);
      headerRange.load("values");
      // First column sample keys (rows 2–21) for lookup key identification
      const keyRange = sheet.getRangeByIndexes(1, 0, Math.min(20, Math.max(rowCount - 1, 1)), 1);
      keyRange.load("values");
      await context.sync();

      // Use whichever row has more non-empty text values as the header row
      const r0NonEmpty = headerRange.values[0].filter(v => String(v ?? "").trim() !== "").length;
      const r1NonEmpty = headerRange.values[1]
        ? headerRange.values[1].filter(v => String(v ?? "").trim() !== "").length : 0;
      const hdrRow = r1NonEmpty > r0NonEmpty ? headerRange.values[1] : headerRange.values[0];

      const headers = hdrRow
        .map((h, i) => ({ col: colLetter(i), header: String(h ?? "").trim() }))
        .filter(h => h.header !== "");

      const sampleKeys = keyRange.values
        .map(r => String(r[0] ?? "").trim())
        .filter(v => v !== "")
        .slice(0, 8);

      schema.push({
        name:     sheet.name,
        isActive: sheet.name === activeSheetName,
        rowCount,
        headers,
        sampleKeys,
      });
    } catch { /* skip unreadable sheet */ }
  }

  return { schema, workbookName: wb.name || "Workbook.xlsx" };
}

// ── Formula mode ──────────────────────────────────────────────────────────────
async function askFormula() {
  const request = $question().value.trim();
  if (!request || !isConnected || isStreaming) return;

  try {
    await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      const sheet = context.workbook.worksheets.getActiveWorksheet();
      range.load(["address","rowIndex","columnIndex","rowCount","columnCount"]);
      sheet.load("name");
      await context.sync();

      const selRowIdx = range.rowIndex, selColIdx = range.columnIndex;
      const selRows   = range.rowCount;

      const targetRowIdx   = selRowIdx;
      const targetColIdx   = selColIdx;
      const targetRowCount = selRows;

      // ── Gather ALL sheets schema (cross-sheet / cross-workbook awareness) ──
      const { schema: sheetsSchema, workbookName } = await gatherSheetsSchema(context);

      // ── Build local context: up to 10 cols left of target + header row above ──
      const ctxStartCol = Math.max(0, selColIdx - 10);
      const ctxCols     = selColIdx - ctxStartCol;
      let contextStr = `Target range: ${range.address} on sheet "${sheet.name}"\n`;

      if (ctxCols > 0) {
        const ctxRange = sheet.getRangeByIndexes(selRowIdx, ctxStartCol, selRows, ctxCols);
        ctxRange.load(["values"]);
        await context.sync();
        ctxRange.values.forEach((row, ri) => {
          const absRow = selRowIdx + ri + 1;
          contextStr  += row.map((v, ci) =>
            `${colLetter(ctxStartCol + ci)}${absRow}=${v === "" || v === null ? "(empty)" : v}`
          ).join(" | ") + "\n";
        });
      }

      // Also read the first row of the target column (header) if not row 1
      if (selRowIdx > 0) {
        const hdrRange = sheet.getRangeByIndexes(0, selColIdx, 1, 1);
        hdrRange.load("values");
        await context.sync();
        const hdr = hdrRange.values[0][0];
        if (hdr !== "" && hdr !== null) {
          contextStr += `Column header for target: "${hdr}"\n`;
        }
      }

      const targetCell  = `${colLetter(targetColIdx)}${targetRowIdx + 1}`;
      const targetRange = targetRowCount > 1
        ? `${targetCell}:${colLetter(targetColIdx)}${targetRowIdx + targetRowCount}`
        : targetCell;
      pendingRange = targetRange;

      const otherSheets = sheetsSchema.filter(s => !s.isActive);
      const sheetHint   = otherSheets.length
        ? ` · ${sheetsSchema.length} sheets visible`
        : "";
      addMessage(`📍 Target: ${targetRange}${sheetHint}`, "status-msg");
      addMessage(request, "user");
      $question().value      = "";
      $question().style.height = "";
      updateAskBtn();
      isStreaming = true;
      updateAskBtn();
      startAiMessage();

      ws.send(JSON.stringify({
        type:         "excel_formula",
        request,
        cellAddress:  targetCell,
        targetRange,
        rowCount:     targetRowCount,
        sheetName:    sheet.name,
        workbookName,
        context:      contextStr,
        sheetsSchema,
      }));
    });
  } catch (err) {
    isStreaming = false;
    updateAskBtn();
    addMessage("⚠️ " + err.message, "error");
  }
}

async function insertFormula() {
  if (!pendingFormula) return;
  const formulas = Array.isArray(pendingFormula) ? pendingFormula : [pendingFormula];
  const t = formulaTarget;
  pendingFormula = null;
  document.querySelectorAll(".insert-btn").forEach(b => { b.disabled = true; b.textContent = "Inserting…"; });
  try {
    await Excel.run(async (context) => {
      const sheet   = context.workbook.worksheets.getActiveWorksheet();
      const rng     = sheet.getRange(t);
      rng.load(["rowCount"]);
      await context.sync();
      const rowCount = rng.rowCount;

      let finalFormulas;
      if (formulas.length >= rowCount) {
        // AI gave one formula per row — use as-is
        finalFormulas = formulas.slice(0, rowCount).map(f => [f]);
      } else {
        // Only one formula — increment row numbers for each subsequent row
        const baseRow = parseInt(t.match(/\d+/)[0]); // e.g. 3 from "L3:L7"
        finalFormulas = Array.from({ length: rowCount }, (_, i) => {
          const f = formulas[0].replace(/([A-Z\$]+)(\d+)/g, (match, col, row) => {
            const r = parseInt(row);
            return r === baseRow ? col + (baseRow + i) : match;
          });
          return [f];
        });
      }
      rng.formulas = finalFormulas;
      await context.sync();
      addMessage(`✅ Inserted ${rowCount} formula${rowCount > 1 ? "s" : ""} → ${t}`, "status-msg");
    });
  } catch (err) { addMessage("⚠️ Insert failed: " + err.message, "error"); }
  document.querySelectorAll(".insert-btn").forEach(b => { b.disabled = false; });
}

// ── Macro mode ────────────────────────────────────────────────────────────────
async function askMacro() {
  const idea = $question().value.trim();
  if (!idea || !isConnected || isStreaming) return;

  // Store user turn in history
  macroHistory.push({ role: "user", content: idea });

  addMessage(idea, "user");
  $question().value      = "";
  $question().style.height = "";
  updateAskBtn();
  isStreaming = true;
  updateAskBtn();
  startAiMessage();

  ws.send(JSON.stringify({
    type:    "macro_query",
    idea,
    history: macroHistory.slice(0, -1), // send previous turns (exclude current)
    suggestedTokens: 1000,
  }));
}

// Copy generated VBA to clipboard and show install instructions
async function copyAndInstallMacro() {
  if (!pendingMacro) return;
  document.querySelectorAll(".insert-btn").forEach(b => { b.disabled = true; b.textContent = "Copied!"; });
  try {
    await navigator.clipboard.writeText(pendingMacro);
    showMacroInstructions();
  } catch {
    // Fallback: select text from a temp textarea
    const ta = document.createElement("textarea");
    ta.value = pendingMacro;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    showMacroInstructions();
  }
  setTimeout(() => {
    document.querySelectorAll(".insert-btn").forEach(b => { b.disabled = false; b.textContent = "📋 Copy & Install Macro"; });
  }, 2000);
}

function showMacroInstructions() {
  const overlay = document.createElement("div");
  overlay.className = "macro-overlay";
  overlay.innerHTML = `
    <div class="macro-overlay-box">
      <div class="macro-overlay-title">✅ Macro copied! Now install it:</div>
      <ol class="macro-steps">
        <li><div class="macro-step-num">1</div><span>Press <span class="macro-key">Alt</span> + <span class="macro-key">F11</span> to open VBA Editor</span></li>
        <li><div class="macro-step-num">2</div><span>Click <span class="macro-key">Insert</span> → <span class="macro-key">Module</span></span></li>
        <li><div class="macro-step-num">3</div><span>Press <span class="macro-key">Ctrl</span> + <span class="macro-key">V</span> to paste</span></li>
        <li><div class="macro-step-num">4</div><span>Press <span class="macro-key">F5</span> to run the macro</span></li>
        <li><div class="macro-step-num">5</div><span>Close the VBA Editor</span></li>
      </ol>
      <div class="macro-warn">💡 Save your file as <b>.xlsm</b> to keep macros permanently</div>
      <button class="macro-ok-btn" id="macroOkBtn">Got it</button>
    </div>`;
  overlay.querySelector("#macroOkBtn").onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

async function ask() {
  if (mode === "formula") askFormula();
  else if (mode === "macro") askMacro();
  else if (mode === "build") askBuild();
  else askQuestion();
}

// ── Build mode ────────────────────────────────────────────────────────────────

async function askBuild() {
  const request = $question().value.trim();
  if (!request || !isConnected || isStreaming) return;

  try {
    await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      const sheet = context.workbook.worksheets.getActiveWorksheet();
      range.load(["address", "rowIndex", "columnIndex", "rowCount", "columnCount"]);
      sheet.load("name");
      await context.sync();

      const selAddress = range.address.split("!").pop();

      // Gather all sheets schema for context
      const { schema: sheetsSchema, workbookName } = await gatherSheetsSchema(context);

      // Build context string
      let contextStr  = `Active sheet: "${sheet.name}" | Workbook: "${workbookName}"\n`;
      contextStr     += `Selected range: ${selAddress} (${range.rowCount} rows × ${range.columnCount} cols)\n\n`;
      for (const s of sheetsSchema) {
        const mark = s.isActive ? " ← ACTIVE" : "";
        contextStr += `Sheet "${s.name}"${mark}: ${s.rowCount} rows`;
        if (s.headers.length) {
          contextStr += `  Columns: ${s.headers.map(h => `${h.col}:"${h.header}"`).join(", ")}`;
        }
        contextStr += "\n";
      }

      addMessage(`🏗️ ${selAddress} · ${range.rowCount}R × ${range.columnCount}C`, "status-msg");
      addMessage(request, "user");
      $question().value      = "";
      $question().style.height = "";
      updateAskBtn();
      isStreaming = true;
      updateAskBtn();
      startAiMessage();

      ws.send(JSON.stringify({
        type:            "excel_build",
        request,
        selAddress,
        sheetName:       sheet.name,
        workbookName,
        context:         contextStr,
        sheetsSchema,
        rowCount:        range.rowCount,
        columnCount:     range.columnCount,
        suggestedTokens: 400,
      }));
    });
  } catch (err) {
    isStreaming = false;
    updateAskBtn();
    addMessage("⚠️ " + err.message, "error");
  }
}

// Execute the action array returned by the AI
async function executeBuildActions(actions, displayEl) {
  const log = [];

  try {
    await Excel.run(async (context) => {
      const sheet = context.workbook.worksheets.getActiveWorksheet();
      const sel   = context.workbook.getSelectedRange();
      sel.load(["address", "rowIndex", "columnIndex", "rowCount", "columnCount"]);
      await context.sync();
      const selAddr = sel.address.split("!").pop();

      for (const action of actions) {
        try {
          const msg = await runBuildAction(context, sheet, action, sel, selAddr);
          await context.sync();
          log.push({ ok: true, op: action.op, msg });
        } catch (e) {
          log.push({ ok: false, op: action.op, msg: `${action.op}: ${e.message}` });
        }
      }
    });
  } catch (e) {
    log.push({ ok: false, op: "excel", msg: "Excel error: " + e.message });
  }

  // Render results inside the AI message bubble
  const chips = actions.map(a => `<span class="build-chip">${opLabel(a.op)}</span>`).join("");
  const items = log.map(r =>
    `<li class="${r.ok ? "ok" : "err"}">
       <span class="act-icon">${r.ok ? "✅" : "⚠️"}</span>
       <span>${r.msg}</span>
     </li>`
  ).join("");

  displayEl.innerHTML =
    `<div style="margin-bottom:6px;line-height:1.8">${chips}</div>` +
    `<ul class="action-log">${items}</ul>`;

  $chat().scrollTop = $chat().scrollHeight;
}

function opLabel(op) {
  const labels = {
    create_table: "Table", apply_filter: "Filter", clear_filters: "Clear Filters",
    sort: "Sort", format_header: "Header Style", format_range: "Format",
    conditional_format: "Cond. Format", freeze_panes: "Freeze", unfreeze_panes: "Unfreeze",
    auto_fit_columns: "Auto-fit Cols", auto_fit_rows: "Auto-fit Rows",
    number_format: "Number Fmt", add_total_row: "Totals Row",
    insert_chart: "Chart", set_column_width: "Col Width", set_row_height: "Row Height",
    set_border: "Borders", clear_formatting: "Clear Fmt", clear_conditional_formats: "Clear CF",
    merge_cells: "Merge", unmerge_cells: "Unmerge",
    add_sheet: "Add Sheet", rename_sheet: "Rename Sheet",
  };
  return labels[op] || op;
}

// ── Individual action runners ─────────────────────────────────────────────────

async function runBuildAction(context, sheet, action, sel, selAddr) {
  // Helper: resolve range — "auto" or undefined → use current selection
  const getRange = (a) =>
    (a && a !== "auto") ? sheet.getRange(a) : sheet.getRange(selAddr);

  switch (action.op) {

    // ── Tables ────────────────────────────────────────────────────────────────
    case "create_table": {
      const rng = getRange(action.range);
      const tbl = sheet.tables.add(rng, action.hasHeaders !== false);
      tbl.style = action.style || "TableStyleMedium9";
      if (action.name) tbl.name = action.name;
      return `Created table (${action.style || "TableStyleMedium9"})`;
    }

    case "add_total_row": {
      const tables = sheet.tables;
      tables.load("items/name");
      await context.sync();
      if (!tables.items.length) throw new Error("No table found on sheet");
      tables.items[0].showTotals = action.enabled !== false;
      return `${action.enabled !== false ? "Added" : "Removed"} totals row`;
    }

    // ── Filters ───────────────────────────────────────────────────────────────
    case "apply_filter": {
      const rng    = getRange(action.range);
      const colIdx = action.columnIndex !== undefined ? action.columnIndex
        : (action.column && typeof action.column === "string")
          ? action.column.toUpperCase().charCodeAt(0) - 65 : 0;
      if (action.value !== undefined) {
        sheet.autoFilter.apply(rng, colIdx, {
          criterion1: String(action.value),
          filterOn:   Excel.FilterOn.values,
        });
      } else {
        sheet.autoFilter.apply(rng, colIdx);
      }
      return `Applied filter on column ${action.column || colIdx}${action.value ? ` = "${action.value}"` : ""}`;
    }

    case "clear_filters": {
      const tables = sheet.tables;
      tables.load("items/name");
      await context.sync();
      if (tables.items.length) {
        tables.items[0].clearFilters();
      } else {
        sheet.autoFilter.remove();
      }
      return "Cleared all filters";
    }

    // ── Sort ──────────────────────────────────────────────────────────────────
    case "sort": {
      const rng    = getRange(action.range);
      // Column may be absolute ("C") or relative index (0-based within range)
      let relIdx = 0;
      if (action.columnIndex !== undefined) {
        relIdx = Math.max(0, action.columnIndex - sel.columnIndex);
      } else if (action.column && typeof action.column === "string") {
        const absIdx = action.column.toUpperCase().charCodeAt(0) - 65;
        relIdx       = Math.max(0, absIdx - sel.columnIndex);
      }
      rng.sort.apply([{ key: relIdx, ascending: action.ascending !== false }]);
      return `Sorted by column ${action.column || relIdx} ${action.ascending !== false ? "↑ A→Z" : "↓ Z→A"}`;
    }

    // ── Formatting ────────────────────────────────────────────────────────────
    case "format_header": {
      sel.load(["rowIndex", "columnIndex", "columnCount"]);
      await context.sync();
      const hdr = sheet.getRangeByIndexes(sel.rowIndex, sel.columnIndex, 1, sel.columnCount);
      if (action.bold      !== undefined) hdr.format.font.bold   = action.bold;
      if (action.bgColor)                 hdr.format.fill.color  = action.bgColor;
      if (action.textColor)               hdr.format.font.color  = action.textColor;
      if (action.fontSize)                hdr.format.font.size   = action.fontSize;
      if (action.italic    !== undefined) hdr.format.font.italic = action.italic;
      return `Styled header row${action.bgColor ? ` (${action.bgColor})` : ""}`;
    }

    case "format_range": {
      const rng = getRange(action.range);
      if (action.bold      !== undefined) rng.format.font.bold         = action.bold;
      if (action.bgColor)                 rng.format.fill.color        = action.bgColor;
      if (action.textColor)               rng.format.font.color        = action.textColor;
      if (action.fontSize)                rng.format.font.size         = action.fontSize;
      if (action.wrapText  !== undefined) rng.format.wrapText          = action.wrapText;
      if (action.hAlign)                  rng.format.horizontalAlignment = action.hAlign;
      if (action.vAlign)                  rng.format.verticalAlignment   = action.vAlign;
      if (action.numberFormat) {
        rng.load(["rowCount", "columnCount"]);
        await context.sync();
        rng.numberFormat = Array.from({ length: rng.rowCount }, () =>
          Array(rng.columnCount).fill(action.numberFormat)
        );
      }
      return `Formatted range${action.bgColor ? ` (fill ${action.bgColor})` : ""}`;
    }

    case "number_format": {
      const rng = getRange(action.range);
      rng.load(["rowCount", "columnCount"]);
      await context.sync();
      const fmt2d = Array.from({ length: rng.rowCount }, () =>
        Array(rng.columnCount).fill(action.format || "#,##0.00")
      );
      rng.numberFormat = fmt2d;
      return `Applied number format: ${action.format}`;
    }

    case "auto_fit_columns": {
      getRange(action.range).format.autofitColumns();
      return "Auto-fitted column widths";
    }

    case "auto_fit_rows": {
      getRange(action.range).format.autofitRows();
      return "Auto-fitted row heights";
    }

    case "set_column_width": {
      getRange(action.range).format.columnWidth = action.width || 100;
      return `Set column width to ${action.width}px`;
    }

    case "set_row_height": {
      getRange(action.range).format.rowHeight = action.height || 20;
      return `Set row height to ${action.height}px`;
    }

    case "set_border": {
      const rng         = getRange(action.range);
      const styleMap    = { thin: "Thin", medium: "Medium", thick: "Thick", dashed: "Dash", dotted: "Dot", none: "None" };
      const borderStyle = styleMap[action.style] || "Thin";
      const color       = action.color || "#000000";
      const sides = [
        Excel.BorderIndex.edgeTop, Excel.BorderIndex.edgeBottom,
        Excel.BorderIndex.edgeLeft, Excel.BorderIndex.edgeRight,
        Excel.BorderIndex.insideHorizontal, Excel.BorderIndex.insideVertical,
      ];
      for (const side of sides) {
        try {
          const b = rng.format.borders.getItem(side);
          b.style = Excel.BorderLineStyle[borderStyle] || Excel.BorderLineStyle.thin;
          b.color = color;
        } catch { /* skip unsupported sides for single-cell ranges */ }
      }
      return `Applied ${action.style || "thin"} borders`;
    }

    case "clear_formatting": {
      getRange(action.range).clear(Excel.ClearApplyTo.formats);
      return "Cleared all formatting";
    }

    // ── Conditional formatting ────────────────────────────────────────────────
    case "conditional_format": {
      const rng   = getRange(action.range);
      const opMap = {
        greater_than:       Excel.ConditionalCellValueOperator.greaterThan,
        less_than:          Excel.ConditionalCellValueOperator.lessThan,
        equal:              Excel.ConditionalCellValueOperator.equalTo,
        not_equal:          Excel.ConditionalCellValueOperator.notEqualTo,
        between:            Excel.ConditionalCellValueOperator.between,
        greater_or_equal:   Excel.ConditionalCellValueOperator.greaterThanOrEqualTo,
        less_or_equal:      Excel.ConditionalCellValueOperator.lessThanOrEqualTo,
      };
      const cf  = rng.conditionalFormats.add(Excel.ConditionalFormatType.cellValue);
      cf.cellValue.format.fill.color = action.bgColor || "#FFFF00";
      if (action.textColor) cf.cellValue.format.font.color = action.textColor;
      if (action.bold !== undefined) cf.cellValue.format.font.bold = action.bold;
      cf.cellValue.rule = {
        formula1: String(action.value),
        formula2: action.value2 !== undefined ? String(action.value2) : undefined,
        operator: opMap[action.rule] || Excel.ConditionalCellValueOperator.greaterThan,
      };
      return `Conditional format: ${action.rule} ${action.value}${action.value2 !== undefined ? " – " + action.value2 : ""} → ${action.bgColor || "#FFFF00"}`;
    }

    case "clear_conditional_formats": {
      getRange(action.range).conditionalFormats.clearAll();
      return "Cleared all conditional formats";
    }

    // ── Freeze panes ──────────────────────────────────────────────────────────
    case "freeze_panes": {
      if (action.rows && action.cols) {
        sheet.freezePanes.freezeAt(sheet.getRangeByIndexes(action.rows, action.cols, 1, 1));
        return `Froze ${action.rows} row(s) and ${action.cols} column(s)`;
      } else if (action.cols) {
        sheet.freezePanes.freezeColumns(action.cols);
        return `Froze ${action.cols} column(s)`;
      } else {
        sheet.freezePanes.freezeRows(action.rows || 1);
        return `Froze ${action.rows || 1} row(s)`;
      }
    }

    case "unfreeze_panes": {
      sheet.freezePanes.unfreeze();
      return "Unfroze all panes";
    }

    // ── Charts ────────────────────────────────────────────────────────────────
    case "insert_chart": {
      const dataRange = getRange(action.range);
      const typeMap   = {
        column:   Excel.ChartType.columnClustered,
        bar:      Excel.ChartType.barClustered,
        line:     Excel.ChartType.line,
        pie:      Excel.ChartType.pie,
        area:     Excel.ChartType.area,
        scatter:  Excel.ChartType.xyscatter,
        doughnut: Excel.ChartType.doughnut,
      };
      const chartType = typeMap[(action.type || "column").toLowerCase()] || Excel.ChartType.columnClustered;
      const chart     = sheet.charts.add(chartType, dataRange, Excel.ChartSeriesBy.auto);
      if (action.title) chart.title.text = action.title;
      chart.width  = action.width  || 480;
      chart.height = action.height || 300;
      return `Inserted ${action.type || "column"} chart${action.title ? `: "${action.title}"` : ""}`;
    }

    // ── Cells ─────────────────────────────────────────────────────────────────
    case "merge_cells": {
      getRange(action.range).merge(action.across || false);
      return "Merged cells";
    }

    case "unmerge_cells": {
      getRange(action.range).unmerge();
      return "Unmerged cells";
    }

    // ── Sheets ────────────────────────────────────────────────────────────────
    case "add_sheet": {
      const newSheet = context.workbook.worksheets.add(action.name);
      if (action.activate) newSheet.activate();
      return `Added sheet "${action.name || "Sheet"}"`;
    }

    case "rename_sheet": {
      if (!action.name) throw new Error("name is required");
      sheet.name = action.name;
      return `Renamed sheet to "${action.name}"`;
    }

    default:
      throw new Error(`Unknown op: "${action.op}"`);
  }
}

function handleKey(e) { if (e.key==="Enter"&&!e.shiftKey){e.preventDefault();ask();} }
function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 90) + "px";
  updateAskBtn();
}
Office.onReady(() => { connect(); $question().addEventListener("input", updateAskBtn); setMode("ask"); });
