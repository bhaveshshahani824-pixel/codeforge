import { useState, useRef, useEffect, useCallback } from "react";
import { runExcelAgent, buildExcelSchema } from "./excelAgent.js";
import QRCode from "qrcode";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile, readDir } from "@tauri-apps/plugin-fs";
import { ClerkProvider, SignIn, useAuth } from "@clerk/react";
import * as WebLLM from "@mlc-ai/web-llm";
import { pipeline, env as hfEnv } from "@huggingface/transformers";
hfEnv.allowLocalModels = false;

// ─── Cache Storage polyfill (needed when served over HTTP on LAN) ─────────────
// Cache API is restricted to HTTPS/localhost; this IndexedDB shim enables WebLLM
// to cache model weights on non-secure origins (e.g. http://192.168.x.x:1420).
if (typeof caches === "undefined") {
  const DB = "wllm-cache", ST = "kv";
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore(ST);
    r.onsuccess = e => res(e.target.result);
    r.onerror = rej;
  });
  const serialize = async r => {
    const body = await r.arrayBuffer();
    const hdrs = {}; r.headers.forEach((v, k) => { hdrs[k] = v; });
    return { body, hdrs, status: r.status, statusText: r.statusText };
  };
  const deserialize = d => new Response(d.body, { status: d.status, statusText: d.statusText, headers: d.hdrs });
  class IDBCache {
    constructor(n) { this.n = n; }
    key(r) { return `${this.n}::${typeof r === "string" ? r : r.url}`; }
    async match(req) {
      const db = await idb();
      return new Promise(res => {
        const r = db.transaction(ST).objectStore(ST).get(this.key(req));
        r.onsuccess = e => res(e.target.result ? deserialize(e.target.result) : undefined);
        r.onerror = () => res(undefined);
      });
    }
    async matchAll(req) {
      // Return all entries whose key starts with this cache name prefix
      const db = await idb(), pfx = `${this.n}::`;
      return new Promise(res => {
        const r = db.transaction(ST).objectStore(ST).getAll();
        r.onsuccess = e => {
          const all = db.transaction(ST).objectStore(ST).getAllKeys();
          all.onsuccess = k => {
            const results = k.result
              .map((key, i) => ({ key, val: e.target.result[i] }))
              .filter(({ key }) => !req || key === `${this.n}::${typeof req === "string" ? req : req.url}`)
              .map(({ val }) => deserialize(val));
            res(results);
          };
          all.onerror = () => res([]);
        };
        r.onerror = () => res([]);
      });
    }
    async add(req) {
      // Fetch the resource and store it
      const url = typeof req === "string" ? req : req.url;
      const response = await fetch(req);
      await this.put(url, response);
    }
    async addAll(requests) {
      await Promise.all(requests.map(r => this.add(r)));
    }
    async put(req, resp) {
      const data = await serialize(resp); const db = await idb();
      return new Promise((res, rej) => {
        const tx = db.transaction(ST, "readwrite");
        tx.objectStore(ST).put(data, this.key(req));
        tx.oncomplete = res; tx.onerror = rej;
      });
    }
    async delete(req) {
      const db = await idb();
      return new Promise(res => {
        const tx = db.transaction(ST, "readwrite");
        tx.objectStore(ST).delete(this.key(req));
        tx.oncomplete = () => res(true); tx.onerror = () => res(false);
      });
    }
    async keys() {
      const db = await idb(), pfx = `${this.n}::`;
      return new Promise(res => {
        const r = db.transaction(ST).objectStore(ST).getAllKeys();
        r.onsuccess = e => res(
          e.target.result
            .filter(k => k.startsWith(pfx))
            .map(k => new Request(k.slice(pfx.length)))
        );
        r.onerror = () => res([]);
      });
    }
  }
  const map = new Map();
  window.caches = {
    open: async n => { if (!map.has(n)) map.set(n, new IDBCache(n)); return map.get(n); },
    match: async req => { for (const c of map.values()) { const m = await c.match(req); if (m) return m; } },
    has: async n => map.has(n),
    delete: async n => { map.delete(n); return true; },
    keys: async () => [...map.keys()],
  };
}

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
  agent:    "M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73A2 2 0 0 1 10 4a2 2 0 0 1 2-2zm-3 9a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm6 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm-3 4a3 3 0 0 0-2.83 2h5.66A3 3 0 0 0 12 15z",
  stop2:    "M6 6h12v12H6z",
  mic:      "M12 1a3 3 0 0 1 3 3v8a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3zm-1 16.93V21h-2v2h6v-2h-2v-3.07A8 8 0 0 0 20 12h-2a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93z",
  qr:       "M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM11 11h2v2h-2zM13 13h2v2h-2zM15 11h2v2h-2zM11 15h2v2h-2zM13 17h2v2h-2zM15 15h2v2h-2zM17 17h2v2h-2zM17 11h4v2h-4zM11 13h2v4h-2z",
  code:     "M16 18l6-6-6-6M8 6l-6 6 6 6",
  apply:    "M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 0 0 1.946-.806 3.42 3.42 0 0 1 4.438 0 3.42 3.42 0 0 0 1.946.806 3.42 3.42 0 0 1 3.138 3.138 3.42 3.42 0 0 0 .806 1.946 3.42 3.42 0 0 1 0 4.438 3.42 3.42 0 0 0-.806 1.946 3.42 3.42 0 0 1-3.138 3.138 3.42 3.42 0 0 0-1.946.806 3.42 3.42 0 0 1-4.438 0 3.42 3.42 0 0 0-1.946-.806 3.42 3.42 0 0 1-3.138-3.138 3.42 3.42 0 0 0-.806-1.946 3.42 3.42 0 0 1 0-4.438 3.42 3.42 0 0 0 .806-1.946 3.42 3.42 0 0 1 3.138-3.138z",
  pdf:      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  docx:     "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4",
  flask:    "M10 2v7.527a2 2 0 0 1-.211.896L4.72 19.63A1 1 0 0 0 5.633 21h12.734a1 1 0 0 0 .912-1.37L14.21 10.423A2 2 0 0 1 14 9.527V2M8.5 2h7",
  chart:    "M3 3v18h18M7 16l4-4 4 4 4-8",
  trendUp:  "M22 7l-8.5 8.5-5-5L2 17",
  barChart: "M18 20V10M12 20V4M6 20v-6",
  warning:  "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01",
  info:     "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 8h.01M12 12v4",
  music:    "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  vol:      "M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07",
  play:     "M5 3l14 9-14 9V3z",
  waveform: "M2 12h2M6 8v8M10 5v14M14 9v6M18 6v12M22 10v4",
  chat:     "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  gamepad:  "M6 12h4M8 10v4M15 11h.01M18 11h.01M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
  arrowL:   "M15 18l-6-6 6-6",
  arrowR:   "M9 18l6-6-6-6",
  arrowU:   "M18 15l-6-6-6 6",
  arrowD:   "M6 9l6 6 6-6",
  restart:  "M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15",
  trophy:   "M6 9H4a2 2 0 0 1-2-2V5h4M18 9h2a2 2 0 0 0 2-2V5h-4M12 17v4m-4 0h8M8 9a4 4 0 0 0 8 0V3H8v6z",
  workflow: "M5 3a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5zM5 11a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2H5zM11 5h10M11 13h10M21 3l-6 6M21 11l-6 6",
  screen:   "M2 3a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h6l-1 3H6v1h12v-1h-1l-1-3h6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H2zm1 2h18v11H3V5z",
  camera:   "M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  scan:     "M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M8 12h8",
  eye:      "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
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
const APP_VERSION = "0.3.4";
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

// ─── Live Source Reader ────────────────────────────────────────────────────────
// Re-reads connected files from disk on every query so the LLM sees the FULL,
// up-to-date data — not keyword-matched fragments from a stale index.
// Excel → full markdown table per sheet
// PDF / DOCX → full extracted text (up to 14k chars)
// Falls back to stored chunks if the file can't be read (moved/deleted/locked).
async function readSourcesLive(connectors) {
  const parts = [];
  for (const c of connectors) {
    try {
      if (c.type === "pubmed" || !c.path) {
        if (c.chunks?.length) {
          const txt = c.chunks.slice(0, 16)
            .map(ch => (typeof ch === "string" ? ch : ch.text || "")).join("\n\n");
          parts.push(`## ${c.name}\n${txt}`);
        }
        continue;
      }
      if (c.type === "excel") {
        const data = await invoke("read_excel_sheets", { path: c.path });
        const sheetsToRead = (data.sheets || []).filter(s => !c.activeSheets || c.activeSheets.includes(s.name)).slice(0, 4);
        for (const sheet of sheetsToRead) {
          const rows = (sheet.rows || []).filter(r =>
            r.some(v => v !== null && v !== undefined && v !== "")
          );
          if (!rows.length) continue;
          const headers = rows[0].map(h => String(h ?? "").trim() || "—");
          const MAX_ROWS = 80;
          const dataRows = rows.slice(1, MAX_ROWS + 1);
          const truncated = rows.length - 1 > MAX_ROWS;
          const mdHead = `| ${headers.join(" | ")} |`;
          const mdSep  = `| ${headers.map(() => "---").join(" | ")} |`;
          const mdBody = dataRows.map(r =>
            `| ${headers.map((_, i) => String(r[i] ?? "").trim()).join(" | ")} |`
          ).join("\n");
          const truncNote = truncated ? `\n[Table truncated: showing ${MAX_ROWS} of ${rows.length - 1} rows]` : "";
          parts.push(`## ${c.name} — Sheet: ${sheet.name}\n${mdHead}\n${mdSep}\n${mdBody}${truncNote}`);
        }
      } else if (c.type === "pdf") {
        const text = await invoke("read_pdf", { path: c.path });
        const trimmed = text.slice(0, 14000);
        parts.push(`## ${c.name}\n${trimmed}${text.length > 14000 ? "\n[…document continues beyond context limit]" : ""}`);
      } else if (c.type === "docx") {
        const text = await invoke("read_docx", { path: c.path });
        const trimmed = text.slice(0, 14000);
        parts.push(`## ${c.name}\n${trimmed}${text.length > 14000 ? "\n[…document continues beyond context limit]" : ""}`);
      } else if (c.path) {
        const text = await invoke("read_file_text", { path: c.path });
        parts.push(`## ${c.name}\n${text.slice(0, 8000)}`);
      }
    } catch (e) {
      console.warn("[sources] failed live-read of", c.name, ":", e);
      // Graceful fall-back to pre-indexed chunks
      if (c.chunks?.length) {
        const fallback = c.chunks.slice(0, 12)
          .map(ch => (typeof ch === "string" ? ch : ch.text || "")).join("\n\n");
        parts.push(`## ${c.name} (cached)\n${fallback}`);
      }
    }
  }
  return parts.length ? parts.join("\n\n---\n\n") : null;
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
  const base = `You are Codeforge AI — a research assistant running 100% on this device. No data leaves this machine.\n\nACCURACY RULES (highest priority — always apply these before answering):\n- PREMISE CHECK: Before answering any math, science, or factual question, verify whether the user's stated facts, equations, or identities are correct. If the user's premise is FALSE or INCORRECT (e.g., a wrong equation like "sinθ + cosθ = 1" when the correct identity is "sin²θ + cos²θ = 1"), you MUST explicitly correct it first using "⚠️ Correction:" before explaining the right concept. Never build an explanation on a false premise — correcting the user is more helpful than confirming a mistake.\n- MATH NOTATION: Write math using plain Unicode text only (e.g., sin²θ + cos²θ = 1, √x, π, θ). Do NOT output raw LaTeX commands like \\sin, \\cos, \\frac{a}{b}, \\sqrt{} or \\text{} — these appear as broken garbled text to the user.\n- NO HALLUCINATION: Never invent facts, formulas, examples, or real-world applications you are not certain about. If you are unsure of an example, omit it or say "I'm not certain about this". It is far better to say "I don't know" than to fabricate a plausible-sounding but wrong answer.\n- CLEAN OUTPUT: Your response must use only the characters of the target language's script. Never mix in characters or words from unrelated writing systems (e.g., no Chinese/Arabic/Cyrillic characters in a French or English response). If you are about to output a character you cannot verify, omit it.\n\nRESPONSE RULES:\n- Be precise, cite sources when context is provided.\n- Structure complex answers with bullet points or sections.\n- If the answer is not in the provided context, say so — never hallucinate.\n- Prefer concise, evidence-based responses.\n- CONCISENESS: Never repeat yourself. Each sentence must add new information. If the answer fits in one sentence, give one sentence — do not pad with restating the question, summaries of what you just said, or closing remarks like "In summary" or "To conclude".\n- Direct answers: For factual or numerical questions, state the answer first, then explain only if needed.\n- For Excel/financial data: calculate requested metrics from the numbers in the context; show your working.\n- Language identification: You understand ALL world languages. When asked "what language is this?", "which language is this?", or any similar question, ALWAYS explicitly state the full language name first (e.g., "This is French.", "This text is written in Arabic.", "This is Spanish."), then provide the translation or meaning. Never skip naming the language.`;
  const docInstr = hasDocs ? "\n\nDOCUMENT CONTEXT RULES (highest priority when context is provided):\n- The user has connected research documents. A \"--- Document context ---\" section will appear in their message with extracted text from those files.\n- You MUST answer the user's question using ONLY the information found in that context section. Quote or paraphrase directly from it.\n- If the answer is clearly present in the context, do NOT add general knowledge — stick to what the document says.\n- Cite the source file name when referencing specific content (e.g., \"According to [filename]...\").\n- Only if the context contains NO relevant information at all should you say so and offer a general answer as a fallback." : "";
  const langInstr = LANG_PROMPTS[lang] || "";
  return base + docInstr + langInstr;
}

// Build a raw prompt string for llama.cpp (no tokenizer required in JS).
// Uses ChatML format (Qwen, Phi-3.5) or Gemma format depending on model.
function buildPrompt(history, userText, ctxChunks, connectors, modelId, lang = "en", liveCtx = null) {
  const sys = buildSystemPrompt(connectors, lang);

  // Context goes BEFORE the question so the model reads the document first,
  // then encounters the question with full context already in working memory.
  let ctx = "";
  if (liveCtx) {
    // Live-read: full data from disk → best accuracy
    ctx = "The following is the COMPLETE content from the user's connected data sources.\n" +
          "Use this data to answer accurately. Never estimate or hallucinate values — if something is not in the data, say so clearly.\n\n" +
          "=== CONNECTED DATA ===\n" + liveCtx + "\n=== END OF DATA ===\n\nQuestion: ";
  } else if (ctxChunks.length > 0) {
    ctx = "The following passages are extracted from the user's connected document(s).\n" +
          "Read them carefully, then answer the question below using ONLY this content.\n\n" +
          "=== DOCUMENT CONTEXT ===\n" +
          ctxChunks.map((c, i) => `[Passage ${i + 1} — ${c.source}]\n${c.text}`).join("\n\n") +
          "\n=== END OF CONTEXT ===\n\nQuestion: ";
  }

  const isGemma = modelId.toLowerCase().includes("gemma");

  // When data context is present, reduce history to save token space.
  const histSlice = (liveCtx || ctxChunks.length > 2) ? -2 : -4;
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
function ModelModal({ modelState, activeModelId, hfToken, onTokenChange, onDownload, onLoad, onDelete, onCancelDownload, onResetServer, onClose }) {
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
              <div style={{ flex: 1, display: "flex", gap: 8 }}>
                <div style={{ flex: 1, padding: "11px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 9, color: C.amber, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <Spinner /> Downloading…
                </div>
                <Btn onClick={() => onCancelDownload(selected)} style={{
                  padding: "11px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
                  borderRadius: 9, color: C.red, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
                }}>
                  Cancel
                </Btn>
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

function ConnectorModal({ connectors, onAdd, onRemove, onClose, onUpdate }) {
  const [adding, setAdding]         = useState(null);
  const [status, setStatus]         = useState("");
  const [pubmedQuery, setPubmedQuery] = useState("");
  const [searching, setSearching]   = useState(false);
  const [expandedId, setExpandedId] = useState(null);

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
        let data = null;
        try {
          data = await invoke("read_excel_sheets", { path: result });
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
        // Compute preview and sheet metadata
        const sheetNames = data?.sheets?.map(s => s.name) || [];
        const firstNonEmpty = data?.sheets?.find(s => s.rows?.length > 0);
        const previewRows = firstNonEmpty ? firstNonEmpty.rows.slice(0, 6) : [];
        const rowCounts = {};
        for (const s of (data?.sheets || [])) { rowCounts[s.name] = s.rows?.length || 0; }
        onAdd({ id: Date.now(), name, path: result, type: "excel", chunks: excelChunks, sync: "Indexed", sheets: sheetNames, activeSheets: sheetNames, previewRows, rowCounts });
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
        onAdd({ id: Date.now(), name, path: result, type: "pdf", chunks, sync: "Indexed", previewText: text.slice(0, 500) });
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
                  const isExpanded = expandedId === c.id;
                  const hasPreview = c.type === "excel" || c.type === "pdf";
                  const sheetsInfo = c.type === "excel" && c.sheets ? `${c.sheets.length} sheet${c.sheets.length !== 1 ? "s" : ""}` : c.type;
                  return (
                    <div key={c.id} style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px" }}>
                        <Icon d={d} size={16} stroke={color} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, color: C.t1, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                          <div style={{ fontSize: 11, color: C.t3 }}>Live sync · {sheetsInfo}</div>
                        </div>
                        {hasPreview && (
                          <Btn onClick={() => setExpandedId(isExpanded ? null : c.id)} style={{ background: isExpanded ? "rgba(59,130,246,0.12)" : C.bgPanel, border: `1px solid ${isExpanded ? C.borderHi : C.border}`, borderRadius: 6, color: isExpanded ? C.blue : C.t3, padding: "5px 8px", display: "flex" }}>
                            <Icon d={IC.eye} size={13} />
                          </Btn>
                        )}
                        <Btn onClick={() => onRemove(c.id)} style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, color: C.red, padding: "5px 8px", display: "flex" }}>
                          <Icon d={IC.trash} size={13} />
                        </Btn>
                      </div>
                      {isExpanded && c.type === "excel" && (
                        <div style={{ borderTop: `1px solid ${C.border}`, padding: "12px 14px" }}>
                          {c.sheets && (
                            <div style={{ marginBottom: 10 }}>
                              <div style={{ fontSize: 10, color: C.t3, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>Sheets</div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                {c.sheets.map(sh => {
                                  const isActive = !c.activeSheets || c.activeSheets.includes(sh);
                                  return (
                                    <label key={sh} style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 9px", background: isActive ? "rgba(59,130,246,0.1)" : "transparent", border: `1px solid ${isActive ? C.borderHi : C.border}`, borderRadius: 20, cursor: "pointer", fontSize: 11, color: isActive ? C.blue : C.t3 }}>
                                      <input type="checkbox" checked={isActive} style={{ margin: 0 }} onChange={() => {
                                        const current = c.activeSheets || c.sheets || [];
                                        const next = isActive ? current.filter(s => s !== sh) : [...current, sh];
                                        if (onUpdate) onUpdate(c.id, { activeSheets: next });
                                      }} />
                                      {sh}
                                      {c.rowCounts?.[sh] ? <span style={{ color: C.t3, fontSize: 10 }}>({c.rowCounts[sh]})</span> : null}
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                          {c.previewRows?.length > 0 && (
                            <div>
                              <div style={{ fontSize: 10, color: C.t3, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>Preview (first 6 rows)</div>
                              <div style={{ overflowX: "auto" }}>
                                <table style={{ borderCollapse: "collapse", fontSize: 10.5, color: C.t2, width: "100%" }}>
                                  <tbody>
                                    {c.previewRows.map((row, ri) => (
                                      <tr key={ri} style={{ borderBottom: `1px solid ${C.border}` }}>
                                        {row.map((cell, ci) => (
                                          <td key={ci} style={{ padding: "3px 8px", borderRight: `1px solid ${C.border}`, whiteSpace: "nowrap", fontWeight: ri === 0 ? 700 : 400, color: ri === 0 ? C.t1 : C.t2 }}>{cell ?? ""}</td>
                                        ))}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {isExpanded && c.type === "pdf" && c.previewText && (
                        <div style={{ borderTop: `1px solid ${C.border}`, padding: "12px 14px" }}>
                          <div style={{ fontSize: 10, color: C.t3, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>Preview</div>
                          <div style={{ maxHeight: 120, overflowY: "auto", fontSize: 11.5, color: C.t2, lineHeight: 1.6, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                            {c.previewText}
                          </div>
                        </div>
                      )}
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
function BugReportCard({ report, onRescan, scanning }) {
  const [expanded, setExpanded] = useState(null);
  if (!report && !scanning) return null;

  const sevColor = (sev) => {
    if (sev === "HIGH")   return "#ef4444";
    if (sev === "MEDIUM") return "#f59e0b";
    if (sev === "LOW")    return "#3b82f6";
    return "#6b7280";
  };
  const sevBg = (sev) => {
    if (sev === "HIGH")   return "rgba(239,68,68,0.1)";
    if (sev === "MEDIUM") return "rgba(245,158,11,0.1)";
    if (sev === "LOW")    return "rgba(59,130,246,0.1)";
    return "rgba(107,114,128,0.1)";
  };

  return (
    <div style={{ margin: "10px 14px 0", border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", background: C.bgCard }}>
      <div style={{ padding: "10px 14px", borderBottom: report?.bugs?.length ? `1px solid ${C.border}` : "none", display: "flex", alignItems: "center", gap: 8, background: "rgba(239,68,68,0.05)" }}>
        <span style={{ fontSize: 14 }}>🐛</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.t1 }}>
            {scanning ? "Scanning for bugs…" : report?.bugs?.length === 0 ? "No issues found ✓" : `${report.bugs.length} issue${report.bugs.length !== 1 ? "s" : ""} found`}
          </div>
          {report?.scannedFile && (
            <div style={{ fontSize: 10, color: C.t3 }}>{report.scannedFile.split(/[\\/]/).pop()}{report.scannedAt ? ` · ${report.scannedAt}` : ""}</div>
          )}
        </div>
        {scanning ? (
          <Spinner />
        ) : (
          <Btn onClick={onRescan} style={{ padding: "3px 10px", fontSize: 11, background: C.bgPanel, border: `1px solid ${C.border}`, borderRadius: 6, color: C.t2, display: "flex", alignItems: "center", gap: 4 }}>
            <Icon d={IC.refresh} size={11} /> Re-scan
          </Btn>
        )}
      </div>
      {!scanning && report?.bugs?.map((bug, i) => (
        <div key={i} style={{ borderBottom: i < report.bugs.length - 1 ? `1px solid ${C.border}` : "none" }}>
          <div onClick={() => setExpanded(expanded === i ? null : i)} style={{ padding: "9px 14px", cursor: "pointer", display: "flex", alignItems: "flex-start", gap: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: sevBg(bug.severity), color: sevColor(bug.severity), flexShrink: 0, marginTop: 1 }}>
              {bug.severity}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.t1 }}>{bug.title}</div>
              {bug.line && <div style={{ fontSize: 10, color: C.t3 }}>Line {bug.line}</div>}
            </div>
            <span style={{ fontSize: 10, color: C.t3 }}>{expanded === i ? "▲" : "▼"}</span>
          </div>
          {expanded === i && (
            <div style={{ padding: "0 14px 12px", borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 12, color: C.t2, marginTop: 8, lineHeight: 1.6 }}>{bug.description}</div>
              {bug.fix && (
                <div style={{ marginTop: 8, padding: "8px 10px", background: "rgba(34,197,94,0.07)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 7 }}>
                  <div style={{ fontSize: 10, color: "#22c55e", fontWeight: 700, marginBottom: 4 }}>SUGGESTED FIX</div>
                  <div style={{ fontSize: 11.5, color: C.t2, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{bug.fix}</div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function SecurityShieldPanel({ shieldedFiles, securityLog, onProtect, onUnprotect, hubClients }) {
  const [protecting, setProtecting] = useState(null);
  const [error, setError] = useState("");

  const handleProtect = async (path, fileType) => {
    setProtecting(path);
    setError("");
    try {
      await onProtect(path, fileType);
    } catch (e) {
      setError("Failed: " + String(e));
    } finally {
      setProtecting(null);
    }
  };

  const connectedFiles = Object.values(hubClients)
    .filter(c => c.file)
    .map(c => ({ path: c.file, language: c.language, editor: c.editor }));

  const uniqueFiles = [...new Map(connectedFiles.map(f => [f.path, f])).values()];

  const eventColor = (ev) => ev === "modified" ? C.amber : C.red;
  const eventIcon = (ev) => ev === "modified" ? "✏️" : "🗑️";

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.25)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🛡️</div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.t1 }}>Security Shield</div>
          <div style={{ fontSize: 11, color: C.t3 }}>Protect files · Generate decoys · Monitor changes</div>
        </div>
      </div>

      {error && <div style={{ padding: "8px 12px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, fontSize: 12, color: C.red }}>{error}</div>}

      {/* Connected files from Hub */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color: C.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Files Via Hub</div>
        {uniqueFiles.length === 0 ? (
          <div style={{ fontSize: 12, color: C.t3, padding: "10px 0" }}>No files connected via VS Code Hub yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {uniqueFiles.map(f => {
              const isProtected = !!shieldedFiles[f.path];
              const entry = shieldedFiles[f.path];
              const fileName = f.path.split(/[\\/]/).pop();
              const ext = fileName.split(".").pop()?.toLowerCase() || "";
              const ftype = ["xlsx","xls","xlsm"].includes(ext) ? "excel" : ["pdf"].includes(ext) ? "pdf" : "code";
              return (
                <div key={f.path} style={{ padding: "11px 14px", background: isProtected ? "rgba(34,197,94,0.06)" : C.bgCard, border: `1px solid ${isProtected ? "rgba(34,197,94,0.3)" : C.border}`, borderRadius: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 16 }}>{isProtected ? "🛡️" : "📄"}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: C.t1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fileName}</div>
                      <div style={{ fontSize: 10, color: C.t3 }}>{f.language || ext} · {f.path}</div>
                    </div>
                    {isProtected ? (
                      <Btn onClick={() => onUnprotect(f.path)} style={{ padding: "4px 10px", fontSize: 11, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 6, color: C.red }}>
                        Unprotect
                      </Btn>
                    ) : (
                      <Btn onClick={() => handleProtect(f.path, ftype)} disabled={protecting === f.path} style={{ padding: "4px 10px", fontSize: 11, background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 6, color: "#22c55e", display: "flex", alignItems: "center", gap: 4 }}>
                        {protecting === f.path ? <Spinner /> : "🛡️ Protect"}
                      </Btn>
                    )}
                  </div>
                  {isProtected && entry?.decoyPath && (
                    <div style={{ marginTop: 8, padding: "7px 10px", background: "rgba(34,197,94,0.05)", borderRadius: 7, fontSize: 11, color: C.t3 }}>
                      ✓ Protected since {entry.protectedAt} · Decoy generated<br />
                      <span style={{ fontFamily: "monospace", fontSize: 10, color: C.t2 }}>{entry.decoyPath.split(/[\\/]/).pop()}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Security Log */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color: C.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          Security Log
          {securityLog.length > 0 && <span style={{ fontSize: 10, padding: "1px 7px", background: "rgba(239,68,68,0.15)", borderRadius: 10, color: C.red }}>{securityLog.length}</span>}
        </div>
        {securityLog.length === 0 ? (
          <div style={{ fontSize: 12, color: C.t3, padding: "10px 0" }}>No events recorded. Protected files will appear here when modifications are detected.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {securityLog.slice(0, 20).map((entry, i) => (
              <div key={entry.id || i} style={{ padding: "8px 12px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ fontSize: 13 }}>{eventIcon(entry.event)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: eventColor(entry.event), fontWeight: 600 }}>{entry.file_name} — {entry.event}</div>
                  <div style={{ fontSize: 10, color: C.t3, marginTop: 1 }}>{entry.timestamp} · {entry.path}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HubPanel({ hubClients, activeHubId, setActiveHubId, hubStreaming, onSendHub, onApply, activeModelId, trialDaysLeft, bugReports, onBugScan, shieldedFiles, securityLog, onShieldProtect, onShieldUnprotect }) {
  const [hubInput, setHubInput] = useState("");
  const hubInputRef = useRef(null);
  const hubBottomRef = useRef(null);
  const [hubTab, setHubTab] = useState("chat"); // "chat" | "shield"

  const clientList = Object.values(hubClients);
  const active = hubClients[activeHubId] || clientList[0] || null;

  useEffect(() => {
    hubBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages, activeHubId]);

  // Editor badge colour
  const editorColor = (editor) => {
    if (editor === "cursor")   return C.purple;
    if (editor === "windsurf") return C.green;
    if (editor === "excel")    return "#1D6F42"; // Excel green
    return C.blue; // vscode
  };

  const editorLabel = (editor) => {
    if (editor === "cursor")   return "Cursor";
    if (editor === "windsurf") return "Windsurf";
    if (editor === "excel")    return "Excel";
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

      {/* ── Tab bar ── */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, background: C.bgPanel }}>
        {[["chat", "💬 Chat"], ["shield", "🛡️ Shield"]].map(([id, label]) => (
          <Btn key={id} onClick={() => setHubTab(id)} style={{
            padding: "9px 18px", fontSize: 12, fontWeight: hubTab === id ? 700 : 400,
            color: hubTab === id ? C.t1 : C.t2, border: "none", borderBottom: `2px solid ${hubTab === id ? C.purple : "transparent"}`,
            background: "transparent", borderRadius: 0,
          }}>{label}</Btn>
        ))}
      </div>

      {hubTab === "shield" ? (
        <SecurityShieldPanel
          shieldedFiles={shieldedFiles || {}}
          securityLog={securityLog || []}
          onProtect={onShieldProtect}
          onUnprotect={onShieldUnprotect}
          hubClients={hubClients}
        />
      ) : (
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
                {active.file && (
                  <Btn onClick={() => onBugScan(active.id)} disabled={bugReports?.[active.id]?.scanning} style={{ padding: "4px 10px", fontSize: 11, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, color: C.red, display: "flex", alignItems: "center", gap: 4 }}>
                    {bugReports?.[active.id]?.scanning ? <><Spinner /> Scanning…</> : "🐛 Scan"}
                  </Btn>
                )}
              </div>

              {/* Selected code preview */}
              {active.selectedCode && (
                <div style={{ marginTop: 10, padding: "8px 12px", background: C.bgDeep, border: `1px solid ${C.border}`, borderRadius: 8, fontFamily: "monospace", fontSize: 11, color: C.cyan, maxHeight: 80, overflow: "hidden", position: "relative" }}>
                  <div style={{ fontSize: 9, color: C.t3, marginBottom: 4, fontFamily: "inherit" }}>SELECTED CODE</div>
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{active.selectedCode.slice(0, 200)}{active.selectedCode.length > 200 ? "…" : ""}</div>
                </div>
              )}
            </div>

            {/* Bug Report Card */}
            {active && (
              <BugReportCard
                report={bugReports?.[active.id]}
                scanning={bugReports?.[active.id]?.scanning}
                onRescan={() => onBugScan(active.id)}
              />
            )}

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
      )}
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

// ─── Prompt Templates ─────────────────────────────────────────────────────────
// Each template has: label, icon (emoji), hint (shown under label), prompt (injected into input)
// [TOPIC] is the placeholder the user replaces with their subject.
const TEMPLATE_CATEGORIES = [
  {
    id: "education",
    label: "Education",
    icon: "🎓",
    templates: [
      {
        label: "MCQ — Quantitative",
        icon: "🔢",
        hint: "Numbered problems with 4 options & answers",
        prompt: `Generate 10 MCQ quantitative questions for MBA entrance exam on the topic: [TOPIC]

Rules (strictly follow):
- Every question MUST contain specific numbers (prices, percentages, quantities)
- Every question MUST require a calculation to solve
- Every question MUST have exactly 4 options: (A) (B) (C) (D)
- Every question MUST have one correct numerical answer shown at the end
- Do NOT ask definition or conceptual questions

Example:
Q1. A trader buys an article for Rs. 450 and sells it for Rs. 540. What is the profit percentage?
(A) 15%  (B) 20%  (C) 25%  (D) 18%
Answer: (B) 20%

Now generate 10 questions in exactly this format.`,
      },
      {
        label: "MCQ — Verbal / English",
        icon: "📝",
        hint: "Grammar, vocabulary & reading comprehension",
        prompt: `Generate 10 MCQ verbal ability questions for MBA entrance exam on the topic: [TOPIC]

Rules:
- Each question must test a specific language skill (grammar rule, vocabulary, sentence correction, etc.)
- Every question must have exactly 4 options: (A) (B) (C) (D)
- Include the correct answer with a brief explanation after each question
- Vary difficulty: 3 easy, 4 medium, 3 hard
- Do NOT repeat the same question type consecutively

Format:
Q1. [Question]
(A) ... (B) ... (C) ... (D) ...
Answer: (X) — [one-line explanation]

Generate 10 questions now.`,
      },
      {
        label: "Concept Explainer",
        icon: "💡",
        hint: "Break down complex topics simply",
        prompt: `Explain the concept of [TOPIC] clearly and simply.

Structure your response as:
1. **What it is** — one sentence definition
2. **Why it matters** — real-world importance
3. **How it works** — step-by-step breakdown (use numbered points)
4. **Simple analogy** — relate it to everyday life
5. **Common mistakes** — 2-3 misconceptions to avoid
6. **Quick example** — a solved worked example

Keep the language simple enough for a first-year student.`,
      },
      {
        label: "Study Notes",
        icon: "📚",
        hint: "Structured revision notes with key points",
        prompt: `Create comprehensive study notes for the topic: [TOPIC]

Format:
## [TOPIC] — Study Notes

### Key Definitions
(bullet list of 5-8 essential terms with concise definitions)

### Core Concepts
(numbered list of the most important ideas to understand)

### Important Formulas / Rules
(if applicable — list with brief explanation)

### Common Exam Questions
(3 typical questions that appear on this topic)

### Quick Revision Summary
(5 bullet points to remember — most testable facts)`,
      },
      {
        label: "Flashcards",
        icon: "🃏",
        hint: "Q&A pairs for active recall practice",
        prompt: `Generate 15 flashcards for studying: [TOPIC]

Format each flashcard as:
**Q:** [question]
**A:** [concise answer — max 2 sentences]

---

Rules:
- Cover definitions, formulas, applications, and common gotchas
- Keep answers short enough to memorize
- Progress from basic to advanced
- Number each card (Card 1/15, Card 2/15, etc.)`,
      },
    ],
  },
  {
    id: "writing",
    label: "Writing",
    icon: "✍️",
    templates: [
      {
        label: "Professional Email",
        icon: "📧",
        hint: "Formal, clear and action-oriented",
        prompt: `Write a professional email about: [TOPIC]

Requirements:
- Subject line: clear and specific
- Opening: polite and direct
- Body: explain the purpose in 2-3 short paragraphs
- Call to action: one clear next step
- Closing: professional sign-off

Tone: formal but friendly. Keep it under 200 words.`,
      },
      {
        label: "Essay Writer",
        icon: "📄",
        hint: "5-paragraph structured essay",
        prompt: `Write a well-structured essay on: [TOPIC]

Structure:
**Introduction** (hook + thesis statement)

**Body Paragraph 1** — Main argument with evidence
**Body Paragraph 2** — Supporting point with example
**Body Paragraph 3** — Counter-argument + rebuttal

**Conclusion** (restate thesis + broader implication)

Word count: ~400-500 words. Use clear transitions between paragraphs.`,
      },
      {
        label: "Cover Letter",
        icon: "💼",
        hint: "Job application cover letter",
        prompt: `Write a compelling cover letter for: [TOPIC] (e.g. "Software Engineer role at a fintech startup")

Structure:
- **Opening paragraph**: express interest + how you found the role
- **Middle paragraph 1**: your most relevant experience and skills
- **Middle paragraph 2**: specific achievement that proves your value (use numbers if possible)
- **Closing paragraph**: enthusiasm + call to action (interview request)

Tone: confident, specific, professional. Keep it to one page (~300 words).`,
      },
      {
        label: "Report Summary",
        icon: "📊",
        hint: "Executive summary of a report or document",
        prompt: `Write an executive summary for a report on: [TOPIC]

Include:
1. **Purpose** — what the report covers and why it matters
2. **Key Findings** — 3-5 bullet points with the most important data/insights
3. **Recommendations** — 2-3 actionable next steps
4. **Conclusion** — one sentence on the overall takeaway

Keep it under 250 words. Use clear, non-technical language suitable for senior management.`,
      },
      {
        label: "Meeting Minutes",
        icon: "🗒️",
        hint: "Structured notes from a meeting",
        prompt: `Generate meeting minutes template for a meeting about: [TOPIC]

Format:
**Meeting Minutes**
Date: [Date] | Time: [Time] | Location: [Location]
Attendees: [Names]

**Agenda Items Discussed:**
1. [Item 1]
   - Discussion summary:
   - Decision made:
   - Action item: [Who] will [what] by [when]

2. [Item 2]
   - Discussion summary:
   - Decision made:
   - Action item:

**Next Steps Summary:**
| Action | Owner | Deadline |
|--------|-------|----------|

**Next Meeting:** [Date/Time]`,
      },
    ],
  },
  {
    id: "coding",
    label: "Coding",
    icon: "💻",
    templates: [
      {
        label: "Code Review",
        icon: "🔍",
        hint: "Analyze code for bugs, style & improvements",
        prompt: `Review the following [TOPIC] code for:

1. **Bugs & Errors** — logic errors, edge cases, potential crashes
2. **Performance** — inefficiencies, unnecessary loops, memory issues
3. **Security** — vulnerabilities, unsafe inputs, injection risks
4. **Readability** — naming, structure, comments
5. **Best Practices** — language conventions, design patterns

For each issue found:
- Quote the problematic line(s)
- Explain the problem
- Provide the corrected version

End with an overall score (1-10) and top 3 priority fixes.

[Paste your code below]`,
      },
      {
        label: "Debug Helper",
        icon: "🐛",
        hint: "Find and fix errors in code",
        prompt: `Help me debug this [TOPIC] code.

Please:
1. **Identify the bug** — what is going wrong and why
2. **Root cause** — trace the exact source of the error
3. **Fix** — provide the corrected code with changes highlighted
4. **Explanation** — explain what the fix does in plain English
5. **Prevention** — how to avoid this type of error in the future

[Paste your code and error message below]`,
      },
      {
        label: "Explain Code",
        icon: "🧩",
        hint: "Line-by-line explanation of code",
        prompt: `Explain this [TOPIC] code in simple terms.

Please provide:
1. **Overview** — what does this code do in one sentence?
2. **Line-by-line breakdown** — explain each significant part
3. **Data flow** — how data moves through the code
4. **Dependencies** — what external libraries/functions are used and why
5. **Example output** — what would this produce given a sample input?

Assume the reader is a beginner. Avoid jargon.

[Paste your code below]`,
      },
      {
        label: "Write Function",
        icon: "⚙️",
        hint: "Generate a function with docs & tests",
        prompt: `Write a [TOPIC] function with the following requirements:

[Describe what the function should do, its inputs, and expected output]

Please provide:
1. **The function** — clean, well-structured implementation
2. **Inline comments** — explaining non-obvious logic
3. **Docstring/JSDoc** — parameters, return type, description
4. **Edge cases handled** — list what edge cases the code handles
5. **Unit tests** — 3-5 test cases covering normal + edge cases`,
      },
      {
        label: "Unit Tests",
        icon: "✅",
        hint: "Generate test cases for existing code",
        prompt: `Write comprehensive unit tests for the following [TOPIC] code.

Cover:
1. **Happy path** — normal expected usage (3+ cases)
2. **Edge cases** — empty inputs, zero, null, boundary values
3. **Error cases** — invalid inputs, exceptions that should be thrown
4. **Integration** — if functions call each other, test the combination

Use the standard testing framework for [TOPIC] (e.g. Jest for JS, pytest for Python).
Add a comment above each test explaining what it tests.

[Paste your code below]`,
      },
    ],
  },
  {
    id: "research",
    label: "Research",
    icon: "🔬",
    templates: [
      {
        label: "Research Summary",
        icon: "📑",
        hint: "Summarize a paper or article",
        prompt: `Summarize the research on: [TOPIC]

Structure:
1. **Research Question** — what problem does this research address?
2. **Methodology** — how was the research conducted?
3. **Key Findings** — top 3-5 findings with supporting data
4. **Limitations** — what are the weaknesses or constraints of the study?
5. **Implications** — real-world applications of this research
6. **My Takeaway** — the single most important insight

Be factual and concise. Use bullet points where possible.`,
      },
      {
        label: "Compare & Contrast",
        icon: "⚖️",
        hint: "Side-by-side analysis of two things",
        prompt: `Compare and contrast: [TOPIC] (e.g. "Python vs JavaScript for backend development")

Format:
| Criteria | Option A | Option B |
|----------|----------|----------|
| [aspect] | ... | ... |

Cover these dimensions:
1. Core differences
2. Strengths of each
3. Weaknesses of each
4. Best use cases for each
5. **Recommendation** — which to choose and when

Conclude with a clear, opinionated recommendation based on common use cases.`,
      },
      {
        label: "Pros & Cons",
        icon: "🔄",
        hint: "Balanced analysis of any topic or decision",
        prompt: `Provide a detailed pros and cons analysis of: [TOPIC]

**PROS (Advantages)**
1. [Pro 1] — explanation
2. [Pro 2] — explanation
3. [Pro 3] — explanation
(continue for all significant pros)

**CONS (Disadvantages)**
1. [Con 1] — explanation
2. [Con 2] — explanation
3. [Con 3] — explanation
(continue for all significant cons)

**Verdict:** [2-3 sentence balanced conclusion with a recommendation]

Base the analysis on facts and real-world evidence.`,
      },
      {
        label: "Literature Review",
        icon: "📖",
        hint: "Academic overview of research on a topic",
        prompt: `Write a literature review outline for the topic: [TOPIC]

Include:
1. **Introduction** — scope and importance of the topic
2. **Theoretical Framework** — key theories and models
3. **Major Research Themes** — 3-4 recurring themes in the literature
4. **Conflicting Views** — where researchers disagree and why
5. **Gaps in Research** — what has not been studied yet
6. **Conclusion** — synthesis and direction for future research

For each section, suggest 2-3 types of sources to look for (e.g. "longitudinal studies on X", "meta-analyses of Y").`,
      },
    ],
  },
  {
    id: "business",
    label: "Business",
    icon: "📈",
    templates: [
      {
        label: "SWOT Analysis",
        icon: "🎯",
        hint: "Strengths, Weaknesses, Opportunities, Threats",
        prompt: `Perform a detailed SWOT analysis for: [TOPIC]

**STRENGTHS (Internal — what the business does well):**
1.
2.
3.

**WEAKNESSES (Internal — areas that need improvement):**
1.
2.
3.

**OPPORTUNITIES (External — favorable conditions to exploit):**
1.
2.
3.

**THREATS (External — risks or challenges to address):**
1.
2.
3.

**STRATEGIC INSIGHTS:**
- SO Strategy (use strengths to exploit opportunities):
- WO Strategy (overcome weaknesses using opportunities):
- ST Strategy (use strengths to counter threats):
- WT Strategy (minimize weaknesses, avoid threats):`,
      },
      {
        label: "Business Plan",
        icon: "🏢",
        hint: "One-page business plan outline",
        prompt: `Create a one-page business plan for: [TOPIC]

**Executive Summary** (2-3 sentences on what the business does)

**Problem & Solution**
- Problem: [what pain point does this solve?]
- Solution: [how does the product/service solve it?]

**Target Market**
- Primary audience:
- Market size estimate:

**Revenue Model** (how does it make money?)

**Competitive Advantage** (why will customers choose this over alternatives?)

**Key Milestones** (3-month, 6-month, 1-year goals)

**Financials** (estimated startup cost, monthly burn, break-even point)

**Team** (key roles needed)`,
      },
      {
        label: "Marketing Copy",
        icon: "📣",
        hint: "Persuasive product or service copy",
        prompt: `Write compelling marketing copy for: [TOPIC]

Provide all 3 formats:

**1. Tagline** (5-8 words, memorable)

**2. Short Ad Copy** (30 words — for social media or banner ads)

**3. Full Product Description** (100-150 words — for website or brochure)
Structure: Hook → Problem → Solution → Benefits (bullet points) → Call to Action

Use persuasive language, focus on benefits not features, and address the target customer's pain points directly.`,
      },
      {
        label: "Job Description",
        icon: "👔",
        hint: "Professional job posting",
        prompt: `Write a professional job description for: [TOPIC] (e.g. "Senior Frontend Developer at a fintech startup")

Include:
**Job Title:**
**Location:**
**Employment Type:**

**About the Role** (2-3 sentences)

**Key Responsibilities** (6-8 bullet points starting with action verbs)

**Required Qualifications** (must-haves)

**Preferred Qualifications** (nice-to-haves)

**What We Offer** (benefits, culture, growth)

**How to Apply**

Keep the tone professional yet welcoming. Avoid jargon and keep requirements realistic.`,
      },
    ],
  },
  {
    id: "creative",
    label: "Creative",
    icon: "🎨",
    templates: [
      {
        label: "Brainstorm Ideas",
        icon: "💭",
        hint: "Generate diverse ideas on any topic",
        prompt: `Brainstorm 15 creative ideas for: [TOPIC]

Format each idea as:
**Idea [N]: [Catchy Name]**
[2-sentence description of the idea and why it's interesting]

Rules:
- Make ideas diverse — vary from conventional to wild/unconventional
- Ideas 1-5: practical and easy to implement
- Ideas 6-10: moderately ambitious
- Ideas 11-15: bold, creative, or disruptive

End with your top 3 picks and why.`,
      },
      {
        label: "Short Story",
        icon: "📖",
        hint: "A complete short story with structure",
        prompt: `Write a short story about: [TOPIC]

Story structure:
- **Setup** (introduce character + setting in first paragraph)
- **Conflict** (introduce the central problem or tension)
- **Rising action** (2-3 paragraphs building toward climax)
- **Climax** (the turning point)
- **Resolution** (satisfying ending)

Guidelines:
- Show don't tell — use sensory details
- Include at least one line of dialogue
- Word count: 350-500 words
- End with something memorable`,
      },
      {
        label: "Poem",
        icon: "🌸",
        hint: "Structured poem with vivid imagery",
        prompt: `Write a poem about: [TOPIC]

Write it in this format:
- **3 stanzas of 4 lines each**
- Use a consistent ABAB or AABB rhyme scheme
- Include at least 2 vivid metaphors or similes
- End with a powerful, thought-provoking final line

Then write a second version as **free verse** (no rhyme, but with strong rhythm and imagery).

Label each version clearly.`,
      },
      {
        label: "Product Names",
        icon: "🏷️",
        hint: "Creative naming ideas for products or brands",
        prompt: `Generate 20 creative name ideas for: [TOPIC] (e.g. "a mobile app that tracks water intake")

Group them by style:

**Descriptive Names** (tell what it does)
**Metaphorical Names** (evoke a feeling or concept)
**Made-up / Invented Words** (portmanteau, modified words)
**Short & Punchy** (1-2 syllables, easy to remember)
**Action-Oriented** (start with a verb)

For each name provide:
- The name
- One sentence on the meaning/inspiration
- Domain availability rating (likely available / might be taken / probably taken)

Highlight your top 5 picks with ⭐`,
      },
    ],
  },
];

// ─── Template Panel Component ─────────────────────────────────────────────────
function TemplatePanel({ onSelect, onClose }) {
  const [activeCategory, setActiveCategory] = useState("education");
  const cat = TEMPLATE_CATEGORIES.find(c => c.id === activeCategory);
  return (
    <div style={{
      position: "absolute", bottom: "calc(100% + 8px)", left: 0, right: 0,
      background: C.bgPanel, border: `1px solid ${C.border}`, borderRadius: 14,
      boxShadow: "0 -8px 32px rgba(0,0,0,0.5)", zIndex: 200, overflow: "hidden",
      display: "flex", flexDirection: "column", maxHeight: 420,
    }}>
      {/* Header */}
      <div style={{ padding: "12px 16px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.t1 }}>⚡ Prompt Templates</span>
        <Btn onClick={onClose} style={{ background: "none", border: "none", color: C.t3, padding: 4, borderRadius: 6 }}>
          <Icon d={IC.x} size={14} />
        </Btn>
      </div>
      {/* Category tabs */}
      <div style={{ display: "flex", gap: 4, padding: "10px 16px 0", overflowX: "auto", flexShrink: 0 }}>
        {TEMPLATE_CATEGORIES.map(c => (
          <Btn key={c.id} onClick={() => setActiveCategory(c.id)} style={{
            padding: "5px 12px", borderRadius: 20, fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap",
            background: activeCategory === c.id ? C.blue : C.bgCard,
            border: `1px solid ${activeCategory === c.id ? C.blue : C.border}`,
            color: activeCategory === c.id ? "#fff" : C.t2,
          }}>
            {c.icon} {c.label}
          </Btn>
        ))}
      </div>
      {/* Templates grid */}
      <div style={{ overflowY: "auto", padding: "10px 16px 14px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {cat?.templates.map(t => (
          <Btn key={t.label} onClick={() => onSelect(t.prompt)} style={{
            background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 10,
            padding: "10px 12px", textAlign: "left", display: "flex", flexDirection: "column", gap: 3,
            cursor: "pointer", transition: "border-color 0.15s",
          }}
            onMouseEnter={e => e.currentTarget.style.borderColor = C.blue}
            onMouseLeave={e => e.currentTarget.style.borderColor = C.border}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>{t.icon} {t.label}</span>
            <span style={{ fontSize: 11, color: C.t3, lineHeight: 1.4 }}>{t.hint}</span>
          </Btn>
        ))}
      </div>
    </div>
  );
}

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
  const [showTemplates, setShowTemplates] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [showConn, setShowConn] = useState(false);
  const [showMod, setShowMod] = useState(false);
  const [connectors, setConnectors] = useState(() => {
    try { return JSON.parse(localStorage.getItem("connectors") || "[]"); } catch { return []; }
  });
  const [sSearch, setSSearch] = useState("");
  const [contextMenu, setContextMenu] = useState(null); // null | { chatId, x, y }
  const [renamingId, setRenamingId] = useState(null);   // chatId being renamed
  const [renameVal, setRenameVal] = useState("");

  // modelState: { [modelId]: { status: "not-downloaded"|"downloading"|"downloaded"|"loaded"|"error", progress?, error? } }
  const [modelState, setModelState] = useState({});
  const [activeModelId, setActiveModelId] = useState(null); // set only after server is ready
  const [modelLoading, setModelLoading] = useState(false);
  const [hfToken, setHfToken] = useState(() => localStorage.getItem("hf_token") || "");
  const [serverReady, setServerReady] = useState(null); // null=checking, true/false
  const [setupProgress, setSetupProgress] = useState(null); // null | { step, downloaded?, total? }
  const [selectedLang, setSelectedLang] = useState("auto"); // language selector
  const [autoDetectedLang, setAutoDetectedLang] = useState("en"); // tracks detected lang in Auto mode

  const [localIP, setLocalIP]           = useState(null);

  // ── Extension Hub state (desktop only) ────────────────────────────────────
  // hubClients: { [id]: { id, editor, file, language, selectedCode, cursorLine, messages: [] } }
  const [showHub, setShowHub] = useState(false);
  const [hubClients, setHubClients] = useState({});
  const [activeHubId, setActiveHubId] = useState(null);
  const [hubStreaming, setHubStreaming] = useState(false);
  const hubStreamBufRef  = useRef("");
  const hubStreamMsgRef  = useRef(null);   // { clientId, msgId }
  const [hubBugReports, setHubBugReports] = useState({});
  // { [clientId]: { scanning: bool, bugs: [], scannedFile: '', scannedAt: null } }

  // ── Security Shield state ─────────────────────────────────────────────────
  const [shieldedFiles, setShieldedFiles] = useState({});
  // { [path]: { decoyPath, protectedAt, fileName, fileType } }
  const [securityLog, setSecurityLog] = useState([]);
  const [showSecurityLog, setShowSecurityLog] = useState(false);

  // Detect mobile — width-based (reliable, ignores "Request Desktop Site")
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth > 768);
  const [mobileTab, setMobileTab] = useState("chat"); // "chat" | "music" | "games"
  // LAN AI: desktop IP for mobile browser to connect to
  const [lanIP, setLanIP]       = useState(() => localStorage.getItem("lan_ip") || "");
  const [showLanSet, setShowLanSet] = useState(false);
  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth > 768);
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // ── WebLLM — offline AI inside mobile browser via WebGPU ─────────────────
  // Status: "idle" | "checking" | "downloading" | "loading" | "ready" | "error"
  const [wllmStatus,   setWllmStatus]   = useState("idle");
  const [wllmProgress, setWllmProgress] = useState(0);
  const [wllmMsg,      setWllmMsg]      = useState("");
  const [wllmModel,    setWllmModel]    = useState(() => localStorage.getItem("wllm_model") || "Qwen2.5-0.5B-Instruct-q4f16_1-MLC");
  const wllmEngineRef = useRef(null); // holds the loaded MLCEngine instance

  const WLLM_MODELS = [
    { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",   label: "Qwen2.5 0.5B",  size: "~390 MB", note: "Fastest, good for chat" },
    { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",   label: "Qwen2.5 1.5B",  size: "~940 MB", note: "Better quality" },
    { id: "Phi-3.5-mini-instruct-q4f16_1-MLC",    label: "Phi-3.5 Mini",  size: "~2.1 GB", note: "Best quality, needs 3GB RAM" },
  ];

  const initWebLLM = async (modelId) => {
    const mid = modelId || wllmModel;
    setWllmStatus("downloading");
    setWllmProgress(0);
    setWllmMsg("Initialising…");
    try {
      const engine = await WebLLM.CreateMLCEngine(mid, {
        initProgressCallback: (p) => {
          setWllmProgress(Math.round((p.progress || 0) * 100));
          setWllmMsg(p.text || "Loading…");
        },
      });
      wllmEngineRef.current = engine;
      localStorage.setItem("wllm_model", mid);
      setWllmModel(mid);
      setWllmStatus("ready");
      setWllmMsg("AI ready — fully offline");
    } catch (err) {
      setWllmStatus("error");
      setWllmMsg(String(err));
    }
  };

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

  // Fetch local IP for mobile QR bridge
  useEffect(() => {
    invoke("get_local_ip").then(ip => setLocalIP(ip)).catch(() => {});
  }, []);

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

  // ── On mount: check which models are already on disk + auto-reconnect ──────
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

      // Auto-reconnect the last used model if it's still on disk
      const saved = localStorage.getItem("active_model_id");
      if (saved && updates[saved]?.status === "downloaded") {
        loadModel(saved);
      }
    };
    check();
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ── Security Shield: poll Rust every 3 s for file tampering ──────────────
  // Rust "shield_check_files" compares mtime/atime/size against baseline and
  // emits "shield-alert" events (which we also catch here as direct return).
  const shieldedFilesRef = useRef(shieldedFiles);
  useEffect(() => { shieldedFilesRef.current = shieldedFiles; }, [shieldedFiles]);

  useEffect(() => {
    // Also listen for the Tauri event (belt-and-suspenders)
    let unlisten;
    listen("shield-alert", (event) => {
      const entry = event.payload;
      setSecurityLog(prev => [{ ...entry, id: Date.now() }, ...prev.slice(0, 99)]);
    }).then(u => { unlisten = u; });

    // Active poll every 3 s — only when at least one file is protected
    const timer = setInterval(async () => {
      if (Object.keys(shieldedFilesRef.current).length === 0) return;
      try {
        const fired = await invoke("shield_check_files");
        if (fired && fired.length > 0) {
          setSecurityLog(prev => {
            const next = [...fired.map(e => ({ ...e, id: Date.now() + Math.random() })), ...prev];
            return next.slice(0, 100);
          });
        }
      } catch (e) { /* ignore – Tauri not available in browser preview */ }
    }, 3000);

    return () => { unlisten?.(); clearInterval(timer); };
  }, []);

  // ── Persist active model ID so app reconnects automatically on next launch ─
  useEffect(() => {
    if (activeModelId) localStorage.setItem("active_model_id", activeModelId);
    else localStorage.removeItem("active_model_id");
  }, [activeModelId]);

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
  // Persist to localStorage (fast, session-safe)
  useEffect(() => { try { localStorage.setItem("codeforge_chats", JSON.stringify(chats)); } catch {} }, [chats]);
  // Persist connectors (sources) — strips no data, safe for typical research docs
  useEffect(() => { try { localStorage.setItem("connectors", JSON.stringify(connectors)); } catch {} }, [connectors]);

  // Also persist to Tauri native storage (survives app reinstall, gives user a real file path)
  // Runs debounced so we don't write on every keystroke
  useEffect(() => {
    if (typeof window.__tauriInvoke !== "function") { return; }
    const timer = setTimeout(async () => {
      for (const ch of chats) {
        if (!ch.messages?.length) { continue; }
        try {
          await invoke("db_save_conversation", {
            conversation: {
              id:        String(ch.id),
              title:     ch.title || "Chat",
              timestamp: Date.now(),
              language:  "general",
              messages:  (ch.messages || []).map(m => ({
                role:      m.role || (m.sender === "user" ? "user" : "assistant"),
                content:   m.text || m.content || "",
                model:     m.model || "local",
                tokens:    m.tokens || 0,
                timestamp: m.timestamp || Date.now(),
              })),
            },
          });
        } catch { /* non-critical — localStorage already saved */ }
      }
    }, 2000); // 2s debounce
    return () => clearTimeout(timer);
  }, [chats]);

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
    let unlisten;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("update-progress", e => setUpdateProgress(e.payload));
    } catch {}
    try {
      await invoke("install_update");
      // Rust calls app.restart() — app closes and relaunches automatically
    } catch (err) {
      console.warn("[update] auto-install failed, opening browser:", err);
      // Fall back: open the GitHub releases page so the user can download manually
      const releaseUrl = updateAvailable?.url || "https://github.com/Edu124/Codeforge-ai/releases/latest";
      try {
        const { open } = await import("@tauri-apps/plugin-shell");
        await open(releaseUrl);
      } catch {
        window.open(releaseUrl, "_blank");
      }
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

  // ── Cancel in-progress download ───────────────────────────────────────────
  const cancelDownload = async (modelId) => {
    try {
      await invoke("cancel_download");
    } catch {}
    setModelState(prev => ({ ...prev, [modelId]: { status: "not-downloaded" } }));
  };

  // ── Delete model from disk ────────────────────────────────────────────────
  const deleteModel = async (modelId) => {
    const model = MODELS.find(m => m.id === modelId);
    const confirmed = window.confirm(
      `Delete ${model?.label || modelId} from your device?\n\nThis will permanently remove the model file (~${model ? (model.sizeMB / 1024).toFixed(1) : "?"}  GB) from your hard drive.`
    );
    if (!confirmed) return;
    if (activeModelId === modelId) {
      await invoke("unload_model").catch(() => {});
      setActiveModelId(null);
    }
    try {
      await invoke("delete_model", { modelId });
      setModelState(prev => ({ ...prev, [modelId]: { status: "not-downloaded" } }));
    } catch (err) {
      alert("Could not delete model: " + err);
    }
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

    // Analytics engine still uses stored chunks for structured value lookup
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

    // Live-read sources from disk for full-fidelity LLM context (desktop only).
    // Excel connectors are excluded — the Excel agent handles them via tool-calling
    // so they never go through the prompt directly (avoids token overflow).
    const nonExcelConnectors = connectors.filter(c => c.type !== "excel");
    let liveCtx = null;
    if (nonExcelConnectors.length && typeof window.__TAURI__ !== "undefined") {
      try { liveCtx = await readSourcesLive(nonExcelConnectors); } catch (e) { console.warn("[sources]", e); }
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
      const detectedCurrent  = detectLanguage(text);
      const recentCtx        = history.slice(-4).filter(m => m.role === "user").map(m => m.text).join(" ");
      const detectedCombined = detectLanguage(`${text} ${recentCtx}`);

      if (text.length >= 60 && detectedCurrent === "en") {
        // Long message that is clearly English — always reset to English
        // (handles templates/structured prompts sent inside a non-English conversation)
        effectiveLang = "en";
        setAutoDetectedLang("en");
        autoDetectedLangRef.current = "en";
      } else if (detectedCombined !== "en") {
        // Non-English detected from current + recent context — make it sticky
        effectiveLang = detectedCombined;
        setAutoDetectedLang(detectedCombined);
        autoDetectedLangRef.current = detectedCombined;
      } else {
        // Short/ambiguous message — keep previously detected language (e.g. "ok", "yes")
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

    const prompt = buildPrompt(history, text + analyticsNote, liveCtx ? [] : ctxChunks, connectors, activeModelId, effectiveLang, liveCtx);

    // Mobile browser — prefer WebLLM (fully offline), fall back to LAN
    const isTauri = typeof window.__TAURI__ !== "undefined";
    if (!isTauri) {
      // ── Option A: WebLLM engine ready — run fully offline ──────────────────
      if (wllmEngineRef.current && wllmStatus === "ready") {
        try {
          const msgs = [
            { role: "system", content: buildSystemPrompt(connectors) },
            ...history.slice(-10).map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.text })),
            { role: "user", content: text },
          ];
          const stream = await wllmEngineRef.current.chat.completions.create({
            messages: msgs,
            stream: true,
            max_tokens: 8192,
            temperature: 0.5,
          });
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content || "";
            if (delta) {
              streamBufRef.current += delta;
              const buf = streamBufRef.current;
              setChats(prev => prev.map(ch => ch.id === activeRef.current
                ? { ...ch, messages: ch.messages.map(m => m.id === aiMsgId ? { ...m, text: buf, streaming: true } : m) }
                : ch));
            }
          }
          setChats(prev => prev.map(ch => ch.id === activeRef.current
            ? { ...ch, messages: ch.messages.map(m => m.id === aiMsgId ? { ...m, streaming: false } : m) }
            : ch));
        } catch (err) {
          setChats(prev => prev.map(ch => ch.id === activeRef.current
            ? { ...ch, messages: ch.messages.map(m => m.id === aiMsgId ? { ...m, text: `⚠️ WebLLM error: ${err}`, streaming: false } : m) }
            : ch));
        }
        setStreaming(false);
        streamBufRef.current = "";
        streamMsgIdRef.current = null;
        return;
      }

      // ── Option B: LAN IP set — connect to desktop llama-server ─────────────
      if (lanIP) {
        try {
          const res = await fetch(`http://${lanIP}:8080/completion`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt, n_predict: 2048, temperature: 0.5, stream: true }),
          });
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let done = false;
          while (!done) {
            const { value, done: d } = await reader.read();
            done = d;
            const chunk = dec.decode(value || new Uint8Array());
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const j = JSON.parse(line.slice(6));
                if (j.content) {
                  streamBufRef.current += j.content;
                  const buf = streamBufRef.current;
                  setChats(prev => prev.map(ch => ch.id === activeRef.current
                    ? { ...ch, messages: ch.messages.map(m => m.id === aiMsgId ? { ...m, text: buf, streaming: !j.stop } : m) }
                    : ch));
                }
                if (j.stop) { done = true; break; }
              } catch {}
            }
          }
          setStreaming(false);
          streamBufRef.current = "";
          streamMsgIdRef.current = null;
        } catch (err) {
          setStreaming(false);
          setChats(prev => prev.map(ch => ch.id === activeRef.current
            ? { ...ch, messages: ch.messages.map(m => m.id === aiMsgId ? { ...m, text: `⚠️ Could not reach desktop AI at ${lanIP}:8080 — make sure the model is loaded on your PC and both devices are on the same Wi-Fi.`, streaming: false } : m) }
            : ch));
        }
        return;
      }

      // ── Option C: Nothing configured — prompt user to set up ───────────────
      setStreaming(false);
      setChats(prev => prev.map(ch => ch.id === activeRef.current
        ? { ...ch, messages: ch.messages.map(m => m.id === aiMsgId ? { ...m, text: "⚠️ No AI configured yet.\n\n**Option 1 — Offline AI (recommended):** Tap **Download AI** in the top bar to download a small AI model (~390 MB) that runs completely offline on your phone.\n\n**Option 2 — Desktop AI:** Make sure your desktop app is running with a model loaded, then tap **AI IP** and enter your PC's local IP address.", streaming: false } : m) }
        : ch));
      return;
    }

    // ── Excel agent: tool-calling approach — no token overflow possible ────────
    const hasExcel = connectors.some(c => c.type === "excel" && c.sheets?.length);
    if (hasExcel) {
      const agentHandled = await runExcelAgent({
        connectors,
        question: text,
        systemPrompt: buildSystemPrompt(connectors, effectiveLang),
        modelId: activeModelId,
        maxTokens: 8192,
        temperature: 0.5,
        onStatus: (msg) => {
          if (msg) {
            setChats(prev => prev.map(ch => ch.id === activeRef.current
              ? { ...ch, messages: ch.messages.map(m => m.id === aiMsgId ? { ...m, text: `🔍 ${msg}` } : m) }
              : ch));
            streamBufRef.current = "";
          }
        },
        onToken: (token) => {
          streamBufRef.current += token;
          const buf = streamBufRef.current;
          setChats(prev => prev.map(ch => ch.id === activeRef.current
            ? { ...ch, messages: ch.messages.map(m => m.id === aiMsgId ? { ...m, text: buf, streaming: true } : m) }
            : ch));
        },
      }).catch(err => {
        setChats(prev => prev.map(ch => ch.id === activeRef.current
          ? { ...ch, messages: ch.messages.map(m => m.id === aiMsgId ? { ...m, text: `⚠️ Error: ${String(err)}`, streaming: false } : m) }
          : ch));
        return true;
      });

      if (agentHandled) {
        setChats(prev => prev.map(ch => ch.id === activeRef.current
          ? { ...ch, messages: ch.messages.map(m => m.id === aiMsgId ? { ...m, streaming: false } : m) }
          : ch));
        setStreaming(false);
        streamBufRef.current = "";
        streamMsgIdRef.current = null;
        return;
      }
    }

    invoke("generate", { prompt, maxTokens: 8192, temperature: 0.5 }).catch(err => {
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
    setShowHub(false);
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

    invoke("generate", { prompt, maxTokens: 8192, temperature: 0.5 }).catch(err => {
      setHubStreaming(false);
      hubStreamBufRef.current = "";
      hubStreamMsgRef.current = null;
      setHubClients(prev => prev[clientId]
        ? { ...prev, [clientId]: { ...prev[clientId], messages: prev[clientId].messages.map(m => m.id === aiMsgId ? { ...m, text: `⚠️ Error: ${err}`, streaming: false } : m) } }
        : prev
      );
    });
  }, [hubClients, hubStreaming, activeModelId]);

  // ── Hub: Bug Scanner ──────────────────────────────────────────────────────
  const triggerBugScan = useCallback(async (clientId) => {
    const client = hubClients[clientId];
    if (!client?.file || !activeModelId) return;
    const code = client.selectedCode || "";
    if (!code && !client.file) return;

    setHubBugReports(prev => ({ ...prev, [clientId]: { scanning: true, bugs: [], scannedFile: client.file, scannedAt: null } }));

    const scanPrompt = `You are a code security and bug analysis expert. Analyze the following ${client.language || "code"} code and identify ALL bugs, security vulnerabilities, and code quality issues.

File: ${client.file}
${code ? `\`\`\`${client.language || ""}\n${code}\n\`\`\`` : `(Full file: ${client.file})`}

Respond with ONLY a JSON array (no markdown, no explanation outside JSON):
[
  {
    "severity": "HIGH" | "MEDIUM" | "LOW" | "INFO",
    "line": <line number or null>,
    "title": "<short title>",
    "description": "<what the issue is>",
    "fix": "<how to fix it with example code if applicable>"
  }
]

If no issues found, respond with: []`;

    const isGemma = activeModelId.toLowerCase().includes("gemma");
    let fullPrompt = "";
    if (isGemma) {
      fullPrompt = `<start_of_turn>user\n${scanPrompt}<end_of_turn>\n<start_of_turn>model\n`;
    } else {
      fullPrompt = `<|im_start|>system\nYou are a code analysis expert. Always respond with valid JSON only.<|im_end|>\n<|im_start|>user\n${scanPrompt}<|im_end|>\n<|im_start|>assistant\n`;
    }

    try {
      const raw = await new Promise((resolve, reject) => {
        let buf = "";
        let unlistenToken, unlistenDone;
        const cleanup = () => { try { unlistenToken?.(); } catch {} try { unlistenDone?.(); } catch {} };
        const timer = setTimeout(() => { cleanup(); reject(new Error("Bug scan timed out")); }, 90_000);
        Promise.all([
          listen("llm-token", e => { buf += e.payload; }),
          listen("llm-done", () => { clearTimeout(timer); cleanup(); resolve(buf.trim()); }),
        ]).then(([ut, ud]) => {
          unlistenToken = ut; unlistenDone = ud;
          invoke("generate", { prompt: fullPrompt, maxTokens: 1024, temperature: 0.1 })
            .catch(err => { clearTimeout(timer); cleanup(); reject(err); });
        }).catch(err => { clearTimeout(timer); cleanup(); reject(err); });
      });

      let bugs = [];
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try { bugs = JSON.parse(jsonMatch[0]); } catch { bugs = []; }
      }
      setHubBugReports(prev => ({ ...prev, [clientId]: { scanning: false, bugs, scannedFile: client.file, scannedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) } }));
    } catch (e) {
      console.error("[bugScan]", e);
      setHubBugReports(prev => ({ ...prev, [clientId]: { scanning: false, bugs: [], scannedFile: client.file, scannedAt: null, error: String(e) } }));
    }
  }, [hubClients, activeModelId]);

  // Auto-trigger bug scan when client file/code changes
  useEffect(() => {
    if (!activeModelId) return;
    Object.values(hubClients).forEach(client => {
      if (!client.file || !client.selectedCode) return;
      const existing = hubBugReports[client.id];
      if (!existing || existing.scannedFile !== client.file || (!existing.scanning && !existing.scannedAt)) {
        const timer = setTimeout(() => triggerBugScan(client.id), 1500);
        return () => clearTimeout(timer);
      }
    });
  }, [hubClients, activeModelId]); // eslint-disable-line

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

  // ── Security Shield: protect / unprotect files ────────────────────────────
  const shieldProtect = useCallback(async (path, fileType) => {
    try {
      const result = await invoke("shield_protect", { path, fileType });
      setShieldedFiles(prev => ({
        ...prev,
        [path]: {
          decoyPath: result.decoyPath,
          protectedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          fileName: path.split(/[\\/]/).pop(),
          fileType,
        }
      }));
      return result;
    } catch (e) {
      console.error("[shield]", e);
      throw e;
    }
  }, []);

  const shieldUnprotect = useCallback(async (path) => {
    try {
      await invoke("shield_unprotect", { path });
      setShieldedFiles(prev => { const n = { ...prev }; delete n[path]; return n; });
    } catch (e) { console.error("[shield]", e); }
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
    <div className="app-layout" style={{ background: C.bgDeep, fontFamily: "'DM Sans',-apple-system,sans-serif" }} onClick={() => contextMenu && setContextMenu(null)}>
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
      <div className="sidebar" style={{ background: C.bgPanel, borderRight: `1px solid ${C.border}` }}>

        {/* Logo */}
        <div className="sidebar-header" style={{ padding: "18px 16px 14px", borderBottom: `1px solid ${C.border}` }}>
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
        <div className="sidebar-search" style={{ padding: "10px 12px 6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8 }}>
            <Icon d={IC.search} size={12} stroke={C.t3} />
            <input value={sSearch} onChange={e => setSSearch(e.target.value)} placeholder="Search chats…"
              style={{ background: "none", border: "none", outline: "none", fontSize: 12, color: C.t1, width: "100%", fontFamily: "inherit", caretColor: C.cyan }} />
          </div>
        </div>

        {/* Chat list */}
        <div className="sidebar-chat-list" style={{ padding: "6px 8px" }} onClick={() => setContextMenu(null)}>
          {filteredChats.map(ch => {
            const snippet = getMatchSnippet(ch);
            const isRenaming = renamingId === ch.id;
            return (
              <div key={ch.id}
                onClick={() => { setContextMenu(null); if (!isRenaming) { setActive(ch.id); setShowHub(false); } }}
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

        {/* Bottom nav — mobile: icon tabs | desktop: text buttons */}
        <div style={{ padding: isDesktop ? "10px 8px" : "0", borderTop: `1px solid ${C.border}`, display: "flex", flexDirection: isDesktop ? "column" : "row", gap: isDesktop ? 2 : 0 }}>

          {/* ── Mobile tab bar ── */}
          {!isDesktop && [
            { id: "chat",   icon: IC.chat,    label: "Chat"  },
            { id: "music",  icon: IC.music,   label: "Music" },
            { id: "games",  icon: IC.gamepad, label: "Games" },
            { id: "models", icon: IC.server,  label: "AI"    },
          ].map(tab => (
            <button key={tab.id}
              className="mobile-tab-btn"
              onClick={() => { setMobileTab(tab.id); }}
              style={{
                color: mobileTab === tab.id ? C.blue : C.t3,
                borderTop: mobileTab === tab.id ? `2px solid ${C.blue}` : "2px solid transparent",
              }}>
              <Icon d={tab.icon} size={20} stroke={mobileTab === tab.id ? C.blue : C.t3} />
              <span style={{ fontWeight: mobileTab === tab.id ? 600 : 400 }}>{tab.label}</span>
            </button>
          ))}

          {/* ── Desktop buttons ── */}
          {isDesktop && <>
          {[
            { icon: IC.server, label: "Models",  action: () => { setShowHub(false); setShowMod(true); } },
            { icon: IC.plug,   label: "Sources", action: () => { setShowHub(false); setShowConn(true); } },
          ].map(({ icon, label, action }) => (
            <Btn key={label} onClick={action} style={{ width: "100%", padding: "9px 10px", background: "transparent", border: "none", borderRadius: 8, color: C.t2, fontSize: 12.5, display: "flex", alignItems: "center", gap: 8, textAlign: "left" }}>
              <Icon d={icon} size={14} stroke={C.t3} />{label}
            </Btn>
          ))}
          <Btn onClick={() => { setShowHub(h => !h); }} style={{
            width: "100%", padding: "9px 10px", borderRadius: 8, border: "none", textAlign: "left",
            background: showHub ? "rgba(168,85,247,0.12)" : "transparent",
            color: showHub ? C.purple : C.t2, fontSize: 12.5, display: "flex", alignItems: "center", gap: 8,
          }}>
            <Icon d={IC.hub} size={14} stroke={showHub ? C.purple : C.t3} />
            Hub
            <span style={{ marginLeft: "auto", fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 10,
              background: trialDaysLeft === null ? "rgba(168,85,247,0.18)" : trialDaysLeft <= 0 ? "rgba(239,68,68,0.15)" : "rgba(168,85,247,0.18)",
              color: trialDaysLeft === null ? C.purple : trialDaysLeft <= 0 ? C.red : C.purple,
              border: `1px solid ${trialDaysLeft !== null && trialDaysLeft <= 0 ? "rgba(239,68,68,0.3)" : "rgba(168,85,247,0.3)"}`,
            }}>
              {trialDaysLeft === null ? "5d trial" : trialDaysLeft <= 0 ? "Expired" : `${trialDaysLeft}d left`}
            </span>
          </Btn>
          </> /* end desktop buttons */}

          {/* Model status chip — desktop only */}
          {isDesktop && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 10px", background: C.bgCard, borderRadius: 8, border: `1px solid ${C.border}`, marginTop: 4 }}>
            <Dot color={statusColor} pulse={ms?.status === "loaded" || modelLoading} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: statusColor }}>{statusLabel}</div>
              {activeModel && ms?.status === "loaded" && (
                <div style={{ fontSize: 10, color: C.t3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeModel.label}</div>
              )}
            </div>
          </div>
          )}


        </div>
      </div>

      {/* ── Main area ── */}
      <div className="main-area">

        {/* ── Mobile top bar ── */}
        {!isDesktop && (
          <div style={{ padding: "0 14px", height: 54, background: C.bgPanel, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, zIndex: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: `linear-gradient(135deg,${C.blueD},${C.cyan})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Icon d={IC.brain} size={14} stroke="#fff" />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.t1 }}>OfflineAI</div>
                <div style={{ fontSize: 9, color: statusColor, display: "flex", alignItems: "center", gap: 4 }}>
                  <Dot color={statusColor} pulse={ms?.status === "loaded"} />
                  {statusLabel}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {/* WebLLM status / download button */}
              {wllmStatus === "ready" ? (
                <div style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 8, padding: "6px 10px" }}>
                  <Dot color={C.green} pulse />
                  <span style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>AI Ready</span>
                </div>
              ) : wllmStatus === "downloading" || wllmStatus === "loading" ? (
                <div style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(168,85,247,0.12)", border: "1px solid rgba(168,85,247,0.3)", borderRadius: 8, padding: "6px 10px" }}>
                  <Spinner size={10} />
                  <span style={{ fontSize: 11, color: C.purple, fontWeight: 600 }}>{wllmProgress}%</span>
                </div>
              ) : (
                <button onClick={() => setShowLanSet(s => !s)} style={{ background: lanIP ? "rgba(34,197,94,0.12)" : "rgba(59,130,246,0.12)", border: `1px solid ${lanIP ? "rgba(34,197,94,0.3)" : "rgba(59,130,246,0.3)"}`, borderRadius: 8, color: lanIP ? C.green : C.blue, fontSize: 11, fontWeight: 600, padding: "6px 10px", cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
                  {lanIP ? "AI ✓" : "Setup AI"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Mobile AI setup panel */}
        {!isDesktop && showLanSet && (
          <div style={{ padding: "14px", background: C.bgPanel, borderBottom: `1px solid ${C.border}` }}>
            {/* Tab: Offline AI vs Desktop AI */}
            <div style={{ display: "flex", gap: 0, marginBottom: 12, background: C.bgCard, borderRadius: 8, padding: 3 }}>
              {[["offline", "📱 Offline AI"], ["lan", "💻 Desktop AI"]].map(([k, lbl]) => (
                <button key={k} onClick={() => { if (typeof window !== "undefined") window.__aiSetupTab = k; setShowLanSet(true); }}
                  id={`ai-tab-${k}`}
                  style={{ flex: 1, padding: "7px 4px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600,
                    background: "transparent", color: C.t2, WebkitTapHighlightColor: "transparent" }}>
                  {lbl}
                </button>
              ))}
            </div>

            {/* Offline AI: WebLLM download */}
            <div id="ai-panel-offline">
              <div style={{ fontSize: 11, color: C.t3, marginBottom: 10 }}>Downloads once (~390 MB). Works fully offline forever after.</div>
              <select value={wllmModel} onChange={e => setWllmModel(e.target.value)}
                style={{ width: "100%", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, color: C.t1, fontSize: 12, padding: "8px 10px", marginBottom: 10, fontFamily: "inherit" }}>
                {WLLM_MODELS.map(m => (
                  <option key={m.id} value={m.id}>{m.label} — {m.size} ({m.note})</option>
                ))}
              </select>
              {(wllmStatus === "downloading" || wllmStatus === "loading") ? (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: C.purple }}>{wllmMsg}</span>
                    <span style={{ fontSize: 11, color: C.purple }}>{wllmProgress}%</span>
                  </div>
                  <div style={{ height: 4, background: C.bgDeep, borderRadius: 4 }}>
                    <div style={{ height: "100%", width: `${wllmProgress}%`, background: C.purple, borderRadius: 4, transition: "width 0.4s" }} />
                  </div>
                </div>
              ) : wllmStatus === "ready" ? (
                <div style={{ padding: "8px 12px", background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 8, fontSize: 12, color: C.green, marginBottom: 10 }}>
                  ✓ AI ready — fully offline
                </div>
              ) : wllmStatus === "error" ? (
                <div style={{ padding: "8px 12px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, fontSize: 11, color: C.red, marginBottom: 10 }}>
                  {wllmMsg}
                </div>
              ) : null}
              {wllmStatus !== "ready" && (
                <button onClick={() => { initWebLLM(wllmModel); setShowLanSet(false); }}
                  disabled={wllmStatus === "downloading" || wllmStatus === "loading"}
                  style={{ width: "100%", padding: "10px", background: C.blue, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", WebkitTapHighlightColor: "transparent", opacity: (wllmStatus === "downloading" || wllmStatus === "loading") ? 0.6 : 1 }}>
                  {wllmStatus === "downloading" || wllmStatus === "loading" ? "Downloading…" : "Download AI Model"}
                </button>
              )}
            </div>

            {/* LAN AI: desktop IP */}
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.t3, marginBottom: 6 }}>Or connect to your desktop PC on the same Wi-Fi (run <strong style={{ color: C.t2 }}>ipconfig</strong> on PC to find its IP)</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={lanIP} onChange={e => setLanIP(e.target.value)} placeholder="e.g. 192.168.1.5"
                  style={{ flex: 1, background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, color: C.t1, fontSize: 13, padding: "8px 10px", fontFamily: "inherit" }} />
                <button onClick={() => { localStorage.setItem("lan_ip", lanIP); setShowLanSet(false); }} style={{ padding: "8px 14px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, color: C.t2, fontSize: 12, fontWeight: 600, cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>Save</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Desktop top bar ── */}
        {isDesktop && <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bgPanel }}>
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
        </div>}

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

        {/* Setup banner — desktop only (Tauri) */}
        {isDesktop && serverReady === false && !setupProgress && (
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
        {isDesktop && setupProgress && setupProgress.step !== "error" && (
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
        {isDesktop && setupProgress?.step === "error" && (
          <div style={{ padding: "10px 20px", borderBottom: `1px solid ${C.border}`, background: "rgba(239,68,68,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ fontSize: 12.5, color: C.red }}>Setup failed: {setupProgress.message}</span>
            <Btn onClick={runSetup} style={{ padding: "6px 12px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 7, color: C.red, fontSize: 12 }}>Retry</Btn>
          </div>
        )}

        {/* No model banner — desktop only */}
        {isDesktop && !activeModelId && !modelLoading && (
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

        {/* Model loading banner — desktop only */}
        {isDesktop && modelLoading && (
          <div style={{ padding: "10px 20px", borderBottom: `1px solid ${C.border}`, background: "rgba(245,158,11,0.05)", display: "flex", alignItems: "center", gap: 10 }}>
            <Spinner />
            <span style={{ fontSize: 12.5, color: C.amber }}>Connecting to model… this may take 10–30 seconds.</span>
          </div>
        )}

        {/* Mobile Music Studio */}
        {!isDesktop && mobileTab === "music" && <MusicStudio />}

        {/* Mobile Games */}
        {!isDesktop && mobileTab === "games" && <GamesPanel />}

        {/* Mobile AI Setup — WebLLM (runs in browser, no Tauri needed) */}
        {!isDesktop && mobileTab === "models" && (
          <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bgDeep, overflow:"hidden" }}>
            {/* Header */}
            <div style={{ padding:"16px", background:C.bgPanel, borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ width:36, height:36, borderRadius:10, background:`linear-gradient(135deg,${C.blue},${C.cyan})`, display:"flex", alignItems:"center", justifyContent:"center" }}>
                  <Icon d={IC.brain} size={18} stroke="#fff" />
                </div>
                <div>
                  <div style={{ fontSize:16, fontWeight:700, color:C.t1 }}>AI Setup</div>
                  <div style={{ fontSize:11, color:C.t3 }}>Download once · runs offline forever on your phone</div>
                </div>
              </div>
            </div>

            <div style={{ flex:1, overflowY:"auto", padding:"14px 12px" }}>

              {/* Current status banner */}
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px", borderRadius:12, marginBottom:16,
                background: wllmStatus==="ready" ? "rgba(34,197,94,0.08)" : "rgba(59,130,246,0.06)",
                border: `1px solid ${wllmStatus==="ready" ? "rgba(34,197,94,0.25)" : C.border}` }}>
                <Dot color={wllmStatus==="ready" ? C.green : wllmStatus==="downloading"||wllmStatus==="loading" ? C.amber : C.t3}
                     pulse={wllmStatus==="downloading"||wllmStatus==="loading"||wllmStatus==="ready"} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12, fontWeight:600,
                    color: wllmStatus==="ready" ? C.green : wllmStatus==="downloading"||wllmStatus==="loading" ? C.amber : C.t2 }}>
                    {wllmStatus==="ready"    ? "AI Ready — fully offline ✓"
                   : wllmStatus==="downloading"||wllmStatus==="loading" ? "Setting up AI…"
                   : wllmStatus==="error"   ? "Setup failed"
                   : "No AI model loaded"}
                  </div>
                  {wllmStatus==="ready" && <div style={{ fontSize:10, color:C.t3, marginTop:1 }}>{WLLM_MODELS.find(m=>m.id===wllmModel)?.label} · chat is ready</div>}
                  {wllmStatus==="error" && <div style={{ fontSize:10, color:C.red, marginTop:1 }}>{wllmMsg}</div>}
                </div>
                {wllmStatus==="ready" && (
                  <button onClick={() => setMobileTab("chat")} style={{ padding:"7px 14px", borderRadius:9, border:"none", background:C.green, color:"#fff", fontSize:12, fontWeight:700, cursor:"pointer", flexShrink:0 }}>
                    Chat →
                  </button>
                )}
              </div>

              {/* Download progress */}
              {(wllmStatus==="downloading" || wllmStatus==="loading") && (
                <div style={{ padding:"14px", background:C.bgCard, borderRadius:12, border:`1px solid ${C.border}`, marginBottom:16 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                    <Spinner />
                    <span style={{ fontSize:12, color:C.t2, flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{wllmMsg || "Loading…"}</span>
                    <span style={{ fontSize:12, fontWeight:700, color:C.purple, flexShrink:0 }}>{wllmProgress}%</span>
                  </div>
                  <div style={{ height:6, background:C.bgDeep, borderRadius:6, overflow:"hidden" }}>
                    <div style={{ height:"100%", width:`${wllmProgress}%`, background:`linear-gradient(90deg,${C.blue},${C.purple})`, borderRadius:6, transition:"width 0.4s" }} />
                  </div>
                  <div style={{ fontSize:10, color:C.t3, marginTop:6 }}>
                    Model is being cached on your device. Keep this screen open.
                  </div>
                </div>
              )}

              {/* Model selection */}
              <div style={{ fontSize:11, color:C.t3, fontWeight:600, marginBottom:8 }}>CHOOSE A MODEL</div>
              {WLLM_MODELS.map(m => {
                const isActive = wllmModel === m.id;
                const isLoaded = wllmStatus==="ready" && wllmModel===m.id;
                return (
                  <div key={m.id}
                    onClick={() => { if(wllmStatus!=="downloading"&&wllmStatus!=="loading") setWllmModel(m.id); }}
                    style={{ background:C.bgCard, borderRadius:12, padding:"14px", marginBottom:10,
                      border:`2px solid ${isLoaded ? C.green : isActive ? C.blue : C.border}`,
                      cursor: wllmStatus==="downloading"||wllmStatus==="loading" ? "default" : "pointer" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <div style={{ width:38, height:38, borderRadius:9, background: isLoaded ? `${C.green}18` : isActive ? `${C.blue}18` : C.bgPanel,
                        border:`1px solid ${isLoaded ? C.green : isActive ? C.blue : C.border}`,
                        display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                        <Icon d={IC.brain} size={16} stroke={isLoaded ? C.green : isActive ? C.blue : C.t3} />
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginBottom:2 }}>
                          <span style={{ fontSize:13, fontWeight:700, color: isLoaded ? C.green : isActive ? C.blue : C.t1 }}>{m.label}</span>
                          <span style={{ fontSize:9, padding:"1px 7px", borderRadius:10, background: isLoaded ? `${C.green}18` : `${C.blue}18`, color: isLoaded ? C.green : C.blue, border:`1px solid ${isLoaded ? C.green : C.blue}30` }}>
                            {isLoaded ? "Active" : m.size}
                          </span>
                        </div>
                        <div style={{ fontSize:11, color:C.t3 }}>{m.note}</div>
                      </div>
                      {isActive && !isLoaded && <div style={{ width:18, height:18, borderRadius:"50%", border:`2px solid ${C.blue}`, display:"flex", alignItems:"center", justifyContent:"center" }}><div style={{ width:8, height:8, borderRadius:"50%", background:C.blue }} /></div>}
                      {isLoaded && <span style={{ fontSize:16 }}>✓</span>}
                    </div>
                  </div>
                );
              })}

              {/* Action button */}
              <button
                onClick={() => { if(wllmStatus!=="downloading"&&wllmStatus!=="loading") initWebLLM(wllmModel); }}
                disabled={wllmStatus==="downloading"||wllmStatus==="loading"}
                style={{ width:"100%", padding:"15px", borderRadius:12, border:"none", marginTop:4, marginBottom:16,
                  cursor: wllmStatus==="downloading"||wllmStatus==="loading" ? "not-allowed" : "pointer",
                  background: wllmStatus==="ready" ? `${C.green}18` : wllmStatus==="downloading"||wllmStatus==="loading" ? C.bgCard : `linear-gradient(135deg,${C.blue},${C.cyan})`,
                  border: wllmStatus==="ready" ? `1px solid ${C.green}40` : "none",
                  color: wllmStatus==="ready" ? C.green : wllmStatus==="downloading"||wllmStatus==="loading" ? C.t3 : "#fff",
                  fontSize:14, fontWeight:700,
                  display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}>
                {wllmStatus==="downloading"||wllmStatus==="loading"
                  ? <><Spinner />Setting up… {wllmProgress}%</>
                  : wllmStatus==="ready"
                  ? "✓ AI Ready — tap to reload"
                  : <><Icon d={IC.dl} size={16} stroke="#fff" />Download & Setup AI</>}
              </button>

              <div style={{ fontSize:10, color:C.t3, textAlign:"center", lineHeight:1.7, padding:"0 8px" }}>
                Model downloads once (~390MB for Qwen 0.5B) and is cached in your browser.{"\n"}
                After setup, AI works with <strong style={{ color:C.t2 }}>no internet, no laptop needed</strong>.
              </div>
            </div>
          </div>
        )}

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
            bugReports={hubBugReports}
            onBugScan={triggerBugScan}
            shieldedFiles={shieldedFiles}
            securityLog={securityLog}
            onShieldProtect={shieldProtect}
            onShieldUnprotect={shieldUnprotect}
          />
        ) : (!isDesktop && mobileTab !== "chat") ? null : (
          <>
        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", WebkitOverflowScrolling: "touch" }}>
          {activeChat?.messages.map(msg => <Bubble key={msg.id} msg={msg} />)}
          <div ref={bottomRef} />
        </div>

        {/* Quick prompts — desktop only */}
        {isDesktop && (!activeChat?.messages || activeChat.messages.length <= 1) && (
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
        <div style={{ padding: isDesktop ? "10px 20px 16px" : "10px 12px 12px", background: C.bgPanel, borderTop: `1px solid ${C.border}`, position: "relative" }}>
          {/* Template panel */}
          {showTemplates && (
            <TemplatePanel
              onSelect={prompt => {
                setInput(prompt);
                setShowTemplates(false);
                setTimeout(() => {
                  if (inputRef.current) {
                    inputRef.current.focus();
                    // Select [TOPIC] so user can type immediately
                    const idx = prompt.indexOf("[TOPIC]");
                    if (idx !== -1) { inputRef.current.setSelectionRange(idx, idx + 7); }
                  }
                }, 50);
              }}
              onClose={() => setShowTemplates(false)}
            />
          )}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, padding: "10px 14px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 14 }}>
            {/* Templates toggle button — desktop only */}
            {isDesktop && (
            <Btn onClick={() => setShowTemplates(v => !v)} title="Prompt Templates" style={{
              flexShrink: 0, padding: "5px 9px", borderRadius: 8, fontSize: 14,
              background: showTemplates ? C.blue : "transparent",
              border: `1px solid ${showTemplates ? C.blue : C.border}`,
              color: showTemplates ? "#fff" : C.t2, lineHeight: 1,
            }}>⚡</Btn>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={isDesktop ? (activeModelId ? "Ask a research question… (Enter to send, Shift+Enter for newline)" : "Download a model first to start chatting") : (lanIP ? "Ask anything… (AI connected via Wi-Fi)" : "Ask anything… (tap AI IP above to connect AI)")}
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
              <Btn onClick={send} disabled={!input.trim() || (isDesktop && !activeModelId)} style={{
                width: 36, height: 36, borderRadius: 9, border: "none", flexShrink: 0,
                background: input.trim() && (!isDesktop || activeModelId) ? C.blue : C.bgPanel,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: input.trim() && (!isDesktop || activeModelId) ? "#fff" : C.t3,
              }}>
                <Icon d={IC.send} size={15} />
              </Btn>
            )}
          </div>

          {/* Language selector + footer — desktop only (takes too much space on mobile) */}
          {isDesktop && (
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            {/* Left: language pills */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Icon d={IC.globe} size={12} stroke={C.t2} />
              <span style={{ fontSize: 11, color: C.t2, fontWeight: 500 }}>Language:</span>
              {LANG_OPTIONS.map(({ id, label }) => {
                const isActive = selectedLang === id;
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
          )}
          {/* Mobile: compact footer */}
          {!isDesktop && (
            <div style={{ marginTop: 6, textAlign: "center", fontSize: 10, color: C.t3 }}>100% on-device · no data sent</div>
          )}
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
          onCancelDownload={cancelDownload}
          onResetServer={resetServer}
          onClose={() => setShowMod(false)}
        />
      )}
      {showConn && (
        <ConnectorModal
          connectors={connectors}
          onAdd={c => setConnectors(prev => [...prev, c])}
          onRemove={id => setConnectors(prev => prev.filter(c => c.id !== id))}
          onUpdate={(id, updates) => setConnectors(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c))}
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

// ─── Games Panel (mobile-only) ────────────────────────────────────────────────
function GamesPanel() {
  const [game, setGame] = useState(null);
  if (game === "ttt")    return <GameTTT    onBack={() => setGame(null)} />;
  if (game === "2048")   return <Game2048   onBack={() => setGame(null)} />;
  if (game === "memory") return <GameMemory onBack={() => setGame(null)} />;
  if (game === "rps")    return <GameRPS    onBack={() => setGame(null)} />;
  if (game === "snake")  return <GameSnake  onBack={() => setGame(null)} />;

  const GAMES = [
    { id:"ttt",    emoji:"⭕",  title:"Tic-Tac-Toe",  desc:"Beat the AI or play with a friend",  tag:"1–2 players", color:C.blue },
    { id:"2048",   emoji:"🔢",  title:"2048",          desc:"Slide tiles and reach 2048",          tag:"Solo",        color:C.cyan },
    { id:"memory", emoji:"🃏",  title:"Memory Match",  desc:"Flip & match pairs — 1 or 2 players",tag:"1–2 players", color:C.purple },
    { id:"rps",    emoji:"✊",  title:"Rock Paper Scissors", desc:"Quick best-of-5 vs the AI",     tag:"Solo",        color:C.green },
    { id:"snake",  emoji:"🐍",  title:"Snake",         desc:"Classic snake — swipe or arrow keys", tag:"Solo",        color:C.amber },
  ];
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bgDeep, overflow:"hidden" }}>
      <div style={{ padding:"16px", background:C.bgPanel, borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:36, height:36, borderRadius:10, background:`linear-gradient(135deg,${C.blue},${C.purple})`, display:"flex", alignItems:"center", justifyContent:"center" }}>
            <Icon d={IC.gamepad} size={18} stroke="#fff" />
          </div>
          <div>
            <div style={{ fontSize:16, fontWeight:700, color:C.t1 }}>Games</div>
            <div style={{ fontSize:11, color:C.t3 }}>Play offline · solo or with friends</div>
          </div>
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"14px 12px" }}>
        {GAMES.map(g => (
          <div key={g.id} onClick={() => setGame(g.id)} style={{ background:C.bgCard, borderRadius:14, padding:"16px", marginBottom:10, border:`1px solid ${C.border}`, cursor:"pointer", display:"flex", alignItems:"center", gap:14, active: undefined }}
            onTouchStart={e => e.currentTarget.style.background = C.bgPanel}
            onTouchEnd={e => e.currentTarget.style.background = C.bgCard}>
            <div style={{ width:50, height:50, borderRadius:12, background:`${g.color}18`, border:`1px solid ${g.color}44`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, flexShrink:0 }}>{g.emoji}</div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:15, fontWeight:600, color:C.t1, marginBottom:3 }}>{g.title}</div>
              <div style={{ fontSize:12, color:C.t3, marginBottom:6 }}>{g.desc}</div>
              <span style={{ fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:10, background:`${g.color}18`, color:g.color, border:`1px solid ${g.color}30` }}>{g.tag}</span>
            </div>
            <Icon d={IC.arrowR} size={16} stroke={C.t3} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tic-Tac-Toe ────────────────────────────────────────────────────────────────
function GameTTT({ onBack }) {
  const empty = Array(9).fill(null);
  const [board, setBoard] = useState(empty);
  const [xIsNext, setXIsNext] = useState(true);
  const [mode, setMode] = useState("ai"); // "ai" | "2p"
  const [scores, setScores] = useState({ X:0, O:0, D:0 });
  const [winner, setWinner] = useState(null);

  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  const checkWin = b => { for (const [a,i,j] of lines) if (b[a] && b[a]===b[i] && b[a]===b[j]) return b[a]; return b.every(Boolean) ? "D" : null; };

  const minimax = (b, isMax) => {
    const w = checkWin(b);
    if (w === "O") return 10; if (w === "X") return -10; if (w === "D") return 0;
    const scores2 = [];
    b.forEach((v,i) => { if (!v) { const nb = [...b]; nb[i] = isMax ? "O" : "X"; scores2.push(minimax(nb, !isMax)); } });
    return isMax ? Math.max(...scores2) : Math.min(...scores2);
  };
  const bestMove = b => {
    let best=-Infinity, idx=-1;
    b.forEach((v,i) => { if (!v) { const nb=[...b]; nb[i]="O"; const s=minimax(nb,false); if(s>best){best=s;idx=i;} } });
    return idx;
  };

  const handleClick = (i) => {
    if (board[i] || winner) return;
    const nb = [...board]; nb[i] = "X"; setBoard(nb);
    const w = checkWin(nb);
    if (w) { setWinner(w); setScores(s=>({...s,[w]:s[w]+1})); return; }
    setXIsNext(false);
    if (mode === "ai") {
      setTimeout(() => {
        const nb2 = [...nb]; nb2[bestMove(nb2)] = "O"; setBoard(nb2);
        const w2 = checkWin(nb2);
        if (w2) { setWinner(w2); setScores(s=>({...s,[w2]:s[w2]+1})); } else setXIsNext(true);
      }, 300);
    } else setXIsNext(true);
  };
  const handle2P = (i) => {
    if (board[i] || winner) return;
    const mark = xIsNext ? "X" : "O";
    const nb = [...board]; nb[i] = mark; setBoard(nb);
    const w = checkWin(nb);
    if (w) { setWinner(w); setScores(s=>({...s,[w]:s[w]+1})); } else setXIsNext(!xIsNext);
  };

  const reset = () => { setBoard(empty); setXIsNext(true); setWinner(null); };
  const winLine = lines.find(([a,i,j]) => board[a] && board[a]===board[i] && board[a]===board[j]);

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bgDeep }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"14px 16px", background:C.bgPanel, borderBottom:`1px solid ${C.border}` }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:C.t2, cursor:"pointer", padding:"4px 8px 4px 0" }}><Icon d={IC.arrowL} size={18} /></button>
        <div style={{ flex:1, fontSize:15, fontWeight:700, color:C.t1 }}>Tic-Tac-Toe</div>
        <div style={{ display:"flex", gap:4 }}>
          {["ai","2p"].map(m => <button key={m} onClick={() => { setMode(m); reset(); }} style={{ padding:"5px 12px", borderRadius:20, border:"none", fontSize:11, fontWeight:600, cursor:"pointer", background: mode===m ? C.blue : C.bgCard, color: mode===m ? "#fff" : C.t3 }}>{m==="ai"?"vs AI":"2P"}</button>)}
        </div>
      </div>
      <div style={{ display:"flex", justifyContent:"center", gap:20, padding:"12px 16px", background:C.bgPanel }}>
        {[["X",C.blue],["O",C.red]].map(([p,col]) => <div key={p} style={{ textAlign:"center" }}><div style={{ fontSize:20, fontWeight:800, color:col }}>{scores[p]}</div><div style={{ fontSize:10, color:C.t3 }}>{p==="X" ? "You" : mode==="ai"?"AI":"P2"}</div></div>)}
        <div style={{ textAlign:"center" }}><div style={{ fontSize:20, fontWeight:800, color:C.t3 }}>{scores.D}</div><div style={{ fontSize:10, color:C.t3 }}>Draw</div></div>
      </div>
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:12, padding:16 }}>
        <div style={{ width:"100%", maxWidth:300 }}>
          {[0,1,2].map(row => (
            <div key={row} style={{ display:"flex" }}>
              {[0,1,2].map(col => {
                const i = row*3+col;
                const inWin = winLine?.includes(i);
                return (
                  <div key={col} onClick={() => mode==="ai" ? handleClick(i) : handle2P(i)} style={{
                    flex:1, aspectRatio:"1", display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:36, fontWeight:800, cursor: board[i]||winner ? "default" : "pointer",
                    background: inWin ? (board[i]==="X" ? `${C.blue}28` : `${C.red}28`) : "transparent",
                    color: board[i]==="X" ? C.blue : C.red,
                    borderRight: col<2 ? `2px solid ${C.border}` : "none",
                    borderBottom: row<2 ? `2px solid ${C.border}` : "none",
                    transition: "background 0.2s",
                  }}>{board[i] || ""}</div>
                );
              })}
            </div>
          ))}
        </div>
        <div style={{ fontSize:14, color:C.t2, minHeight:22, textAlign:"center" }}>
          {winner ? (winner==="D" ? "It's a draw!" : `${winner==="X"?"You":mode==="ai"?"AI":"P2"} won! 🎉`) : `${xIsNext||mode==="2p" ? (mode==="2p" ? (xIsNext?"P1 (X)":"P2 (O)") : "Your turn (X)") : "AI thinking…"}`}
        </div>
        <button onClick={reset} style={{ padding:"10px 24px", borderRadius:10, border:"none", background:C.blue, color:"#fff", fontSize:13, fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", gap:8 }}>
          <Icon d={IC.restart} size={14} stroke="#fff" />New Game
        </button>
      </div>
    </div>
  );
}

// ── 2048 ────────────────────────────────────────────────────────────────────────
function Game2048({ onBack }) {
  const newGrid = () => { const g=Array(4).fill(null).map(()=>Array(4).fill(0)); addTile(g); addTile(g); return g; };
  const addTile = (g) => { const emp=[]; g.forEach((r,i)=>r.forEach((v,j)=>{if(!v)emp.push([i,j]);})); if(!emp.length)return; const [i,j]=emp[Math.floor(Math.random()*emp.length)]; g[i][j]=Math.random()<0.9?2:4; };
  const clone = g => g.map(r=>[...r]);
  const [grid, setGrid] = useState(newGrid);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [over, setOver] = useState(false);
  const touchRef = useRef(null);

  const slideRow = (row) => {
    const r = row.filter(v=>v); let add=0;
    for(let i=0;i<r.length-1;i++) if(r[i]===r[i+1]){r[i]*=2;add+=r[i];r.splice(i+1,1);}
    while(r.length<4)r.push(0);
    return {row:r, gained:add};
  };

  const move = useCallback((dir) => {
    if (over) return;
    const g = clone(grid); let gained=0, moved=false;
    const process = rows => rows.map(row => { const {row:r,gained:g2}=slideRow(row); gained+=g2; if(r.join()!==row.join())moved=true; return r; });
    let rows;
    if (dir==="L") rows = process(g);
    else if (dir==="R") rows = process(g.map(r=>[...r].reverse())).map(r=>[...r].reverse());
    else if (dir==="U") { const t=g[0].map((_,i)=>g.map(r=>r[i])); const p=process(t); rows=p[0].map((_,i)=>p.map(r=>r[i])); }
    else { const t=g[0].map((_,i)=>g.map(r=>r[i]).reverse()); const p=process(t); rows=p[0].map((_,i)=>p.map(r=>r[i]).reverse()); }
    if (!moved) return;
    addTile(rows);
    const ns = score + gained;
    setGrid(rows); setScore(ns); if(ns>best)setBest(ns);
    const emp = rows.some(r=>r.some(v=>!v));
    if (!emp) {
      const canMove = rows.some((r,i)=>r.some((v,j)=>(j<3&&v===r[j+1])||(i<3&&v===rows[i+1][j])));
      if(!canMove) setOver(true);
    }
  }, [grid, score, best, over]);

  useEffect(() => {
    const handler = e => { const k={ArrowLeft:"L",ArrowRight:"R",ArrowUp:"U",ArrowDown:"D"}[e.key]; if(k){e.preventDefault();move(k);} };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [move]);

  const COLORS = {0:"#1e3a5f",2:"#3b82f6",4:"#2563eb",8:"#7c3aed",16:"#9333ea",32:"#ec4899",64:"#ef4444",128:"#f97316",256:"#f59e0b",512:"#22c55e",1024:"#06b6d4",2048:"#ffd700"};
  const tileColor = v => COLORS[v] || "#ffd700";

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bgDeep }}
      onTouchStart={e => { touchRef.current = {x:e.touches[0].clientX, y:e.touches[0].clientY}; }}
      onTouchEnd={e => {
        if (!touchRef.current) return;
        const dx=e.changedTouches[0].clientX-touchRef.current.x, dy=e.changedTouches[0].clientY-touchRef.current.y;
        if(Math.abs(dx)>Math.abs(dy)){move(dx>0?"R":"L");}else{move(dy>0?"D":"U");}
        touchRef.current=null;
      }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"14px 16px", background:C.bgPanel, borderBottom:`1px solid ${C.border}` }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:C.t2, cursor:"pointer", padding:"4px 8px 4px 0" }}><Icon d={IC.arrowL} size={18} /></button>
        <div style={{ flex:1, fontSize:15, fontWeight:700, color:C.t1 }}>2048</div>
        <div style={{ display:"flex", gap:8 }}>
          {[["Score",score],["Best",best]].map(([l,v])=><div key={l} style={{ textAlign:"center", padding:"4px 10px", background:C.bgCard, borderRadius:8 }}><div style={{ fontSize:13, fontWeight:700, color:C.t1 }}>{v}</div><div style={{ fontSize:9, color:C.t3 }}>{l}</div></div>)}
        </div>
        <button onClick={() => { setGrid(newGrid()); setScore(0); setOver(false); }} style={{ background:C.blue, border:"none", borderRadius:8, color:"#fff", fontSize:11, fontWeight:600, padding:"6px 10px", cursor:"pointer" }}>New</button>
      </div>
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:16, gap:8 }}>
        {over && <div style={{ fontSize:18, fontWeight:700, color:C.amber, marginBottom:8 }}>Game Over! 🎮</div>}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, width:"100%", maxWidth:340, background:C.bgCard, borderRadius:12, padding:8 }}>
          {grid.flat().map((v,i) => (
            <div key={i} style={{ aspectRatio:"1", borderRadius:8, background:v?tileColor(v):C.bgDeep, display:"flex", alignItems:"center", justifyContent:"center", fontSize:v>=1000?16:v>=100?20:v>=10?24:28, fontWeight:800, color:"#fff", transition:"all 0.1s" }}>
              {v||""}
            </div>
          ))}
        </div>
        <div style={{ fontSize:11, color:C.t3, marginTop:4 }}>Swipe to move tiles</div>
      </div>
    </div>
  );
}

// ── Memory Match ───────────────────────────────────────────────────────────────
function GameMemory({ onBack }) {
  const EMOJIS = ["🐶","🐱","🦊","🐻","🐼","🐨","🦁","🐯","🦋","🌸","⭐","🎸","🍕","🚀","🎮","🌈"];
  const makeCards = () => {
    const pairs = [...EMOJIS,...EMOJIS].map((e,i)=>({id:i,emoji:e,flipped:false,matched:false}));
    for(let i=pairs.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pairs[i],pairs[j]]=[pairs[j],pairs[i]];}
    return pairs;
  };
  const [cards, setCards]   = useState(makeCards);
  const [flipped, setFlipped] = useState([]);
  const [moves, setMoves]   = useState(0);
  const [mode, setMode]     = useState("1p"); // "1p"|"2p"
  const [turn, setTurn]     = useState(1);
  const [scores, setScores] = useState({1:0,2:0});
  const [locked, setLocked] = useState(false);
  const [done, setDone]     = useState(false);

  const flip = (id) => {
    if (locked || done) return;
    const card = cards.find(c=>c.id===id);
    if (!card || card.flipped || card.matched) return;
    const nf = [...flipped, id];
    setCards(c=>c.map(x=>x.id===id?{...x,flipped:true}:x));
    if (nf.length === 2) {
      setMoves(m=>m+1); setLocked(true);
      const [a,b] = nf.map(i=>cards.find(c=>c.id===i));
      if (a.emoji === b.emoji) {
        setCards(c=>c.map(x=>nf.includes(x.id)?{...x,matched:true}:x));
        const ns = {...scores, [turn]:scores[turn]+1};
        setScores(ns);
        setFlipped([]); setLocked(false);
        if(ns[1]+ns[2]===EMOJIS.length) setDone(true);
      } else {
        setTimeout(() => {
          setCards(c=>c.map(x=>nf.includes(x.id)?{...x,flipped:false}:x));
          setFlipped([]); setLocked(false);
          if(mode==="2p") setTurn(t=>t===1?2:1);
        }, 900);
      }
      nf.length===1 && setFlipped(nf);
    } else setFlipped(nf);
  };

  const reset = () => { setCards(makeCards()); setFlipped([]); setMoves(0); setTurn(1); setScores({1:0,2:0}); setLocked(false); setDone(false); };

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bgDeep, overflow:"hidden" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"14px 16px", background:C.bgPanel, borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:C.t2, cursor:"pointer", padding:"4px 8px 4px 0" }}><Icon d={IC.arrowL} size={18} /></button>
        <div style={{ flex:1, fontSize:15, fontWeight:700, color:C.t1 }}>Memory Match</div>
        <div style={{ display:"flex", gap:4 }}>
          {["1p","2p"].map(m=><button key={m} onClick={()=>{setMode(m);reset();}} style={{ padding:"5px 12px", borderRadius:20, border:"none", fontSize:11, fontWeight:600, cursor:"pointer", background:mode===m?C.blue:C.bgCard, color:mode===m?"#fff":C.t3 }}>{m==="1p"?"Solo":"2P"}</button>)}
        </div>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 16px", background:C.bgPanel, flexShrink:0 }}>
        {mode==="2p" ? (
          <>{[1,2].map(p=><div key={p} style={{ display:"flex", alignItems:"center", gap:8 }}><div style={{ width:8,height:8,borderRadius:"50%",background:turn===p&&!done?C.green:"transparent",border:`2px solid ${p===1?C.blue:C.purple}` }} /><span style={{ fontSize:12, color:p===1?C.blue:C.purple, fontWeight:600 }}>P{p}: {scores[p]}</span></div>)}</>
        ) : (
          <span style={{ fontSize:12, color:C.t2 }}>Pairs: {scores[1]}/{EMOJIS.length}</span>
        )}
        <span style={{ fontSize:12, color:C.t3 }}>Moves: {moves}</span>
        <button onClick={reset} style={{ background:C.blue, border:"none", borderRadius:8, color:"#fff", fontSize:11, fontWeight:600, padding:"6px 10px", cursor:"pointer" }}>New</button>
      </div>
      {done && <div style={{ padding:"10px 16px", background:`${C.green}18`, borderBottom:`1px solid ${C.green}30`, textAlign:"center", fontSize:13, color:C.green, fontWeight:600, flexShrink:0 }}>
        {mode==="2p" ? (scores[1]>scores[2]?"P1 wins! 🎉":scores[2]>scores[1]?"P2 wins! 🎉":"It's a tie! 🤝") : "You matched them all! 🎉"}
      </div>}
      {mode==="2p"&&!done&&<div style={{ padding:"6px 16px", background:`${C.bgCard}`, borderBottom:`1px solid ${C.border}`, textAlign:"center", fontSize:12, color:turn===1?C.blue:C.purple, fontWeight:600, flexShrink:0 }}>Player {turn}'s turn</div>}
      <div style={{ flex:1, overflowY:"auto", padding:"10px 12px" }}>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8 }}>
          {cards.map(card => (
            <div key={card.id} onClick={() => flip(card.id)} style={{
              aspectRatio:"1", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:24,
              background: card.matched ? `${C.green}18` : card.flipped ? C.bgCard : C.bgPanel,
              border: `1px solid ${card.matched ? C.green : card.flipped ? C.borderHi : C.border}`,
              cursor: card.matched||card.flipped ? "default" : "pointer",
              transition:"all 0.2s",
            }}>
              {(card.flipped||card.matched) ? card.emoji : "❓"}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Rock Paper Scissors ────────────────────────────────────────────────────────
function GameRPS({ onBack }) {
  const CHOICES = [{id:"rock",emoji:"✊",beats:"scissors"},{id:"scissors",emoji:"✌️",beats:"paper"},{id:"paper",emoji:"🖐️",beats:"rock"}];
  const [playerScore, setPlayerScore] = useState(0);
  const [aiScore, setAiScore]         = useState(0);
  const [round, setRound]             = useState(1);
  const [result, setResult]           = useState(null); // { player, ai, outcome }
  const [done, setDone]               = useState(false);
  const ROUNDS = 5;

  const play = (choice) => {
    if (done) return;
    const ai = CHOICES[Math.floor(Math.random()*3)];
    const player = CHOICES.find(c=>c.id===choice);
    let outcome;
    if (player.id === ai.id) outcome = "draw";
    else if (player.beats === ai.id) outcome = "win";
    else outcome = "lose";
    const np = playerScore + (outcome==="win"?1:0);
    const na = aiScore + (outcome==="lose"?1:0);
    setPlayerScore(np); setAiScore(na);
    setResult({player, ai, outcome});
    const nr = round + 1;
    setRound(nr);
    if (nr > ROUNDS) setDone(true);
  };

  const reset = () => { setPlayerScore(0); setAiScore(0); setRound(1); setResult(null); setDone(false); };

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bgDeep }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"14px 16px", background:C.bgPanel, borderBottom:`1px solid ${C.border}` }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:C.t2, cursor:"pointer", padding:"4px 8px 4px 0" }}><Icon d={IC.arrowL} size={18} /></button>
        <div style={{ flex:1, fontSize:15, fontWeight:700, color:C.t1 }}>Rock Paper Scissors</div>
        <span style={{ fontSize:11, color:C.t3 }}>Best of {ROUNDS}</span>
      </div>
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:24, gap:20 }}>
        <div style={{ display:"flex", gap:28, alignItems:"center" }}>
          <div style={{ textAlign:"center" }}><div style={{ fontSize:32, fontWeight:800, color:C.blue }}>{playerScore}</div><div style={{ fontSize:11, color:C.t3 }}>You</div></div>
          <div style={{ fontSize:14, color:C.t3, fontWeight:600 }}>Round {Math.min(round,ROUNDS)}/{ROUNDS}</div>
          <div style={{ textAlign:"center" }}><div style={{ fontSize:32, fontWeight:800, color:C.red }}>{aiScore}</div><div style={{ fontSize:11, color:C.t3 }}>AI</div></div>
        </div>
        {result && (
          <div style={{ textAlign:"center", padding:"16px 24px", background:C.bgCard, borderRadius:14, border:`1px solid ${C.border}`, width:"100%" }}>
            <div style={{ fontSize:36, marginBottom:6 }}>{result.player.emoji} vs {result.ai.emoji}</div>
            <div style={{ fontSize:15, fontWeight:700, color: result.outcome==="win"?C.green:result.outcome==="lose"?C.red:C.amber }}>
              {result.outcome==="win"?"You win this round! 🎉":result.outcome==="lose"?"AI wins this round":"Draw!"}
            </div>
          </div>
        )}
        {done ? (
          <div style={{ textAlign:"center", width:"100%" }}>
            <div style={{ fontSize:20, fontWeight:800, color: playerScore>aiScore?C.green:aiScore>playerScore?C.red:C.amber, marginBottom:16 }}>
              {playerScore>aiScore?"You won! 🏆":aiScore>playerScore?"AI won 🤖":"It's a tie! 🤝"}
            </div>
            <button onClick={reset} style={{ padding:"12px 32px", borderRadius:12, border:"none", background:C.blue, color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer" }}>Play Again</button>
          </div>
        ) : (
          <div style={{ display:"flex", gap:12, width:"100%" }}>
            {CHOICES.map(c => (
              <button key={c.id} onClick={() => play(c.id)} style={{ flex:1, padding:"18px 8px", borderRadius:14, border:`1px solid ${C.border}`, background:C.bgCard, cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:6, fontSize:32, WebkitTapHighlightColor:"transparent" }}>
                {c.emoji}<span style={{ fontSize:10, color:C.t3, textTransform:"capitalize" }}>{c.id}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Snake ──────────────────────────────────────────────────────────────────────
function GameSnake({ onBack }) {
  const COLS=20, ROWS=18, CELL=16;
  const initState = () => ({ snake:[{x:10,y:9},{x:9,y:9},{x:8,y:9}], dir:{x:1,y:0}, food:randFood([{x:10,y:9}]), alive:true, score:0 });
  function randFood(snake) { let p; do { p={x:Math.floor(Math.random()*COLS),y:Math.floor(Math.random()*ROWS)}; } while(snake.some(s=>s.x===p.x&&s.y===p.y)); return p; }
  const [state, setState] = useState(initState);
  const dirRef = useRef({x:1,y:0});
  const stateRef = useRef(state);
  const touchRef = useRef(null);
  const [running, setRunning] = useState(false);
  const [best, setBest] = useState(0);
  stateRef.current = state;

  const step = useCallback(() => {
    setState(prev => {
      if (!prev.alive) return prev;
      const d = dirRef.current;
      const head = {x:(prev.snake[0].x+d.x+COLS)%COLS, y:(prev.snake[0].y+d.y+ROWS)%ROWS};
      if (prev.snake.some(s=>s.x===head.x&&s.y===head.y)) return {...prev, alive:false};
      const ate = head.x===prev.food.x && head.y===prev.food.y;
      const snake = [head, ...prev.snake.slice(0, ate?undefined:-1)];
      const score = prev.score + (ate?10:0);
      if (score>best) setBest(score);
      return {...prev, snake, food: ate?randFood(snake):prev.food, score};
    });
  }, [best]);

  useEffect(() => {
    if (!running || !state.alive) return;
    const id = setInterval(step, 110);
    return () => clearInterval(id);
  }, [running, state.alive, step]);

  useEffect(() => {
    const h = e => {
      const map={ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1},ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0}};
      const d=map[e.key]; if(d){e.preventDefault(); const c=dirRef.current; if(c.x!==(-d.x)||c.y!==(-d.y)) dirRef.current=d;}
    };
    window.addEventListener("keydown",h); return ()=>window.removeEventListener("keydown",h);
  }, []);

  const reset = () => { const s=initState(); dirRef.current={x:1,y:0}; setState(s); setRunning(true); };

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bgDeep }}
      onTouchStart={e=>{touchRef.current={x:e.touches[0].clientX,y:e.touches[0].clientY};}}
      onTouchEnd={e=>{
        if(!touchRef.current)return;
        const dx=e.changedTouches[0].clientX-touchRef.current.x, dy=e.changedTouches[0].clientY-touchRef.current.y;
        const c=dirRef.current;
        if(Math.abs(dx)>Math.abs(dy)){const d=dx>0?{x:1,y:0}:{x:-1,y:0}; if(c.x!==(-d.x))dirRef.current=d;}
        else{const d=dy>0?{x:0,y:1}:{x:0,y:-1}; if(c.y!==(-d.y))dirRef.current=d;}
        touchRef.current=null;
      }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"14px 16px", background:C.bgPanel, borderBottom:`1px solid ${C.border}` }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:C.t2, cursor:"pointer", padding:"4px 8px 4px 0" }}><Icon d={IC.arrowL} size={18} /></button>
        <div style={{ flex:1, fontSize:15, fontWeight:700, color:C.t1 }}>Snake</div>
        <div style={{ display:"flex", gap:12 }}>
          <span style={{ fontSize:12, color:C.t2 }}>Score: <b style={{ color:C.t1 }}>{state.score}</b></span>
          <span style={{ fontSize:12, color:C.t3 }}>Best: {best}</span>
        </div>
      </div>
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:12, gap:10 }}>
        {!running && !state.alive && state.score>0 && <div style={{ fontSize:16, fontWeight:700, color:C.red, marginBottom:4 }}>Game Over! Score: {state.score}</div>}
        <div style={{ position:"relative", background:C.bgCard, borderRadius:10, border:`1px solid ${C.border}`, overflow:"hidden", width:COLS*CELL, height:ROWS*CELL, flexShrink:0 }}>
          {state.snake.map((s,i) => <div key={i} style={{ position:"absolute", left:s.x*CELL, top:s.y*CELL, width:CELL, height:CELL, borderRadius: i===0?4:2, background: i===0?C.green:`${C.green}${i===1?"dd":"88"}` }} />)}
          <div style={{ position:"absolute", left:state.food.x*CELL, top:state.food.y*CELL, width:CELL, height:CELL, borderRadius:CELL/2, background:C.red }} />
          {!running && <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", background:"rgba(6,17,30,0.8)" }}>
            <button onClick={reset} style={{ padding:"12px 28px", borderRadius:12, border:"none", background:C.green, color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer" }}>{state.score>0?"Restart":"Start Game"}</button>
          </div>}
          {!state.alive && running && <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"rgba(6,17,30,0.85)", gap:12 }}>
            <div style={{ fontSize:16, fontWeight:700, color:C.red }}>Game Over!</div>
            <button onClick={reset} style={{ padding:"10px 24px", borderRadius:10, border:"none", background:C.green, color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer" }}>Play Again</button>
          </div>}
        </div>
        {running && state.alive && <div style={{ fontSize:11, color:C.t3 }}>Swipe or use arrow keys to steer</div>}
        {running && state.alive && (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,44px)", gap:4 }}>
            {[["↑","U",1,0],["←","L",0,1],["↓","D",2,1],["→","R",2,2]].map(([label,_,r,c])=>(
              <button key={label} onClick={()=>{
                const map={U:{x:0,y:-1},D:{x:0,y:1},L:{x:-1,y:0},R:{x:1,y:0}};
                const d=map[_]; const cur=dirRef.current; if(cur.x!==(-d.x)||cur.y!==(-d.y))dirRef.current=d;
              }} style={{ gridRow:r, gridColumn:c+1, width:44, height:44, borderRadius:10, border:`1px solid ${C.border}`, background:C.bgCard, color:C.t1, fontSize:18, cursor:"pointer", WebkitTapHighlightColor:"transparent" }}>{label}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Root: Clerk auth gate ────────────────────────────────────────────────────
// ─── WAV encoder ──────────────────────────────────────────────────────────────
function audioBufferToWav(buffer) {
  const numCh = buffer.numberOfChannels, sr = buffer.sampleRate;
  const dataSize = buffer.length * numCh * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0,"RIFF"); v.setUint32(4,36+dataSize,true); ws(8,"WAVE");
  ws(12,"fmt "); v.setUint32(16,16,true); v.setUint16(20,1,true);
  v.setUint16(22,numCh,true); v.setUint32(24,sr,true);
  v.setUint32(28,sr*numCh*2,true); v.setUint16(32,numCh*2,true);
  v.setUint16(34,16,true); ws(36,"data"); v.setUint32(40,dataSize,true);
  let offset = 44;
  for (let i = 0; i < buffer.length; i++)
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  return ab;
}

// ─── Music Studio (mobile-only panel) ─────────────────────────────────────────
// ─── Mood definitions for generative music ────────────────────────────────────
const MOODS = {
  happy:     { label:"Happy",     emoji:"😄", bpm:124, key:261.63, wave:"triangle", color:"#f59e0b", notes:[0,4,7,9,7,4,2,4],  rhythm:[1,0,1,0,1,1,0,1], filterHz:2000, reverbMix:0.1 },
  sad:       { label:"Sad",       emoji:"😢", bpm:58,  key:220,    wave:"sine",     color:"#3b82f6", notes:[0,3,5,7,5,3,0,3],  rhythm:[1,0,0,1,0,0,1,0], filterHz:800,  reverbMix:0.4 },
  energetic: { label:"Energetic", emoji:"⚡", bpm:148, key:293.66, wave:"sawtooth", color:"#ef4444", notes:[0,0,7,0,5,7,9,0],  rhythm:[1,1,1,1,1,1,1,1], filterHz:3000, reverbMix:0.05 },
  calm:      { label:"Calm",      emoji:"🌿", bpm:68,  key:174.61, wave:"sine",     color:"#22c55e", notes:[0,4,7,9,7,9,7,4],  rhythm:[1,0,0,0,1,0,0,0], filterHz:600,  reverbMix:0.5 },
  dark:      { label:"Dark",      emoji:"🌑", bpm:88,  key:146.83, wave:"sawtooth", color:"#a855f7", notes:[0,3,6,10,8,6,3,0], rhythm:[1,0,1,1,0,1,0,1], filterHz:500,  reverbMix:0.6 },
  romantic:  { label:"Romantic",  emoji:"💗", bpm:76,  key:196,    wave:"triangle", color:"#ec4899", notes:[4,7,9,12,9,7,4,7], rhythm:[1,0,0,1,0,0,1,0], filterHz:1200, reverbMix:0.35 },
};
const SEMITONE = Math.pow(2, 1/12);
const noteFreq = (base, semitones) => base * Math.pow(SEMITONE, semitones);

function MusicStudio() {
  const [tracks, setTracks]       = useState([]);
  const [playing, setPlaying]     = useState(false);
  const [masterVol, setMasterVol] = useState(0.85);
  const [exportUrl, setExportUrl] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [studioTab, setStudioTab]   = useState("mashup"); // "mashup" | "generate"
  // AI Music Generation state
  const [mgStatus, setMgStatus]     = useState("idle"); // idle | loading-model | generating | playing | done | error
  const [mgProgress, setMgProgress] = useState(0);
  const [mgProgressText, setMgProgressText] = useState("");
  const [mgPrompt, setMgPrompt]     = useState("");
  const [mgDuration, setMgDuration] = useState(10); // seconds (mapped to tokens)
  const [mgAudioUrl, setMgAudioUrl] = useState(null);
  const mgEngineRef = useRef(null);
  const mgSrcRef    = useRef(null);
  const mgCtxRef    = useRef(null);
  // Keep old mood state for oscillator fallback (not shown in UI but needed for export)
  const [selMood, setSelMood]     = useState("happy");
  const [genPlaying, setGenPlaying] = useState(false);
  const [genExportUrl, setGenExportUrl] = useState(null);
  const [genExporting, setGenExporting] = useState(false);
  const audioCtxRef  = useRef(null);
  const srcNodesRef  = useRef([]);
  const gainNodesRef = useRef([]);
  const masterRef    = useRef(null);
  const genNodesRef  = useRef([]); // oscillators for generative playback
  const genIntervalRef = useRef(null);

  const getCtx = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      masterRef.current = audioCtxRef.current.createGain();
      masterRef.current.connect(audioCtxRef.current.destination);
    }
    return audioCtxRef.current;
  };

  const loadFiles = async (e) => {
    const ctx = getCtx();
    for (const file of [...e.target.files]) {
      const buf = await file.arrayBuffer();
      try {
        const decoded = await ctx.decodeAudioData(buf);
        setTracks(prev => [...prev, {
          id: Date.now() + Math.random(),
          name: file.name.replace(/\.[^.]+$/, ""),
          buffer: decoded,
          volume: 0.85,
          duration: decoded.duration,
        }]);
      } catch {}
    }
    e.target.value = "";
  };

  const stopAll = () => {
    srcNodesRef.current.forEach(s => { try { s.stop(); } catch {} });
    srcNodesRef.current = [];
    gainNodesRef.current = [];
    setPlaying(false);
  };

  const playMix = () => {
    if (playing) { stopAll(); return; }
    if (!tracks.length) return;
    const ctx = getCtx();
    if (ctx.state === "suspended") ctx.resume();
    stopAll();
    masterRef.current.gain.value = masterVol;
    tracks.forEach(t => {
      const src = ctx.createBufferSource();
      src.buffer = t.buffer; src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = t.volume;
      src.connect(gain); gain.connect(masterRef.current);
      src.start(0);
      srcNodesRef.current.push(src);
      gainNodesRef.current.push({ id: t.id, node: gain });
    });
    setPlaying(true);
  };

  useEffect(() => {
    gainNodesRef.current.forEach(({ id, node }) => {
      const t = tracks.find(x => x.id === id);
      if (t) node.gain.value = t.volume;
    });
  }, [tracks]);

  useEffect(() => {
    if (masterRef.current) masterRef.current.gain.value = masterVol;
  }, [masterVol]);

  const exportMix = async () => {
    if (!tracks.length) return;
    setExporting(true);
    const duration = Math.min(Math.max(...tracks.map(t => t.buffer.duration)), 300);
    const offCtx = new OfflineAudioContext(2, Math.ceil(44100 * duration), 44100);
    const master = offCtx.createGain();
    master.gain.value = masterVol;
    master.connect(offCtx.destination);
    tracks.forEach(t => {
      const src = offCtx.createBufferSource();
      src.buffer = t.buffer;
      const gain = offCtx.createGain();
      gain.gain.value = t.volume;
      src.connect(gain); gain.connect(master);
      src.start(0);
    });
    try {
      const rendered = await offCtx.startRendering();
      const blob = new Blob([audioBufferToWav(rendered)], { type: "audio/wav" });
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      setExportUrl(URL.createObjectURL(blob));
    } catch {}
    setExporting(false);
  };

  // ── Mood generation ────────────────────────────────────────────────────────
  const stopGen = () => {
    genNodesRef.current.forEach(n => { try { n.stop?.(); n.disconnect?.(); } catch {} });
    genNodesRef.current = [];
    if (genIntervalRef.current) { clearInterval(genIntervalRef.current); genIntervalRef.current = null; }
    setGenPlaying(false);
  };

  const playMood = () => {
    if (genPlaying) { stopGen(); return; }
    const ctx = getCtx();
    if (ctx.state === "suspended") ctx.resume();
    stopGen();
    const mood = MOODS[selMood];
    const beatDur = 60 / mood.bpm;
    let step = 0;

    const playStep = () => {
      if (!mood.rhythm[step % mood.rhythm.length]) { step++; return; }
      const freq = noteFreq(mood.key, mood.notes[step % mood.notes.length]);
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      const filt = ctx.createBiquadFilter();

      osc.type = mood.wave;
      osc.frequency.value = freq;
      filt.type = "lowpass";
      filt.frequency.value = mood.filterHz;
      gain.gain.setValueAtTime(0.4, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + beatDur * 0.8);

      osc.connect(filt); filt.connect(gain); gain.connect(masterRef.current);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + beatDur * 0.8);
      genNodesRef.current.push(osc);
      step++;
    };

    playStep();
    genIntervalRef.current = setInterval(playStep, beatDur * 1000);
    setGenPlaying(true);
  };

  const exportMoodMix = async () => {
    const mood = MOODS[selMood];
    setGenExporting(true);
    const bars = 8, beatDur = 60 / mood.bpm;
    const totalDur = bars * mood.notes.length * beatDur;
    const offCtx = new OfflineAudioContext(2, Math.ceil(44100 * totalDur), 44100);
    const master = offCtx.createGain();
    master.gain.value = masterVol;
    master.connect(offCtx.destination);

    let t = 0;
    for (let bar = 0; bar < bars; bar++) {
      for (let i = 0; i < mood.notes.length; i++) {
        if (mood.rhythm[i % mood.rhythm.length]) {
          const freq = noteFreq(mood.key, mood.notes[i]);
          const osc  = offCtx.createOscillator();
          const gain = offCtx.createGain();
          const filt = offCtx.createBiquadFilter();
          osc.type = mood.wave;
          osc.frequency.value = freq;
          filt.type = "lowpass"; filt.frequency.value = mood.filterHz;
          gain.gain.setValueAtTime(0.4, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + beatDur * 0.8);
          osc.connect(filt); filt.connect(gain); gain.connect(master);
          osc.start(t); osc.stop(t + beatDur * 0.8);
        }
        t += beatDur;
      }
    }
    try {
      const rendered = await offCtx.startRendering();
      const blob = new Blob([audioBufferToWav(rendered)], { type: "audio/wav" });
      if (genExportUrl) URL.revokeObjectURL(genExportUrl);
      setGenExportUrl(URL.createObjectURL(blob));
    } catch {}
    setGenExporting(false);
  };

  // ── AI Music Generation (MusicGen via @huggingface/transformers) ─────────────
  const MOOD_PROMPTS = {
    happy:     "upbeat happy pop music with bright piano and catchy melody",
    sad:       "melancholic sad piano ballad with soft strings and slow tempo",
    energetic: "high energy electronic dance music with heavy bass and driving beat",
    calm:      "peaceful ambient music with soft pads and gentle acoustic guitar",
    dark:      "dark cinematic music with deep bass, tension and mysterious atmosphere",
    romantic:  "romantic soft jazz with warm piano and gentle acoustic guitar",
    epic:      "epic orchestral film score with soaring strings and powerful drums",
    lofi:      "lo-fi hip hop beats with warm vinyl crackle and relaxed groove",
  };

  const generateMusic = async () => {
    if (mgStatus === "playing") {
      mgSrcRef.current?.stop();
      mgSrcRef.current = null;
      setMgStatus("done");
      return;
    }
    setMgStatus("loading-model");
    setMgProgress(0);
    setMgProgressText("Loading MusicGen AI model (one-time ~300MB download)…");
    try {
      if (!mgEngineRef.current) {
        mgEngineRef.current = await pipeline("text-to-audio", "Xenova/musicgen-small", {
          progress_callback: (p) => {
            if (p.status === "downloading" || p.status === "loading") {
              const pct = p.progress ? Math.round(p.progress) : 0;
              setMgProgress(pct);
              setMgProgressText(`${p.status === "loading" ? "Loading" : "Downloading"} model${p.file ? ` (${p.file.split("/").pop()})` : ""}… ${pct}%`);
            } else if (p.status === "ready") {
              setMgProgressText("Model ready ✓");
            }
          },
        });
      }
      setMgStatus("generating");
      setMgProgressText("Generating music…");
      const prompt = mgPrompt.trim() || MOOD_PROMPTS[selMood] || "upbeat happy music";
      const tokensPerSec = 50;
      const maxTokens = Math.min(Math.max(mgDuration * tokensPerSec, 100), 1500);
      const output = await mgEngineRef.current(prompt, {
        max_new_tokens: maxTokens,
        do_sample: true,
        guidance_scale: 3,
      });
      // output[0].audio = Float32Array, output[0].sampling_rate = number
      const sampleRate = output[0].sampling_rate;
      const audioData  = output[0].audio;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      mgCtxRef.current = ctx;
      const buf = ctx.createBuffer(1, audioData.length, sampleRate);
      buf.getChannelData(0).set(audioData);
      // Also create downloadable URL
      const wavBlob = new Blob([audioBufferToWav(buf)], { type: "audio/wav" });
      if (mgAudioUrl) URL.revokeObjectURL(mgAudioUrl);
      setMgAudioUrl(URL.createObjectURL(wavBlob));
      // Auto-play
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => setMgStatus("done");
      src.start(0);
      mgSrcRef.current = src;
      setMgStatus("playing");
      setMgProgressText("");
    } catch (err) {
      setMgStatus("error");
      setMgProgressText(`Error: ${err.message || err}`);
    }
  };

  const GRAD = [
    ["#3b82f6","#38bdf8"],["#a855f7","#3b82f6"],["#22c55e","#38bdf8"],
    ["#f59e0b","#ef4444"],["#ef4444","#a855f7"],["#38bdf8","#22c55e"],
  ];
  const fmtDur = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: C.bgDeep, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "16px 16px 12px", background: C.bgPanel, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: `linear-gradient(135deg,${C.purple},${C.blue})`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Icon d={IC.music} size={18} stroke="#fff" />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.t1 }}>Music Studio</div>
            <div style={{ fontSize: 11, color: C.t3 }}>Mix & mashup your songs · 100% offline</div>
          </div>
        </div>
        {/* Tab switcher */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {[["mashup","🎛 Mashup"],["generate","✨ Generate"]].map(([id, label]) => (
            <button key={id} onClick={() => setStudioTab(id)} style={{ flex: 1, padding: "8px", borderRadius: 9, border: `1px solid ${studioTab===id ? C.blue : C.border}`, background: studioTab===id ? "rgba(59,130,246,0.15)" : C.bgCard, color: studioTab===id ? C.blue : C.t2, fontSize: 12.5, fontWeight: studioTab===id ? 700 : 400, cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
              {label}
            </button>
          ))}
        </div>

        {studioTab === "mashup" && (
          <label style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "11px", background: C.blue, borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
            <Icon d={IC.plus} size={15} stroke="#fff" /> Add Tracks (MP3 / WAV)
            <input type="file" accept="audio/*" multiple onChange={loadFiles} style={{ display: "none" }} />
          </label>
        )}
      </div>

      {/* ── AI Generate (MusicGen — like Lyria) ── */}
      {studioTab === "generate" && (
        <div style={{ flex: 1, overflowY: "auto", padding: "14px", WebkitOverflowScrolling: "touch" }}>

          {/* Hero badge */}
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14, padding:"10px 12px", background:"rgba(168,85,247,0.08)", border:"1px solid rgba(168,85,247,0.2)", borderRadius:10 }}>
            <span style={{ fontSize:18 }}>🎵</span>
            <div>
              <div style={{ fontSize:12, fontWeight:700, color:C.purple }}>AI Music Generator</div>
              <div style={{ fontSize:10, color:C.t3 }}>Powered by MusicGen · 100% offline after first load</div>
            </div>
            {mgEngineRef.current && <span style={{ marginLeft:"auto", fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:10, background:"rgba(34,197,94,0.15)", color:C.green, border:"1px solid rgba(34,197,94,0.3)" }}>Ready</span>}
          </div>

          {/* Prompt input */}
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11, color:C.t3, marginBottom:6, fontWeight:600 }}>DESCRIBE YOUR MUSIC</div>
            <textarea
              value={mgPrompt}
              onChange={e => setMgPrompt(e.target.value)}
              placeholder="e.g. upbeat electronic dance music with heavy bass and synths…"
              rows={3}
              style={{ width:"100%", padding:"10px 12px", background:C.bgCard, border:`1px solid ${C.border}`, borderRadius:10, color:C.t1, fontSize:13, lineHeight:1.5, fontFamily:"inherit" }}
            />
          </div>

          {/* Style presets */}
          <div style={{ fontSize:11, color:C.t3, marginBottom:8, fontWeight:600 }}>QUICK STYLES</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6, marginBottom:14 }}>
            {Object.entries(MOOD_PROMPTS).map(([id, prompt]) => {
              const EMOJIS2 = {happy:"😊",sad:"😢",energetic:"⚡",calm:"🌿",dark:"🌑",romantic:"💗",epic:"🎬",lofi:"🎧"};
              const LABELS  = {happy:"Happy",sad:"Sad",energetic:"Energy",calm:"Calm",dark:"Dark",romantic:"Romance",epic:"Epic",lofi:"Lo-fi"};
              const isActive = mgPrompt === prompt;
              return (
                <button key={id} onClick={() => setMgPrompt(prompt)} style={{
                  padding:"8px 4px", borderRadius:10, border:`1px solid ${isActive ? C.purple : C.border}`,
                  background: isActive ? "rgba(168,85,247,0.15)" : C.bgCard,
                  cursor:"pointer", WebkitTapHighlightColor:"transparent",
                  display:"flex", flexDirection:"column", alignItems:"center", gap:3,
                }}>
                  <span style={{ fontSize:18 }}>{EMOJIS2[id]}</span>
                  <span style={{ fontSize:9, color: isActive ? C.purple : C.t3, fontWeight: isActive ? 600 : 400 }}>{LABELS[id]}</span>
                </button>
              );
            })}
          </div>

          {/* Duration */}
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16, padding:"10px 12px", background:C.bgCard, borderRadius:10, border:`1px solid ${C.border}` }}>
            <span style={{ fontSize:11, color:C.t3, fontWeight:600, flexShrink:0 }}>DURATION</span>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              {[5,10,15,30].map(d => (
                <button key={d} onClick={() => setMgDuration(d)} style={{ padding:"5px 12px", borderRadius:20, border:`1px solid ${mgDuration===d?C.blue:C.border}`, background:mgDuration===d?`${C.blue}18`:C.bgPanel, color:mgDuration===d?C.blue:C.t3, fontSize:11, fontWeight:600, cursor:"pointer" }}>{d}s</button>
              ))}
            </div>
          </div>

          {/* Progress */}
          {(mgStatus === "loading-model" || mgStatus === "generating") && (
            <div style={{ marginBottom:14, padding:"12px", background:C.bgCard, borderRadius:10, border:`1px solid ${C.border}` }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                <Spinner />
                <span style={{ fontSize:12, color:C.t2 }}>{mgProgressText}</span>
              </div>
              {mgStatus === "loading-model" && mgProgress > 0 && (
                <div style={{ height:3, background:C.bgDeep, borderRadius:4 }}>
                  <div style={{ height:"100%", width:`${mgProgress}%`, background:C.purple, borderRadius:4, transition:"width 0.3s" }} />
                </div>
              )}
              {mgStatus === "generating" && (
                <div style={{ height:3, background:C.bgDeep, borderRadius:4, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:"40%", background:C.purple, borderRadius:4, animation:"oai-slide-bar 1.5s ease-in-out infinite" }} />
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {mgStatus === "error" && (
            <div style={{ marginBottom:14, padding:"12px", background:"rgba(239,68,68,0.08)", borderRadius:10, border:"1px solid rgba(239,68,68,0.2)", fontSize:12, color:C.red }}>{mgProgressText}</div>
          )}

          {/* Generated audio player */}
          {mgAudioUrl && (mgStatus === "playing" || mgStatus === "done") && (
            <div style={{ marginBottom:14, padding:"14px", background:`rgba(168,85,247,0.08)`, borderRadius:12, border:`1px solid rgba(168,85,247,0.2)` }}>
              <div style={{ fontSize:12, fontWeight:600, color:C.purple, marginBottom:10 }}>✨ Music Generated!</div>
              <audio controls src={mgAudioUrl} style={{ width:"100%", borderRadius:8, height:36 }} />
              <a href={mgAudioUrl} download="ai-music.wav" style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:7, marginTop:10, padding:"10px", background:"rgba(34,197,94,0.10)", border:"1px solid rgba(34,197,94,0.25)", borderRadius:9, color:C.green, fontSize:12, fontWeight:600, textDecoration:"none" }}>
                <Icon d={IC.dl} size={13} stroke={C.green} /> Download (WAV)
              </a>
            </div>
          )}

          {/* Generate button */}
          <button onClick={generateMusic}
            disabled={mgStatus==="loading-model"||mgStatus==="generating"}
            style={{ width:"100%", padding:"15px", borderRadius:12, border:"none", cursor: mgStatus==="loading-model"||mgStatus==="generating" ? "not-allowed" : "pointer",
              background: mgStatus==="playing" ? C.red : mgStatus==="loading-model"||mgStatus==="generating" ? C.t3 : `linear-gradient(135deg,${C.purple},${C.blue})`,
              color:"#fff", fontSize:15, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center", gap:10, WebkitTapHighlightColor:"transparent" }}>
            {mgStatus==="loading-model" ? <><Spinner />Loading model…</> :
             mgStatus==="generating"    ? <><Spinner />Generating music…</> :
             mgStatus==="playing"       ? <><Icon d={IC.stopSq} size={16} stroke="#fff" fill="#fff" />Stop</> :
             <><span style={{ fontSize:18 }}>🎵</span>Generate Music</>}
          </button>

          <div style={{ fontSize:10, color:C.t3, textAlign:"center", marginTop:10, lineHeight:1.5 }}>
            First use downloads MusicGen (~300MB) into browser cache.<br/>After that, works 100% offline forever.
          </div>
        </div>
      )}

      {/* ── Mashup track list ── */}
      {studioTab === "mashup" && <div style={{ flex: 1, overflowY: "auto", padding: "12px", WebkitOverflowScrolling: "touch" }}>
        {!tracks.length && (
          <div style={{ textAlign: "center", padding: "48px 20px" }}>
            <div style={{ fontSize: 48, marginBottom: 14 }}>🎵</div>
            <div style={{ fontSize: 14, color: C.t2, fontWeight: 500, marginBottom: 6 }}>No tracks yet</div>
            <div style={{ fontSize: 12, color: C.t3 }}>Tap "Add Tracks" to load MP3 or WAV files and create a mashup</div>
          </div>
        )}
        {tracks.map((t, i) => (
          <div key={t.id} style={{ background: C.bgCard, borderRadius: 14, padding: "14px", marginBottom: 10, border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: `linear-gradient(135deg,${GRAD[i%GRAD.length][0]},${GRAD[i%GRAD.length][1]})`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon d={IC.waveform} size={18} stroke="#fff" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.t1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</div>
                <div style={{ fontSize: 10, color: C.t3, marginTop: 2 }}>{fmtDur(t.duration)}</div>
              </div>
              <button onClick={() => { if (playing) stopAll(); setTracks(p => p.filter(x => x.id !== t.id)); setExportUrl(null); }} style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 7, color: C.red, padding: "5px 7px", cursor: "pointer" }}>
                <Icon d={IC.x} size={13} stroke={C.red} />
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Icon d={IC.vol} size={13} stroke={C.t3} />
              <input type="range" min={0} max={1} step={0.01} value={t.volume}
                onChange={e => setTracks(p => p.map(x => x.id === t.id ? { ...x, volume: +e.target.value } : x))}
                style={{ flex: 1, accentColor: GRAD[i%GRAD.length][0], height: 4, cursor: "pointer" }} />
              <span style={{ fontSize: 10, color: C.t3, width: 32, textAlign: "right" }}>{Math.round(t.volume * 100)}%</span>
            </div>
          </div>
        ))}
      </div>}{/* end mashup track list */}

      {/* Controls — mashup only */}
      {studioTab === "mashup" && tracks.length > 0 && (
        <div style={{ padding: "12px 14px", background: C.bgPanel, borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 11, color: C.t3, width: 50, flexShrink: 0 }}>Master</span>
            <input type="range" min={0} max={1} step={0.01} value={masterVol}
              onChange={e => setMasterVol(+e.target.value)}
              style={{ flex: 1, accentColor: C.purple, height: 4, cursor: "pointer" }} />
            <span style={{ fontSize: 10, color: C.t3, width: 32, textAlign: "right" }}>{Math.round(masterVol*100)}%</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={playMix} style={{ flex: 2, padding: "13px", borderRadius: 11, border: "none", cursor: "pointer", background: playing ? C.red : C.green, color: "#fff", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, WebkitTapHighlightColor: "transparent" }}>
              <Icon d={playing ? IC.stop2 : IC.play} size={16} stroke="#fff" fill="#fff" />
              {playing ? "Stop" : "Play Mix"}
            </button>
            <button onClick={exportMix} disabled={exporting} style={{ flex: 1, padding: "13px", borderRadius: 11, border: `1px solid ${C.border}`, background: C.bgCard, color: C.t2, fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, WebkitTapHighlightColor: "transparent" }}>
              {exporting ? <Spinner /> : <Icon d={IC.dl} size={14} stroke={C.t2} />}
              {exporting ? "…" : "Export"}
            </button>
          </div>
          {exportUrl && (
            <a href={exportUrl} download="mashup.wav" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 10, padding: "11px", background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.25)", borderRadius: 10, color: C.green, fontSize: 12.5, fontWeight: 600, textDecoration: "none", WebkitTapHighlightColor: "transparent" }}>
              <Icon d={IC.dl} size={13} stroke={C.green} /> Download Mashup (WAV)
            </a>
          )}
        </div>
      )}
    </div>
  );
}

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
