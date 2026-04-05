// ── Content script — extracts page content for CodeForge AI ──────────────────
// Listens for messages from the side panel and returns page content

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_PAGE_CONTENT") {
    sendResponse({ content: extractPageContent(), url: location.href, title: document.title });
  }
  if (msg.type === "GET_SELECTION") {
    const sel = window.getSelection()?.toString().trim() || "";
    sendResponse({ selection: sel });
  }

  // ── Translation overlay messages ──────────────────────────────────────────
  if (msg.type === "TRANSLATION_INIT") {
    // Create the overlay with a loading state before tokens start arriving
    initTranslationOverlay(msg.fromLang, msg.toLang, msg.pageTitle);
    sendResponse({ ok: true });
  }
  if (msg.type === "TRANSLATION_CHUNK") {
    // Append streamed text chunk to the overlay in real-time
    appendTranslationChunk(msg.text);
    sendResponse({ ok: true });
  }
  if (msg.type === "TRANSLATION_DONE") {
    // Finalise — hide loader, show the full text cleanly
    finaliseTranslation();
    sendResponse({ ok: true });
  }
  if (msg.type === "TRANSLATION_ERROR") {
    showTranslationError(msg.message);
    sendResponse({ ok: true });
  }

  return true;
});

function extractPageContent() {
  const clone = document.body.cloneNode(true);
  ["script","style","nav","footer","header","aside","iframe",
   "noscript","svg","button","input","select","form"].forEach(tag => {
    clone.querySelectorAll(tag).forEach(el => el.remove());
  });
  let text = clone.innerText || clone.textContent || "";
  text = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  if (text.length > 8000) text = text.slice(0, 8000) + "\n\n[content truncated...]";
  return text;
}

// ── Translation overlay ────────────────────────────────────────────────────────

const OVERLAY_ID = "codeforge-translation-overlay";

function initTranslationOverlay(fromLang, toLang, pageTitle) {
  // Remove any previous overlay
  document.getElementById(OVERLAY_ID)?.remove();

  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches
    || document.documentElement.classList.contains("dark")
    || parseInt(getComputedStyle(document.body).backgroundColor.match(/\d+/)?.[0] || 255) < 80;

  const bg    = isDark ? "#0f172a" : "#ffffff";
  const text  = isDark ? "#e2e8f0" : "#1e293b";
  const sub   = isDark ? "#64748b" : "#94a3b8";
  const border= isDark ? "#1e293b" : "#e2e8f0";
  const btnBg = isDark ? "#1e293b" : "#f1f5f9";
  const btnTx = isDark ? "#94a3b8" : "#475569";

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = `
    position:fixed; inset:0; background:${bg}; color:${text};
    z-index:2147483647; overflow-y:auto; overflow-x:hidden;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    font-size:16px; line-height:1.75;
  `;

  overlay.innerHTML = `
    <div style="max-width:820px;margin:0 auto;padding:36px 28px 60px;">

      <!-- Header bar -->
      <div style="display:flex;justify-content:space-between;align-items:center;
                  margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid ${border};">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="font-size:18px;">🌐</span>
          <span style="font-weight:700;font-size:14px;color:${text};">CodeForge Translation</span>
          <span style="font-size:13px;color:${sub};">${fromLang || "Auto"}</span>
          <span style="font-size:13px;color:${sub};">→</span>
          <span style="font-size:13px;font-weight:600;color:#3b82f6;">${toLang}</span>
          ${pageTitle ? `<span style="font-size:12px;color:${sub};margin-left:8px;max-width:300px;
            overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(pageTitle)}</span>` : ""}
        </div>
        <button id="cf-close-translation"
          style="background:${btnBg};border:none;border-radius:8px;padding:7px 14px;
                 font-size:12.5px;font-weight:600;cursor:pointer;color:${btnTx};
                 white-space:nowrap;flex-shrink:0;">
          ✕ Show Original
        </button>
      </div>

      <!-- Loading indicator (visible until first chunk arrives) -->
      <div id="cf-translation-loader"
        style="display:flex;align-items:center;gap:10px;color:${sub};font-size:13px;margin-bottom:20px;">
        <span style="display:inline-block;width:14px;height:14px;border:2px solid #3b82f6;
          border-top-color:transparent;border-radius:50%;
          animation:cf-spin 0.7s linear infinite;"></span>
        Translating…
      </div>

      <!-- Translated text area — populated as tokens stream in -->
      <div id="cf-translation-body" style="white-space:pre-wrap;word-break:break-word;"></div>

    </div>
    <style>
      @keyframes cf-spin { to { transform:rotate(360deg); } }
      #cf-close-translation:hover { opacity:0.8; }
    </style>
  `;

  document.body.appendChild(overlay);
  overlay.scrollTop = 0;

  document.getElementById("cf-close-translation").addEventListener("click", () => {
    overlay.remove();
  });
}

function appendTranslationChunk(text) {
  const body   = document.getElementById("cf-translation-body");
  const loader = document.getElementById("cf-translation-loader");
  if (!body) return;
  if (loader) loader.style.display = "none";  // hide spinner once text starts
  body.textContent += text;
  // Keep scroll at bottom while streaming
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.scrollTop = overlay.scrollHeight;
}

function finaliseTranslation() {
  document.getElementById("cf-translation-loader")?.remove();
  // Add a subtle "done" bar at the bottom
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  const bar = document.createElement("div");
  bar.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;
    background:rgba(59,130,246,0.9);color:#fff;
    text-align:center;font-size:12px;font-weight:600;
    padding:7px;letter-spacing:0.3px;z-index:2147483648;
  `;
  bar.textContent = "✅ Translation complete — click \"Show Original\" to go back";
  overlay.appendChild(bar);
  overlay.scrollTop = 0; // scroll back to top after translation finishes
}

function showTranslationError(message) {
  const loader = document.getElementById("cf-translation-loader");
  if (loader) loader.innerHTML = `⚠️ ${escapeHtml(message)}`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
