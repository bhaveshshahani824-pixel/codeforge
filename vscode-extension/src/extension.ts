/**
 * Codeforge AI Hub — VS Code / Cursor Extension
 *
 * Connects to the Codeforge AI desktop app via a local WebSocket on ws://127.0.0.1:7471.
 * Sends live file context (open file, selected code, language, cursor line) so the
 * AI in Codeforge AI can answer questions about your code without sending any data to
 * the internet.
 *
 * Works in VS Code, Cursor, Windsurf, and any VS Code-compatible fork.
 */

import * as vscode from "vscode";
import WebSocket from "ws";

// ── Constants ──────────────────────────────────────────────────────────────────
const HUB_PORT    = 7471;
const HUB_URL     = `ws://127.0.0.1:${HUB_PORT}`;
const RECONNECT_DELAY_MS = 3000;  // 3 s between reconnect attempts
const CONTEXT_DEBOUNCE_MS = 500;  // debounce context sends (ms)

// ── Extension globals ──────────────────────────────────────────────────────────
let ws:              WebSocket | null = null;
let statusBarItem:   vscode.StatusBarItem;
let reconnectTimer:  ReturnType<typeof setTimeout> | null = null;
let contextTimer:    ReturnType<typeof setTimeout> | null = null;
let isConnected      = false;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Detect editor name for the "hello" handshake. */
function detectEditorName(): string {
  const name = vscode.env.appName.toLowerCase();
  if (name.includes("cursor"))   return "cursor";
  if (name.includes("windsurf")) return "windsurf";
  return "vscode";
}

/** Send a JSON message to Codeforge AI (no-op if not connected). */
function send(obj: object): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/** Update the VS Code status bar item. */
function setStatus(connected: boolean, text?: string): void {
  statusBarItem.text = connected
    ? `$(circle-filled) Codeforge AI`
    : `$(circle-outline) Codeforge AI`;
  statusBarItem.tooltip = connected
    ? "Codeforge AI Hub: Connected"
    : text || "Codeforge AI Hub: Disconnected — click to reconnect";
  statusBarItem.color = connected ? new vscode.ThemeColor("statusBar.foreground") : "#888";
}

// ── Context sender ─────────────────────────────────────────────────────────────

/** Read the current editor state and send it to Codeforge AI (debounced). */
function scheduleContextUpdate(): void {
  if (contextTimer) clearTimeout(contextTimer);
  contextTimer = setTimeout(sendContextUpdate, CONTEXT_DEBOUNCE_MS);
}

function sendContextUpdate(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isConnected) return;

  const doc          = editor.document;
  const selection    = editor.selection;
  const selectedCode = doc.getText(selection);
  const fullCode     = doc.getText().slice(0, 3000); // first 3 KB only

  send({
    type:         "context",
    file:         doc.fileName,
    language:     doc.languageId,
    selectedCode: selectedCode,
    fullCode:     fullCode,
    cursorLine:   selection.active.line + 1,  // 1-based for display
  });
}

// ── WebSocket connection ───────────────────────────────────────────────────────

function connect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.terminate(); } catch { /* ignore */ } ws = null; }

  // Use a local reference — avoids TS "possibly null" errors inside callbacks
  // since the module-level ws can be reassigned at any point.
  const socket = new WebSocket(HUB_URL);
  ws = socket;

  socket.on("open", () => {
    isConnected = true;
    setStatus(true);
    send({ type: "hello", editor: detectEditorName(), version: "1.0.0" });
    sendContextUpdate();
  });

  socket.on("message", (raw: WebSocket.RawData) => {
    let msg: { type?: string; code?: string; text?: string };
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "apply" && msg.code) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const code = msg.code;
        editor.edit(eb => { eb.replace(editor.selection, code); });
        vscode.window.showInformationMessage("Codeforge AI: Code applied to editor ✓");
      }
    } else if (msg.type === "ping") {
      send({ type: "pong" });
    }
  });

  socket.on("close", () => {
    isConnected = false;
    ws = null;
    setStatus(false, "Codeforge AI Hub: Disconnected — retrying…");
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  });

  socket.on("error", () => {
    isConnected = false;
    setStatus(false, "Codeforge AI Hub: Not reachable — is Codeforge AI running?");
  });
}

// ── Context menu helper ────────────────────────────────────────────────────────

/** Send the selected code + a prompt hint to Codeforge AI Hub as a message. */
function sendCommand(verb: string): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Codeforge AI: No active editor.");
    return;
  }
  if (!isConnected) {
    vscode.window.showWarningMessage("Codeforge AI: Not connected to Codeforge AI Hub. Is the app running?");
    return;
  }
  const selected = editor.document.getText(editor.selection);
  if (!selected) {
    vscode.window.showWarningMessage("Codeforge AI: Select some code first.");
    return;
  }

  // Send context update first, then the command message
  sendContextUpdate();
  send({ type: "message", text: `${verb}:\n\`\`\`${editor.document.languageId}\n${selected}\n\`\`\`` });

  vscode.window.showInformationMessage(`Codeforge AI: Sent "${verb}" — check the Codeforge AI Hub panel.`);
}

// ── Activation ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "codeforgeai.connect";
  statusBarItem.show();
  setStatus(false, "Codeforge AI Hub: Connecting…");
  context.subscriptions.push(statusBarItem);

  // Start connection
  connect();

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("codeforgeai.explain",  () => sendCommand("Explain this code")),
    vscode.commands.registerCommand("codeforgeai.refactor", () => sendCommand("Refactor this code to be cleaner and more efficient")),
    vscode.commands.registerCommand("codeforgeai.fix",      () => sendCommand("Find and fix the bug in this code")),
    vscode.commands.registerCommand("codeforgeai.comment",  () => sendCommand("Add clear inline comments to this code")),
    vscode.commands.registerCommand("codeforgeai.connect",  () => {
      vscode.window.showInformationMessage("Codeforge AI: Reconnecting…");
      connect();
    }),
  );

  // Send context on cursor move / selection change (debounced)
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => scheduleContextUpdate()),
    vscode.window.onDidChangeActiveTextEditor(()    => scheduleContextUpdate()),
    vscode.workspace.onDidSaveTextDocument(()       => scheduleContextUpdate()),
  );
}

export function deactivate(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (contextTimer)   clearTimeout(contextTimer);
  if (ws)             ws.terminate();
}
