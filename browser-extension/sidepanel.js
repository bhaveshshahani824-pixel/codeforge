// ── CodeForge AI — Browser Extension Side Panel ───────────────────────────────
const HUB_URL      = "ws://127.0.0.1:7471";
const RECONNECT_MS = 3000;

let ws             = null;
let isConnected    = false;
let isStreaming    = false;
let currentAiEl   = null;
let useContext     = false;   // whether to send page content with question
let pageContent    = "";
let pageUrl        = "";
let pageTitle      = "";

// Translation state — tokens go to page instead of sidepanel chat
let isTranslating  = false;
let translateTabId = null;
let translateBuf   = "";
let translateFlush = null;  // interval for flushing chunk buffer to page

// ── DOM ───────────────────────────────────────────────────────────────────────
const $chat      = () => document.getElementById("chat");
const $question  = () => document.getElementById("question");
const $askBtn    = () => document.getElementById("askBtn");
const $statusDot = () => document.getElementById("statusDot");
const $statusTxt = () => document.getElementById("statusText");
const $subHint   = () => document.getElementById("subHint");
const $empty     = () => document.getElementById("emptyState");
const $ctxLabel  = () => document.getElementById("ctxLabel");
const $ctxToggle = () => document.getElementById("ctxToggle");

// ── Page info ─────────────────────────────────────────────────────────────────
async function loadPageInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    pageUrl   = tab.url   || "";
    pageTitle = tab.title || "";
    document.getElementById("pageTitle").textContent = pageTitle || pageUrl;
    const favicon = document.getElementById("pageFavicon");
    favicon.src = `https://www.google.com/s2/favicons?sz=16&domain=${new URL(pageUrl).hostname}`;
  } catch { /* ignore */ }
}

async function fetchPageContent() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return "";
    const result = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_CONTENT" });
    return result?.content || "";
  } catch { return ""; }
}

async function fetchSelection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return "";
    const result = await chrome.tabs.sendMessage(tab.id, { type: "GET_SELECTION" });
    return result?.selection || "";
  } catch { return ""; }
}

// ── Context toggle ────────────────────────────────────────────────────────────
async function toggleContext() {
  useContext = !useContext;
  $ctxToggle().classList.toggle("active", useContext);
  if (useContext) {
    $ctxLabel().textContent = "⏳ Reading page…";
    pageContent = await fetchPageContent();
    const words = pageContent.split(/\s+/).length;
    $ctxLabel().textContent = `📄 Page loaded (~${words} words)`;
  } else {
    pageContent = "";
    $ctxLabel().textContent = "📄 Page context: off";
  }
  updateAskBtn();
}

// ── Connection ────────────────────────────────────────────────────────────────
function setConnected(v) {
  isConnected = v;
  $statusDot().className = "status-dot" + (v ? " connected" : "");
  $statusTxt().textContent = v ? "Connected" : "Disconnected";
  updateAskBtn();
}
function updateAskBtn() {
  const hasText = $question().value.trim().length > 0;
  $askBtn().disabled = !isConnected || isStreaming || !hasText;
  if (!isConnected)     $subHint().textContent = "⚠️ Open CodeForge app first";
  else if (isStreaming) $subHint().textContent = "Answering…";
  else                  $subHint().textContent = useContext ? "Asking about this page" : "Ask any question";
}

// ── Chat ──────────────────────────────────────────────────────────────────────
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

// ── Token estimator ───────────────────────────────────────────────────────────
function estimateTokens(question) {
  const q = question.toLowerCase().trim();
  if (q.startsWith("explain"))                             return 1500;
  if (q.includes("summarise") || q.includes("summarize")) return 1000;
  if (q.includes("compare") || q.includes("list all"))    return 800;
  return 600;
}

// ── Ask ───────────────────────────────────────────────────────────────────────
async function ask() {
  const question = $question().value.trim();
  if (!question || !isConnected || isStreaming) return;

  // ── Translation detection: route to page instead of sidepanel ────────────
  const targetLang = detectTranslation(question);
  if (targetLang) {
    await askTranslation(question, targetLang);
    return;
  }

  // ── Normal question ───────────────────────────────────────────────────────
  const selection = await Promise.race([
    fetchSelection(),
    new Promise(resolve => setTimeout(() => resolve(""), 500))
  ]);

  addMessage(question, "user");
  $question().value = "";
  $question().style.height = "";
  updateAskBtn();
  isStreaming = true;
  updateAskBtn();
  startAiMessage();

  const tokens = estimateTokens(question);

  ws.send(JSON.stringify({
    type:            "browser_query",
    question,
    pageTitle,
    pageUrl,
    pageContent:     useContext ? pageContent : "",
    selection:       selection,
    hasContext:      useContext || selection.length > 0,
    suggestedTokens: tokens,
  }));
}

// ── Translation flow ──────────────────────────────────────────────────────────
async function askTranslation(question, targetLang) {
  // Get the current tab ID — needed to send overlay messages
  let tabId = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id || null;
  } catch { /* ignore */ }

  if (!tabId) {
    addMessage("⚠️ Cannot access this tab for translation.", "error");
    return;
  }

  // Read full page content for translation
  addMessage(question, "user");
  $question().value = "";
  $question().style.height = "";
  updateAskBtn();

  addMessage("🌐 Reading page content…", "status-msg");
  const content = await Promise.race([
    fetchPageContent(),
    new Promise(resolve => setTimeout(() => resolve(""), 3000))
  ]);

  if (!content.trim()) {
    addMessage("⚠️ Could not read page content. Try enabling Page Context first.", "error");
    return;
  }

  // Cap at 3000 chars — local LLM quality degrades on very long translations
  const cappedContent = content.length > 3000
    ? content.slice(0, 3000) + "\n\n[content truncated — only first ~500 words translated]"
    : content;

  // Detect source language hint from URL / meta / content for display purposes only
  const fromLang = detectSourceLanguage();

  // Init overlay on the page BEFORE tokens start arriving
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "TRANSLATION_INIT",
      fromLang,
      toLang: targetLang,
      pageTitle,
    });
  } catch {
    addMessage("⚠️ Cannot inject translation overlay on this page (restricted URL).", "error");
    return;
  }

  addMessage(`🌐 Translating to ${targetLang}… (shown on page)`, "status-msg");

  // Set translation state — tokens now go to page, not chat
  isTranslating  = true;
  isStreaming     = true;
  translateTabId  = tabId;
  translateBuf    = "";
  updateAskBtn();

  // Flush buffer to page every 150ms for a smooth streaming effect
  translateFlush = setInterval(flushTranslationBuffer, 150);

  ws.send(JSON.stringify({
    type:            "translate_page",
    content:         cappedContent,
    targetLang,
    sourceHint:      fromLang,
    pageTitle,
    suggestedTokens: 2000,
  }));
}

/** Guess source language from page meta tags / lang attribute */
function detectSourceLanguage() {
  try {
    const [tab] = chrome.tabs.query
      ? [] // can't use sync tabs.query here
      : [];
  } catch { /* */ }
  // Check document.documentElement.lang via pageUrl heuristics
  const url = pageUrl.toLowerCase();
  if (url.includes(".cn") || url.includes("/zh"))   return "Chinese";
  if (url.includes(".fr") || url.includes("/fr"))   return "French";
  if (url.includes(".de") || url.includes("/de"))   return "German";
  if (url.includes(".es") || url.includes("/es"))   return "Spanish";
  if (url.includes(".jp") || url.includes("/ja"))   return "Japanese";
  if (url.includes(".ru") || url.includes("/ru"))   return "Russian";
  if (url.includes(".ar") || url.includes("/ar"))   return "Arabic";
  if (url.includes(".in") || url.includes("/hi"))   return "Hindi";
  return "Auto-detect";
}

// ── Translation helpers ───────────────────────────────────────────────────────

/** Returns target language if the question is a translation request, else null */
function detectTranslation(question) {
  const q = question.toLowerCase();
  const LANGS = {
    english: "English", hindi: "Hindi", french: "French", german: "German",
    spanish: "Spanish", italian: "Italian", chinese: "Chinese",
    japanese: "Japanese", arabic: "Arabic", portuguese: "Portuguese",
    russian: "Russian", korean: "Korean", dutch: "Dutch", turkish: "Turkish",
    swedish: "Swedish", polish: "Polish", vietnamese: "Vietnamese",
  };
  const isTranslate =
    /translat|convert.*(page|article|this|language)|to (english|hindi|french|german|spanish|italian|chinese|japanese|arabic|portuguese|russian|korean|dutch|turkish|swedish|polish|vietnamese)|in (english|hindi|french|german|spanish|italian|chinese|japanese|arabic)/
      .test(q);
  if (!isTranslate) return null;

  for (const [key, val] of Object.entries(LANGS)) {
    if (q.includes(key)) return val;
  }
  return "English"; // default target
}

/** Flush buffered translation tokens to the content script */
async function flushTranslationBuffer() {
  if (!translateBuf || !translateTabId) return;
  const chunk = translateBuf;
  translateBuf = "";
  try {
    await chrome.tabs.sendMessage(translateTabId, { type: "TRANSLATION_CHUNK", text: chunk });
  } catch { /* tab may have navigated */ }
}

/** Clean up translation streaming state */
function endTranslation() {
  if (translateFlush) { clearInterval(translateFlush); translateFlush = null; }
  if (translateBuf)   flushTranslationBuffer();
  isTranslating  = false;
  translateTabId = null;
  translateBuf   = "";
  isStreaming    = false;
  updateAskBtn();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
  try { ws = new WebSocket(HUB_URL); } catch { setTimeout(connect, RECONNECT_MS); return; }
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", editor: "browser" }));
    setConnected(true);
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }

    // ── Translation: tokens go to the PAGE, not the sidepanel chat ────────
    if (isTranslating) {
      switch (msg.type) {
        case "token":
          if (msg.content) translateBuf += msg.content;
          break;
        case "done":
          flushTranslationBuffer().then(() => {
            chrome.tabs.sendMessage(translateTabId, { type: "TRANSLATION_DONE" }).catch(() => {});
            addMessage("✅ Translation shown on the page — click \"Show Original\" to restore.", "status-msg");
            endTranslation();
          });
          break;
        case "error":
          chrome.tabs.sendMessage(translateTabId, {
            type: "TRANSLATION_ERROR", message: msg.message || "Translation failed"
          }).catch(() => {});
          addMessage("⚠️ Translation error: " + (msg.message || "Unknown error"), "error");
          endTranslation();
          break;
      }
      return;  // do NOT fall through to normal chat handling
    }

    // ── Normal chat ────────────────────────────────────────────────────────
    switch (msg.type) {
      case "token": if (msg.content) appendToken(msg.content); break;
      case "done":  finishAiMessage(); break;
      case "error": finishAiMessage(); addMessage("⚠️ " + (msg.message || "Error"), "error"); break;
    }
  };
  ws.onclose = () => {
    setConnected(false);
    if (isTranslating) endTranslation();
    else if (isStreaming) finishAiMessage();
    setTimeout(connect, RECONNECT_MS);
  };
  ws.onerror = () => ws.close();
}

// ── UI ────────────────────────────────────────────────────────────────────────
function handleKey(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }
function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 90) + "px";
  updateAskBtn();
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  connect();
  loadPageInfo();
  $question().addEventListener("input", () => { autoResize($question()); updateAskBtn(); });
  $question().addEventListener("keydown", handleKey);
  $askBtn().addEventListener("click", ask);
  $ctxToggle().addEventListener("click", toggleContext);
  $ctxToggle().addEventListener("error", () => {}, true); // suppress favicon errors
  document.getElementById("pageFavicon").addEventListener("error", function() { this.style.display = "none"; });
});
