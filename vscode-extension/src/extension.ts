/**
 * Codeforge AI Hub — VS Code Extension (Enhanced)
 *
 * Features:
 *  1. Generate Unit Tests     — select code → right-click → generate test file
 *  2. Inline Code Suggester   — ghost text completions as you type (Tab to accept)
 *  3. Smart Debug             — describe bug → AI analyzes current + connected files → applies fixes
 *  4. Terminal Error Explainer — paste error → AI explains + proposes fix → apply on approval
 */

import * as vscode from "vscode";
import * as fs     from "fs";
import * as path   from "path";
import WebSocket   from "ws";

// ── Constants ──────────────────────────────────────────────────────────────────
const HUB_URL             = "ws://127.0.0.1:7471";
const RECONNECT_DELAY_MS  = 3000;
const CONTEXT_DEBOUNCE_MS = 500;
const INLINE_DEBOUNCE_MS  = 800;   // wait this long after last keystroke before suggesting
const INLINE_TIMEOUT_MS   = 5000;  // give up on inline suggestion after this

// ── State ──────────────────────────────────────────────────────────────────────
let ws:               WebSocket | null = null;
let statusBarItem:    vscode.StatusBarItem;
let outputChannel:    vscode.OutputChannel | null = null;
let reconnectTimer:   ReturnType<typeof setTimeout> | null = null;
let contextTimer:     ReturnType<typeof setTimeout> | null = null;
let inlineDebounce:   ReturnType<typeof setTimeout> | null = null;
let isConnected       = false;

// Response buffer — collects streamed tokens from Hub for in-extension features
let responseBuffer    = "";
let currentOperation: string | null = null;
let currentOpMeta:    Record<string, any> = {};

// Inline suggestion — resolved when Hub returns suggestion
let pendingInlineResolve: ((s: string) => void) | null = null;
// Request ID guard — prevents stale responses from resolving new requests
let inlineRequestId   = 0;

// ── Helpers ────────────────────────────────────────────────────────────────────

function detectEditorName(): string {
  const name = vscode.env.appName.toLowerCase();
  if (name.includes("cursor"))   return "cursor";
  if (name.includes("windsurf")) return "windsurf";
  return "vscode";
}

function send(obj: object): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function setStatus(connected: boolean, text?: string): void {
  statusBarItem.text    = connected ? "$(circle-filled) CodeForge AI" : "$(circle-outline) CodeForge AI";
  statusBarItem.tooltip = connected ? "CodeForge AI: Connected" : (text || "CodeForge AI: Disconnected — click to reconnect");
  statusBarItem.color   = connected ? new vscode.ThemeColor("statusBar.foreground") : "#888";
}

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel("CodeForge AI");
  return outputChannel;
}

// ── Context sender ─────────────────────────────────────────────────────────────

function scheduleContextUpdate(): void {
  if (contextTimer) clearTimeout(contextTimer);
  contextTimer = setTimeout(sendContextUpdate, CONTEXT_DEBOUNCE_MS);
}

function sendContextUpdate(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isConnected) return;
  const doc = editor.document;
  send({
    type:         "context",
    file:         doc.fileName,
    language:     doc.languageId,
    selectedCode: doc.getText(editor.selection),
    fullCode:     doc.getText().slice(0, 3000),
    cursorLine:   editor.selection.active.line + 1,
  });
}

// ── Operation complete dispatcher ─────────────────────────────────────────────

async function handleOperationComplete(): Promise<void> {
  const result = responseBuffer;
  const op     = currentOperation;
  const meta   = { ...currentOpMeta };
  responseBuffer    = "";
  currentOperation  = null;
  currentOpMeta     = {};

  switch (op) {
    case "test_generate":    await handleTestResult(result, meta);        break;
    case "debug_query":      await handleDebugResult(result, meta);       break;
    case "terminal_error":   await handleTerminalFixResult(result, meta); break;
    case "hub_chat":         await handleHubChatResult(result, meta);     break;
    case "quantum_rewrite":  await handleQuantumResult(result, meta);     break;
    case "inline_suggest":
      if (pendingInlineResolve) { pendingInlineResolve(result); pendingInlineResolve = null; }
      break;
  }
}

// ── Feature 1: Generate Unit Tests ────────────────────────────────────────────

async function generateUnitTests(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage("CodeForge AI: Open a file first."); return; }
  if (!isConnected) { vscode.window.showWarningMessage("CodeForge AI: Not connected to Hub."); return; }

  const doc       = editor.document;
  const selection = doc.getText(editor.selection);
  const code      = selection || doc.getText().slice(0, 4000);
  const language  = doc.languageId;
  const fileName  = doc.fileName;
  const framework = await detectTestFramework(fileName, language);

  vscode.window.showInformationMessage(`CodeForge AI: Generating ${framework} tests…`);

  currentOperation = "test_generate";
  currentOpMeta    = { fileName, language, framework };
  responseBuffer   = "";

  send({ type: "test_generate", code, language, framework, fileName: path.basename(fileName), suggestedTokens: 1200 });
}

async function detectTestFramework(filePath: string, language: string): Promise<string> {
  let searchDir = path.dirname(filePath);
  for (let i = 0; i < 4; i++) {
    // JS/TS: check package.json
    try {
      const pkg  = JSON.parse(fs.readFileSync(path.join(searchDir, "package.json"), "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["vitest"])             return "Vitest";
      if (deps["jest"] || deps["@jest/core"]) return "Jest";
      if (deps["mocha"])              return "Mocha";
    } catch { /* not found */ }
    // Python: check requirements.txt
    try {
      const req = fs.readFileSync(path.join(searchDir, "requirements.txt"), "utf8");
      if (req.includes("pytest")) return "pytest";
    } catch { /* not found */ }
    searchDir = path.dirname(searchDir);
  }
  // Fallback by language
  const defaults: Record<string, string> = {
    python: "pytest", java: "JUnit", rust: "Rust built-in tests",
    go: "Go testing", csharp: "xUnit",
  };
  return defaults[language] || "Jest";
}

async function handleTestResult(result: string, meta: Record<string, any>): Promise<void> {
  // Strip markdown code fences if present
  const codeMatch = result.match(/```[\w]*\n([\s\S]+?)```/);
  const testCode  = codeMatch ? codeMatch[1] : result;

  const testPath = getTestFilePath(meta.fileName, meta.language);
  try {
    const uri = vscode.Uri.file(testPath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(testCode, "utf8"));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    vscode.window.showInformationMessage(`✅ CodeForge AI: Tests created → ${path.basename(testPath)}`);
  } catch (err) {
    vscode.window.showErrorMessage(`CodeForge AI: Could not create test file — ${err}`);
  }
}

function getTestFilePath(filePath: string, language: string): string {
  const dir  = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const ext  = path.extname(filePath);
  if (language === "python")  return path.join(dir, `test_${base}.py`);
  if (language === "java")    return path.join(dir, `${base}Test.java`);
  if (language === "go")      return path.join(dir, `${base}_test.go`);
  return path.join(dir, `${base}.test${ext}`);
}

// ── Feature 2: Inline Code Suggester ─────────────────────────────────────────

function registerInlineSuggester(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("codeforgeai");
  if (!config.get<boolean>("inlineSuggestions", true)) return;

  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(doc, position, _ctx, token) {
      if (!isConnected) return null;
      if (currentOperation && currentOperation !== "inline_suggest") return null;

      // Need at least 3 non-whitespace chars on the current line to trigger
      const linePrefix = doc.getText(new vscode.Range(position.with(undefined, 0), position));
      if (!linePrefix.trim() || linePrefix.trim().length < 3) return null;

      // Give the model: up to 20 lines of prior context + the current partial line
      const startLine   = Math.max(0, position.line - 20);
      const contextCode = doc.getText(new vscode.Range(new vscode.Position(startLine, 0), position));

      if (token.isCancellationRequested) return null;

      const suggestion = await requestInlineSuggestion(contextCode, linePrefix, doc.languageId, token);
      if (!suggestion || token.isCancellationRequested) return null;

      // VS Code inserts the completion starting at the cursor position.
      // The model sometimes echoes back the partial line — strip it.
      const stripped = stripLinePrefix(suggestion, linePrefix);
      if (!stripped.trim()) return null;

      return [new vscode.InlineCompletionItem(stripped)];
    },
  };

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider)
  );
}

/**
 * If the model echoed the partial line at the start of its suggestion,
 * remove that duplicate portion so the cursor doesn't see double text.
 * e.g. linePrefix = "const x = "  suggestion = "const x = 42;" → returns "42;"
 */
function stripLinePrefix(suggestion: string, linePrefix: string): string {
  const trimmedPrefix = linePrefix.trimStart();
  const trimmedSug    = suggestion.trimStart();

  // Try progressively shorter suffix of linePrefix to find the overlap
  for (let len = trimmedPrefix.length; len > 2; len--) {
    const suffix = trimmedPrefix.slice(-len);
    if (trimmedSug.startsWith(suffix)) {
      // Return everything after the duplicated part, re-adding leading whitespace
      const leadingSpaces = suggestion.match(/^(\s*)/)?.[1] ?? "";
      return leadingSpaces + trimmedSug.slice(len);
    }
  }
  return suggestion;
}

function requestInlineSuggestion(
  ctx: string, linePrefix: string, language: string, token: vscode.CancellationToken
): Promise<string> {
  // Bump request ID — any older pending resolve is now stale and must be ignored
  const myId = ++inlineRequestId;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (inlineRequestId === myId) { pendingInlineResolve = null; }
      resolve("");
    }, INLINE_TIMEOUT_MS);

    token.onCancellationRequested(() => {
      clearTimeout(timeout);
      if (inlineRequestId === myId) { pendingInlineResolve = null; }
      resolve("");
    });

    // Only the most recent request gets the resolve callback
    pendingInlineResolve = (suggestion: string) => {
      if (inlineRequestId !== myId) { resolve(""); return; }  // stale — discard
      clearTimeout(timeout);
      resolve(suggestion);
    };

    currentOperation = "inline_suggest";
    responseBuffer   = "";
    // Pass linePrefix so Rust can use it as a prefix hint and avoid re-generating it
    send({ type: "inline_suggest", context: ctx, linePrefix, language, suggestedTokens: 80 });
  });
}

// ── Feature 3: Smart Debug ────────────────────────────────────────────────────

async function debugWithAI(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage("CodeForge AI: Open a file first."); return; }
  if (!isConnected) { vscode.window.showWarningMessage("CodeForge AI: Not connected to Hub."); return; }

  const bugDesc = await vscode.window.showInputBox({
    prompt:          "Describe the bug or error you're seeing",
    placeHolder:     "e.g. getUserData returns null when user hasn't logged in",
    ignoreFocusOut:  true,
  });
  if (!bugDesc) return;

  const doc         = editor.document;
  const currentFile = doc.fileName;
  const currentCode = doc.getText();
  const language    = doc.languageId;

  vscode.window.showInformationMessage("CodeForge AI: Scanning connected files…");

  // Find files imported/required by the current file (max 5)
  const connectedPaths   = findConnectedFiles(currentFile, currentCode, language);
  const connectedFiles: Array<{ name: string; path: string; content: string }> = [];
  for (const fp of connectedPaths) {
    try {
      connectedFiles.push({
        name:    path.basename(fp),
        path:    fp,
        content: fs.readFileSync(fp, "utf8").slice(0, 2000),
      });
    } catch { /* unreadable */ }
  }

  const fileCount = connectedFiles.length + 1;
  vscode.window.showInformationMessage(`CodeForge AI: Debugging across ${fileCount} file(s)…`);

  currentOperation = "debug_query";
  currentOpMeta    = { currentFile, language, connectedFiles };
  responseBuffer   = "";

  send({
    type:           "debug_query",
    bugDescription: bugDesc,
    currentFile:    path.basename(currentFile),
    currentCode:    currentCode.slice(0, 4000),
    language,
    connectedFiles,
    suggestedTokens: 1500,
  });
}

function findConnectedFiles(filePath: string, content: string, language: string): string[] {
  const dir   = path.dirname(filePath);
  const found: string[] = [];
  let   regex: RegExp | null = null;

  if (["javascript","typescript","javascriptreact","typescriptreact"].includes(language)) {
    regex = /(?:import\s+[\s\S]*?\s+from|require)\s*\(?['"](\.[^'"]+)['"]\)?/g;
  } else if (language === "python") {
    regex = /(?:from\s+(\.[\w./]+)\s+import|import\s+(\.[\w./]+))/g;
  }
  if (!regex) return [];

  const exts = language === "python" ? [".py"] : [".ts",".tsx",".js",".jsx",""];
  let m: RegExpExecArray | null;

  while ((m = regex.exec(content)) !== null && found.length < 5) {
    const imp      = m[1] || m[2];
    if (!imp || !imp.startsWith(".")) continue;
    const resolved = path.resolve(dir, imp);

    for (const ext of exts) {
      const candidate = resolved + ext;
      if (fs.existsSync(candidate) && candidate !== filePath) { found.push(candidate); break; }
      if (ext) {
        const idx = path.join(resolved, `index${ext}`);
        if (fs.existsSync(idx)) { found.push(idx); break; }
      }
    }
  }

  return [...new Set(found)];
}

interface CodeChange { file: string; description: string; oldCode: string; newCode: string; }

async function handleDebugResult(result: string, meta: Record<string, any>): Promise<void> {
  const changesMatch = result.match(/<CHANGES>([\s\S]*?)<\/CHANGES>/);
  const explanation  = result.replace(/<CHANGES>[\s\S]*?<\/CHANGES>/g, "").trim();

  // Always show explanation in output channel
  const ch = getOutputChannel();
  ch.appendLine("\n═══ CodeForge AI — Debug Analysis ═══");
  ch.appendLine(explanation);
  ch.show(true);

  if (!changesMatch) return;

  let changes: CodeChange[] = [];
  try { changes = JSON.parse(changesMatch[1].trim()); } catch { return; }
  if (!changes.length) return;

  const fileList = changes.map(c => `• ${c.file}: ${c.description}`).join("\n");
  const choice   = await vscode.window.showInformationMessage(
    `CodeForge AI wants to make ${changes.length} change(s)`,
    { modal: true, detail: `${explanation.slice(0, 250)}\n\n${fileList}` },
    "Apply All", "Review Each", "Cancel"
  );

  if (choice === "Apply All") {
    await applyChanges(changes, meta.connectedFiles, meta.currentFile);
    vscode.window.showInformationMessage(`✅ CodeForge AI: Applied ${changes.length} fix(es)`);
  } else if (choice === "Review Each") {
    for (const change of changes) {
      const c = await vscode.window.showInformationMessage(
        `Fix: ${change.description}`,
        { modal: true, detail: `File: ${change.file}\n\nOld:\n${change.oldCode}\n\nNew:\n${change.newCode}` },
        "Apply", "Skip"
      );
      if (c === "Apply") {
        await applyChanges([change], meta.connectedFiles, meta.currentFile);
      }
    }
  }
}

// ── Feature 4: Terminal Error Explainer ───────────────────────────────────────

async function explainTerminalError(): Promise<void> {
  if (!isConnected) { vscode.window.showWarningMessage("CodeForge AI: Not connected to Hub."); return; }

  // Pre-fill InputBox with clipboard text if it looks like an error
  const clip       = await vscode.env.clipboard.readText();
  const looksLike  = clip.length > 10 && clip.length < 2000;

  const errorText = await vscode.window.showInputBox({
    prompt:         "Paste the terminal error (or it was auto-filled from clipboard)",
    value:          looksLike ? clip : "",
    placeHolder:    "e.g. TypeError: Cannot read properties of undefined (reading 'map')",
    ignoreFocusOut: true,
  });
  if (!errorText) return;

  const editor      = vscode.window.activeTextEditor;
  const currentFile = editor?.document.fileName || "";
  const currentCode = editor?.document.getText().slice(0, 3000) || "";
  const language    = editor?.document.languageId || "";

  vscode.window.showInformationMessage("CodeForge AI: Analyzing error…");

  currentOperation = "terminal_error";
  currentOpMeta    = { errorText, currentFile, language };
  responseBuffer   = "";

  send({ type: "terminal_error", errorText, currentFile: path.basename(currentFile), currentCode, language, suggestedTokens: 800 });
}

async function handleTerminalFixResult(result: string, meta: Record<string, any>): Promise<void> {
  const fixMatch    = result.match(/<FIX>([\s\S]*?)<\/FIX>/);
  const explanation = result.replace(/<FIX>[\s\S]*?<\/FIX>/g, "").trim();

  // Show explanation
  const ch = getOutputChannel();
  ch.appendLine("\n═══ CodeForge AI — Error Explanation ═══");
  ch.appendLine(explanation);
  ch.show(true);

  if (!fixMatch) {
    vscode.window.showInformationMessage("CodeForge AI: Error explained — see CodeForge AI output panel.");
    return;
  }

  let fixes: CodeChange[] = [];
  try { fixes = JSON.parse(fixMatch[1].trim()); } catch { return; }
  if (!fixes.length) return;

  ch.appendLine("\n── Proposed Fix ──");
  for (const fix of fixes) {
    ch.appendLine(`${fix.file}: ${fix.description}`);
    ch.appendLine(`  Old: ${fix.oldCode}`);
    ch.appendLine(`  New: ${fix.newCode}`);
  }

  const choice = await vscode.window.showInformationMessage(
    `CodeForge AI found a fix for the error`,
    { modal: false },
    "Apply Fix", "Show Details", "Dismiss"
  );

  if (choice === "Apply Fix") {
    await applyChanges(fixes, [], meta.currentFile);
    vscode.window.showInformationMessage("✅ CodeForge AI: Fix applied!");
  } else if (choice === "Show Details") {
    getOutputChannel().show();
  }
}

// ── Shared: Apply code changes via WorkspaceEdit ──────────────────────────────

async function applyChanges(
  changes: CodeChange[],
  connectedFiles: Array<{ name: string; path: string }>,
  currentFilePath: string
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();

  for (const change of changes) {
    // Resolve file path: check connected files first, fallback to current file
    const connMatch = connectedFiles.find(f => f.name === change.file);
    const resolvedPath = connMatch?.path
      || (path.basename(currentFilePath) === change.file ? currentFilePath : currentFilePath);

    try {
      const uri  = vscode.Uri.file(resolvedPath);
      const doc  = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const idx  = text.indexOf(change.oldCode);
      if (idx === -1) { vscode.window.showWarningMessage(`CodeForge AI: Could not locate code in ${change.file} — skipped.`); continue; }
      const start = doc.positionAt(idx);
      const end   = doc.positionAt(idx + change.oldCode.length);
      edit.replace(uri, new vscode.Range(start, end), change.newCode);
    } catch (err) {
      vscode.window.showWarningMessage(`CodeForge AI: Could not edit ${change.file} — ${err}`);
    }
  }

  await vscode.workspace.applyEdit(edit);
}

// ── Context menu helper (explain / refactor / fix / comment) ──────────────────

function sendCommand(verb: string, instruction = ""): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor)      { vscode.window.showWarningMessage("CodeForge AI: No active editor.");       return; }
  if (!isConnected) { vscode.window.showWarningMessage("CodeForge AI: Not connected to Hub.");   return; }
  const selected = editor.document.getText(editor.selection);
  if (!selected)    { vscode.window.showWarningMessage("CodeForge AI: Select some code first."); return; }

  const language  = editor.document.languageId;
  const verbLower = verb.toLowerCase();

  const suggestedTokens =
    verbLower.includes("explain") ? 600 :
    verbLower.includes("comment") ? 900 : 900;

  currentOperation = "hub_chat";
  currentOpMeta    = { verb, instruction, selected, language, canApply: !verbLower.includes("explain") };
  responseBuffer   = "";

  send({ type: "hub_chat", verb, instruction, code: selected, language, suggestedTokens });
  const label = instruction || verb;
  vscode.window.showInformationMessage(`CodeForge AI: Running "${label}"…`);
}

/** Prompts the user for a specific refactor instruction, then sends the command. */
async function askAndRefactor(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor)      { vscode.window.showWarningMessage("CodeForge AI: No active editor.");       return; }
  if (!isConnected) { vscode.window.showWarningMessage("CodeForge AI: Not connected to Hub.");   return; }
  const selected = editor.document.getText(editor.selection);
  if (!selected)    { vscode.window.showWarningMessage("CodeForge AI: Select some code first."); return; }

  const instruction = await vscode.window.showInputBox({
    prompt:         "Describe exactly what to refactor",
    placeHolder:    "e.g. Remove duplicate CSS properties and change 0px to 0",
    ignoreFocusOut: true,
  });
  if (instruction === undefined) return; // user pressed Escape

  sendCommand("refactor", instruction.trim());
}

// ── hub_chat result handler ────────────────────────────────────────────────────

async function handleHubChatResult(result: string, meta: Record<string, any>): Promise<void> {
  const verb     = (meta.verb     as string)  || "Result";
  const canApply = (meta.canApply as boolean);
  const selected = (meta.selected as string)  || "";

  // Strip any markdown the model output despite instructions
  const cleanResult = stripMarkdown(result.trim());

  if (canApply) {
    // ── Refactor / Fix / Comment ──────────────────────────────────────────────
    // Show in a scrollable read-only document (virtual file) — user can scroll freely,
    // select text, and copy. Also offer "Apply to Selection" for code output.

    // Strip code fences if the model wrapped output anyway
    const fenceMatch = cleanResult.match(/```[\w]*\n?([\s\S]+?)```/);
    const cleanCode  = fenceMatch ? fenceMatch[1].trimEnd() : cleanResult;

    // Open result as a virtual document beside the editor
    const docContent = `// CodeForge AI — ${verb}\n// ${new Date().toLocaleTimeString()}\n\n${cleanCode}`;
    const doc = await vscode.workspace.openTextDocument({
      content:  docContent,
      language: meta.language as string || "plaintext",
    });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true });

    const looksLikeCode = cleanCode.includes("\n") || /[{(;=:#]/.test(cleanCode);
    if (looksLikeCode && cleanCode.trim() !== selected.trim()) {
      const choice = await vscode.window.showInformationMessage(
        `CodeForge AI: "${verb}" ready — result opened beside your file`,
        { modal: false },
        "Apply to Selection", "Dismiss"
      );
      if (choice === "Apply to Selection") {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          await activeEditor.edit(eb => { eb.replace(activeEditor.selection, cleanCode); });
          vscode.window.showInformationMessage("✅ CodeForge AI: Applied to selection!");
        }
      }
    }

  } else {
    // ── Explain ───────────────────────────────────────────────────────────────
    // Open as a Markdown document so the user can scroll up and read at their own pace
    const docContent = `CodeForge AI — Explain\n${"=".repeat(40)}\n\n${cleanResult}`;
    const doc = await vscode.workspace.openTextDocument({
      content:  docContent,
      language: "plaintext",
    });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false, preview: true });
  }
}

/**
 * Strip common markdown formatting that the model outputs despite instructions.
 * Converts **bold**, *italic*, ## Headers, ``` fences to plain text equivalents.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")          // ## Headings → plain
    .replace(/\*\*(.+?)\*\*/g, "$1")       // **bold** → plain
    .replace(/\*(.+?)\*/g, "$1")           // *italic* → plain
    .replace(/__(.+?)__/g, "$1")           // __bold__ → plain
    .replace(/_(.+?)_/g, "$1")             // _italic_ → plain
    .replace(/`{3}[\w]*\n?([\s\S]*?)`{3}/g, "$1")  // ```code``` → code only
    .replace(/`([^`]+)`/g, "$1")           // `inline code` → plain
    .replace(/^\s*[-*]\s+/gm, "- ")        // normalise bullet chars
    .replace(/\n{3,}/g, "\n\n")            // collapse extra blank lines
    .trim();
}

// ── Feature 5: Quantum Rewrite ⚛ ─────────────────────────────────────────────
//
//  Quantum mechanics metaphors:
//    Superposition   → code exists in State α (old) and State β (new) simultaneously
//    Wave fn collapse→ user approves → superposition collapses to the new state
//    Entanglement    → connected files form the "quantum field" scanned in parallel
//    Observer effect → reviewing the diff determines which state the code takes
//

async function quantumRewrite(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor)      { vscode.window.showWarningMessage("⚛ CodeForge AI: Open a file first."); return; }
  if (!isConnected) { vscode.window.showWarningMessage("⚛ CodeForge AI: Not connected to Hub."); return; }

  const changeDesc = await vscode.window.showInputBox({
    prompt:         "⚛ Describe the change — AI will find and rewrite the exact logic",
    placeHolder:    "e.g. Make getUserData return null instead of throwing when user not found",
    ignoreFocusOut: true,
  });
  if (!changeDesc) return;

  const doc         = editor.document;
  const currentFile = doc.fileName;
  const currentCode = doc.getText();
  const language    = doc.languageId;

  vscode.window.showInformationMessage("⚛ CodeForge AI: Scanning quantum field…");

  // Gather entangled files (imported / required by this file)
  const connectedPaths = findConnectedFiles(currentFile, currentCode, language);
  const entangledFiles: Array<{ name: string; path: string; content: string }> = [];
  for (const fp of connectedPaths) {
    try {
      entangledFiles.push({
        name:    path.basename(fp),
        path:    fp,
        content: fs.readFileSync(fp, "utf8").slice(0, 2000),
      });
    } catch { /* skip unreadable */ }
  }

  const totalEntangled = entangledFiles.length + 1;
  vscode.window.showInformationMessage(
    `⚛ Quantum field: ${totalEntangled} entangled file(s) — collapsing superposition…`
  );

  currentOperation = "quantum_rewrite";
  currentOpMeta    = { currentFile, currentCode, language, entangledFiles, changeDesc };
  responseBuffer   = "";

  send({
    type:            "quantum_rewrite",
    changeDesc,
    currentFile:     path.basename(currentFile),
    currentCode:     currentCode.slice(0, 6000),
    language,
    entangledFiles,
    suggestedTokens: 1000,
  });
}

async function handleQuantumResult(result: string, meta: Record<string, any>): Promise<void> {
  const fileMatch = result.match(/<QR_FILE>([\s\S]*?)<\/QR_FILE>/);
  const oldMatch  = result.match(/<QR_OLD>([\s\S]*?)<\/QR_OLD>/);
  const newMatch  = result.match(/<QR_NEW>([\s\S]*?)<\/QR_NEW>/);
  const whyMatch  = result.match(/<QR_WHY>([\s\S]*?)<\/QR_WHY>/);

  if (!oldMatch || !newMatch) {
    // Show raw output so the user can read the analysis even without tags
    const ch = getOutputChannel();
    ch.appendLine("\n═══ ⚛ Quantum Rewrite — Analysis ═══");
    ch.appendLine(result);
    ch.show(false);
    vscode.window.showWarningMessage(
      "⚛ Could not parse change tags — raw analysis shown in output panel.",
      "Show Output"
    ).then(c => { if (c === "Show Output") getOutputChannel().show(false); });
    return;
  }

  const qrFile   = fileMatch?.[1].trim() || path.basename(meta.currentFile as string);
  const oldCode  = oldMatch[1].trim();
  const newCode  = newMatch[1].trim();
  const whyText  = whyMatch?.[1].trim() || "Logic updated per your description.";

  // Resolve the target file path — check entangled files, fall back to current file
  const entangled = meta.entangledFiles as Array<{ name: string; path: string }>;
  const connMatch    = entangled.find(f =>
    f.name === qrFile || path.basename(f.path) === qrFile
  );
  const resolvedPath = connMatch?.path
    || (path.basename(meta.currentFile as string) === qrFile
        ? meta.currentFile as string
        : meta.currentFile as string);

  // Verify the old code is actually in the file so the user knows it's a real match
  const fileContent = meta.currentCode as string;
  const exactMatch  = fileContent.includes(oldCode);
  if (!exactMatch) {
    vscode.window.showWarningMessage(
      "⚛ Exact match not found in file — diff shown for manual review. You can still collapse."
    );
  }

  showQuantumPanel(
    path.basename(resolvedPath),
    oldCode,
    newCode,
    whyText,
    entangled.length + 1,
    resolvedPath,
  );
}

/** Opens the quantum-themed WebView diff panel. */
function showQuantumPanel(
  fileName:       string,
  oldCode:        string,
  newCode:        string,
  why:            string,
  entangledCount: number,
  resolvedPath:   string,
): void {
  const panel = vscode.window.createWebviewPanel(
    "codeforgeQuantum",
    "⚛ Quantum Rewrite",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
     .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const ts = new Date().toLocaleTimeString();

  panel.webview.html = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>⚛ Quantum Rewrite</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:#060612;color:#e2e8f0;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  min-height:100vh;overflow-x:hidden
}
/* ── Quantum field background ── */
.qbg{
  position:fixed;inset:0;z-index:0;
  background:
    radial-gradient(ellipse at 15% 50%,  rgba(120,0,255,.08)  0%,transparent 55%),
    radial-gradient(ellipse at 85% 20%,  rgba(0,200,255,.08)  0%,transparent 55%),
    radial-gradient(ellipse at 50% 90%,  rgba(0,255,170,.05)  0%,transparent 55%)
}
/* ── Animated scan line ── */
.scan{
  position:fixed;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(0,200,255,.4),transparent);
  animation:scanAnim 5s linear infinite;z-index:1
}
@keyframes scanAnim{from{top:-2px}to{top:100vh}}
/* ── Floating particles ── */
.particles{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.p{position:absolute;border-radius:50%;animation:float linear infinite;opacity:.0}
@keyframes float{0%{opacity:0;transform:translateY(0)}10%{opacity:.6}90%{opacity:.6}100%{opacity:0;transform:translateY(-80px)}}
/* ── Layout ── */
.wrap{position:relative;z-index:2;padding:22px 24px;max-width:980px;margin:0 auto}
/* ── Header ── */
.hdr{display:flex;align-items:center;gap:13px;margin-bottom:20px}
.qi{
  width:40px;height:40px;border-radius:10px;flex-shrink:0;
  background:linear-gradient(135deg,#7c3aed,#06b6d4);
  display:flex;align-items:center;justify-content:center;font-size:20px;
  box-shadow:0 0 28px rgba(6,182,212,.4),0 0 60px rgba(124,58,237,.2)
}
.ht{font-size:17px;font-weight:700;color:#f1f5f9;letter-spacing:-.2px}
.hs{font-size:11px;color:#475569;margin-top:3px}
/* ── File badge ── */
.fbadge{
  display:inline-flex;align-items:center;gap:6px;
  background:rgba(6,182,212,.07);border:1px solid rgba(6,182,212,.22);
  border-radius:6px;padding:5px 11px;font-size:11.5px;
  color:#67e8f9;font-family:monospace;margin-bottom:16px
}
/* ── Coherence meter ── */
.pmeter{margin-bottom:14px}
.plbl{font-size:9.5px;color:#1e3a5f;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:5px}
.pbar{height:3px;background:#0b0f1a;border-radius:2px;overflow:hidden;position:relative}
.pfill{
  height:100%;width:0%;border-radius:2px;
  background:linear-gradient(90deg,#7c3aed,#06b6d4,#22d3ee);
  background-size:200% 100%;animation:shimmer 2s linear infinite;
  transition:width 1.6s cubic-bezier(.25,.46,.45,.94)
}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
/* ── Entanglement bar ── */
.ent{
  display:flex;align-items:center;gap:8px;
  background:rgba(6,182,212,.05);border:1px solid rgba(6,182,212,.14);
  border-radius:6px;padding:9px 13px;margin-bottom:16px;font-size:11.5px;color:#475569
}
.ent em{color:#67e8f9;font-style:normal;font-weight:600}
/* ── State panels ── */
.states{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}
@media(max-width:640px){.states{grid-template-columns:1fr}}
.sp{border-radius:9px;overflow:hidden}
.sh{
  padding:8px 12px;font-size:10px;font-weight:700;
  letter-spacing:.8px;text-transform:uppercase;
  display:flex;align-items:center;gap:6px
}
.sa .sh{
  background:rgba(239,68,68,.1);color:#fca5a5;
  border:1px solid rgba(239,68,68,.2);border-bottom:none
}
.sb .sh{
  background:rgba(34,197,94,.1);color:#86efac;
  border:1px solid rgba(34,197,94,.2);border-bottom:none
}
.sa .sh::before{content:"●";color:#ef4444;filter:drop-shadow(0 0 4px #ef4444)}
.sb .sh::before{content:"●";color:#22c55e;filter:drop-shadow(0 0 4px #22c55e)}
.sc{
  background:#080d18;padding:14px;
  font-family:"Cascadia Code","Fira Code","Consolas",monospace;
  font-size:11.5px;line-height:1.8;color:#c9d1d9;
  white-space:pre;overflow:auto;max-height:340px;
  border:1px solid;border-top:none;
  scrollbar-width:thin;scrollbar-color:#1e293b transparent
}
.sa .sc{border-color:rgba(239,68,68,.2)}
.sb .sc{border-color:rgba(34,197,94,.2)}
/* ── Analysis block ── */
.analysis{
  background:rgba(124,58,237,.06);border:1px solid rgba(124,58,237,.2);
  border-radius:9px;padding:14px;margin-bottom:16px
}
.albl{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:#a78bfa;margin-bottom:6px}
.atxt{font-size:12.5px;color:#94a3b8;line-height:1.7}
/* ── Action buttons ── */
.actions{display:flex;gap:10px;margin-bottom:14px}
.bcol{
  flex:1;background:linear-gradient(135deg,#6d28d9 0%,#0e7490 100%);
  border:none;border-radius:9px;color:#fff;
  font-size:13.5px;font-weight:700;padding:12px 22px;cursor:pointer;
  box-shadow:0 0 24px rgba(6,182,212,.25),0 4px 12px rgba(0,0,0,.4);
  transition:all .2s;letter-spacing:.1px
}
.bcol:hover:not(:disabled){
  box-shadow:0 0 40px rgba(6,182,212,.45),0 4px 20px rgba(0,0,0,.5);
  transform:translateY(-1px)
}
.bcol:disabled{opacity:.45;cursor:not-allowed;transform:none!important}
.bcol:active:not(:disabled){transform:translateY(0)}
.bpre{
  background:transparent;border:1px solid #1e293b;border-radius:9px;
  color:#475569;font-size:12.5px;padding:12px 18px;cursor:pointer;transition:all .2s
}
.bpre:hover{border-color:#334155;color:#64748b}
/* ── Status + collapsed ── */
.status{display:flex;align-items:center;gap:7px;font-size:10px;color:#1e293b}
.dot{width:5px;height:5px;border-radius:50%;background:#06b6d4;animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
.collapsed-msg{
  display:none;text-align:center;padding:28px 20px;
  background:rgba(34,197,94,.05);border:1px solid rgba(34,197,94,.2);
  border-radius:9px;margin-top:16px
}
.collapsed-msg .big{font-size:36px;display:block;margin-bottom:10px}
.collapsed-msg p{color:#86efac;font-size:14px;font-weight:600}
.collapsed-msg small{color:#475569;font-size:11px;display:block;margin-top:4px}
</style>
</head>
<body>
<div class="qbg"></div>
<div class="scan"></div>
<div class="particles" id="pts"></div>
<div class="wrap">
  <div class="hdr">
    <div class="qi">⚛</div>
    <div>
      <div class="ht">Quantum Rewrite</div>
      <div class="hs">Superposition detected &mdash; wave function awaiting collapse</div>
    </div>
  </div>

  <div class="fbadge">📄 ${esc(fileName)}</div>

  <div class="pmeter">
    <div class="plbl">Quantum coherence</div>
    <div class="pbar"><div class="pfill" id="pf"></div></div>
  </div>

  <div class="ent">
    <span style="color:#06b6d4">🔗</span>
    <span>
      Field entangled across <em>${entangledCount} file(s)</em>
      &mdash; rewrite isolated to <em>${esc(fileName)}</em>
    </span>
  </div>

  <div class="states" id="statesWrap">
    <div class="sp sa">
      <div class="sh">State α &mdash; Current</div>
      <div class="sc">${esc(oldCode)}</div>
    </div>
    <div class="sp sb">
      <div class="sh">State β &mdash; Proposed</div>
      <div class="sc">${esc(newCode)}</div>
    </div>
  </div>

  <div class="analysis">
    <div class="albl">⚛ Quantum Analysis</div>
    <div class="atxt">${esc(why)}</div>
  </div>

  <div class="actions" id="actionsRow">
    <button class="bcol" id="colBtn">⚛ Collapse State &mdash; Apply Change</button>
    <button class="bpre" id="preBtn">Preserve State</button>
  </div>

  <div class="status">
    <div class="dot"></div>
    <span>Wave function in superposition &middot; ${ts}</span>
  </div>

  <div class="collapsed-msg" id="collapsedMsg">
    <span class="big">⚛</span>
    <p>Quantum state collapsed successfully</p>
    <small>${esc(fileName)} has been updated</small>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();

// Animate coherence bar on load
setTimeout(() => { document.getElementById('pf').style.width = '87%'; }, 300);

// Spawn floating quantum particles
(function spawnParticles() {
  const pts = document.getElementById('pts');
  const colors = ['rgba(6,182,212,.5)','rgba(124,58,237,.5)','rgba(34,197,94,.4)'];
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('div');
    p.className = 'p';
    const sz = Math.random() * 3 + 1;
    p.style.cssText = [
      'width:' + sz + 'px', 'height:' + sz + 'px',
      'left:' + (Math.random() * 100) + '%',
      'top:' + (60 + Math.random() * 40) + '%',
      'background:' + colors[Math.floor(Math.random() * colors.length)],
      'animation-duration:' + (6 + Math.random() * 10) + 's',
      'animation-delay:' + (Math.random() * 8) + 's'
    ].join(';');
    pts.appendChild(p);
  }
})();

document.getElementById('colBtn').onclick = () => {
  document.getElementById('colBtn').textContent = '⚛ Collapsing…';
  document.getElementById('colBtn').disabled    = true;
  document.getElementById('preBtn').disabled    = true;
  vscode.postMessage({ command: 'collapse' });
};
document.getElementById('preBtn').onclick = () => {
  vscode.postMessage({ command: 'preserve' });
};

window.addEventListener('message', e => {
  if (e.data.command === 'collapsed') {
    document.getElementById('statesWrap').style.transition = 'opacity 0.6s';
    document.getElementById('statesWrap').style.opacity    = '0.25';
    document.getElementById('actionsRow').style.display    = 'none';
    document.getElementById('collapsedMsg').style.display  = 'block';
    document.getElementById('pf').style.width = '100%';
  }
});
</script>
</body>
</html>`;

  // Handle collapse / preserve messages from WebView
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === "collapse") {
      try {
        const uri  = vscode.Uri.file(resolvedPath);
        const doc  = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const idx  = text.indexOf(oldCode);

        if (idx === -1) {
          // Code not found exactly — open file and warn, but still show success UI so
          // user knows the operation ran (they can manually apply from the panel)
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
          panel.webview.postMessage({ command: "collapsed" });
          vscode.window.showWarningMessage(
            "⚛ Exact code not matched — file opened. Apply the State β code from the panel manually."
          );
        } else {
          const start = doc.positionAt(idx);
          const end   = doc.positionAt(idx + oldCode.length);
          const edit  = new vscode.WorkspaceEdit();
          edit.replace(uri, new vscode.Range(start, end), newCode);
          await vscode.workspace.applyEdit(edit);
          panel.webview.postMessage({ command: "collapsed" });
          vscode.window.showInformationMessage(
            `⚛ Quantum state collapsed — ${path.basename(resolvedPath)} updated!`
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(`⚛ Collapse failed: ${err}`);
      }

    } else if (msg.command === "preserve") {
      panel.dispose();
      vscode.window.showInformationMessage("⚛ State preserved — no changes made.");
    }
  });
}

// ── WebSocket ──────────────────────────────────────────────────────────────────

function connect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.terminate(); } catch { /* ignore */ } ws = null; }

  const socket = new WebSocket(HUB_URL);
  ws = socket;

  socket.on("open", () => {
    isConnected = true;
    setStatus(true);
    send({ type: "hello", editor: detectEditorName(), version: "1.1.0" });
    sendContextUpdate();
  });

  socket.on("message", (raw: WebSocket.RawData) => {
    let msg: Record<string, any>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      // Streaming tokens — buffer for in-extension feature handlers
      case "token":
        if (msg.content) responseBuffer += msg.content;
        break;

      // Stream complete — dispatch to feature handler
      case "done":
        handleOperationComplete();
        break;

      // Error from Hub
      case "error":
        if (currentOperation) {
          vscode.window.showErrorMessage(`CodeForge AI: ${msg.message || "Unknown error"}`);
          responseBuffer = ""; currentOperation = null; currentOpMeta = {};
          if (pendingInlineResolve) { pendingInlineResolve(""); pendingInlineResolve = null; }
        }
        break;

      // Legacy: apply code directly to editor selection
      case "apply":
        if (msg.code) {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            editor.edit(eb => { eb.replace(editor.selection, msg.code); });
            vscode.window.showInformationMessage("CodeForge AI: Code applied ✓");
          }
        }
        break;

      case "ping":
        send({ type: "pong" });
        break;
    }
  });

  socket.on("close", () => {
    isConnected = false; ws = null;
    setStatus(false, "CodeForge AI: Disconnected — retrying…");
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  });

  socket.on("error", () => {
    isConnected = false;
    setStatus(false, "CodeForge AI: Hub not reachable — is CodeForge running?");
  });
}

// ── Activation ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "codeforgeai.connect";
  statusBarItem.show();
  setStatus(false, "CodeForge AI: Connecting…");
  context.subscriptions.push(statusBarItem);

  // Connect to Hub
  connect();

  // Register all commands
  context.subscriptions.push(
    // Existing commands
    vscode.commands.registerCommand("codeforgeai.explain",  () => sendCommand("Explain this code")),
    vscode.commands.registerCommand("codeforgeai.refactor", () => askAndRefactor()),
    vscode.commands.registerCommand("codeforgeai.fix",      () => sendCommand("Find and fix the bug in this code")),
    vscode.commands.registerCommand("codeforgeai.comment",  () => sendCommand("Add clear inline comments to this code")),
    vscode.commands.registerCommand("codeforgeai.connect",  () => { vscode.window.showInformationMessage("CodeForge AI: Reconnecting…"); connect(); }),

    // New commands
    vscode.commands.registerCommand("codeforgeai.generateTests",       () => generateUnitTests()),
    vscode.commands.registerCommand("codeforgeai.debugWithAI",         () => debugWithAI()),
    vscode.commands.registerCommand("codeforgeai.explainTerminalError",() => explainTerminalError()),
    vscode.commands.registerCommand("codeforgeai.quantumRewrite",      () => quantumRewrite()),
  );

  // Register inline suggester
  registerInlineSuggester(context);

  // Send context update on file save only (selection/active-editor listeners removed —
  // those caused the "shield" auto-scan behaviour on every click/keystroke)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => scheduleContextUpdate()),
  );
}

export function deactivate(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (contextTimer)   clearTimeout(contextTimer);
  if (inlineDebounce) clearTimeout(inlineDebounce);
  if (ws)             ws.terminate();
  if (pendingInlineResolve) pendingInlineResolve("");
}
