import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile, readDir } from "@tauri-apps/plugin-fs";
import { ClerkProvider, SignIn, useAuth } from "@clerk/react";

// ─── Color tokens ─────────────────────────────────────────────────────────────
const C = {
  bgDeep:   "#06111e",
  bgPanel:  "#0c1a2e",
  bgCard:   "#112035",
  border:   "rgba(255,255,255,0.09)",
  borderHi: "rgba(59,130,246,0.38)",
  t1: "#f1f5f9", t2: "#7a90a8", t3: "#3d5068",
  blue: "#3b82f6", blueD: "#1d4ed8",
  cyan: "#38bdf8", green: "#22c55e",
  amber: "#f59e0b", red: "#ef4444",
  purple: "#a855f7",
};

// ─── Icons ────────────────────────────────────────────────────────────────────
const Icon = ({ d, size = 16, stroke = "currentColor", fill = "none", sw = 1.5 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const IC = {
  plus:     "M12 5v14M5 12h14",
  send:     "M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z",
  search:   "M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z",
  brain:    "M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.84A2.5 2.5 0 0 1 9.5 2M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.84A2.5 2.5 0 0 0 14.5 2",
  file:     "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  folder:   "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  plug:     "M12 22v-5M9 8V2M15 8V2M18 8H6a1 1 0 0 0-1 1v4a6 6 0 0 0 12 0V9a1 1 0 0 0-1-1z",
  dl:       "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  x:        "M18 6L6 18M6 6l12 12",
  check:    "M20 6L9 17l-5-5",
  copy:     "M20 9H11a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  trash:    "M3 6h18M8 6V4h8v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
  server:   "M20 8V4H4v4h16zM20 20v-4H4v4h16zM20 14v-4H4v4h16zM8 6h.01M8 12h.01M8 18h.01",
  shield:   "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  zap:      "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  cpu:      "M9 2H15M9 22H15M2 9V15M22 9V15M9 9h6v6H9zM2 14h4M18 14h4M2 10h4M18 10h4M10 2v4M14 2v4M10 18v4M14 18v4",
  menu:     "M3 12h18M3 6h18M3 18h18",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  refresh:  "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
  stop:     "M6 6h12v12H6z",
  table:    "M3 10h18M3 14h18M10 3v18M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z",
  globe:    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  hub:      "M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18",
  code:     "M16 18l6-6-6-6M8 6l-6 6 6 6",
  apply:    "M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 0 0 1.946-.806 3.42 3.42 0 0 1 4.438 0 3.42 3.42 0 0 0 1.946.806 3.42 3.42 0 0 1 3.138 3.138 3.42 3.42 0 0 0 .806 1.946 3.42 3.42 0 0 1 0 4.438 3.42 3.42 0 0 0-.806 1.946 3.42 3.42 0 0 1-3.138 3.138 3.42 3.42 0 0 0-1.946.806 3.42 3.42 0 0 1-4.438 0 3.42 3.42 0 0 0-1.946-.806 3.42 3.42 0 0 1-3.138-3.138 3.42 3.42 0 0 0-.806-1.946 3.42 3.42 0 0 1 0-4.438 3.42 3.42 0 0 0 .806-1.946 3.42 3.42 0 0 1 3.138-3.138z",
  pdf:      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  docx:     "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4",
  flask:    "M10 2v7.527a2 2 0 0 1-.211.896L4.72 19.63A1 1 0 0 0 5.633 21h12.734a1 1 0 0 0 .912-1.37L14.21 10.423A2 2 0 0 1 14 9.527V2M8.5 2h7",
};

// ─── Research Models (GGUF — runs via llama.cpp, no WebView memory limits) ────
// requiresToken: false → completely free, no HF account needed
// requiresToken: true  → needs a HF token (free at huggingface.co/settings/tokens)
// licenseGated: true   → also requires accepting the model license on HuggingFace
const MODELS = [
  {
    id:            "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    file:          "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    label:         "Qwen2.5 0.5B",
    org:           "Alibaba",
    orgColor:      C.cyan,
    sizeMB:        397,
    size:          "~397 MB",
    minRamGB:      1,
    quality:       "Good",
    speed:         "Very Fast",
    desc:          "Best starting point — no token or account needed. Apache 2.0 by Alibaba.",
    recommended:   true,
    requiresToken: false,
    licenseGated:  false,
  },
  {
    id:            "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
    file:          "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    label:         "Qwen2.5 1.5B",
    org:           "Alibaba",
    orgColor:      C.cyan,
    sizeMB:        986,
    size:          "~986 MB",
    minRamGB:      2,
    quality:       "Very Good",
    speed:         "Fast",
    desc:          "Better reasoning quality — still no token needed. Apache 2.0 by Alibaba.",
    recommended:   false,
    requiresToken: false,
    licenseGated:  false,
  },
  {
    id:            "MaziyarPanahi/Phi-3.5-mini-instruct-GGUF",
    file:          "Phi-3.5-mini-instruct.Q4_K_M.gguf",
    label:         "Phi-3.5 Mini",
    org:           "Microsoft",
    orgColor:      C.blue,
    sizeMB:        2390,
    size:          "~2.4 GB",
    minRamGB:      4,
    quality:       "Excellent",
    speed:         "Moderate",
    desc:          "Best reasoning quality — no token or account needed. MIT license by Microsoft.",
    requiresToken: false,
    licenseGated:  false,
  },
  {
    id:            "lmstudio-community/gemma-2-2b-it-GGUF",
    file:          "gemma-2-2b-it-Q4_K_M.gguf",
    label:         "Gemma 2 2B",
    org:           "Google",
    orgColor:      C.green,
    sizeMB:        1710,
    size:          "~1.7 GB",
    minRamGB:      3,
    quality:       "Good",
    speed:         "Fast",
    desc:          "Fast & efficient for document Q&A — no token or account needed. By Google.",
    requiresToken: false,
    licenseGated:  false,
  },
];

// HuggingFace base URL for downloads
const HF = "https://huggingface.co";

// ─── Clerk auth config ────────────────────────────────────────────────────────
// 1. Create a free account at https://clerk.com
// 2. Create an application → go to "API Keys"
// 3. Copy "Publishable key" (starts with pk_test_ or pk_live_) → paste below
// 4. In Clerk dashboard → Email address → enable "Email verification code"
const CLERK_KEY = "pk_test_aW1tZW5zZS1yb2RlbnQtNTEuY2xlcmsuYWNjb3VudHMuZGV2JA";

// ─── App version + update config ─────────────────────────────────────────────
// Bump APP_VERSION with every release so the update banner auto-hides.
const APP_VERSION = "0.3.3";
// GitHub Releases API — returns the latest release JSON (tag_name, body, html_url).
const UPDATE_CHECK_URL = "https://api.github.com/repos/Edu124/Codeforge-ai/releases/latest";

// ─── Hub trial config ─────────────────────────────────────────────────────────
const HUB_TRIAL_DAYS   = 5;
const HUB_TRIAL_KEY    = "offlineai_hub_trial_start"; // localStorage key
const HUB_CONTACT_MAIL = "support@offlineai.app";     // update to your real email

// ─── RAG helpers ──────────────────────────────────────────────────────────────
function chunkText(text, size = 150) {
  const words = text.split(/\s+/);
  const out = [];
  for (let i = 0; i < words.length; i += size)
    out.push(words.slice(i, i + size).join(" "));
  return out;
}

// Common stop words — excluded from scoring so only content words matter.
const STOP_WORDS = new Set([
  "the","and","are","for","this","that","with","have","from","they","will",
  "been","were","has","had","not","but","can","you","all","any","its","our",
  "was","use","may","also","each","into","these","those","than","when","what",
  "your","their","there","which","would","could","should","about","after",
  "such","how","who","make","more","some","only","used","just","very","even",
  "most","then","now","one","two","per","via","non","get","set",
  "them","him","her","his","she","out","did","does","been","upon",
]);

// Financial + general domain synonyms for query expansion.
// Allows "PBT" to match "profit before tax", "revenue" to match "turnover", etc.
const SYNONYMS = new Map([
  ["revenue",      ["sales","turnover","income","receipts","topline"]],
  ["sales",        ["revenue","turnover","income","receipts"]],
  ["turnover",     ["revenue","sales","income"]],
  ["income",       ["revenue","sales","earnings","profit","receipts"]],
  ["profit",       ["earnings","income","gain","surplus"]],
  ["pbt",          ["profit","before","tax","pretax","pre-tax","earnings","before","tax","ebt"]],
  ["ebt",          ["earnings","before","tax","profit","before","tax","pbt","pretax"]],
  ["pat",          ["profit","after","tax","net","profit","net","income","npat","bottom","line"]],
  ["ebit",         ["operating","profit","operating","income","operating","earnings"]],
  ["ebitda",       ["operating","profit","ebit","earnings","before","interest","tax","depreciation"]],
  ["gross",        ["gross","profit","gross","margin","gross","income"]],
  ["net",          ["net","profit","net","income","bottom","line","after","tax"]],
  ["tax",          ["taxation","income","tax","levy","duty","pbt","pat"]],
  ["expense",      ["cost","expenditure","outflow","spend","spending","charges","opex"]],
  ["cost",         ["expense","expenditure","spend","outflow","charges"]],
  ["depreciation", ["amortization","amortisation","writeoff","write-off","da","d&a"]],
  ["amortization", ["depreciation","amortisation","da","d&a","writeoff"]],
  ["interest",     ["finance","cost","finance","charge","borrowing","cost","interest","expense"]],
  ["dividend",     ["distribution","payout","shareholder","return"]],
  ["asset",        ["property","equipment","plant","resource","fixed","asset"]],
  ["liability",    ["debt","obligation","payable","borrowing","loan"]],
  ["equity",       ["capital","net","worth","shareholders","equity","shareholder"]],
  ["cash",         ["liquidity","funds","cash","flow","balance","liquid"]],
  ["margin",       ["ratio","percentage","rate","markup","profitability"]],
  ["total",        ["aggregate","combined","overall","sum","grand","total"]],
  ["operating",    ["operations","operational","ebit","opex","operating","profit"]],
  ["growth",       ["increase","rise","gain","improvement","change","percent","change"]],
  ["quarter",      ["q1","q2","q3","q4","quarterly"]],
  ["annual",       ["yearly","year","fy","fiscal","year"]],
]);

// Expand query with synonyms so "PBT" also matches "profit before tax" rows.
function expandQuery(query) {
  const lower = query.toLowerCase();
  const words = lower.split(/\W+/).filter(Boolean);
  const expanded = new Set(words);
  for (const w of words) {
    if (SYNONYMS.has(w)) SYNONYMS.get(w).forEach(s => expanded.add(s));
    // also reverse-check: if w appears in any synonym list, add that key too
    for (const [key, vals] of SYNONYMS) {
      if (vals.includes(w)) {
        expanded.add(key);
        SYNONYMS.get(key).forEach(s => expanded.add(s));
      }
    }
  }
  return [...expanded].join(" ");
}

// Prefix stem: "selection"→"selec", "selecting"→"selec" → they match each other.
function stemWord(w) {
  if (w.length <= 5) return w;
  return w.slice(0, 5);
}

// Score a chunk against a query. Uses content words of length >= 2 (catches PBT, net, tax).
function scoreChunk(chunk, query) {
  const qWords = query.toLowerCase().split(/\W+/).filter(w => w.length >= 2 && !STOP_WORDS.has(w));
  if (qWords.length === 0) return 0;
  const qStems = new Set(qWords.map(stemWord));
  const qExact = new Set(qWords);
  let s = 0;
  for (const w of chunk.toLowerCase().split(/\W+/)) {
    if (!w || w.length < 2 || STOP_WORDS.has(w)) continue;
    if (qExact.has(w))               s += 2; // exact match → 2 pts
    else if (qStems.has(stemWord(w))) s += 1; // stem match → 1 pt
  }
  return s;
}

// Shared helper: extract a period token from any query string.
// Matches full period strings like "Mar-23", "FY24", "Q3-24", "2023" so
// we can filter Excel chunks to only show the requested period.
function extractPeriodHint(query) {
  // Try full period first: "Mar-23", "Jun-22", "FY24", "Q3-24", "2023"
  const full = query.match(
    /\b((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)-?\s*\d{2,4}|fy\s*\d{2,4}|q[1-4][-\s]?\d{2,4}|20\d{2})\b/i
  );
  if (full) return full[0].replace(/\s+/g, ""); // "Mar 23" → "Mar23"
  // Fallback: bare month or quarter
  const short = query.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4])\b/i);
  return short ? short[0] : null;
}

function retrieveContext(connectors, query, topK = 8) {
  const expandedQuery = expandQuery(query);
  const periodHint = extractPeriodHint(query);

  const all = [];
  for (const c of connectors)
    if (c.chunks) for (const t of c.chunks) {
      let score = scoreChunk(t, expandedQuery);

      // Period boost: if query mentions a specific period (e.g. "Mar-23"),
      // massively boost chunks from that period so the LLM only sees the
      // correct column and cannot accidentally pick values from another period.
      if (periodHint) {
        const pm = t.match(/Period:\s*([^\]\n]+)/i);
        if (pm) {
          const chunkPeriod = pm[1].trim().toLowerCase().replace(/\s+/g, "");
          const hint = periodHint.toLowerCase().replace(/\s+/g, "");
          if (chunkPeriod === hint || chunkPeriod.includes(hint) || hint.includes(chunkPeriod)) {
            score += 100; // guaranteed top-K for the exact period
          }
        }
      }
      all.push({ text: t, source: c.name, score });
    }

  all.sort((a, b) => b.score - a.score);

  // Small doc (≤ 20 chunks): include everything — no query filtering.
  if (all.length <= 20) return all.slice(0, Math.max(topK, all.length));

  // Large doc: prefer scored chunks; fallback to top scored.
  const withScore = all.filter(c => c.score > 0);
  return (withScore.length > 0 ? withScore : all).slice(0, topK);
}

// ─── Domain Analytics Engine ──────────────────────────────────────────────────
// Detects formula queries, extracts values from Excel chunks, calculates results.
// Covers Finance (P/E, ROE, margins, D/E, current ratio…) and Pharma (assay,
// cell viability, yield, purity, recovery).
const FORMULA_CATALOG = [
  // ── FINANCIAL ───────────────────────────────────────────────────────────────
  {
    id: "gross_margin", name: "Gross Margin", domain: "finance",
    aliases: ["gross margin", "gross profit margin"],
    fields: {
      gross_profit: ["gross profit", "gross income", "gross"],
      revenue: ["revenue", "sales", "turnover", "net revenue", "net sales"],
    },
    formula: "Gross Margin = (Gross Profit / Revenue) × 100",
    calculate: (v) => (v.gross_profit / v.revenue) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
  {
    id: "net_margin", name: "Net Profit Margin", domain: "finance",
    aliases: ["net margin", "net profit margin", "pat margin", "profit margin", "npm"],
    fields: {
      net_profit: ["net profit", "pat", "profit after tax", "net income", "net earnings", "bottom line"],
      revenue: ["revenue", "sales", "turnover", "net revenue"],
    },
    formula: "Net Margin = (Net Profit / Revenue) × 100",
    calculate: (v) => (v.net_profit / v.revenue) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
  {
    id: "ebitda_margin", name: "EBITDA Margin", domain: "finance",
    aliases: ["ebitda margin"],
    fields: {
      ebitda: ["ebitda", "earnings before interest tax depreciation", "ebitda profit"],
      revenue: ["revenue", "sales", "turnover"],
    },
    formula: "EBITDA Margin = (EBITDA / Revenue) × 100",
    calculate: (v) => (v.ebitda / v.revenue) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
  {
    id: "ebit_margin", name: "EBIT / Operating Margin", domain: "finance",
    aliases: ["ebit margin", "operating margin", "pbit margin"],
    fields: {
      ebit: ["ebit", "pbit", "operating profit", "operating income"],
      revenue: ["revenue", "sales", "turnover"],
    },
    formula: "EBIT Margin = (EBIT / Revenue) × 100",
    calculate: (v) => (v.ebit / v.revenue) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
  {
    id: "pbt_margin", name: "PBT Margin", domain: "finance",
    aliases: ["pbt margin", "pre-tax margin", "pretax margin"],
    fields: {
      pbt: ["pbt", "profit before tax", "ebt", "pre-tax profit", "pretax profit"],
      revenue: ["revenue", "sales", "turnover"],
    },
    formula: "PBT Margin = (PBT / Revenue) × 100",
    calculate: (v) => (v.pbt / v.revenue) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
  {
    id: "roe", name: "Return on Equity (ROE)", domain: "finance",
    aliases: ["roe", "return on equity"],
    fields: {
      net_profit: ["net profit", "pat", "net income", "profit after tax"],
      equity: ["equity", "shareholders equity", "shareholder equity", "net worth", "total equity"],
    },
    formula: "ROE = (Net Profit / Shareholders' Equity) × 100",
    calculate: (v) => (v.net_profit / v.equity) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
  {
    id: "roa", name: "Return on Assets (ROA)", domain: "finance",
    aliases: ["roa", "return on assets"],
    fields: {
      net_profit: ["net profit", "pat", "net income", "profit after tax"],
      total_assets: ["total assets", "assets"],
    },
    formula: "ROA = (Net Profit / Total Assets) × 100",
    calculate: (v) => (v.net_profit / v.total_assets) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
  {
    id: "debt_equity", name: "Debt-to-Equity Ratio", domain: "finance",
    aliases: ["debt to equity", "debt-to-equity", "d/e ratio", "leverage ratio", "gearing"],
    fields: {
      total_debt: ["total debt", "debt", "borrowings", "loans", "total borrowings", "long term debt"],
      equity: ["equity", "shareholders equity", "net worth", "total equity"],
    },
    formula: "D/E = Total Debt / Shareholders' Equity",
    calculate: (v) => v.total_debt / v.equity,
    format: (r) => r.toFixed(2) + "x",
  },
  {
    id: "current_ratio", name: "Current Ratio", domain: "finance",
    aliases: ["current ratio", "liquidity ratio"],
    fields: {
      current_assets: ["current assets"],
      current_liabilities: ["current liabilities"],
    },
    formula: "Current Ratio = Current Assets / Current Liabilities",
    calculate: (v) => v.current_assets / v.current_liabilities,
    format: (r) => r.toFixed(2) + "x",
  },
  {
    id: "pe_ratio", name: "P/E Ratio (Price-to-Earnings)", domain: "finance",
    aliases: ["p/e", "pe ratio", "price to earnings", "price-to-earnings", "pe multiple"],
    fields: {
      price: ["stock price", "share price", "market price", "price per share", "cmp"],
      eps: ["eps", "earnings per share", "diluted eps", "basic eps"],
    },
    formula: "P/E = Price per Share / Earnings per Share",
    calculate: (v) => v.price / v.eps,
    format: (r) => r.toFixed(2) + "x",
  },
  {
    id: "revenue_growth", name: "Revenue Growth", domain: "finance",
    aliases: ["revenue growth", "sales growth", "topline growth", "revenue increase"],
    multiperiod: true,
    fields: {
      revenue_curr: ["revenue", "sales", "turnover"],
      revenue_prev: ["revenue", "sales", "turnover"],
    },
    formula: "Revenue Growth = ((Current Revenue − Prior Revenue) / Prior Revenue) × 100",
    calculate: (v) => ((v.revenue_curr - v.revenue_prev) / v.revenue_prev) * 100,
    format: (r) => (r >= 0 ? "+" : "") + r.toFixed(2) + "%",
  },
  // ── PHARMA / BIOTECH ────────────────────────────────────────────────────────
  {
    id: "assay_potency", name: "Assay Potency", domain: "pharma",
    aliases: ["assay potency", "relative potency", "assay"],
    fields: {
      test: ["test", "sample", "test response", "sample response", "test result", "test absorbance"],
      reference: ["reference", "standard", "reference standard", "reference response", "reference absorbance"],
    },
    formula: "Potency% = (Test Response / Reference Response) × 100",
    calculate: (v) => (v.test / v.reference) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
  {
    id: "cell_viability", name: "% Cell Viability", domain: "pharma",
    aliases: ["cell viability", "viability", "cell survival", "percent viability"],
    fields: {
      treated: ["treated", "sample od", "treated od", "treated absorbance", "treated cells"],
      control: ["control", "control od", "untreated", "control absorbance", "control cells"],
    },
    formula: "% Viability = (Treated OD / Control OD) × 100",
    calculate: (v) => (v.treated / v.control) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
  {
    id: "drug_yield", name: "Drug Yield %", domain: "pharma",
    aliases: ["yield", "drug yield", "process yield", "yield percent", "percent yield"],
    fields: {
      actual: ["actual yield", "obtained", "actual", "measured yield", "product obtained"],
      theoretical: ["theoretical yield", "theoretical", "expected yield", "theoretical amount"],
    },
    formula: "Yield% = (Actual Yield / Theoretical Yield) × 100",
    calculate: (v) => (v.actual / v.theoretical) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
  {
    id: "purity", name: "Purity %", domain: "pharma",
    aliases: ["purity", "drug purity", "compound purity", "chemical purity", "assay purity"],
    fields: {
      active: ["active ingredient", "pure compound", "api", "active pharmaceutical ingredient", "active content"],
      total: ["total", "total sample", "gross weight", "total compound", "sample weight"],
    },
    formula: "Purity% = (Active Ingredient / Total Sample) × 100",
    calculate: (v) => (v.active / v.total) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
  {
    id: "recovery", name: "Recovery %", domain: "pharma",
    aliases: ["recovery", "percent recovery", "recovery percent", "drug recovery", "% recovery"],
    fields: {
      measured: ["measured", "found", "recovered", "actual amount", "amount found"],
      expected: ["expected", "theoretical", "spiked", "known amount", "added amount"],
    },
    formula: "Recovery% = (Measured Amount / Expected Amount) × 100",
    calculate: (v) => (v.measured / v.expected) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
  {
    id: "label_claim", name: "Assay (Label Claim %)", domain: "pharma",
    aliases: ["label claim", "drug content", "content uniformity", "assay content", "assay label"],
    fields: {
      measured: ["measured content", "found content", "assayed", "content found", "drug found"],
      label: ["label claim", "labeled amount", "declared content", "theoretical content", "nominal content"],
    },
    formula: "Assay% = (Measured Content / Label Claim) × 100",
    calculate: (v) => (v.measured / v.label) * 100,
    format: (r) => r.toFixed(2) + "%",
  },
];

// Find best formula match for the user query.
function detectFormula(query) {
  const q = query.toLowerCase();
  let best = null, bestScore = 0;
  for (const f of FORMULA_CATALOG) {
    for (const alias of f.aliases) {
      if (q.includes(alias)) {
        const score = alias.length;
        if (score > bestScore) { bestScore = score; best = f; }
      }
    }
  }
  return best;
}

// Extract one numeric value for a given set of field aliases from Excel chunks.
// Scoring tiers (higher = better match):
//   40 pts — label IS exactly the alias (e.g. label="Revenue", alias="revenue")
//   20 pts — label STARTS with the alias (e.g. label="Revenue Growth", alias="revenue")
//   10 pts — alias IS fully contained in label (e.g. label="Total Revenue", alias="revenue")
//    1 pt  — alias word appears somewhere in the label (partial / fallback)
// This prevents "Other Revenue" (score 10) from beating "Revenue" (score 40).
function extractFieldValue(aliases, connectors, preferredPeriod = null, excludePeriod = null) {
  let bestScore = 0, bestResult = null;

  for (const c of connectors) {
    if (c.type !== "excel" || !c.chunks) continue;
    for (const chunk of c.chunks) {
      const periodMatch = chunk.match(/Period:\s*([^\]\n]+)/);
      const period = periodMatch ? periodMatch[1].trim() : null;
      if (preferredPeriod && period && !period.toLowerCase().includes(preferredPeriod.toLowerCase())) continue;
      if (excludePeriod && period && period === excludePeriod) continue;

      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.startsWith("[")) continue;
        // Label is everything before the first ":"  e.g. "Revenue for Mar-23"
        // Strip the " for <period>" suffix to get the clean label name
        const colonIdx = line.indexOf(":");
        if (colonIdx < 0) continue;
        const rawLabel = line.slice(0, colonIdx).trim();
        // Remove trailing " for <period>" so we compare just the metric name
        const cleanLabel = rawLabel.replace(/\s+for\s+\S+$/i, "").trim().toLowerCase();

        let lineScore = 0;
        for (const alias of aliases) {
          const a = alias.toLowerCase().trim();
          if (cleanLabel === a) {
            lineScore = Math.max(lineScore, 40);          // exact match
          } else if (cleanLabel.startsWith(a + " ") || cleanLabel.startsWith(a)) {
            lineScore = Math.max(lineScore, 20);          // label starts with alias
          } else if (cleanLabel.includes(a)) {
            lineScore = Math.max(lineScore, 10);          // alias contained in label
          } else if (cleanLabel.split(/\s+/).some(w => w === a)) {
            lineScore = Math.max(lineScore, 5);           // alias is a whole word in label
          }
        }

        if (lineScore > bestScore) {
          // Extract numeric value — handle comma-separated thousands (1,234.56)
          const valStr = line.slice(colonIdx + 1).trim();
          const num = parseFloat(valStr.replace(/,/g, ""));
          if (!isNaN(num)) {
            bestScore = lineScore;
            bestResult = { value: num, period, source: c.name, label: cleanLabel };
          }
        }
      }
    }
  }
  return bestResult;
}

// Try to calculate a formula from Excel connectors.
// Returns null if no formula matched or no values found.
function tryAnalyticalCalculation(query, connectors) {
  if (!connectors.some(c => c.type === "excel")) return null;
  const formula = detectFormula(query);
  if (!formula) return null;

  // Extract period hint using the shared helper — captures full "Mar-23" not just "Mar"
  const periodHint = extractPeriodHint(query);

  const extracted = {}, missing = [];
  const fieldEntries = Object.entries(formula.fields);

  for (const [fieldId, aliases] of fieldEntries) {
    if (formula.multiperiod && fieldId === "revenue_prev") {
      // For growth: pull from a different period than revenue_curr
      const currPeriod = extracted.revenue_curr?.period || null;
      const res = extractFieldValue(aliases, connectors, null, currPeriod);
      if (res) extracted[fieldId] = res; else missing.push(fieldId);
    } else {
      const res = extractFieldValue(aliases, connectors, periodHint);
      if (res) extracted[fieldId] = res; else missing.push(fieldId);
    }
  }

  if (Object.keys(extracted).length === 0) return null; // nothing found

  let calculatedValue = null, calcError = null;
  if (missing.length === 0) {
    try {
      const vals = Object.fromEntries(Object.entries(extracted).map(([k, v]) => [k, v.value]));
      calculatedValue = formula.calculate(vals);
      if (!isFinite(calculatedValue)) { calcError = "Division by zero or invalid inputs"; calculatedValue = null; }
    } catch (e) { calcError = String(e); }
  }

  return {
    formula,
    extracted,
    missing,
    calculatedValue,
    formattedValue: calculatedValue !== null ? formula.format(calculatedValue) : null,
    calcError,
  };
}

// ─── Language support ─────────────────────────────────────────────────────────
// Two options: Auto detects language and replies in it; EN forces English only
const LANG_OPTIONS = [
  { id: "auto", label: "Auto" },
  { id: "en",   label: "EN" },
];

const LANG_PROMPTS = {
  hi: "\n\nIMPORTANT LANGUAGE RULE: The user is writing in Hindi/Hinglish. You MUST respond ENTIRELY in Hindi using Devanagari script (हिंदी). Do NOT mix in characters from Chinese, Arabic, or Latin scripts. Only use English for code snippets, proper nouns, or technical terms that have no Hindi equivalent. For mathematics, write formulas in plain text (e.g., sin²θ + cos²θ = 1) — never use raw LaTeX commands.",
  ta: "\n\nIMPORTANT LANGUAGE RULE: The user wants a response in Tamil. You MUST respond ENTIRELY in Tamil script (தமிழ்). Do NOT mix in characters from other scripts. Only use English for code snippets, proper nouns, or technical terms that have no Tamil equivalent. For mathematics, write formulas in plain text — never use raw LaTeX commands.",
  te: "\n\nIMPORTANT LANGUAGE RULE: The user wants a response in Telugu. You MUST respond ENTIRELY in Telugu script (తెలుగు). Do NOT mix in characters from other scripts. Only use English for code snippets, proper nouns, or technical terms that have no Telugu equivalent. For mathematics, write formulas in plain text — never use raw LaTeX commands.",
  fr: "\n\nIMPORTANT LANGUAGE RULE: The user wants a response in French (Français). You MUST respond ENTIRELY in French using ONLY standard Latin characters (a–z, accented letters like é è ê ë à â ù û ü î ï ô œ ç). Do NOT mix in characters from Chinese, Arabic, Cyrillic, or any other script — if you are about to write such a character, omit it entirely. Only use English for code snippets or technical terms that have no French equivalent. For mathematics, write formulas in plain text (e.g., sin²θ + cos²θ = 1) — never use raw LaTeX commands.",
  es: "\n\nIMPORTANT LANGUAGE RULE: The user wants a response in Spanish (Español). You MUST respond ENTIRELY in Spanish using only standard Latin characters. Do NOT mix in characters from other scripts. Only use English for code snippets or technical terms with no Spanish equivalent. For mathematics, write formulas in plain text — never use raw LaTeX commands.",
  de: "\n\nIMPORTANT LANGUAGE RULE: The user wants a response in German (Deutsch). You MUST respond ENTIRELY in German using only standard Latin characters. Do NOT mix in characters from other scripts. Only use English for code snippets or technical terms with no German equivalent. For mathematics, write formulas in plain text — never use raw LaTeX commands.",
  ar: "\n\nIMPORTANT LANGUAGE RULE: The user is writing in Arabic (العربية). You MUST respond ENTIRELY in Arabic using only Arabic script characters. Do NOT mix in characters from Latin, Chinese, or other scripts. Only use English for code snippets or technical terms with no Arabic equivalent. For mathematics, write formulas in plain text — never use raw LaTeX commands.",
  zh: "\n\nIMPORTANT LANGUAGE RULE: The user wants a response in Chinese (中文). You MUST respond ENTIRELY in Simplified Chinese (简体中文). Do NOT mix in characters from other scripts mid-sentence. Only use English for code snippets or technical terms with no Chinese equivalent. For mathematics, write formulas in plain text — never use raw LaTeX commands.",
  ja: "\n\nIMPORTANT LANGUAGE RULE: The user wants a response in Japanese (日本語). You MUST respond ENTIRELY in Japanese. Do NOT mix in characters from unrelated scripts. Only use English for code snippets or technical terms with no Japanese equivalent. For mathematics, write formulas in plain text — never use raw LaTeX commands.",
  ko: "\n\nIMPORTANT LANGUAGE RULE: The user wants a response in Korean (한국어). You MUST respond ENTIRELY in Korean. Do NOT mix in characters from unrelated scripts. Only use English for code snippets or technical terms with no Korean equivalent. For mathematics, write formulas in plain text — never use raw LaTeX commands.",
  ru: "\n\nIMPORTANT LANGUAGE RULE: The user wants a response in Russian (Русский). You MUST respond ENTIRELY in Russian. Only use English for code snippets or technical terms with no Russian equivalent.",
};

function detectLanguage(text) {
  // Script-based detection (unambiguous Unicode ranges — single character is enough)
  if (/[\u0900-\u097F]/.test(text)) return "hi";             // Devanagari → Hindi
  if (/[\u0B80-\u0BFF]/.test(text)) return "ta";             // Tamil script
  if (/[\u0C00-\u0C7F]/.test(text)) return "te";             // Telugu script
  if (/[\u0600-\u06FF]/.test(text)) return "ar";             // Arabic script
  if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text)) return "zh"; // CJK → Chinese
  if (/[\u3040-\u30FF]/.test(text)) return "ja";             // Hiragana + Katakana → Japanese
  if (/[\uAC00-\uD7A3]/.test(text)) return "ko";             // Hangul → Korean
  if (/[\u0400-\u04FF]/.test(text)) return "ru";             // Cyrillic → Russian

  // Strong single-word indicators (very distinctive — one match is enough)
  if (/\b(bonjour|bonsoir|bonne\s*nuit|au\s*revoir|enchanté|voilà|qu'est-ce|je\s*m'appelle|s'il\s*vous\s*plaît|pourquoi\s*pas|bien\s*sûr)\b/gi.test(text)) return "fr";
  if (/\b(hola|buenos\s*días|buenas\s*tardes|buenas\s*noches|de\s*nada|por\s*favor|cómo\s*estás|qué\s*tal|mucho\s*gusto)\b/gi.test(text)) return "es";
  if (/\b(guten\s*tag|guten\s*morgen|gute\s*nacht|auf\s*wiedersehen|bitte\s*schön|danke\s*schön|entschuldigung|herzlich\s*willkommen)\b/gi.test(text)) return "de";
  if (/\b(ciao|buongiorno|buonasera|buona\s*notte|grazie\s*mille|prego|arrivederci|scusi)\b/gi.test(text)) return "it";

  // Hinglish: common Hindi words in Latin script (≥2 matches)
  const hinglish = /\b(mujhe|kya|hai|nahi|hain|aur|yeh|woh|chahiye|batao|karo|kaise|kyun|kyunki|lekin|bhi|main|aap|bahut|abhi|aaj|phir|matlab|sahi|galat|suno|dekho|achha|theek|sirf|kaafi|zyada|pehle)\b/gi;
  if ((text.match(hinglish) || []).length >= 2) return "hi";

  // French: common function words (≥2 matches)
  const french = /\b(je|tu|il|elle|nous|vous|ils|elles|est|sont|les|des|une|dans|avec|pour|sur|par|mais|merci|oui|non|c'est|n'est|qu'il|j'ai|suis|m'appelle|s'il|aussi|très|bien|quoi|quel|quelle)\b/gi;
  if ((text.match(french) || []).length >= 2) return "fr";

  // Spanish: common words (≥2 matches)
  const spanish = /\b(yo|él|ella|nosotros|ellos|está|están|para|cómo|qué|también|gracias|sí|buenos|señor|señora|muy|pero|porque|todo|nada|tengo|quiero|puedo)\b/gi;
  if ((text.match(spanish) || []).length >= 2) return "es";

  // German: common words (≥2 matches)
  const german = /\b(ich|du|er|sie|wir|ihr|bin|ist|sind|das|die|der|ein|eine|und|oder|aber|mit|für|auf|nicht|kein|auch|guten|danke|bitte|hallo|nein|sehr|hier|dort)\b/gi;
  if ((text.match(german) || []).length >= 2) return "de";

  return "en";
}

// ─── Prompt engineering ───────────────────────────────────────────────────────
function buildSystemPrompt(connectors, lang = "en") {
  const hasDocs = connectors.some(c => c.chunks?.length > 0);
  const base = `You are Codeforge AI — a research assistant running 100% on this device. No data leaves this machine.\n\nACCURACY RULES (highest priority — always apply these before answering):\n- PREMISE CHECK: Before answering any math, science, or factual question, verify whether the user's stated facts, equations, or identities are correct. If the user's premise is FALSE or INCORRECT (e.g., a wrong equation like "sinθ + cosθ = 1" when the correct identity is "sin²θ + cos²θ = 1"), you MUST explicitly correct it first using "⚠️ Correction:" before explaining the right concept. Never build an explanation on a false premise — correcting the user is more helpful than confirming a mistake.\n- MATH NOTATION: Write math using plain Unicode text only (e.g., sin²θ + cos²θ = 1, √x, π, θ). Do NOT output raw LaTeX commands like \\sin, \\cos, \\frac{a}{b}, \\sqrt{} or \\text{} — these appear as broken garbled text to the user.\n- NO HALLUCINATION: Never invent facts, formulas, examples, or real-world applications you are not certain about. If you are unsure of an example, omit it or say "I'm not certain about this". It is far better to say "I don't know" than to fabricate a plausible-sounding but wrong answer.\n- CLEAN OUTPUT: Your response must use only the characters of the target language's script. Never mix in characters or words from unrelated writing systems (e.g., no Chinese/Arabic/Cyrillic characters in a French or English response). If you are about to output a character you cannot verify, omit it.\n\nRESPONSE RULES:\n- Be precise, cite sources when context is provided.\n- Structure complex answers with bullet points or sections.\n- If the answer is not in the provided context, say so — never hallucinate.\n- Prefer concise, evidence-based responses.\n- For Excel/financial data: calculate requested metrics from the numbers in the context; show your working.\n- Language identification: You understand ALL world languages. When asked "what language is this?", "which language is this?", or any similar question, ALWAYS explicitly state the full language name first (e.g., "This is French.", "This text is written in Arabic.", "This is Spanish."), then provide the translation or meaning. Never skip naming the language.`;
  const docInstr = hasDocs ? "\n\nDOCUMENT CONTEXT RULES (highest priority when context is provided):\n- The user has connected research documents. A \"--- Document context ---\" section will appear in their message with extracted text from those files.\n- You MUST answer the user's question using ONLY the information found in that context section. Quote or paraphrase directly from it.\n- If the answer is clearly present in the context, do NOT add general knowledge — stick to what the document says.\n- Cite the source file name when referencing specific content (e.g., \"According to [filename]...\").\n- Only if the context contains NO relevant information at all should you say so and offer a general answer as a fallback." : "";
  const langInstr = LANG_PROMPTS[lang] || "";
  return base + docInstr + langInstr;
}

// Build a raw prompt string for llama.cpp (no tokenizer required in JS).
// Uses ChatML format (Qwen, Phi-3.5) or Gemma format depending on model.
function buildPrompt(history, userText, ctxChunks, connectors, modelId, lang = "en") {
  const sys = buildSystemPrompt(connectors, lang);

  // Context goes BEFORE the question so the model reads the document first,
  // then encounters the question with full context already in working memory.
  const ctx = ctxChunks.length > 0
    ? "The following passages are extracted from the user's connected document(s).\n" +
      "Read them carefully, then answer the question below using ONLY this content.\n\n" +
      "=== DOCUMENT CONTEXT ===\n" +
      ctxChunks.map((c, i) => `[Passage ${i + 1} — ${c.source}]\n${c.text}`).join("\n\n") +
      "\n=== END OF CONTEXT ===\n\nQuestion: "
    : "";

  const isGemma = modelId.toLowerCase().includes("gemma");

  // When lots of document context is present, reduce history to save token space.
  // 0-2 chunks → 4 turns; 3+ chunks → 2 turns.
  const histSlice = ctxChunks.length > 2 ? -2 : -4;
  const recentHistory = history.slice(histSlice);

  if (isGemma) {
    let p = `<start_of_turn>user\n${sys}\n`;
    for (const m of recentHistory) {
      if (m.role === "user") p += `<start_of_turn>user\n${m.text}<end_of_turn>\n`;
      else                   p += `<start_of_turn>model\n${m.text}<end_of_turn>\n`;
    }
    p += `<start_of_turn>user\n${ctx}${userText}<end_of_turn>\n<start_of_turn>model\n`;
    return p;
  }

  // ChatML (Qwen2.5, Phi-3.5)
  let p = `<|im_start|>system\n${sys}<|im_end|>\n`;
  for (const m of recentHistory) {
    const role = m.role === "ai" ? "assistant" : "user";
    p += `<|im_start|>${role}\n${m.text}<|im_end|>\n`;
  }
  p += `<|im_start|>user\n${ctx}${userText}<|im_end|>\n<|im_start|>assistant\n`;
  return p;
}

// ─── Tiny components ──────────────────────────────────────────────────────────
function Dot({ color = C.green, pulse = false }) {
  return <div style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0, animation: pulse ? "oai-pulse 2s ease infinite" : "none" }} />;
}
function Btn({ onClick, disabled, style, children }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ cursor: disabled ? "default" : "pointer", fontFamily: "inherit", transition: "opacity 0.15s, background 0.15s", opacity: disabled ? 0.45 : 1, ...style }}>
      {children}
    </button>
  );
}
function Spinner() {
  return <span style={{ width: 13, height: 13, border: `2px solid rgba(255,255,255,0.2)`, borderTopColor: C.cyan, borderRadius: "50%", display: "inline-block", animation: "oai-spin 0.8s linear infinite" }} />;
}

// ─── Analytical Calculation Card ──────────────────────────────────────────────
// Rendered above the AI text when the engine solved a formula from Excel data.
function CalcCard({ calc }) {
  const domainColor = calc.formula.domain === "pharma" ? C.purple : C.green;
  const domainLabel = calc.formula.domain === "pharma" ? "Pharma" : "Finance";
  return (
    <div style={{ marginBottom: 8, padding: "13px 16px", background: `${domainColor}0d`, border: `1px solid ${domainColor}40`, borderRadius: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 16 }}>{calc.formula.domain === "pharma" ? "🧪" : "📊"}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.t1 }}>{calc.formula.name}</span>
        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: `${domainColor}20`, border: `1px solid ${domainColor}40`, color: domainColor }}>{domainLabel}</span>
      </div>
      <div style={{ fontSize: 11, color: C.t2, fontFamily: "monospace", marginBottom: 10, padding: "6px 10px", background: "rgba(0,0,0,0.25)", borderRadius: 7 }}>
        {calc.formula.formula}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
        {Object.entries(calc.extracted).map(([fieldId, info]) => (
          <div key={fieldId} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: C.t2 }}>
              {fieldId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
              {info.period && <span style={{ color: C.t3, marginLeft: 4 }}>({info.period})</span>}
              {info.source && <span style={{ color: C.t3, marginLeft: 4 }}>· {info.source}</span>}
            </span>
            <span style={{ color: C.cyan, fontFamily: "monospace", fontWeight: 600 }}>
              {info.value.toLocaleString()}
            </span>
          </div>
        ))}
        {calc.missing.map(f => (
          <div key={f} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: C.t3 }}>{f.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</span>
            <span style={{ color: C.amber, fontFamily: "monospace" }}>not found</span>
          </div>
        ))}
      </div>
      {calc.formattedValue !== null ? (
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "10px 14px", background: `${domainColor}15`, border: `1px solid ${domainColor}55`, borderRadius: 9 }}>
          <span style={{ fontSize: 12, color: C.t2 }}>Result</span>
          <span style={{ fontSize: 22, fontWeight: 800, color: domainColor, letterSpacing: "-0.02em", fontFamily: "monospace" }}>{calc.formattedValue}</span>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: C.amber }}>
          {calc.calcError || "Missing values — unable to calculate. AI will attempt from context."}
        </div>
      )}
    </div>
  );
}

// ─── Model Modal ──────────────────────────────────────────────────────────────
function ModelModal({ modelState, activeModelId, hfToken, onTokenChange, onDownload, onLoad, onDelete, onResetServer, onClose }) {
  const [selected, setSelected] = useState(activeModelId || MODELS[0].id);
  const [freeDiskMB, setFreeDiskMB] = useState(0);

  useEffect(() => {
    invoke("get_free_disk_space").then(mb => setFreeDiskMB(mb)).catch(() => setFreeDiskMB(0));
  }, []);

  const sel = MODELS.find(m => m.id === selected) || MODELS[0];
  const hasSpace = freeDiskMB === 0 || freeDiskMB >= sel.sizeMB;
  const needsToken = sel.requiresToken && !hfToken.trim();
  const canDownload = hasSpace && !needsToken;
  const state = modelState[selected] || { status: "not-downloaded" };
  const freeDiskGB = freeDiskMB > 0 ? (freeDiskMB / 1024).toFixed(1) : null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(6px)" }}>
      <div style={{ width: 560, background: C.bgPanel, border: `1px solid ${C.border}`, borderRadius: 18, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,0.7)" }}>

        {/* Header */}
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.t1 }}>Research AI Models</div>
            <div style={{ fontSize: 12, color: C.t2, marginTop: 2 }}>
              Downloaded to <strong style={{ color: C.t1 }}>your device</strong> — runs fully offline
            </div>
          </div>
          <Btn onClick={onClose} style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, color: C.t2, padding: "6px 8px", display: "flex" }}>
            <Icon d={IC.x} size={15} />
          </Btn>
        </div>

        <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Disk space badge */}
          {freeDiskGB && (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 12px", background: C.bgCard, borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12 }}>
              <span style={{ color: C.t3 }}>Free disk space</span>
              <span style={{ color: freeDiskMB >= sel.sizeMB ? C.cyan : C.red, fontFamily: "monospace" }}>{freeDiskGB} GB available</span>
            </div>
          )}

          {/* Model list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {MODELS.map(m => {
              const ms = modelState[m.id] || { status: "not-downloaded" };
              const isSel = selected === m.id;
              const isActive = activeModelId === m.id && ms.status === "loaded";

              return (
                <div key={m.id} onClick={() => setSelected(m.id)} style={{
                  padding: "13px 15px", borderRadius: 11,
                  background: isSel ? "rgba(59,130,246,0.1)" : C.bgCard,
                  border: `1px solid ${isSel ? C.borderHi : C.border}`,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 13.5, fontWeight: 700, color: C.t1 }}>{m.label}</span>
                        <span style={{ fontSize: 10, padding: "1px 7px", background: `${m.orgColor}18`, border: `1px solid ${m.orgColor}40`, borderRadius: 20, color: m.orgColor }}>{m.org}</span>
                        {m.recommended && <span style={{ fontSize: 10, padding: "1px 7px", background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 20, color: C.green }}>Recommended</span>}
                        {isActive && <span style={{ fontSize: 10, padding: "1px 7px", background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.3)", borderRadius: 20, color: C.cyan }}>Active</span>}
                        {!m.requiresToken
                          ? <span style={{ fontSize: 10, padding: "1px 7px", background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 20, color: C.green }}>✓ Free — no account needed</span>
                          : m.licenseGated
                          ? <span style={{ fontSize: 10, padding: "1px 7px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 20, color: C.red }}>🔒 License + token</span>
                          : <span style={{ fontSize: 10, padding: "1px 7px", background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 20, color: C.amber }}>🔑 Free token only</span>
                        }
                      </div>
                      <div style={{ fontSize: 11.5, color: C.t2, lineHeight: 1.5 }}>{m.desc}</div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                      <div style={{ fontSize: 12, color: C.cyan, fontWeight: 600 }}>{m.size}</div>
                      <div style={{ fontSize: 10, color: C.t3, marginTop: 2 }}>{m.speed}</div>
                      {/* Download state badge */}
                      <div style={{ marginTop: 6 }}>
                        {ms.status === "downloaded" || ms.status === "loaded" || ms.status === "load-error"
                          ? <span style={{ fontSize: 10, padding: "2px 8px", background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 20, color: C.green }}>✓ On disk</span>
                          : ms.status === "downloading"
                            ? <span style={{ fontSize: 10, color: C.amber }}>Downloading…</span>
                            : <span style={{ fontSize: 10, color: C.t3 }}>Not downloaded</span>
                        }
                      </div>
                    </div>
                  </div>

                  {/* Per-model download progress */}
                  {ms.status === "downloading" && ms.progress && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.t2, marginBottom: 5 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }}>{ms.progress.file}</span>
                        <span style={{ color: C.cyan, flexShrink: 0 }}>
                          {ms.progress.total > 0 ? `${Math.round((ms.progress.downloaded / ms.progress.total) * 100)}%` : `${(ms.progress.downloaded / 1048576).toFixed(0)} MB`}
                        </span>
                      </div>
                      <div style={{ height: 4, background: C.bgDeep, borderRadius: 4, overflow: "hidden" }}>
                        <div style={{
                          height: "100%",
                          width: ms.progress.total > 0 ? `${Math.round((ms.progress.downloaded / ms.progress.total) * 100)}%` : "40%",
                          background: `linear-gradient(90deg,${C.blueD},${C.cyan})`,
                          transition: "width 0.3s",
                          borderRadius: 4,
                          animation: ms.progress.total === 0 ? "oai-slide-bar 1.5s ease infinite" : "none",
                        }} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Warnings */}
          {!hasSpace && (
            <div style={{ padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, fontSize: 12, color: C.red }}>
              ⚠️ Not enough disk space. {sel.label} needs ~{(sel.sizeMB / 1024).toFixed(1)} GB but only {freeDiskGB} GB is free.
            </div>
          )}
          {needsToken && (
            <div style={{ padding: "10px 14px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 8, fontSize: 12, color: C.amber }}>
              {sel.licenseGated
                ? `🔒 ${sel.label} requires: (1) accept the model license on HuggingFace, then (2) paste your HF token below.`
                : `🔑 ${sel.label} needs a free HuggingFace read token — no license to accept. Get one free at huggingface.co/settings/tokens`
              }
            </div>
          )}

          {/* HuggingFace token — only shown if a model requires it */}
          {sel.requiresToken && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 11, color: C.t2, fontWeight: 600, letterSpacing: "0.04em" }}>
                HUGGINGFACE TOKEN
              </label>
              <input
                type="password"
                placeholder="hf_xxxxxxxxxxxxxxxxxxxx"
                value={hfToken}
                onChange={e => onTokenChange(e.target.value)}
                style={{
                  background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8,
                  padding: "8px 12px", color: C.t1, fontSize: 13, outline: "none",
                  fontFamily: "monospace",
                }}
              />
              <div style={{ fontSize: 11, color: C.t3 }}>
                Get a free token at huggingface.co/settings/tokens — also accept each model&apos;s license there first.
              </div>
            </div>
          )}

          {/* Info box */}
          <div style={{ padding: "11px 14px", background: "rgba(59,130,246,0.06)", borderRadius: 10, border: "1px solid rgba(59,130,246,0.18)", fontSize: 12, color: C.t2, lineHeight: 1.65 }}>
            <strong style={{ color: C.blue }}>How it works:</strong> Files download once from HuggingFace to your device's local storage. After that, the model runs <strong style={{ color: C.t1 }}>100% offline</strong> — no internet needed, no data sent anywhere.
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8 }}>
            {(state.status === "not-downloaded" || state.status === "error") && (
              <Btn onClick={() => canDownload && onDownload(selected)} disabled={!canDownload} style={{
                flex: 1, padding: "11px", background: canDownload ? C.blue : C.bgCard,
                border: "none", borderRadius: 9, color: canDownload ? "#fff" : C.t3,
                fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
              }}>
                <Icon d={IC.dl} size={14} stroke={canDownload ? "#fff" : C.t3} />
                Download {sel.label}
              </Btn>
            )}

            {state.status === "downloading" && (
              <div style={{ flex: 1, padding: "11px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 9, color: C.amber, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <Spinner /> Downloading…
              </div>
            )}

            {state.status === "loading-into-memory" && (
              <div style={{ flex: 1, padding: "11px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 9, color: C.amber, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <Spinner /> Connecting…
              </div>
            )}

            {(state.status === "downloaded" || state.status === "loaded" || state.status === "load-error") && (
              <>
                {state.status === "loaded" ? (
                  <div style={{ flex: 1, padding: "11px", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 9, color: C.green, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
                    ✓ Connected
                  </div>
                ) : (
                  <Btn onClick={() => onLoad(selected)} style={{
                    flex: 1, padding: "11px", background: C.blue, border: "none",
                    borderRadius: 9, color: "#fff", fontSize: 13, fontWeight: 600,
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                  }}>
                    {state.status === "load-error" ? "Retry Connect" : "Connect"}
                  </Btn>
                )}
                <Btn onClick={() => onDelete(selected)} style={{
                  padding: "11px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
                  borderRadius: 9, color: C.red, fontSize: 13, display: "flex", alignItems: "center",
                }}>
                  <Icon d={IC.trash} size={14} />
                </Btn>
              </>
            )}
          </div>

          {/* Error from download OR load failure */}
          {state.error && (
            <div style={{ padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, fontSize: 12, color: C.red }}>
              <strong>Error:</strong> {state.error}
              {state.error.includes("llama-server crashed") && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ color: C.amber, marginBottom: 8 }}>
                    ⚠️ The server binary may be incompatible with your CPU. Click below to re-download a compatible version (no-AVX build):
                  </div>
                  <Btn onClick={onResetServer} style={{
                    padding: "8px 14px", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.35)",
                    borderRadius: 8, color: C.amber, fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6,
                  }}>
                    <Icon d={IC.refresh} size={13} stroke={C.amber} /> Reset Server &amp; Re-download
                  </Btn>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Connector Modal ──────────────────────────────────────────────────────────
// Icon + accent colour per source type
const SOURCE_TYPES = [
  { t: "folder", label: "Folder",  icon: IC.folder, color: "#38bdf8" },
  { t: "file",   label: "TXT/MD",  icon: IC.file,   color: "#38bdf8" },
  { t: "excel",  label: "Excel",   icon: IC.table,  color: "#22c55e" },
  { t: "pdf",    label: "PDF",     icon: IC.pdf,    color: "#f87171" },
  { t: "docx",   label: "Word",    icon: IC.docx,   color: "#60a5fa" },
  { t: "pubmed", label: "PubMed",  icon: IC.flask,  color: "#a78bfa" },
];
function srcIcon(type) {
  const s = SOURCE_TYPES.find(x => x.t === type);
  return s ? { d: s.icon, color: s.color } : { d: IC.file, color: "#38bdf8" };
}

function ConnectorModal({ connectors, onAdd, onRemove, onClose }) {
  const [adding, setAdding]         = useState(null);
  const [status, setStatus]         = useState("");
  const [pubmedQuery, setPubmedQuery] = useState("");
  const [searching, setSearching]   = useState(false);

  const done = (msg) => {
    setStatus(msg);
    setTimeout(() => { setStatus(""); setAdding(null); }, 1800);
  };

  // ── File / folder pickers ─────────────────────────────────────────────────
  const pickPath = async (type) => {
    try {
      setStatus("Opening picker…");
      let result, text = "", name = "";

      if (type === "folder") {
        result = await open({ directory: true, multiple: false, title: "Select a research folder" });
        if (!result) { setStatus(""); return; }
        setStatus("Indexing…");
        name = result.split(/[\\/]/).pop();
        try {
          const entries = await readDir(result);
          const files = entries.filter(e => /\.(txt|md|csv)$/i.test(e.name));
          const texts = await Promise.all(files.slice(0, 20).map(e => readTextFile(result + "/" + e.name).catch(() => "")));
          text = texts.join("\n\n");
          name = `${name} (${files.length} files)`;
        } catch { text = ""; }
        const chunks = text ? chunkText(text) : [];
        onAdd({ id: Date.now(), name, path: result, type, chunks, sync: "Indexed" });
        done(`✓ ${chunks.length} chunks indexed`);

      } else if (type === "excel") {
        result = await open({ multiple: false, title: "Select an Excel file", filters: [{ name: "Excel", extensions: ["xlsx", "xls", "xlsm"] }] });
        if (!result) { setStatus(""); return; }
        setStatus("Reading Excel sheets…");
        name = result.split(/[\\/]/).pop();
        let excelChunks = [];
        try {
          const data = await invoke("read_excel_sheets", { path: result });
          for (const sheet of data.sheets) {
            const rows = sheet.rows;
            if (!rows.length) continue;

            // Column-based chunking: ONE chunk per period/column.
            // Format: "[Sheet: P&L | Period: Mar-23]\nRevenue for Mar-23: 300\n..."
            // This eliminates wrong-column confusion — the model sees only ONE
            // period's values per chunk, so it cannot accidentally pick Mar-22
            // when asked about Mar-23.
            const headerRow = rows[0];
            const colHeaders = headerRow.map((h, i) => (h && h.toString().trim()) ? h.toString().trim() : `Col${i + 1}`);
            const dataRows = rows.slice(1).filter(r => (r[0] || "").toString().trim()); // skip blank label rows

            for (let colIdx = 1; colIdx < colHeaders.length; colIdx++) {
              const period = colHeaders[colIdx];
              if (!period || period.startsWith("Col")) continue; // skip unnamed columns
              const lines = [`[Sheet: ${sheet.name} | Period: ${period}]`];
              for (const row of dataRows) {
                const label = (row[0] || "").toString().trim();
                const val = row[colIdx];
                const v = (val !== null && val !== undefined) ? val.toString().trim() : "";
                if (v) lines.push(`${label} for ${period}: ${v}`);
              }
              if (lines.length > 1) excelChunks.push(lines.join("\n"));
            }
          }
          name = `${name} (${data.sheets.length} sheet${data.sheets.length !== 1 ? "s" : ""})`;
        } catch (e) { setStatus("Error reading Excel: " + String(e)); return; }
        onAdd({ id: Date.now(), name, path: result, type: "excel", chunks: excelChunks, sync: "Indexed" });
        done(`✓ ${excelChunks.length} chunks indexed`);

      } else if (type === "pdf") {
        result = await open({ multiple: false, title: "Select a PDF file", filters: [{ name: "PDF", extensions: ["pdf"] }] });
        if (!result) { setStatus(""); return; }
        setStatus("Extracting PDF text…");
        name = result.split(/[\\/]/).pop();
        try {
          text = await invoke("read_pdf", { path: result });
        } catch (e) { setStatus("Error reading PDF: " + String(e)); return; }
        const chunks = text ? chunkText(text) : [];
        onAdd({ id: Date.now(), name, path: result, type: "pdf", chunks, sync: "Indexed" });
        done(`✓ ${chunks.length} chunks indexed`);

      } else if (type === "docx") {
        result = await open({ multiple: false, title: "Select a Word document", filters: [{ name: "Word Document", extensions: ["docx"] }] });
        if (!result) { setStatus(""); return; }
        setStatus("Extracting Word text…");
        name = result.split(/[\\/]/).pop();
        try {
          text = await invoke("read_docx", { path: result });
        } catch (e) { setStatus("Error reading Word file: " + String(e)); return; }
        const chunks = text ? chunkText(text) : [];
        onAdd({ id: Date.now(), name, path: result, type: "docx", chunks, sync: "Indexed" });
        done(`✓ ${chunks.length} chunks indexed`);

      } else {
        // Plain text / markdown / CSV
        result = await open({ multiple: false, title: "Select a file", filters: [{ name: "Documents", extensions: ["txt", "md", "csv"] }] });
        if (!result) { setStatus(""); return; }
        setStatus("Indexing…");
        name = result.split(/[\\/]/).pop();
        try { text = await readTextFile(result); } catch { text = ""; }
        const chunks = text ? chunkText(text) : [];
        onAdd({ id: Date.now(), name, path: result, type, chunks, sync: "Indexed" });
        done(`✓ ${chunks.length} chunks indexed`);
      }
    } catch (e) { setStatus("Error: " + String(e)); }
  };

  // ── PubMed search ─────────────────────────────────────────────────────────
  const runPubmedSearch = async () => {
    if (!pubmedQuery.trim()) return;
    setSearching(true);
    setStatus("Searching PubMed…");
    try {
      const text = await invoke("pubmed_search", { query: pubmedQuery.trim(), maxResults: 5 });
      const chunks = chunkText(text, 250);
      const name = `PubMed: "${pubmedQuery.trim().slice(0, 40)}"`;
      onAdd({ id: Date.now(), name, path: "pubmed", type: "pubmed", chunks, sync: "Fetched" });
      setPubmedQuery("");
      done(`✓ ${chunks.length} abstract chunks indexed`);
    } catch (e) {
      setStatus("PubMed error: " + String(e));
    } finally {
      setSearching(false);
    }
  };

  const isPubmed = adding === "pubmed";
  const { d: addIcon, color: addColor } = srcIcon(adding);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(6px)" }}>
      <div style={{ width: 540, maxHeight: "82vh", background: C.bgPanel, border: `1px solid ${C.border}`, borderRadius: 18, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 30px 80px rgba(0,0,0,0.6)" }}>

        {/* Header */}
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.t1 }}>Research Sources</div>
            <div style={{ fontSize: 12, color: C.t2, marginTop: 2 }}>Connect documents & databases for AI context — stays on your device</div>
          </div>
          <Btn onClick={onClose} style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, color: C.t2, padding: "6px 8px", display: "flex" }}>
            <Icon d={IC.x} size={15} />
          </Btn>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 22 }}>

          {/* Connected sources list */}
          {connectors.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: C.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Connected</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 22 }}>
                {connectors.map(c => {
                  const { d, color } = srcIcon(c.type);
                  return (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 10 }}>
                      <Icon d={d} size={16} stroke={color} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: C.t1, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                        <div style={{ fontSize: 11, color: C.t3 }}>{c.chunks?.length || 0} chunks · {c.sync}</div>
                      </div>
                      <Btn onClick={() => onRemove(c.id)} style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, color: C.red, padding: "5px 8px", display: "flex" }}>
                        <Icon d={IC.trash} size={13} />
                      </Btn>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Source type buttons — 2 rows of 3 */}
          <div style={{ fontSize: 10, color: C.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Add Source</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
            {SOURCE_TYPES.map(({ t, label, icon, color }) => (
              <Btn key={t} onClick={() => { setAdding(t); setStatus(""); }} style={{
                padding: "13px 8px",
                background: adding === t ? `${color}18` : C.bgCard,
                border: `1px solid ${adding === t ? color + "55" : C.border}`,
                borderRadius: 10, color: adding === t ? color : C.t2, fontSize: 12,
                display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                transition: "all 0.15s",
              }}>
                <Icon d={icon} size={18} stroke={adding === t ? color : C.t3} />
                {label}
              </Btn>
            ))}
          </div>

          {/* Action panel */}
          {adding && (
            <div style={{ padding: 14, background: "rgba(59,130,246,0.07)", border: `1px solid ${addColor}33`, borderRadius: 10 }}>
              {status && (
                <div style={{ fontSize: 12, color: status.startsWith("✓") ? C.green : status.startsWith("Error") ? C.red : C.cyan, marginBottom: 10 }}>
                  {status}
                </div>
              )}

              {isPubmed ? (
                /* PubMed search UI */
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 12, color: C.t2, marginBottom: 2 }}>
                    Search PubMed/NCBI (top 5 papers, requires internet)
                  </div>
                  <input
                    value={pubmedQuery}
                    onChange={e => setPubmedQuery(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && runPubmedSearch()}
                    placeholder="e.g. ivermectin COVID-19 clinical trial"
                    style={{
                      background: C.bgCard, border: `1px solid ${C.borderHi}`, borderRadius: 8,
                      color: C.t1, fontSize: 13, padding: "9px 12px", outline: "none", width: "100%", boxSizing: "border-box",
                    }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <Btn onClick={runPubmedSearch} disabled={searching || !pubmedQuery.trim()} style={{
                      flex: 1, padding: "9px", background: "#a855f7", border: "none",
                      borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 600,
                      opacity: (searching || !pubmedQuery.trim()) ? 0.5 : 1,
                    }}>
                      {searching ? "Searching…" : "Search PubMed"}
                    </Btn>
                    <Btn onClick={() => { setAdding(null); setStatus(""); setPubmedQuery(""); }} style={{ padding: "9px 14px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, color: C.t2, fontSize: 13 }}>
                      Cancel
                    </Btn>
                  </div>
                </div>
              ) : (
                /* File / folder picker UI */
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn onClick={() => pickPath(adding)} style={{ flex: 1, padding: "9px", background: C.blue, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 600 }}>
                    {adding === "folder" ? "Browse Folder…" : `Browse ${SOURCE_TYPES.find(s => s.t === adding)?.label || "File"}…`}
                  </Btn>
                  <Btn onClick={() => { setAdding(null); setStatus(""); }} style={{ padding: "9px 14px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, color: C.t2, fontSize: 13 }}>
                    Cancel
                  </Btn>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Chat bubble ──────────────────────────────────────────────────────────────
function Bubble({ msg }) {
  const isAI = msg.role === "ai";
  const [cp, setCp] = useState(false);
  const copy = () => { navigator.clipboard.writeText(msg.text); setCp(true); setTimeout(() => setCp(false), 2000); };

  // Render inline markdown: **bold**, *italic*, `code`
  const renderInline = (text) => {
    if (!text) return null;
    const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
    return parts.map((p, i) => {
      if (p.startsWith("**") && p.endsWith("**") && p.length > 4)
        return <strong key={i} style={{ color: C.t1, fontWeight: 600 }}>{p.slice(2, -2)}</strong>;
      if (p.startsWith("*") && p.endsWith("*") && p.length > 2)
        return <em key={i} style={{ color: C.t1, fontStyle: "italic" }}>{p.slice(1, -1)}</em>;
      if (p.startsWith("`") && p.endsWith("`") && p.length > 2)
        return <code key={i} style={{ background: "rgba(0,0,0,0.4)", padding: "1px 5px", borderRadius: 4, fontSize: 11.5, color: "#e2e8f0", fontFamily: "monospace" }}>{p.slice(1, -1)}</code>;
      return <span key={i}>{p}</span>;
    });
  };

  const renderText = (t) => {
    if (!t) return null;
    const lines = t.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // ── Fenced code block ───────────────────────────────
      if (line.startsWith("```")) {
        let code = "";
        i++;
        while (i < lines.length && !lines[i].startsWith("```")) { code += lines[i] + "\n"; i++; }
        out.push(
          <pre key={i} style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "10px 14px", overflowX: "auto", fontSize: 12, lineHeight: 1.6, color: "#e2e8f0", margin: "6px 0", fontFamily: "monospace", whiteSpace: "pre" }}>
            <code>{code.trimEnd()}</code>
          </pre>
        );
        i++; continue;
      }

      // ── Headings ────────────────────────────────────────
      const hm = line.match(/^(#{1,4})\s+(.*)/);
      if (hm) {
        const lvl = hm[1].length;
        const sz = [17, 15, 14, 13][lvl - 1];
        out.push(<div key={i} style={{ fontSize: sz, fontWeight: 700, color: C.t1, marginTop: lvl <= 2 ? 16 : 12, marginBottom: 5, borderBottom: lvl === 1 ? `1px solid ${C.border}` : "none", paddingBottom: lvl === 1 ? 5 : 0 }}>{renderInline(hm[2])}</div>);
        i++; continue;
      }

      // ── Horizontal rule ─────────────────────────────────
      if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
        out.push(<hr key={i} style={{ border: "none", borderTop: `1px solid ${C.border}`, margin: "10px 0" }} />);
        i++; continue;
      }

      // ── Bullet list ─────────────────────────────────────
      if (/^[\-\*\•]\s+/.test(line)) {
        out.push(
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 3, alignItems: "flex-start" }}>
            <span style={{ color: C.cyan, flexShrink: 0, marginTop: 1, fontSize: 14 }}>•</span>
            <span style={{ flex: 1 }}>{renderInline(line.replace(/^[\-\*\•]\s+/, ""))}</span>
          </div>
        );
        i++; continue;
      }

      // ── Numbered list ───────────────────────────────────
      const nm = line.match(/^(\d+)\.\s+(.*)/);
      if (nm) {
        out.push(
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 3, alignItems: "flex-start" }}>
            <span style={{ color: C.cyan, flexShrink: 0, fontWeight: 600, minWidth: 18, textAlign: "right" }}>{nm[1]}.</span>
            <span style={{ flex: 1 }}>{renderInline(nm[2])}</span>
          </div>
        );
        i++; continue;
      }

      // ── Blockquote ──────────────────────────────────────
      if (line.startsWith("> ")) {
        out.push(
          <div key={i} style={{ borderLeft: `3px solid ${C.cyan}`, paddingLeft: 12, marginLeft: 4, color: C.t2, fontStyle: "italic", margin: "4px 0 4px 4px" }}>
            {renderInline(line.slice(2))}
          </div>
        );
        i++; continue;
      }

      // ── Empty line ──────────────────────────────────────
      if (line.trim() === "") {
        out.push(<div key={i} style={{ height: 5 }} />);
        i++; continue;
      }

      // ── Regular paragraph ───────────────────────────────
      out.push(<div key={i} style={{ marginBottom: 2 }}>{renderInline(line)}</div>);
      i++;
    }
    return out;
  };

  return (
    <div style={{ display: "flex", flexDirection: isAI ? "row" : "row-reverse", gap: 10, marginBottom: 18, alignItems: "flex-start", animation: "oai-slide 0.22s ease" }}>
      {isAI && (
        <div style={{ width: 30, height: 30, borderRadius: "50%", background: `linear-gradient(135deg,${C.blueD},${C.cyan})`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon d={IC.brain} size={13} stroke="#fff" />
        </div>
      )}
      <div style={{ maxWidth: "78%", display: "flex", flexDirection: "column", gap: 5 }}>
        {isAI && msg.calc && <CalcCard calc={msg.calc} />}
        <div style={{
          padding: "11px 15px",
          borderRadius: isAI ? "4px 14px 14px 14px" : "14px 4px 14px 14px",
          background: isAI ? "rgba(59,130,246,0.09)" : C.bgCard,
          border: `1px solid ${isAI ? "rgba(59,130,246,0.2)" : C.border}`,
          fontSize: 13.5, lineHeight: 1.75, color: C.t2,
        }}>
          {renderText(msg.text)}
          {msg.streaming && <span style={{ display: "inline-block", width: 8, height: 14, background: C.cyan, marginLeft: 3, borderRadius: 2, animation: "oai-pulse 0.8s ease infinite" }} />}
        </div>
        {isAI && msg.sources?.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {msg.sources.map((s, i) => (
              <span key={i} style={{ fontSize: 10.5, padding: "2px 9px", background: "rgba(56,189,248,0.07)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 20, color: C.cyan }}>
                📄 {s}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: C.t3 }}>{msg.time}</span>
          {isAI && (
            <button onClick={copy} style={{ background: "none", border: "none", cursor: "pointer", color: C.t3, display: "flex", alignItems: "center", gap: 3, fontSize: 10, fontFamily: "inherit" }}>
              <Icon d={cp ? IC.check : IC.copy} size={9} />{cp ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Typing indicator ─────────────────────────────────────────────────────────
function Typing() {
  return (
    <div style={{ display: "flex", gap: 12, marginBottom: 20, alignItems: "flex-start" }}>
      <div style={{ width: 30, height: 30, borderRadius: "50%", background: `linear-gradient(135deg,${C.blueD},${C.cyan})`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon d={IC.brain} size={13} stroke="#fff" />
      </div>
      <div style={{ padding: "12px 16px", background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.2)", borderRadius: "4px 14px 14px 14px", display: "flex", alignItems: "center", gap: 5 }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: C.cyan, animation: "oai-bounce 1.2s ease infinite", animationDelay: `${i * 0.2}s` }} />
        ))}
        <span style={{ fontSize: 12, color: C.t2, marginLeft: 4 }}>Thinking…</span>
      </div>
    </div>
  );
}

// ─── Extension Hub Panel (desktop only) ───────────────────────────────────────
// Shows connected VS Code / Cursor editors as separate subhubs with AI chat.
// trialDaysLeft: number (≥1 = trial active, 0 = expired, null = not started yet)
function HubPanel({ hubClients, activeHubId, setActiveHubId, hubStreaming, onSendHub, onApply, activeModelId, trialDaysLeft }) {
  const [hubInput, setHubInput] = useState("");
  const hubInputRef = useRef(null);
  const hubBottomRef = useRef(null);

  const clientList = Object.values(hubClients);
  const active = hubClients[activeHubId] || clientList[0] || null;

  useEffect(() => {
    hubBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages, activeHubId]);

  // Editor badge colour
  const editorColor = (editor) => {
    if (editor === "cursor") return C.purple;
    if (editor === "windsurf") return C.green;
    return C.blue; // vscode
  };

  const editorLabel = (editor) => {
    if (editor === "cursor")   return "Cursor";
    if (editor === "windsurf") return "Windsurf";
    return "VS Code";
  };

  const sendHub = () => {
    const text = hubInput.trim();
    if (!text || !active || hubStreaming) return;
    onSendHub(active.id, text);
    setHubInput("");
    hubInputRef.current?.focus();
  };

  // ── Trial expired: show locked screen ─────────────────────────────────────
  if (trialDaysLeft !== null && trialDaysLeft <= 0) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 20, padding: 40 }}>
        <div style={{ width: 64, height: 64, borderRadius: 20, background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width={30} height={30} viewBox="0 0 24 24" fill="none" stroke={C.purple} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div style={{ textAlign: "center", maxWidth: 380 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.t1, marginBottom: 8 }}>Trial Ended</div>
          <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.7 }}>
            Your <strong style={{ color: C.purple }}>5-day free trial</strong> of Extension Hub has ended.<br />
            Contact our team to unlock full access and continue using Hub with your VS Code / Cursor editors.
          </div>
        </div>
        <a href={`mailto:${HUB_CONTACT_MAIL}?subject=Codeforge AI Hub Access&body=Hi, I would like to get full access to Extension Hub.`}
          style={{ padding: "11px 28px", background: `linear-gradient(135deg,${C.blueD},${C.purple})`, borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 700, textDecoration: "none", letterSpacing: "0.02em" }}>
          Contact Our Team
        </a>
        <div style={{ fontSize: 11, color: C.t3 }}>{HUB_CONTACT_MAIL}</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* ── Trial countdown banner ── */}
      {trialDaysLeft !== null && trialDaysLeft > 0 && (
        <div style={{ padding: "8px 18px", background: "rgba(168,85,247,0.08)", borderBottom: `1px solid rgba(168,85,247,0.2)`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, color: C.purple }}>
            🧪 <strong>Free Trial</strong> — <strong>{trialDaysLeft}</strong> day{trialDaysLeft !== 1 ? "s" : ""} remaining
          </span>
          <a href={`mailto:${HUB_CONTACT_MAIL}?subject=Codeforge AI Hub Access`}
            style={{ fontSize: 11, color: C.purple, textDecoration: "none", padding: "3px 10px", border: `1px solid rgba(168,85,247,0.4)`, borderRadius: 6 }}>
            Get Full Access
          </a>
        </div>
      )}

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

      {/* ── Left panel: editor list ── */}
      <div style={{ width: 200, background: C.bgPanel, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "16px 14px 10px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.t1, letterSpacing: "0.06em", textTransform: "uppercase" }}>Connected Editors</div>
          <div style={{ fontSize: 10, color: C.t3, marginTop: 3 }}>ws://127.0.0.1:7471</div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
          {clientList.length === 0 ? (
            <div style={{ padding: "12px 10px", fontSize: 11, color: C.t3, lineHeight: 1.6 }}>
              No editors connected.<br />Install the Codeforge AI extension in VS Code or Cursor to get started.
            </div>
          ) : (
            clientList.map(c => {
              const isActive = c.id === (active?.id);
              const ec = editorColor(c.editor);
              return (
                <div key={c.id} onClick={() => setActiveHubId(c.id)} style={{
                  padding: "10px 10px", borderRadius: 8, cursor: "pointer", marginBottom: 3,
                  background: isActive ? `${ec}18` : "transparent",
                  border: `1px solid ${isActive ? ec + "55" : "transparent"}`,
                  transition: "all 0.15s",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: ec, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: isActive ? C.t1 : C.t2 }}>{editorLabel(c.editor)}</div>
                      <div style={{ fontSize: 10, color: C.t3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                        {c.file ? c.file.split(/[\\/]/).pop() : "No file open"}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Install hint */}
        <div style={{ padding: "10px 12px", borderTop: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 10, color: C.t3, lineHeight: 1.5 }}>
            💡 Install the <strong style={{ color: C.t2 }}>Codeforge AI Hub</strong> extension in VS Code or Cursor, then open any file to connect.
          </div>
        </div>
      </div>

      {/* ── Right panel: subhub chat ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {!active ? (
          /* Empty state */
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 40 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: `linear-gradient(135deg,${C.blueD},${C.purple})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon d={IC.hub} size={26} stroke="#fff" />
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.t1, marginBottom: 8 }}>Extension Hub</div>
              <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.7, maxWidth: 340 }}>
                Connect VS Code, Cursor, or any VS Code-compatible editor to chat with AI in context of your open files.
              </div>
            </div>
            <div style={{ padding: "14px 18px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 12, fontSize: 12, color: C.t2, lineHeight: 1.7, maxWidth: 380 }}>
              <div style={{ fontWeight: 600, color: C.t1, marginBottom: 6 }}>How to connect:</div>
              <div>1. Install the <strong style={{ color: C.cyan }}>Codeforge AI Hub</strong> extension from the <code style={{ background: C.bgDeep, padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>vscode-extension/</code> folder</div>
              <div style={{ marginTop: 4 }}>2. Open any file in VS Code or Cursor</div>
              <div style={{ marginTop: 4 }}>3. The editor connects automatically — it appears here</div>
              <div style={{ marginTop: 8, padding: "6px 10px", background: C.bgDeep, borderRadius: 7, fontFamily: "monospace", fontSize: 11, color: C.cyan }}>ws://127.0.0.1:7471</div>
            </div>
          </div>
        ) : (
          <>
            {/* Subhub header — file context */}
            <div style={{ padding: "12px 20px", borderBottom: `1px solid ${C.border}`, background: C.bgPanel }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: editorColor(active.editor) }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>
                    {editorLabel(active.editor)}
                    {active.file && (
                      <span style={{ fontWeight: 400, color: C.t2, marginLeft: 8, fontSize: 12 }}>
                        {active.file.split(/[\\/]/).pop()}
                      </span>
                    )}
                  </div>
                  {active.language && (
                    <div style={{ fontSize: 10, color: C.t3, marginTop: 1 }}>
                      {active.language}{active.cursorLine ? ` · Line ${active.cursorLine}` : ""}
                      {active.file && <span style={{ marginLeft: 6 }}>{active.file}</span>}
                    </div>
                  )}
                </div>
              </div>

              {/* Selected code preview */}
              {active.selectedCode && (
                <div style={{ marginTop: 10, padding: "8px 12px", background: C.bgDeep, border: `1px solid ${C.border}`, borderRadius: 8, fontFamily: "monospace", fontSize: 11, color: C.cyan, maxHeight: 80, overflow: "hidden", position: "relative" }}>
                  <div style={{ fontSize: 9, color: C.t3, marginBottom: 4, fontFamily: "inherit" }}>SELECTED CODE</div>
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{active.selectedCode.slice(0, 200)}{active.selectedCode.length > 200 ? "…" : ""}</div>
                </div>
              )}
            </div>

            {/* Chat messages */}
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
              {(!active.messages || active.messages.length === 0) && (
                <div style={{ fontSize: 12, color: C.t3, textAlign: "center", marginTop: 40 }}>
                  {active.selectedCode
                    ? `Ask anything about the selected ${active.language || "code"}…`
                    : `Ask anything about ${active.file ? active.file.split(/[\\/]/).pop() : "this editor"}…`}
                </div>
              )}
              {(active.messages || []).map(msg => (
                <div key={msg.id} style={{ display: "flex", flexDirection: msg.role === "ai" ? "row" : "row-reverse", gap: 8, marginBottom: 14, alignItems: "flex-start", animation: "oai-slide 0.2s ease" }}>
                  {msg.role === "ai" && (
                    <div style={{ width: 26, height: 26, borderRadius: "50%", background: `linear-gradient(135deg,${C.blueD},${C.purple})`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Icon d={IC.brain} size={12} stroke="#fff" />
                    </div>
                  )}
                  <div style={{ maxWidth: "82%", display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{
                      padding: "10px 14px",
                      borderRadius: msg.role === "ai" ? "4px 12px 12px 12px" : "12px 4px 12px 12px",
                      background: msg.role === "ai" ? "rgba(168,85,247,0.09)" : C.bgCard,
                      border: `1px solid ${msg.role === "ai" ? "rgba(168,85,247,0.2)" : C.border}`,
                      fontSize: 13, lineHeight: 1.7, color: C.t2, whiteSpace: "pre-wrap", wordBreak: "break-word",
                    }}>
                      {msg.text}
                      {msg.streaming && <span style={{ display: "inline-block", width: 7, height: 13, background: C.purple, marginLeft: 3, borderRadius: 2, animation: "oai-pulse 0.8s ease infinite" }} />}
                    </div>
                    {/* Apply to editor button — only on non-streaming AI messages with code */}
                    {msg.role === "ai" && !msg.streaming && msg.text.includes("```") && (
                      <Btn onClick={() => onApply(active.id, msg.text)} style={{
                        alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 5,
                        padding: "4px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600,
                        background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.3)", color: C.purple,
                      }}>
                        <Icon d={IC.apply} size={11} stroke={C.purple} /> Apply to Editor
                      </Btn>
                    )}
                    <span style={{ fontSize: 10, color: C.t3 }}>{msg.time}</span>
                  </div>
                </div>
              ))}
              <div ref={hubBottomRef} />
            </div>

            {/* Hub input */}
            <div style={{ padding: "10px 16px 14px", background: C.bgPanel, borderTop: `1px solid ${C.border}` }}>
              {!activeModelId && (
                <div style={{ fontSize: 11, color: C.amber, marginBottom: 6 }}>⚠️ Load a model first to chat in the Hub.</div>
              )}
              <div style={{ display: "flex", alignItems: "flex-end", gap: 8, padding: "8px 12px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 12 }}>
                <textarea
                  ref={hubInputRef}
                  value={hubInput}
                  onChange={e => setHubInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendHub(); } }}
                  placeholder={active.selectedCode ? `Ask about selected ${active.language || "code"}…` : "Ask about this file…"}
                  rows={1}
                  style={{ flex: 1, background: "none", border: "none", color: C.t1, fontSize: 13, lineHeight: 1.6, maxHeight: 100, overflowY: "auto", fontFamily: "inherit" }}
                />
                <Btn onClick={sendHub} disabled={!hubInput.trim() || !activeModelId || hubStreaming} style={{
                  width: 32, height: 32, borderRadius: 8, border: "none", flexShrink: 0,
                  background: hubInput.trim() && activeModelId && !hubStreaming ? C.purple : C.bgPanel,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: hubInput.trim() && activeModelId && !hubStreaming ? "#fff" : C.t3,
                }}>
                  <Icon d={IC.send} size={14} />
                </Btn>
              </div>
              <div style={{ marginTop: 5, fontSize: 10, color: C.t3 }}>
                AI sees your selected code + file context · Desktop only
              </div>
            </div>
          </>
        )}
      </div>
    </div>
    </div>
  );
}

// ─── Initial chats ────────────────────────────────────────────────────────────
const INIT_CHATS = [{
  id: 1, title: "Welcome", date: "Today",
  messages: [{
    id: 1, role: "ai",
    text: "Hello! I'm Codeforge AI — a research assistant running 100% on your device.\n\nYour documents and data never leave this machine.\n\nTo get started:\n1. Click **Models** in the sidebar\n2. Download a model — **no account or token needed for any model!**\n   • **Qwen2.5 0.5B** — fastest, ~397 MB (recommended)\n   • **Qwen2.5 1.5B** — better quality, ~986 MB\n   • **Phi-3.5 Mini** — excellent reasoning, ~2.4 GB\n   • **Gemma 2 2B** — fast & efficient, ~1.7 GB\n3. Model connects automatically after download — ready to chat!\n4. Connect research papers or documents via **Sources**\n5. Ask anything — the AI will use your documents as context",
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  }],
}];

const quickPrompts = [
  "Summarize the key findings",
  "What are the main conclusions?",
  "List the research methodology",
  "Find contradictions in the data",
  "Explain this in simple terms",
];

// ─── Login Page ───────────────────────────────────────────────────────────────
function LoginPage() {
  // Incrementing signInKey force-remounts <SignIn />, resetting it to the
  // first screen — this is the "back" button when stuck in Google/OAuth flow.
  const [signInKey, setSignInKey]   = useState(0);
  const [inSubFlow, setInSubFlow]   = useState(false);
  const handleReset = () => { setSignInKey(k => k + 1); setInSubFlow(false); };

  const appearance = {
    variables: {
      colorPrimary: C.blue, colorBackground: C.bgPanel,
      colorText: C.t1, colorTextSecondary: C.t2,
      colorInputBackground: C.bgCard, colorInputText: C.t1,
      borderRadius: "12px", fontFamily: "inherit",
    },
    elements: {
      card: { boxShadow: "0 30px 80px rgba(0,0,0,0.6)", border: `1px solid ${C.border}` },
      headerTitle: { color: C.t1 }, headerSubtitle: { color: C.t2 },
      socialButtonsBlockButton: { background: C.bgCard, border: `1px solid ${C.border}`, color: C.t1 },
      dividerLine: { background: C.border }, dividerText: { color: C.t3 },
      formFieldInput: { background: C.bgCard, borderColor: C.border, color: C.t1 },
      formButtonPrimary: { background: C.blue }, footerAction: { color: C.t3 },
    },
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: C.bgDeep, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 28 }}>
      {/* Logo */}
      <div style={{ textAlign: "center" }}>
        <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 62, height: 62, borderRadius: 18, background: `linear-gradient(135deg,${C.blueD},${C.cyan})`, marginBottom: 16 }}>
          <Icon d={IC.brain} size={30} stroke="#fff" />
        </div>
        <div style={{ fontSize: 26, fontWeight: 800, color: C.t1, letterSpacing: "-0.03em" }}>Codeforge AI</div>
        <div style={{ fontSize: 13, color: C.t2, marginTop: 4 }}>Research AI — runs 100% on your device</div>
      </div>

      {/* Back button — visible once user has clicked into a sub-flow (Google, etc.) */}
      {inSubFlow && (
        <button onClick={handleReset} style={{
          display: "flex", alignItems: "center", gap: 6, background: "none",
          border: `1px solid ${C.border}`, borderRadius: 8, color: C.t2,
          fontSize: 13, padding: "7px 16px", cursor: "pointer", fontFamily: "inherit",
        }}>
          ← Back to sign in
        </button>
      )}

      {/* Clerk SignIn — key forces full remount on reset; click sets inSubFlow */}
      <div onClick={() => setInSubFlow(true)} style={{ display: "contents" }}>
        <SignIn key={signInKey} routing="virtual" appearance={appearance} />
      </div>

      {/* Fallback reset link always visible */}
      <div style={{ fontSize: 11, color: C.t3, textAlign: "center" }}>
        Stuck on a screen?{" "}
        <span onClick={handleReset} style={{ color: C.blue, cursor: "pointer", textDecoration: "underline" }}>
          Start over
        </span>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function OfflineAIApp() {
  const [chats, setChats] = useState(() => {
    try {
      const saved = localStorage.getItem("codeforge_chats");
      if (saved) { const parsed = JSON.parse(saved); if (parsed?.length) return parsed; }
    } catch {}
    return INIT_CHATS;
  });
  const [active, setActive] = useState(() => {
    try {
      const saved = localStorage.getItem("codeforge_chats");
      if (saved) { const parsed = JSON.parse(saved); if (parsed?.length) return parsed[0].id; }
    } catch {}
    return 1;
  });
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [showConn, setShowConn] = useState(false);
  const [showMod, setShowMod] = useState(false);
  const [connectors, setConnectors] = useState([]);
  const [sSearch, setSSearch] = useState("");
  const [contextMenu, setContextMenu] = useState(null); // null | { chatId, x, y }
  const [renamingId, setRenamingId] = useState(null);   // chatId being renamed
  const [renameVal, setRenameVal] = useState("");

  // modelState: { [modelId]: { status: "not-downloaded"|"downloading"|"downloaded"|"loaded"|"error", progress?, error? } }
  const [modelState, setModelState] = useState({});
  const [activeModelId, setActiveModelId] = useState(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [hfToken, setHfToken] = useState(() => localStorage.getItem("hf_token") || "");
  const [serverReady, setServerReady] = useState(null); // null=checking, true/false
  const [setupProgress, setSetupProgress] = useState(null); // null | { step, downloaded?, total? }
  const [selectedLang, setSelectedLang] = useState("auto"); // language selector
  const [autoDetectedLang, setAutoDetectedLang] = useState("en"); // tracks detected lang in Auto mode

  // ── Extension Hub state (desktop only) ────────────────────────────────────
  // hubClients: { [id]: { id, editor, file, language, selectedCode, cursorLine, messages: [] } }
  const [showHub, setShowHub] = useState(false);
  const [hubClients, setHubClients] = useState({});
  const [activeHubId, setActiveHubId] = useState(null);
  const [hubStreaming, setHubStreaming] = useState(false);
  const hubStreamBufRef  = useRef("");
  const hubStreamMsgRef  = useRef(null);   // { clientId, msgId }
  // Detect desktop once at mount — Hub is hidden on mobile
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    setIsDesktop(!/android|iphone|ipad|ipod/.test(ua));
  }, []);

  // ── Hub trial ─────────────────────────────────────────────────────────────
  // trialDaysLeft: null = trial not started yet, ≥1 = active, 0 = expired
  const getTrialDaysLeft = () => {
    const start = localStorage.getItem(HUB_TRIAL_KEY);
    if (!start) return null; // not started
    const elapsed = Date.now() - Number(start);
    const daysUsed = Math.floor(elapsed / (1000 * 60 * 60 * 24));
    return Math.max(0, HUB_TRIAL_DAYS - daysUsed);
  };
  const [trialDaysLeft, setTrialDaysLeft] = useState(getTrialDaysLeft);

  // ── Auto-update check ─────────────────────────────────────────────────────
  // updateAvailable: null (none) | { version, notes, url }
  const [updateAvailable, setUpdateAvailable] = useState(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);

  useEffect(() => {
    // Check for updates 4 seconds after launch (so app loads first).
    const timer = setTimeout(async () => {
      try {
        const info = await invoke("check_for_update", { url: UPDATE_CHECK_URL });
        // GitHub releases API uses tag_name (e.g. "v0.2.0") and html_url
        const latestVersion = (info?.tag_name || info?.version || "").replace(/^v/, "");
        if (latestVersion && latestVersion !== APP_VERSION) {
          setUpdateAvailable({
            version: latestVersion,
            notes: info.body || info.notes || "",
            url: info.html_url || info.url || "",
          });
        }
      } catch {
        // No internet or placeholder URL — silently ignore
      }
    }, 4000);
    return () => clearTimeout(timer);
  }, []);

  const activeRef           = useRef(active);   // stable ref for event listeners
  const bottomRef           = useRef(null);
  const inputRef            = useRef(null);
  const streamBufRef        = useRef("");
  const streamMsgIdRef      = useRef(null);
  const autoDetectedLangRef = useRef("en");     // ref so send() always sees latest without deps

  // Keep refs in sync
  useEffect(() => { activeRef.current = active; }, [active]);

  // Reset detected language whenever user switches to a different chat
  useEffect(() => {
    setAutoDetectedLang("en");
    autoDetectedLangRef.current = "en";
  }, [active]);

  // ── Extension Hub event listeners (desktop only) ─────────────────────────
  useEffect(() => {
    if (!isDesktop) return;
    const unsubs = [];

    listen("hub-client-connected", (ev) => {
      const c = ev.payload;
      setHubClients(prev => ({ ...prev, [c.id]: { ...c, messages: [] } }));
      setActiveHubId(id => id || c.id); // auto-select first connection
      // Start the 5-day trial on the very first editor connection
      if (!localStorage.getItem(HUB_TRIAL_KEY)) {
        localStorage.setItem(HUB_TRIAL_KEY, String(Date.now()));
        setTrialDaysLeft(HUB_TRIAL_DAYS);
      }
    }).then(fn => unsubs.push(fn));

    listen("hub-client-disconnected", (ev) => {
      const { id } = ev.payload;
      setHubClients(prev => { const next = { ...prev }; delete next[id]; return next; });
      setActiveHubId(prev => prev === id ? null : prev);
    }).then(fn => unsubs.push(fn));

    listen("hub-context-update", (ev) => {
      const c = ev.payload;
      setHubClients(prev => prev[c.id]
        ? { ...prev, [c.id]: { ...prev[c.id], file: c.file, language: c.language, selectedCode: c.selected_code, cursorLine: c.cursor_line } }
        : prev
      );
    }).then(fn => unsubs.push(fn));

    return () => unsubs.forEach(fn => fn?.());
  }, [isDesktop]);

  // ── Hub streaming token events ─────────────────────────────────────────────
  useEffect(() => {
    if (!isDesktop) return;
    const unsubs = [];

    listen("llm-token", (ev) => {
      if (!hubStreamMsgRef.current) return; // only intercept if hub is generating
      hubStreamBufRef.current += ev.payload;
      const { clientId, msgId } = hubStreamMsgRef.current;
      const buf = hubStreamBufRef.current;
      setHubClients(prev => {
        if (!prev[clientId]) return prev;
        return { ...prev, [clientId]: { ...prev[clientId], messages: prev[clientId].messages.map(m => m.id === msgId ? { ...m, text: buf, streaming: true } : m) } };
      });
    }).then(fn => unsubs.push(fn));

    listen("llm-done", () => {
      if (!hubStreamMsgRef.current) return;
      const { clientId, msgId } = hubStreamMsgRef.current;
      const finalText = hubStreamBufRef.current;
      setHubClients(prev => {
        if (!prev[clientId]) return prev;
        return { ...prev, [clientId]: { ...prev[clientId], messages: prev[clientId].messages.map(m => m.id === msgId ? { ...m, text: finalText, streaming: false } : m) } };
      });
      setHubStreaming(false);
      hubStreamBufRef.current = "";
      hubStreamMsgRef.current = null;
    }).then(fn => unsubs.push(fn));

    return () => unsubs.forEach(fn => fn?.());
  }, [isDesktop]);

  // ── Check if llama-server.exe is present ─────────────────────────────────
  useEffect(() => {
    invoke("is_server_ready").then(ready => setServerReady(ready)).catch(() => setServerReady(false));
  }, []);

  // ── Listen for setup progress events ─────────────────────────────────────
  useEffect(() => {
    let unlisten;
    listen("setup-progress", (event) => {
      setSetupProgress(event.payload);
      if (event.payload?.step === "done") {
        setServerReady(true);
        setSetupProgress(null);
      }
    }).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  // ── Setup llama-server ────────────────────────────────────────────────────
  const runSetup = async () => {
    setSetupProgress({ step: "starting" });
    try {
      await invoke("setup_llama_server");
      setServerReady(true);
    } catch (err) {
      setSetupProgress({ step: "error", message: String(err) });
    }
  };

  // ── On mount: check which models are already on disk ──────────────────────
  useEffect(() => {
    const check = async () => {
      const updates = {};
      for (const m of MODELS) {
        const onDisk = await invoke("list_model_files", { modelId: m.id }).catch(() => []);
        if (onDisk.some(f => f.endsWith(".gguf"))) {
          updates[m.id] = { status: "downloaded" };
        } else {
          updates[m.id] = { status: "not-downloaded" };
        }
      }
      setModelState(updates);
    };
    check();
  }, []);

  // ── Listen for download progress events from Rust ─────────────────────────
  useEffect(() => {
    let unlisten;
    listen("dl-progress", (event) => {
      const { file, downloaded, total } = event.payload;
      // Find which model is downloading
      setModelState(prev => {
        const downloading = Object.keys(prev).find(id => prev[id].status === "downloading");
        if (!downloading) return prev;
        return { ...prev, [downloading]: { status: "downloading", progress: { file, downloaded, total } } };
      });
    }).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  // ── Listen for llama.cpp token streaming events ───────────────────────────
  useEffect(() => {
    let cancelled = false;
    const unlisteners = [];

    Promise.all([
      listen("llm-token", (event) => {
        // Guard: only handle when a chat message is streaming (not hub)
        if (!streamMsgIdRef.current) return;
        streamBufRef.current += event.payload;
        const buf = streamBufRef.current;
        setChats(prev => prev.map(ch =>
          ch.id === activeRef.current
            ? { ...ch, messages: ch.messages.map(m => m.id === streamMsgIdRef.current ? { ...m, text: buf, streaming: true } : m) }
            : ch
        ));
      }),
      listen("llm-done", () => {
        // Guard: only handle when a chat message was streaming (not hub)
        if (!streamMsgIdRef.current) return;
        const finalText = streamBufRef.current;
        setChats(prev => prev.map(ch =>
          ch.id === activeRef.current
            ? { ...ch, messages: ch.messages.map(m => m.id === streamMsgIdRef.current ? { ...m, text: finalText, streaming: false } : m) }
            : ch
        ));
        setStreaming(false);
        streamBufRef.current = "";
        streamMsgIdRef.current = null;
      }),
      listen("llm-error", (event) => {
        setStreaming(false);
        hubStreamBufRef.current = "";
        hubStreamMsgRef.current = null;
        streamBufRef.current = "";
        streamMsgIdRef.current = null;
        setHubStreaming(false);
        console.error("[llm-error]", event.payload);
      }),
    ]).then(fns => {
      if (cancelled) { fns.forEach(fn => fn()); }   // cleaned up before resolved
      else { unlisteners.push(...fns); }
    });

    return () => {
      cancelled = true;
      unlisteners.forEach(fn => fn());
    };
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chats, active]);
  useEffect(() => { try { localStorage.setItem("codeforge_chats", JSON.stringify(chats)); } catch {} }, [chats]);

  // ── Download model (single GGUF file) ─────────────────────────────────────
  const downloadModel = async (modelId) => {
    const model = MODELS.find(m => m.id === modelId);
    setModelState(prev => ({ ...prev, [modelId]: { status: "downloading", progress: null } }));
    try {
      const tok = hfToken.trim() || null;
      const url = `${HF}/${modelId}/resolve/main/${model.file}`;
      await invoke("download_file", { url, modelId, filePath: model.file, token: tok });
      // Auto-connect after download — no separate "Load" step needed
      const ok = await loadModel(modelId);
      if (ok) setShowMod(false);
    } catch (err) {
      setModelState(prev => ({ ...prev, [modelId]: { status: "error", error: String(err) } }));
    }
  };

  // ── Connect model via llama-server ───────────────────────────────────────
  const loadModel = async (modelId) => {
    const model = MODELS.find(m => m.id === modelId);
    setModelLoading(true);
    setModelState(prev => ({ ...prev, [modelId]: { ...prev[modelId], status: "loading-into-memory" } }));
    try {
      await invoke("load_model", { modelId, file: model.file });
      setModelLoading(false);
      setActiveModelId(modelId);
      setModelState(prev => ({ ...prev, [modelId]: { status: "loaded" } }));
      return true;
    } catch (err) {
      setModelLoading(false);
      setModelState(prev => ({ ...prev, [modelId]: { status: "load-error", error: String(err) } }));
      return false;
    }
  };

  // ── Stop ongoing generation ───────────────────────────────────────────────
  const stopGenerate = () => {
    invoke("stop_generate").catch(console.error);
    // Immediately update UI — don't wait for llm-done event
    setStreaming(false);
    const stoppedMsgId = streamMsgIdRef.current;
    streamBufRef.current = "";
    streamMsgIdRef.current = null;
    if (stoppedMsgId) {
      setChats(prev => prev.map(ch =>
        ch.id === activeRef.current
          ? { ...ch, messages: ch.messages.map(m => m.id === stoppedMsgId ? { ...m, streaming: false } : m) }
          : ch
      ));
    }
  };

  // ── In-app update install (tauri-plugin-updater) ─────────────────────────
  const [updateProgress, setUpdateProgress] = useState(0);
  const installUpdate = async () => {
    setUpdateInstalling(true);
    setUpdateProgress(0);
    // Listen for download progress
    let unlisten;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("update-progress", e => setUpdateProgress(e.payload));
    } catch {}
    try {
      await invoke("install_update");
      // app.restart() is called in Rust — app will close and relaunch
    } catch (err) {
      console.error("[update] install failed:", err);
      alert("Update failed: " + err + "\n\nPlease download manually from the website.");
      setUpdateInstalling(false);
      setUpdateProgress(0);
    } finally {
      if (unlisten) unlisten();
    }
  };

  // ── Reset server binary and re-download (noavx fallback) ─────────────────
  const resetServer = async () => {
    setSetupProgress({ step: "starting" });
    setServerReady(false);
    try {
      await invoke("reset_server");
      await invoke("setup_llama_server");
      setServerReady(true);
      setSetupProgress(null);
    } catch (err) {
      setSetupProgress({ step: "error", message: String(err) });
    }
  };

  // ── Delete model from disk ────────────────────────────────────────────────
  const deleteModel = async (modelId) => {
    if (activeModelId === modelId) {
      await invoke("unload_model").catch(() => {});
      setActiveModelId(null);
    }
    await invoke("delete_model", { modelId }).catch(() => {});
    setModelState(prev => ({ ...prev, [modelId]: { status: "not-downloaded" } }));
  };

  // ── Send message ──────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    if (!activeModelId) {
      alert("Please download a model first — click Models in the sidebar.");
      return;
    }

    const userMsg = { id: Date.now(), role: "user", text, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
    const aiMsgId = Date.now() + 1;
    const activeChat = chats.find(c => c.id === active);
    const history = activeChat?.messages || [];

    // Run domain analytics FIRST so we know if a formula was fully solved
    const calcResult = tryAnalyticalCalculation(text, connectors);

    // Retrieve context chunks — period hint boosting already applied inside
    let ctxChunks = retrieveContext(connectors, text);

    // When a formula was fully calculated, further narrow context to ONLY the
    // extracted period(s). This prevents the LLM from seeing other periods and
    // accidentally quoting a value from e.g. Mar-22 when asked about Mar-23.
    if (calcResult?.formattedValue !== null && calcResult?.extracted) {
      const usedPeriods = new Set(
        Object.values(calcResult.extracted)
          .map(v => v.period)
          .filter(Boolean)
          .map(p => p.toLowerCase())
      );
      if (usedPeriods.size > 0) {
        const periodFiltered = ctxChunks.filter(c => {
          const pm = c.text.match(/Period:\s*([^\]\n]+)/i);
          if (!pm) return true; // non-Excel chunk — keep it
          return usedPeriods.has(pm[1].trim().toLowerCase());
        });
        if (periodFiltered.length > 0) ctxChunks = periodFiltered;
      }
    }

    const sources = [...new Set(ctxChunks.map(c => c.source))];

    const aiMsg = { id: aiMsgId, role: "ai", text: "", time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), streaming: true, sources, calc: calcResult || undefined };

    streamBufRef.current = "";
    streamMsgIdRef.current = aiMsgId;

    setChats(prev => prev.map(ch => ch.id === active ? { ...ch, messages: [...ch.messages, userMsg, aiMsg] } : ch));
    setInput("");
    setStreaming(true);

    // ── Language resolution ──────────────────────────────────────────────────
    let effectiveLang;
    if (selectedLang !== "auto") {
      // User manually picked a language — always honour it
      effectiveLang = selectedLang;
    } else {
      // Auto mode: detect from current message + last 4 user messages combined
      // (using conversation context makes short messages like "Merci" reliable)
      const recentCtx = history.slice(-4).filter(m => m.role === "user").map(m => m.text).join(" ");
      const detected  = detectLanguage(`${text} ${recentCtx}`);
      if (detected !== "en") {
        // Non-English detected — make it sticky for this conversation
        effectiveLang = detected;
        setAutoDetectedLang(detected);
        autoDetectedLangRef.current = detected;
      } else {
        // English (or ambiguous) — keep using the previously detected language
        effectiveLang = autoDetectedLangRef.current;
      }
    }

    // Inject analytics result prominently so the LLM cannot ignore it or
    // compute its own (potentially wrong) answer from raw context.
    let analyticsNote = "";
    if (calcResult) {
      const extractedLines = Object.entries(calcResult.extracted)
        .map(([k, v]) => `  • ${k.replace(/_/g," ")}: ${v.value.toLocaleString()}${v.period ? " ("+v.period+")" : ""}${v.source ? " — "+v.source : ""}`)
        .join("\n");
      if (calcResult.formattedValue !== null) {
        analyticsNote = `\n\n⚠️ IMPORTANT — USE THESE PRE-CALCULATED VALUES ONLY. Do NOT recalculate from raw context.\n`
          + `Formula applied: ${calcResult.formula.formula}\n`
          + `Values extracted from document:\n${extractedLines}\n`
          + `✅ CALCULATED RESULT: ${calcResult.formattedValue}\n`
          + `Your job: briefly explain what this ${calcResult.formula.name} result of ${calcResult.formattedValue} means for the business/study and whether it is good or concerning.`;
      } else if (Object.keys(calcResult.extracted).length > 0) {
        const missingList = calcResult.missing.map(m => m.replace(/_/g," ")).join(", ");
        analyticsNote = `\n\n[PARTIAL CALCULATION — ${calcResult.formula.name}]\nFormula: ${calcResult.formula.formula}\nValues found:\n${extractedLines}\nCould not find: ${missingList}.\nPlease explain what was found, note the missing values, and provide context where possible.`;
      }
    }

    const prompt = buildPrompt(history, text + analyticsNote, ctxChunks, connectors, activeModelId, effectiveLang);
    invoke("generate", { prompt, maxTokens: 2048, temperature: 0.7 }).catch(err => {
      const errText = String(err);
      setStreaming(false);
      streamBufRef.current = "";
      streamMsgIdRef.current = null;
      // Show the error as the AI message content so it's visible in chat
      setChats(prev => prev.map(ch =>
        ch.id === activeRef.current
          ? { ...ch, messages: ch.messages.map(m => m.id === aiMsgId ? { ...m, text: `⚠️ Error: ${errText}`, streaming: false } : m) }
          : ch
      ));
      console.error("[generate]", err);
    });
  }, [input, streaming, activeModelId, chats, active, connectors, selectedLang]);

  const newChat = () => {
    const id = Date.now();
    setChats(prev => [{ id, title: "New Chat", date: "Today", messages: [] }, ...prev]);
    setActive(id);
    setAutoDetectedLang("en");
    autoDetectedLangRef.current = "en";
  };

  // ── Hub: send a message to a specific editor's chat ───────────────────────
  const sendHubMessage = useCallback(async (clientId, text) => {
    if (!text || hubStreaming || !activeModelId) return;

    const client = hubClients[clientId];
    if (!client) return;

    const userMsg = { id: Date.now(), role: "user", text, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
    const aiMsgId = Date.now() + 1;
    const aiMsg   = { id: aiMsgId, role: "ai", text: "", time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), streaming: true };

    // Prepend editor context to the user question
    let contextPrefix = "";
    if (client.selectedCode) {
      contextPrefix = `[Context — ${client.language || "code"} in ${client.file || "editor"}]\n\`\`\`${client.language || ""}\n${client.selectedCode}\n\`\`\`\n\n`;
    } else if (client.file) {
      contextPrefix = `[File: ${client.file}, Language: ${client.language || "unknown"}, Line: ${client.cursorLine || 0}]\n\n`;
    }
    const fullText = contextPrefix + text;

    hubStreamBufRef.current = "";
    hubStreamMsgRef.current = { clientId, msgId: aiMsgId };
    setHubStreaming(true);

    setHubClients(prev => prev[clientId]
      ? { ...prev, [clientId]: { ...prev[clientId], messages: [...(prev[clientId].messages || []), userMsg, aiMsg] } }
      : prev
    );

    // Build a code-assistant system prompt for the hub
    const hubSys = `You are Codeforge AI Hub — an AI coding assistant embedded in ${client.editor || "VS Code"}.\n- The user is working in ${client.language || "a code file"}: ${client.file || "unknown"}.\n- Be concise and practical. Prefer showing corrected code over long explanations.\n- When providing code, always use fenced code blocks with the language tag.\n- Never hallucinate APIs or functions. If unsure, say so.`;
    const isGemma = activeModelId.toLowerCase().includes("gemma");
    const recentMsgs = (client.messages || []).slice(-4);
    let prompt = "";
    if (isGemma) {
      prompt = `<start_of_turn>user\n${hubSys}\n`;
      for (const m of recentMsgs) {
        prompt += m.role === "user" ? `<start_of_turn>user\n${m.text}<end_of_turn>\n` : `<start_of_turn>model\n${m.text}<end_of_turn>\n`;
      }
      prompt += `<start_of_turn>user\n${fullText}<end_of_turn>\n<start_of_turn>model\n`;
    } else {
      prompt = `<|im_start|>system\n${hubSys}<|im_end|>\n`;
      for (const m of recentMsgs) {
        const role = m.role === "ai" ? "assistant" : "user";
        prompt += `<|im_start|>${role}\n${m.text}<|im_end|>\n`;
      }
      prompt += `<|im_start|>user\n${fullText}<|im_end|>\n<|im_start|>assistant\n`;
    }

    invoke("generate", { prompt, maxTokens: 2048, temperature: 0.7 }).catch(err => {
      setHubStreaming(false);
      hubStreamBufRef.current = "";
      hubStreamMsgRef.current = null;
      setHubClients(prev => prev[clientId]
        ? { ...prev, [clientId]: { ...prev[clientId], messages: prev[clientId].messages.map(m => m.id === aiMsgId ? { ...m, text: `⚠️ Error: ${err}`, streaming: false } : m) } }
        : prev
      );
    });
  }, [hubClients, hubStreaming, activeModelId]);

  // ── Hub: apply AI response code back to the connected editor ─────────────
  const applyToEditor = useCallback(async (clientId, aiText) => {
    // Extract first code block from AI response
    const match = aiText.match(/```[\w]*\n?([\s\S]*?)```/);
    const code = match ? match[1].trim() : aiText;
    try {
      await invoke("hub_send", {
        clientId,
        message: JSON.stringify({ type: "apply", code }),
      });
    } catch (e) { console.error("[hub_send]", e); }
  }, []);

  const activeChat = chats.find(c => c.id === active);
  const searchQ = sSearch.trim().toLowerCase();
  const filteredChats = searchQ
    ? chats.filter(c =>
        c.title.toLowerCase().includes(searchQ) ||
        c.messages.some(m => m.text?.toLowerCase().includes(searchQ))
      )
    : chats;
  // For each chat, find first matching message snippet (if title didn't match)
  const getMatchSnippet = (ch) => {
    if (!searchQ || ch.title.toLowerCase().includes(searchQ)) return null;
    const m = ch.messages.find(msg => msg.text?.toLowerCase().includes(searchQ));
    if (!m) return null;
    const idx = m.text.toLowerCase().indexOf(searchQ);
    const start = Math.max(0, idx - 20);
    const end = Math.min(m.text.length, idx + searchQ.length + 30);
    return (start > 0 ? "…" : "") + m.text.slice(start, end) + (end < m.text.length ? "…" : "");
  };

  const activeModel = MODELS.find(m => m.id === activeModelId);
  const ms = activeModelId ? modelState[activeModelId] : null;
  const statusColor = ms?.status === "loaded" ? C.green : modelLoading ? C.amber : C.t3;
  const statusLabel = ms?.status === "loaded" ? "Ready" : modelLoading ? "Connecting…" : "No model loaded";


  return (
    <div style={{ display: "flex", height: "100vh", background: C.bgDeep, fontFamily: "'DM Sans',-apple-system,sans-serif", overflow: "hidden" }} onClick={() => contextMenu && setContextMenu(null)}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap');
        @keyframes oai-pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes oai-spin{to{transform:rotate(360deg)}}
        @keyframes oai-bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}
        @keyframes oai-slide{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
        @keyframes oai-slide-bar{0%{margin-left:0;width:40%}50%{margin-left:60%;width:40%}100%{margin-left:0;width:40%}}
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:${C.t3};border-radius:4px}
        textarea{resize:none;outline:none} button{outline:none;border:none} input{outline:none}
      `}</style>

      {/* ── Sidebar ── */}
      <div style={{ width: 240, background: C.bgPanel, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", flexShrink: 0 }}>

        {/* Logo */}
        <div style={{ padding: "18px 16px 14px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
            <div style={{ width: 32, height: 32, borderRadius: 9, background: `linear-gradient(135deg,${C.blueD},${C.cyan})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon d={IC.brain} size={16} stroke="#fff" />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.t1 }}>Codeforge AI</div>
              <div style={{ fontSize: 10, color: C.t3 }}>Research Assistant</div>
            </div>
          </div>
          <Btn onClick={newChat} style={{ width: "100%", padding: "8px", background: C.blue, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Icon d={IC.plus} size={13} /> New Chat
          </Btn>
        </div>

        {/* Search */}
        <div style={{ padding: "10px 12px 6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8 }}>
            <Icon d={IC.search} size={12} stroke={C.t3} />
            <input value={sSearch} onChange={e => setSSearch(e.target.value)} placeholder="Search chats…"
              style={{ background: "none", border: "none", outline: "none", fontSize: 12, color: C.t1, width: "100%", fontFamily: "inherit", caretColor: C.cyan }} />
          </div>
        </div>

        {/* Chat list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px" }} onClick={() => setContextMenu(null)}>
          {filteredChats.map(ch => {
            const snippet = getMatchSnippet(ch);
            const isRenaming = renamingId === ch.id;
            return (
              <div key={ch.id}
                onClick={() => { setContextMenu(null); if (!isRenaming) setActive(ch.id); }}
                onContextMenu={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  const menuW = 130, menuH = 72;
                  const x = e.clientX + menuW > window.innerWidth ? e.clientX - menuW : e.clientX;
                  const y = e.clientY + menuH > window.innerHeight ? e.clientY - menuH : e.clientY;
                  setContextMenu({ chatId: ch.id, x, y });
                }}
                style={{
                  padding: "9px 10px", borderRadius: 8, cursor: "pointer", marginBottom: 2,
                  background: active === ch.id ? "rgba(59,130,246,0.12)" : "transparent",
                  border: `1px solid ${active === ch.id ? C.borderHi : "transparent"}`,
                  transition: "all 0.15s",
                }}>
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameVal}
                    onChange={e => setRenameVal(e.target.value)}
                    onBlur={() => {
                      if (renameVal.trim()) {
                        setChats(prev => prev.map(c => c.id === ch.id ? { ...c, title: renameVal.trim() } : c));
                      }
                      setRenamingId(null);
                    }}
                    onKeyDown={e => {
                      if (e.key === "Enter") e.target.blur();
                      if (e.key === "Escape") { setRenamingId(null); }
                    }}
                    onClick={e => e.stopPropagation()}
                    style={{ background: "none", border: "none", outline: "none", fontSize: 12.5,
                             color: C.t1, width: "100%", fontFamily: "inherit", caretColor: C.cyan }}
                  />
                ) : (
                  <div style={{ fontSize: 12.5, color: active === ch.id ? C.t1 : C.t2, fontWeight: active === ch.id ? 500 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.title}</div>
                )}
                {snippet && !isRenaming && (
                  <div style={{ fontSize: 10, color: C.cyan, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 }}>{snippet}</div>
                )}
                <div style={{ fontSize: 10, color: C.t3, marginTop: 2 }}>{ch.date}</div>
              </div>
            );
          })}
        </div>

        {/* Bottom nav */}
        <div style={{ padding: "10px 8px", borderTop: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: 2 }}>
          {[
            { icon: IC.server, label: "Models",  action: () => { setShowHub(false); setShowMod(true); } },
            { icon: IC.plug,   label: "Sources", action: () => { setShowHub(false); setShowConn(true); } },
          ].map(({ icon, label, action }) => (
            <Btn key={label} onClick={action} style={{ width: "100%", padding: "9px 10px", background: "transparent", border: "none", borderRadius: 8, color: C.t2, fontSize: 12.5, display: "flex", alignItems: "center", gap: 8, textAlign: "left" }}>
              <Icon d={icon} size={14} stroke={C.t3} />{label}
            </Btn>
          ))}

          {/* Extension Hub button — desktop only */}
          {isDesktop && (
            <Btn onClick={() => setShowHub(h => !h)} style={{
              width: "100%", padding: "9px 10px", borderRadius: 8, border: "none", textAlign: "left",
              background: showHub ? "rgba(168,85,247,0.12)" : "transparent",
              color: showHub ? C.purple : C.t2, fontSize: 12.5, display: "flex", alignItems: "center", gap: 8,
            }}>
              <Icon d={IC.hub} size={14} stroke={showHub ? C.purple : C.t3} />
              Hub
              {/* Trial badge — shows days left or Expired */}
              <span style={{ marginLeft: "auto", fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 10,
                background: trialDaysLeft === null ? "rgba(168,85,247,0.18)" : trialDaysLeft <= 0 ? "rgba(239,68,68,0.15)" : "rgba(168,85,247,0.18)",
                color: trialDaysLeft === null ? C.purple : trialDaysLeft <= 0 ? C.red : C.purple,
                border: `1px solid ${trialDaysLeft !== null && trialDaysLeft <= 0 ? "rgba(239,68,68,0.3)" : "rgba(168,85,247,0.3)"}`,
              }}>
                {trialDaysLeft === null ? "5d trial" : trialDaysLeft <= 0 ? "Expired" : `${trialDaysLeft}d left`}
              </span>
            </Btn>
          )}

          {/* Model status chip */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 10px", background: C.bgCard, borderRadius: 8, border: `1px solid ${C.border}`, marginTop: 4 }}>
            <Dot color={statusColor} pulse={ms?.status === "loaded" || modelLoading} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: statusColor }}>{statusLabel}</div>
              {activeModel && ms?.status === "loaded" && (
                <div style={{ fontSize: 10, color: C.t3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeModel.label}</div>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* ── Main area ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Top bar */}
        <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bgPanel }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>
            {showHub ? (
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon d={IC.hub} size={15} stroke={C.purple} />
                <span style={{ color: C.purple }}>Extension Hub</span>
                <span style={{ fontSize: 11, color: C.t3, fontWeight: 400 }}>· Desktop Only</span>
              </span>
            ) : (activeChat?.title || "Chat")}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {connectors.length > 0 && (
              <div style={{ fontSize: 11, color: C.cyan, display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 20 }}>
                <Icon d={IC.plug} size={10} stroke={C.cyan} />{connectors.length} source{connectors.length !== 1 ? "s" : ""}
              </div>
            )}
          </div>
        </div>

        {/* ── Update available banner ── */}
        {updateAvailable && !updateDismissed && (
          <div style={{ padding: "9px 20px", borderBottom: `1px solid rgba(34,197,94,0.25)`, background: "rgba(34,197,94,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div style={{ fontSize: 12.5, color: C.t1, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 15 }}>🚀</span>
              <span>
                <strong style={{ color: C.green }}>Codeforge AI v{updateAvailable.version}</strong> is available!
                {updateAvailable.notes && <span style={{ color: C.t2, marginLeft: 4 }}>{updateAvailable.notes.split('\n')[0].slice(0, 80)}</span>}
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <Btn onClick={installUpdate} disabled={updateInstalling}
                style={{ padding: "6px 14px", background: updateInstalling ? C.bgCard : C.green, border: "none", borderRadius: 7, color: "#fff", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", opacity: updateInstalling ? 0.7 : 1 }}>
                {updateInstalling ? (updateProgress > 0 ? `Downloading… ${updateProgress}%` : "Starting…") : "Install & Restart"}
              </Btn>
              <Btn onClick={() => setUpdateDismissed(true)} style={{ padding: "6px 10px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 7, color: C.t3, fontSize: 12 }}>
                Later
              </Btn>
            </div>
          </div>
        )}

        {/* Setup banner */}
        {serverReady === false && !setupProgress && (
          <div style={{ padding: "10px 20px", borderBottom: `1px solid ${C.border}`, background: "rgba(168,85,247,0.05)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ fontSize: 12.5, color: C.t2 }}>
                <strong style={{ color: C.purple }}>One-time setup required.</strong> Download the llama.cpp inference engine (~5 MB) to run AI locally.
              </div>
              <Btn onClick={runSetup} style={{ padding: "7px 14px", background: C.purple, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
                Setup Now
              </Btn>
            </div>
          </div>
        )}
        {setupProgress && setupProgress.step !== "error" && (
          <div style={{ padding: "10px 20px", borderBottom: `1px solid ${C.border}`, background: "rgba(168,85,247,0.05)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Spinner />
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 12.5, color: C.purple }}>
                  {setupProgress.step === "downloading"
                    ? `Downloading llama-server${setupProgress.total > 0 ? ` — ${Math.round((setupProgress.downloaded / setupProgress.total) * 100)}%` : "…"}`
                    : setupProgress.step === "extracting"
                    ? "Extracting llama-server.exe…"
                    : "Setting up…"}
                </span>
                {setupProgress.step === "downloading" && setupProgress.total > 0 && (
                  <div style={{ marginTop: 5, height: 3, background: C.bgDeep, borderRadius: 4 }}>
                    <div style={{ height: "100%", width: `${Math.round((setupProgress.downloaded / setupProgress.total) * 100)}%`, background: C.purple, borderRadius: 4, transition: "width 0.3s" }} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {setupProgress?.step === "error" && (
          <div style={{ padding: "10px 20px", borderBottom: `1px solid ${C.border}`, background: "rgba(239,68,68,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ fontSize: 12.5, color: C.red }}>Setup failed: {setupProgress.message}</span>
            <Btn onClick={runSetup} style={{ padding: "6px 12px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 7, color: C.red, fontSize: 12 }}>Retry</Btn>
          </div>
        )}

        {/* No model banner */}
        {!activeModelId && (
          <div style={{ padding: "10px 20px", borderBottom: `1px solid ${C.border}`, background: "rgba(59,130,246,0.05)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ fontSize: 12.5, color: C.t2 }}>
                <strong style={{ color: C.blue }}>No model loaded.</strong> Download a model — it connects automatically.
              </div>
              <Btn onClick={() => setShowMod(true)} style={{ padding: "7px 14px", background: C.blue, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
                Get a Model
              </Btn>
            </div>
          </div>
        )}

        {/* Model loading banner */}
        {modelLoading && (
          <div style={{ padding: "10px 20px", borderBottom: `1px solid ${C.border}`, background: "rgba(245,158,11,0.05)", display: "flex", alignItems: "center", gap: 10 }}>
            <Spinner />
            <span style={{ fontSize: 12.5, color: C.amber }}>Connecting to model… this may take 10–30 seconds.</span>
          </div>
        )}

        {/* ── Hub Panel (replaces chat when showHub is true) ── */}
        {showHub ? (
          <HubPanel
            hubClients={hubClients}
            activeHubId={activeHubId}
            setActiveHubId={setActiveHubId}
            hubStreaming={hubStreaming}
            onSendHub={sendHubMessage}
            onApply={applyToEditor}
            activeModelId={activeModelId}
            trialDaysLeft={trialDaysLeft}
          />
        ) : (
          <>
        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          {activeChat?.messages.map(msg => <Bubble key={msg.id} msg={msg} />)}
          <div ref={bottomRef} />
        </div>

        {/* Quick prompts */}
        {(!activeChat?.messages || activeChat.messages.length <= 1) && (
          <div style={{ padding: "0 24px 10px", display: "flex", gap: 7, flexWrap: "wrap" }}>
            {quickPrompts.map(p => (
              <Btn key={p} onClick={() => { setInput(p); inputRef.current?.focus(); }}
                style={{ padding: "6px 12px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 20, color: C.t2, fontSize: 11.5 }}>
                {p}
              </Btn>
            ))}
          </div>
        )}

        {/* Input */}
        <div style={{ padding: "10px 20px 16px", background: C.bgPanel, borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, padding: "10px 14px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 14 }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={activeModelId ? "Ask a research question… (Enter to send, Shift+Enter for newline)" : "Download a model first to start chatting"}
              rows={1}
              style={{ flex: 1, background: "none", border: "none", color: C.t1, fontSize: 13.5, lineHeight: 1.6, maxHeight: 120, overflowY: "auto", fontFamily: "inherit" }}
            />
            {/* Stop button — shown while streaming */}
            {streaming ? (
              <Btn onClick={stopGenerate} style={{
                width: 36, height: 36, borderRadius: 9, border: `1px solid rgba(239,68,68,0.4)`, flexShrink: 0,
                background: "rgba(239,68,68,0.12)", display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Icon d={IC.stop} size={14} fill={C.red} stroke="none" />
              </Btn>
            ) : (
              <Btn onClick={send} disabled={!input.trim() || !activeModelId} style={{
                width: 36, height: 36, borderRadius: 9, border: "none", flexShrink: 0,
                background: input.trim() && activeModelId ? C.blue : C.bgPanel,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: input.trim() && activeModelId ? "#fff" : C.t3,
              }}>
                <Icon d={IC.send} size={15} />
              </Btn>
            )}
          </div>

          {/* Language selector + footer */}
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            {/* Left: language pills */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Icon d={IC.globe} size={12} stroke={C.t2} />
              <span style={{ fontSize: 11, color: C.t2, fontWeight: 500 }}>Language:</span>
              {LANG_OPTIONS.map(({ id, label }) => {
                const isActive = selectedLang === id;
                // In Auto mode, show what language was detected (e.g. "Auto · FR")
                const showDetected = id === "auto" && isActive && autoDetectedLang !== "en";
                const displayLabel = showDetected ? `Auto · ${autoDetectedLang.toUpperCase()}` : label;
                return (
                  <Btn key={id} onClick={() => {
                    setSelectedLang(id);
                    if (id !== "auto") {
                      setAutoDetectedLang("en");
                      autoDetectedLangRef.current = "en";
                    }
                  }} style={{
                    padding: "4px 13px",
                    borderRadius: 20,
                    background: isActive ? C.blue : C.bgCard,
                    border: `1px solid ${isActive ? C.blue : C.borderHi}`,
                    color: isActive ? "#fff" : C.t1,
                    fontSize: 12,
                    fontWeight: isActive ? 700 : 500,
                    letterSpacing: "0.02em",
                    transition: "all 0.2s",
                    boxShadow: isActive ? `0 0 0 2px ${C.blue}44` : "none",
                  }}>
                    {displayLabel}
                  </Btn>
                );
              })}
            </div>
            {/* Right: privacy note */}
            <div style={{ fontSize: 10, color: C.t3, whiteSpace: "nowrap" }}>100% on-device · no data sent</div>
          </div>
        </div>
          </>
        )}
      </div>

      {/* Modals */}
      {showMod && (
        <ModelModal
          modelState={modelState}
          activeModelId={activeModelId}
          hfToken={hfToken}
          onTokenChange={(t) => { setHfToken(t); localStorage.setItem("hf_token", t); }}
          onDownload={(id) => downloadModel(id)}
          onLoad={(id) => { loadModel(id); setShowMod(false); }}
          onDelete={deleteModel}
          onResetServer={resetServer}
          onClose={() => setShowMod(false)}
        />
      )}
      {showConn && (
        <ConnectorModal
          connectors={connectors}
          onAdd={c => setConnectors(prev => [...prev, c])}
          onRemove={id => setConnectors(prev => prev.filter(c => c.id !== id))}
          onClose={() => setShowConn(false)}
        />
      )}

      {/* Context menu — rendered at root level so nothing clips it */}
      {contextMenu && (
        <div
          style={{
            position: "fixed", zIndex: 99999,
            left: contextMenu.x, top: contextMenu.y,
            background: C.bgCard, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: "4px 0", minWidth: 130,
            boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
          }}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
        >
          {[
            { label: "Rename", action: () => {
              const ch = chats.find(c => c.id === contextMenu.chatId);
              if (ch) { setRenameVal(ch.title); setRenamingId(ch.id); setActive(ch.id); }
              setContextMenu(null);
            }},
            { label: "Delete", action: () => {
              const id = contextMenu.chatId;
              setChats(prev => {
                const next = prev.filter(c => c.id !== id);
                if (next.length === 0) {
                  const newId = Date.now();
                  setActive(newId);
                  return [{ id: newId, title: "New Chat", date: "Today", messages: [] }];
                }
                if (active === id) setActive(next[0].id);
                return next;
              });
              setContextMenu(null);
            }, danger: true },
          ].map(({ label, action, danger }) => (
            <div key={label} onClick={action} style={{
              padding: "7px 14px", fontSize: 12.5, cursor: "pointer",
              color: danger ? "#f87171" : C.t1,
              transition: "background 0.1s",
            }}
              onMouseEnter={e => e.currentTarget.style.background = danger ? "rgba(248,113,113,0.12)" : "rgba(255,255,255,0.06)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >{label}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Auth gate (inside ClerkProvider) ────────────────────────────────────────
function AuthGate() {
  const { isSignedIn, isLoaded } = useAuth();
  if (!isLoaded) {
    // Clerk loading — show minimal splash
    return (
      <div style={{ position: "fixed", inset: 0, background: C.bgDeep, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <div style={{ width: 50, height: 50, borderRadius: 14, background: `linear-gradient(135deg,${C.blueD},${C.cyan})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon d={IC.brain} size={24} stroke="#fff" />
          </div>
          <Spinner />
        </div>
      </div>
    );
  }
  return isSignedIn ? <OfflineAIApp /> : <LoginPage />;
}

// ─── Root: Clerk auth gate ────────────────────────────────────────────────────
// If CLERK_KEY is a placeholder, skip auth and go straight to the app.
// Replace CLERK_KEY with your real Publishable Key from https://clerk.com to enable login.
export default function OfflineAI() {
  const isConfigured = CLERK_KEY && !CLERK_KEY.includes("REPLACE");

  if (!isConfigured) {
    // No Clerk key yet — bypass auth (developer / first-launch mode)
    return <OfflineAIApp />;
  }

  return (
    <ClerkProvider publishableKey={CLERK_KEY}>
      <AuthGate />
    </ClerkProvider>
  );
}
