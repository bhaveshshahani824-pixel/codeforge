# OfflineAI Hub — VS Code Extension

Connect **VS Code**, **Cursor**, or any VS Code-compatible editor to the OfflineAI desktop app.
The AI sees your open file, selected code, and cursor position — all 100% offline, nothing sent to the internet.

---

## Install

### Step 1 — Build the extension
```bash
cd vscode-extension
npm install
npm run build
```
This creates the compiled extension in the `out/` folder.

### Step 2 — Package into a .vsix file
```bash
npx vsce package --allow-missing-repository
```
This creates `offlineai-hub-1.0.0.vsix` in the current folder.

### Step 3 — Install in VS Code / Cursor
1. Open VS Code or Cursor
2. Press `Ctrl+Shift+P` → type **"Install from VSIX"**
3. Select `offlineai-hub-1.0.0.vsix`
4. Reload the window when prompted

---

## Usage

1. **Open the OfflineAI desktop app** — it starts the Hub server automatically on `ws://127.0.0.1:7471`
2. **Open any file** in VS Code or Cursor — the extension connects automatically
3. **Check the status bar** — you'll see `● OfflineAI` (green dot = connected)
4. **Open the Hub panel** in OfflineAI — your editor appears as a subhub
5. **Select code** in the editor → it appears in the Hub panel context
6. **Ask AI questions** about your code in the OfflineAI Hub panel
7. **Right-click selected code** to use quick commands:
   - 🔍 Explain Selection
   - ♻️ Refactor Selection
   - 🐛 Fix Bug
   - 💬 Add Comments
8. **Click "Apply to Editor"** in OfflineAI → code is inserted directly into your editor

---

## How it works

```
VS Code Extension ──ws://127.0.0.1:7471──► OfflineAI Desktop App
    │                                              │
    │  { type: "context",                          │  Shows file + selected
    │    file: "app.tsx",                          │  code in Hub panel
    │    language: "typescript",                   │
    │    selectedCode: "...",          ◄───────────┤
    │    cursorLine: 42 }                          │  { type: "apply",
    │                                              │    code: "..." }
    └──────────────────────────────────────────────┘
```

- Context updates are sent automatically when your cursor moves or selection changes (debounced 500 ms)
- AI responses with code show an **"Apply to Editor"** button that replaces your selection
- The extension auto-reconnects if OfflineAI is restarted

---

## Supported Editors

| Editor    | Status |
|-----------|--------|
| VS Code   | ✓ Full support |
| Cursor    | ✓ Full support |
| Windsurf  | ✓ Full support |
| Any VS Code fork | ✓ Should work |

---

## Troubleshooting

**Status bar shows `○ OfflineAI` (disconnected)**
→ Make sure the OfflineAI desktop app is running. The Hub server starts automatically.

**"Apply to Editor" doesn't work**
→ Make sure you have text selected in the editor before clicking Apply.

**Extension doesn't appear after install**
→ Try reloading the VS Code window (`Ctrl+Shift+P` → "Reload Window").
