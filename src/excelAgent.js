// ── Excel Tool-Calling Agent ──────────────────────────────────────────────────
//
// Instead of dumping all rows into the prompt (which causes token overflow),
// this agent works in two passes:
//
//   Pass 1 — Send only the schema (headers + row labels, ~60 tokens)
//             AI responds with TOOL_CALL specifying exactly what it needs
//
//   Pass 2 — App fetches only those rows/columns from the loaded Excel data
//             AI receives just that data (~100-300 tokens) and streams its answer
//
// No context overflow is possible — the AI never sees more than it asks for.
// Works on files with thousands of rows.
// ─────────────────────────────────────────────────────────────────────────────

import { invoke } from "@tauri-apps/api/core";

const LLAMA_URL = "http://127.0.0.1:8088";
const MAX_LOOKUP_ROWS = 100; // safety cap: even if AI asks for ALL, max 100 rows

// ── Re-read connectors from disk to get full row data ─────────────────────────
// The connector stored in state only keeps sheet NAME strings, not row data.
// We re-read from disk here so the agent always has fresh, complete data.

async function loadSheetData(connectors) {
  const enriched = [];
  for (const c of connectors) {
    if (c.type !== "excel" || !c.path) continue;
    try {
      const data = await invoke("read_excel_sheets", { path: c.path });
      // Filter to activeSheets if set
      const sheets = (c.activeSheets?.length
        ? (data.sheets || []).filter(s => c.activeSheets.includes(s.name))
        : (data.sheets || [])
      );
      enriched.push({ ...c, sheets });
    } catch {
      // If re-read fails, skip this connector
    }
  }
  return enriched;
}

// ── 1. Schema builder ─────────────────────────────────────────────────────────
// Extracts structure only — no data values. Keeps token count tiny (~60-100).

export function buildExcelSchema(connectors) {
  const parts = [];

  for (const c of connectors) {
    if (c.type !== "excel" || !c.sheets?.length) continue;

    const sheets = (c.activeSheets?.length
      ? c.sheets.filter(s => c.activeSheets.includes(s.name))
      : c.sheets
    ).slice(0, 6);

    for (const sheet of sheets) {
      const rows = (sheet.rows || []).filter(r =>
        r.some(v => v !== null && v !== undefined && v !== "")
      );
      if (rows.length < 2) continue;

      const headers   = rows[0].map(h => String(h ?? "").trim()).filter(Boolean);
      const rowLabels = rows.slice(1)
        .map(r => String(r[0] ?? "").trim())
        .filter(Boolean);

      // Show all labels if small file; otherwise first 30 + count + last 10
      const labelStr = rowLabels.length <= 60
        ? rowLabels.join(", ")
        : [
            ...rowLabels.slice(0, 30),
            `…(${rowLabels.length - 40} more)…`,
            ...rowLabels.slice(-10),
          ].join(", ");

      parts.push(
        `File: ${c.name} | Sheet: "${sheet.name}"\n` +
        `Columns: ${headers.join(", ")}\n` +
        `Rows (${rowLabels.length} total): ${labelStr}`
      );
    }
  }

  return parts.join("\n\n");
}

// ── Safety cap on lookup result ───────────────────────────────────────────────
// secondPass compact prompt = ~200 tokens. Context limit = 8192.
// Safe budget for data = ~6000 tokens ≈ 24000 chars. Cap at 20000 to be safe.
const MAX_RESULT_CHARS = 20000;
function capResult(text) {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const lines = text.split("\n");
  let out = "";
  for (const line of lines) {
    if ((out + line).length > MAX_RESULT_CHARS) break;
    out += line + "\n";
  }
  return out.trimEnd() + "\n[…data truncated to fit context limit]";
}

// ── 2. Lookup executor ────────────────────────────────────────────────────────
// Fetches specific rows/columns from in-memory connector data.
// Called after the AI specifies exactly what it needs.

export function excelLookup(connectors, sheetName, requestedRows, requestedCols) {
  let headers = null;
  let dataRows = null;

  // Find the matching sheet across all connectors
  outer: for (const c of connectors) {
    if (c.type !== "excel" || !c.sheets?.length) continue;
    for (const sheet of c.sheets) {
      const nameMatch = !sheetName || sheetName === "auto" ||
        sheet.name.toLowerCase() === sheetName.toLowerCase() ||
        c.sheets.length === 1;
      if (!nameMatch) continue;

      const rows = (sheet.rows || []).filter(r =>
        r.some(v => v !== null && v !== undefined && v !== "")
      );
      if (rows.length < 2) continue;

      headers  = rows[0].map(h => String(h ?? "").trim());
      dataRows = rows.slice(1);
      break outer;
    }
  }

  if (!dataRows) return "No matching sheet found.";

  // Normalize: strip spaces/hyphens/underscores for fuzzy matching
  const normCol = s => s.toLowerCase().replace(/[\s\-_]/g, "");

  // Resolve column indices
  const colIndices = (requestedCols === "ALL" || !Array.isArray(requestedCols))
    ? headers.map((_, i) => i)
    : requestedCols.map(col => {
        const n = normCol(col);
        let idx = headers.findIndex(h => normCol(h) === n);
        if (idx === -1) idx = headers.findIndex(h => normCol(h).includes(n) || n.includes(normCol(h)));
        return idx;
      }).filter(i => i >= 0);

  if (colIndices.length === 0) {
    return `Columns not found. Available columns: ${headers.join(", ")}`;
  }

  // Resolve rows
  let matched;
  const wantsAll = requestedRows === "ALL" ||
    (Array.isArray(requestedRows) && requestedRows[0] === "ALL");

  if (wantsAll) {
    matched = dataRows.slice(0, MAX_LOOKUP_ROWS);
  } else {
    matched = [];
    for (const label of requestedRows) {
      const lbl = label.toLowerCase();
      const found = dataRows.filter(r => {
        const cell = String(r[0] ?? "").trim().toLowerCase();
        return cell === lbl || cell.includes(lbl) || lbl.includes(cell);
      });
      matched.push(...found);
    }
    // Deduplicate by first-column value
    matched = [...new Map(matched.map(r => [String(r[0]), r])).values()];

    // Fuzzy fallback — partial match anywhere in the row
    if (matched.length === 0) {
      matched = dataRows.filter(r =>
        requestedRows.some(lbl =>
          r.some(cell => String(cell ?? "").toLowerCase().includes(lbl.toLowerCase()))
        )
      ).slice(0, 20);
    }

    if (matched.length === 0) {
      const sample = dataRows.slice(0, 8).map(r => String(r[0] ?? "")).join(", ");
      return `No rows matched: ${requestedRows.join(", ")}.\nAvailable row labels start with: ${sample}`;
    }
  }

  // Format as compact "Label: Col1=val, Col2=val" lines — easy for AI to read
  return matched.map(row => {
    const label  = String(row[0] ?? "").trim();
    const values = colIndices.map(i => {
      const h = headers[i] || `Col${i}`;
      const v = String(row[i] ?? "").trim();
      return `${h}=${v || "—"}`;
    });
    return `${label}: ${values.join(", ")}`;
  }).join("\n");
}

// ── 3. Tool call parser ───────────────────────────────────────────────────────
// Reads TOOL_CALL: excel_lookup(...) from AI output and extracts arguments.

function parseToolCall(text) {
  // Try to close a truncated tool call before matching
  let normalized = text.trim();
  if (normalized.includes("excel_lookup") && !normalized.endsWith(")")) {
    normalized = normalized + ")";
  }
  const match = normalized.match(/TOOL_CALL:\s*excel_lookup\s*\(([^)]+)\)/i);
  if (!match) return null;

  const args = match[1];

  const sheetM = args.match(/sheet\s*=\s*["']([^"']+)["']/i);
  const sheet  = sheetM ? sheetM[1] : "auto";

  const rowsM = args.match(/rows\s*=\s*\[([^\]]*)\]/i);
  let rows = ["ALL"];
  if (rowsM) {
    const raw = rowsM[1].trim();
    if (!raw || raw.includes('"ALL"') || raw.includes("'ALL'")) {
      rows = ["ALL"];
    } else {
      rows = [...raw.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
      if (!rows.length) rows = ["ALL"];
    }
  }

  const colsM = args.match(/columns?\s*=\s*\[([^\]]*)\]/i);
  let cols = "ALL";
  if (colsM) {
    const raw = colsM[1].trim();
    if (!raw || raw.includes('"ALL"') || raw.includes("'ALL'")) {
      cols = "ALL";
    } else {
      cols = [...raw.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
      if (!cols.length) cols = "ALL";
    }
  }

  return { sheet, rows, cols };
}

// ── 4. Prompt builder ─────────────────────────────────────────────────────────
// Wraps text in the right chat format (ChatML for Qwen/Phi, Gemma for Gemma).

function wrapPrompt(system, user, modelId = "", primeAssistant = "") {
  const isGemma = modelId.toLowerCase().includes("gemma");
  if (isGemma) {
    return `<start_of_turn>user\n${system}\n\n${user}<end_of_turn>\n<start_of_turn>model\n${primeAssistant}`;
  }
  // ChatML (Qwen2.5, Phi-3.5, Llama-3, etc.)
  return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n${primeAssistant}`;
}

// ── 5. Sanitize tool call against real schema ─────────────────────────────────
// Fixes placeholder values ("SheetName", hallucinated columns) the model
// sometimes outputs when it ignores or misreads the schema.

function sanitizeToolCall(toolCall, excelConns) {
  if (!toolCall) return null;

  // Collect real sheet names and their columns/row labels
  const sheetMeta = [];
  for (const c of excelConns) {
    for (const sheet of (c.sheets || [])) {
      const rows = (sheet.rows || []).filter(r => r.some(v => v != null && v !== ""));
      if (rows.length < 2) continue;
      const headers   = rows[0].map(h => String(h ?? "").trim()).filter(Boolean);
      const rowLabels = rows.slice(1).map(r => String(r[0] ?? "").trim()).filter(Boolean);
      sheetMeta.push({ name: sheet.name, headers, rowLabels });
    }
  }
  if (!sheetMeta.length) return toolCall;

  // Fix sheet name: if placeholder or unknown, use first real sheet
  let { sheet, rows, cols } = toolCall;
  const knownSheet = sheetMeta.find(s => s.name.toLowerCase() === sheet.toLowerCase());
  const target = knownSheet || sheetMeta[0];
  sheet = target.name;

  // Normalize helper: strip spaces, hyphens, underscores for fuzzy matching
  // so "Mar 23" matches "Mar-23", "Q1 2023" matches "Q1-2023", etc.
  const norm = s => s.toLowerCase().replace(/[\s\-_]/g, "");

  // Fix columns: remove any that don't exist in target sheet (fuzzy match)
  if (Array.isArray(cols) && cols[0] !== "ALL") {
    const validCols = cols.filter(c =>
      target.headers.some(h =>
        norm(h) === norm(c) ||
        norm(h).includes(norm(c)) ||
        norm(c).includes(norm(h))
      )
    );
    // If nothing matched (model hallucinated), fall back to ALL
    cols = validCols.length > 0 ? validCols : "ALL";
  }

  // Fix rows: remove any that don't exist (keep as-is — excelLookup has fuzzy fallback)
  // If model used date strings as rows but sheet has named rows, use ALL
  if (Array.isArray(rows) && rows[0] !== "ALL") {
    const looksLikeDateRows = rows.every(r => /^\d{4}-\d{2}/.test(r));
    if (looksLikeDateRows && target.rowLabels.length > 0) {
      const hasDateLabels = target.rowLabels.some(l => /^\d{4}-\d{2}/.test(l));
      if (!hasDateLabels) rows = ["ALL"]; // model confused rows with dates
    }
  }

  return { sheet, rows, cols };
}

// ── 6. First pass — non-streaming ────────────────────────────────────────────
// Sends schema + question. AI outputs a TOOL_CALL line specifying what it needs.
// Uses the actual sheet/column names in the example so the model can't use placeholders.

async function firstPass(schema, question, modelId, excelConns) {
  // Build a concrete example using the REAL first sheet and column names
  const firstSheet = excelConns[0]?.sheets?.[0];
  const firstRows  = firstSheet?.rows || [];
  const realHeaders  = firstRows[0]?.map(h => String(h ?? "").trim()).filter(Boolean) || [];
  const realRowLabels = firstRows.slice(1).map(r => String(r[0] ?? "").trim()).filter(Boolean);
  const exSheetName = firstSheet?.name || "Sheet1";
  const exCol       = realHeaders[1] || realHeaders[0] || "ColumnName";
  const exRow       = realRowLabels[0] || "RowLabel";

  const system =
    `You look up data from an Excel file to answer questions.\n\n` +
    `EXCEL DATA AVAILABLE:\n${schema}\n\n` +
    `To fetch data, output EXACTLY one line in this format:\n` +
    `TOOL_CALL: excel_lookup(sheet="${exSheetName}", rows=["${exRow}"], columns=["${exCol}"])\n\n` +
    `RULES:\n` +
    `- sheet= must be one of the sheet names listed above\n` +
    `- rows= must be labels from the "Rows" list above (or ["ALL"] for all rows)\n` +
    `- columns= must be names from the "Columns" list above (or ["ALL"] for all columns)\n` +
    `- Output ONLY the TOOL_CALL line — no explanation, no other text`;

  const user   = `QUESTION: ${question}`;
  const prompt = wrapPrompt(system, user, modelId, "TOOL_CALL:");

  const res = await fetch(`${LLAMA_URL}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      n_predict: 300,         // enough for any realistic tool call
      temperature: 0.05,
      stream: false,
      stop: ["\n", "<|im_end|>", "<end_of_turn>"], // tool call is ONE line — stop at first newline
      cache_prompt: false,
    }),
  });

  if (!res.ok) throw new Error(`llama-server ${res.status} ${res.statusText}`);
  const data = await res.json();
  const raw  = (data.content || "").trim();

  // Model was primed with "TOOL_CALL:" — it completes from there.
  // Re-prepend so parseToolCall finds the full pattern.
  return "TOOL_CALL: " + raw;
}

// ── 6. Second pass — streaming ────────────────────────────────────────────────
// Gives AI the fetched data. Streams the final answer token-by-token to the UI.

async function secondPass(schema, question, lookupResult, systemPrompt, modelId, maxTokens, temperature, onToken) {
  // Use a short focused system prompt here — the full buildSystemPrompt (~1200 tokens)
  // is too expensive when combined with Excel data. All we need is accurate data answering.
  const compactSystem =
    "You are a precise data analyst. Answer the user's question using ONLY the Excel data " +
    "provided below. Show calculations if needed. Never guess or hallucinate values. " +
    "If the answer is not in the data, say so.";

  const user =
    `EXCEL DATA:\n${lookupResult}\n\n` +
    `QUESTION: ${question}`;

  const prompt = wrapPrompt(compactSystem, user, modelId);

  const res = await fetch(`${LLAMA_URL}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      n_predict: maxTokens || 2048,
      temperature: temperature ?? 0.5,
      stream: true,
      repeat_penalty: 1.1,
      top_k: 40,
      top_p: 0.95,
      cache_prompt: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Server error ${res.status}: ${errText}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE: events are separated by double newline
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";

    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const json = JSON.parse(line.slice(6));
          if (json.content) onToken(json.content);
          if (json.stop)    return;
        } catch { /* partial JSON chunk — skip */ }
      }
    }
  }
}

// ── 7. Main entry point ───────────────────────────────────────────────────────
//
// Returns true  — agent handled the question (caller should not call generate)
// Returns false — no Excel connectors found (caller falls back to normal flow)
//
// onToken(text)  — streams answer characters to the UI as they arrive
// onStatus(msg)  — brief status text shown in the AI bubble ("Looking up data…")
//                  call with null to clear

export async function runExcelAgent({
  connectors,
  question,
  systemPrompt = "",
  modelId = "",
  maxTokens = 2048,
  temperature = 0.5,
  onToken,
  onStatus,
}) {
  const rawExcelConns = connectors.filter(c => c.type === "excel" && c.path);
  if (!rawExcelConns.length) return false;

  // Re-read from disk — connector.sheets in state is just name strings, not row data
  const excelConns = await loadSheetData(rawExcelConns);
  if (!excelConns.length) return false;

  const schema = buildExcelSchema(excelConns);
  if (!schema) return false;

  // ── Pass 1: ask the AI what data it needs ──────────────────────────────────
  onStatus?.("Analyzing question…");

  let firstResponse;
  try {
    firstResponse = await firstPass(schema, question, modelId, excelConns);
  } catch (err) {
    throw new Error(`Agent pass 1 failed: ${err.message}`);
  }

  const rawToolCall = parseToolCall(firstResponse);

  // Sanitize: fix placeholder sheet names, hallucinated columns, date-as-row confusion
  const toolCall = sanitizeToolCall(rawToolCall, excelConns);

  if (!toolCall) {
    // Tool call failed to parse — keyword fallback.
    // Extract row AND column keywords from the question to keep lookup small.
    onStatus?.("Looking up data in Excel…");
    const stopWords = new Set(["what","the","for","and","how","was","were","is","are","can","get","give","show","find","tell","me","of","in","a","an","its","this"]);
    const keywords = question.toLowerCase()
      .replace(/[^a-z0-9\s\-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    const fallbackRows = keywords.length > 0 ? keywords : ["ALL"];
    // For columns, also use keywords — avoids returning all 24+ monthly columns
    const fallbackCols = keywords.length > 0 ? keywords : "ALL";
    const fallback = excelLookup(excelConns, "auto", fallbackRows, fallbackCols);
    onStatus?.(null);
    await secondPass(schema, question, capResult(fallback), systemPrompt, modelId, maxTokens, temperature, onToken);
    return true;
  }

  // ── Lookup: fetch only the requested cells ─────────────────────────────────
  onStatus?.("Looking up data in Excel…");

  const lookupResult = excelLookup(excelConns, toolCall.sheet, toolCall.rows, toolCall.cols);

  // ── Pass 2: give AI the data, stream answer to UI ──────────────────────────
  onStatus?.(null);

  try {
    await secondPass(schema, question, capResult(lookupResult), systemPrompt, modelId, maxTokens, temperature, onToken);
  } catch (err) {
    throw new Error(`Agent pass 2 failed: ${err.message}`);
  }

  return true;
}
