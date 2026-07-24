const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOG = path.join(os.tmpdir(), "keypilot.log");
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
}

function cfg() { return vscode.workspace.getConfiguration("keypilot"); }

let statusBar, statsProvider;
let stats = { prompt: 0, completion: 0, total: 0, requests: 0 };

function fmt(n) { return n.toLocaleString("en"); }
function updateStatusBar() {
  statusBar.text = `$(circuit-board) ${fmt(stats.total)} tok`;
  statusBar.tooltip = "KeyPilot — click to open stats";
}

function sleep(ms, token) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(true), ms);
    if (token) token.onCancellationRequested(() => { clearTimeout(t); resolve(false); });
  });
}

async function saveApiKey(key) {
  await cfg().update("apiKey", key.trim(), vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("KeyPilot: API Key saved.");
}

async function promptForApiKey() {
  const input = await vscode.window.showInputBox({
    prompt: "Paste your API Key (Gemini / Groq / OpenAI-compatible)",
    placeHolder: "AIzaSy...",
    ignoreFocusOut: true,
    password: true
  });
  if (input?.trim()) { await saveApiKey(input); statsProvider?.refresh(); }
}

async function promptForApiKeyStartup() {
  if (cfg().get("apiKey")?.trim()) return;
  const go = "Enter API Key", link = "Get one (AI Studio)";
  const sel = await vscode.window.showInformationMessage(
    "KeyPilot: add your API Key to enable completions.", go, link
  );
  if (sel === link) vscode.env.openExternal(vscode.Uri.parse("https://aistudio.google.com/"));
  if (sel === go || sel === link) await promptForApiKey();
}

// Compress whitespace to cut tokens sent to the model
function compress(s) {
  return s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n");
}

// Build an InlineCompletionItem with a range that covers any existing lines
// the model wants to edit (next-edit pattern detection)
function makeItem(document, position, text) {
  const lines = text.split("\n");
  const lineAfterCursor = document.lineAt(position.line).text.slice(position.character);

  let endLine = position.line;
  let endChar = lineAfterCursor.trim()
    ? document.lineAt(position.line).text.length  // replace rest of current line
    : position.character;

  for (let i = 1; i < lines.length; i++) {
    const docNum = position.line + i;
    if (docNum >= document.lineCount) break;
    const docText = document.lineAt(docNum).text;
    // Extend range only when completion clearly edits a non-empty existing line
    if (docText.trim() && lines[i] !== docText) {
      endLine = docNum;
      endChar = docText.length;
    }
  }

  return new vscode.InlineCompletionItem(
    text,
    new vscode.Range(position, new vscode.Position(endLine, endChar))
  );
}

async function getCompletion(document, position, token) {
  const c = cfg();
  if (!c.get("enabled")) return null;
  const apiKey = c.get("apiKey");
  if (!apiKey?.trim()) return null;

  if (token) {
    if (!await sleep(200, token)) return null;
    if (token.isCancellationRequested) return null;
  }

  const maxBefore = c.get("maxContextChars") || 3000;
  const maxAfter = Math.round(maxBefore / 5);

  const full = document.getText();
  const offset = document.offsetAt(position);
  const before = compress(full.slice(Math.max(0, offset - maxBefore * 2), offset)).slice(-maxBefore);
  const after  = compress(full.slice(offset, offset + maxAfter * 2)).slice(0, maxAfter);

  if (!before.trim() && !after.trim()) return null;

  const lang = document.languageId;
  const system = `You are an AI programming assistant like GitHub Copilot. Your role is to provide highly accurate and context-aware code completions. Carefully study the patterns, style, and structure of the surrounding code in the file. Infer the developer's intent and provide the exact code that should be inserted at <CURSOR>. Keep the ${lang} language and its conventions in mind. Output ONLY code—no markdown, no comments, no explanation. If lines after <CURSOR> follow the same pattern and need the same edit, include them verbatim then corrected.`;

  const controller = new AbortController();
  if (token) token.onCancellationRequested(() => controller.abort());

  let resp;
  try {
    resp = await fetch(c.get("endpoint"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: c.get("model"),
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${before}<CURSOR>${after}` }
        ],
        temperature: 0,
        max_tokens: 256,
      }),
      signal: controller.signal,
    });
  } catch (e) { log("fetch error", e.name, e.message); return null; }

  if (!resp.ok) {
    log("http error", resp.status, (await resp.text().catch(() => "")).slice(0, 200));
    return null;
  }

  const data = await resp.json().catch(() => null);

  if (data?.usage) {
    stats.prompt     += data.usage.prompt_tokens     ?? 0;
    stats.completion += data.usage.completion_tokens ?? 0;
    stats.total      += data.usage.total_tokens      ?? 0;
    stats.requests++;
    updateStatusBar();
    statsProvider?.refresh();
  }

  let text = data?.choices?.[0]?.message?.content;
  if (!text) { log("empty", JSON.stringify(data).slice(0, 200)); return null; }

  text = text.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "");

  const lineEnd = document.lineAt(position.line).text.slice(position.character);
  if (lineEnd.trim() && text.startsWith(lineEnd.trim())) {
    text = text.slice(lineEnd.trim().length);
  }

  if (!text.trim()) return null;
  log("ok", text.slice(0, 80).replace(/\n/g, "\\n"));
  return text;
}

class StatsViewProvider {
  constructor(extensionUri) { this._view = null; this._extensionUri = extensionUri; }

  resolveWebviewView(view) {
    this._view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
    const logoUri = view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "logo-1.png"));
    view.webview.html = this._html(logoUri);
    view.webview.onDidReceiveMessage(async msg => {
      switch (msg.command) {
        case "setApiKey":   await promptForApiKey(); break;
        case "setContext":  await cfg().update("maxContextChars", Number(msg.value), vscode.ConfigurationTarget.Global); break;
        case "toggleEnabled": await cfg().update("enabled", msg.value, vscode.ConfigurationTarget.Global); break;
        case "resetTokens":
          stats = { prompt: 0, completion: 0, total: 0, requests: 0 };
          updateStatusBar(); this.refresh();
          break;
      }
    });
  }

  refresh() {
    if (!this._view) return;
    const c = cfg();
    const key = c.get("apiKey") || "";
    const masked = key.length > 8 ? `${key.slice(0, 6)}••••${key.slice(-2)}` : key ? "••••••" : "Not set";
    this._view.webview.postMessage({
      type: "update", stats, masked,
      context: c.get("maxContextChars") ?? 3000,
      enabled: c.get("enabled") ?? true,
    });
  }

  _html(logoUri) {
    const c = cfg();
    const key = c.get("apiKey") || "";
    const masked = key.length > 8 ? `${key.slice(0, 6)}••••${key.slice(-2)}` : key ? "••••••" : "Not set";
    const context = c.get("maxContextChars") ?? 3000;
    const enabled = c.get("enabled") ?? true;
    const pct = stats.total ? Math.round(stats.completion / stats.total * 100) : 0;

    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src ${logoUri};">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',var(--vscode-font-family),sans-serif;
  font-size:13px;
  color:var(--vscode-foreground);
  padding:20px 18px 24px;
  -webkit-font-smoothing:antialiased;
}

/* Header */
.header{
  display:flex;align-items:center;gap:8px;
  margin-bottom:28px;
}
.header-dot{
  width:8px;height:8px;border-radius:50%;
  background:#007AFF;
  box-shadow:0 0 6px rgba(0,122,255,.6);
  flex-shrink:0;
}
.header-title{
  font-size:11px;font-weight:600;
  letter-spacing:.1em;text-transform:uppercase;
  color:var(--vscode-descriptionForeground);
  opacity:.7;
}

/* Big number */
.stat-num{
  font-size:48px;font-weight:700;
  letter-spacing:-.03em;
  line-height:1;
  font-variant-numeric:tabular-nums;
  margin-bottom:4px;
}
.stat-sub{
  font-size:11px;
  color:var(--vscode-descriptionForeground);
  opacity:.55;
  letter-spacing:.02em;
  margin-bottom:16px;
}

/* Progress bar */
.bar-track{
  height:2px;
  background:rgba(128,128,128,.12);
  border-radius:999px;
  overflow:hidden;
  margin-bottom:20px;
}
.bar-fill{
  height:100%;
  background:linear-gradient(90deg,#007AFF,#34C8F5);
  border-radius:999px;
  transition:width .5s cubic-bezier(.4,0,.2,1);
}

/* Mini stat cards */
.cards{
  display:grid;grid-template-columns:1fr 1fr;
  gap:8px;margin-bottom:4px;
}
.card{
  background:rgba(128,128,128,.07);
  border-radius:10px;
  padding:11px 13px;
}
.card-label{
  font-size:10px;font-weight:600;
  letter-spacing:.08em;text-transform:uppercase;
  color:var(--vscode-descriptionForeground);
  opacity:.55;margin-bottom:5px;
}
.card-value{
  font-size:20px;font-weight:600;
  letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;
}

/* Separator */
.sep{
  height:.5px;
  background:var(--vscode-foreground);
  opacity:.08;
  margin:22px 0;
}

/* Section label */
.section-label{
  font-size:10px;font-weight:600;
  letter-spacing:.1em;text-transform:uppercase;
  color:var(--vscode-descriptionForeground);
  opacity:.55;
  margin-bottom:14px;
}

/* Setting rows */
.srow{
  display:flex;align-items:center;
  padding:9px 0;
  border-bottom:.5px solid rgba(128,128,128,.1);
}
.srow:last-child{border-bottom:none}
.srow-name{font-size:13px;flex:1}
.srow-val{
  font-size:12px;
  color:var(--vscode-descriptionForeground);
  opacity:.7;margin-right:10px;
  overflow:hidden;text-overflow:ellipsis;
  max-width:120px;white-space:nowrap;
}

/* Pill button */
.pill{
  background:rgba(0,122,255,.13);
  color:#007AFF;
  border:none;
  padding:5px 13px;
  font-size:12px;font-weight:500;
  cursor:pointer;
  border-radius:999px;
  white-space:nowrap;
  transition:background .15s;
  font-family:inherit;
}
.pill:hover{background:rgba(0,122,255,.22)}

/* Number input */
.num-input{
  background:rgba(128,128,128,.1);
  border:none;
  color:var(--vscode-foreground);
  padding:5px 9px;
  font-size:12px;
  width:70px;
  border-radius:7px;
  text-align:right;
  font-family:inherit;
}
.num-input:focus{
  outline:1.5px solid #007AFF;
}
.num-unit{
  font-size:11px;
  color:var(--vscode-descriptionForeground);
  opacity:.5;
  margin-left:5px;
}

/* Apple toggle */
.tog-wrap{display:flex;align-items:center;gap:8px;cursor:pointer}
.tog-track{
  width:36px;height:20px;
  background:rgba(128,128,128,.25);
  border-radius:999px;
  position:relative;
  transition:background .2s;
  cursor:pointer;flex-shrink:0;
}
.tog-track.on{background:#34C759}
.tog-track::after{
  content:'';position:absolute;
  width:16px;height:16px;
  background:#fff;
  border-radius:50%;
  top:2px;left:2px;
  transition:transform .22s cubic-bezier(.4,0,.2,1);
  box-shadow:0 1px 4px rgba(0,0,0,.35);
}
.tog-track.on::after{transform:translateX(16px)}
.tog-label{
  font-size:12px;
  color:var(--vscode-descriptionForeground);
  opacity:.6;
  transition:color .2s,opacity .2s;
}
.tog-label.on{color:#34C759;opacity:1}

/* Reset */
.reset{
  width:100%;
  background:transparent;
  color:var(--vscode-descriptionForeground);
  border:.5px solid rgba(128,128,128,.2);
  padding:9px;
  font-size:12px;font-weight:500;
  cursor:pointer;
  border-radius:9px;
  transition:background .15s,color .15s,border-color .15s;
  font-family:inherit;
  letter-spacing:.01em;
}
.reset:hover{
  background:rgba(255,59,48,.1);
  color:#FF3B30;
  border-color:rgba(255,59,48,.3);
}
</style></head><body>

<div class="header">
  <div class="header-dot" id="statusDot"></div>
  <span class="header-title">KeyPilot</span>
</div>

<div class="stat-num" id="total">${fmt(stats.total)}</div>
<div class="stat-sub" id="reqs">${stats.requests} request${stats.requests !== 1 ? "s" : ""} this session</div>

<div class="bar-track"><div class="bar-fill" id="bar" style="width:${pct}%"></div></div>

<div class="cards">
  <div class="card">
    <div class="card-label">Prompt</div>
    <div class="card-value" id="prompt">${fmt(stats.prompt)}</div>
  </div>
  <div class="card">
    <div class="card-label">Completion</div>
    <div class="card-value" id="compl">${fmt(stats.completion)}</div>
  </div>
</div>

<div class="sep"></div>

<div class="section-label">Settings</div>

<div class="srow">
  <span class="srow-name">API Key</span>
  <span class="srow-val" id="masked">${masked}</span>
  <button class="pill" onclick="p({command:'setApiKey'})">Change</button>
</div>

<div class="srow">
  <span class="srow-name">Context</span>
  <input class="num-input" type="number" id="ctx" value="${context}" min="500" max="50000" step="500"
    onchange="p({command:'setContext',value:this.value})">
  <span class="num-unit">chars</span>
</div>

<div class="srow">
  <span class="srow-name">Inline suggestions</span>
  <div class="tog-wrap" onclick="toggleEnabled()">
    <div class="tog-track ${enabled ? "on" : ""}" id="togTrack"></div>
    <span class="tog-label ${enabled ? "on" : ""}" id="togLabel">${enabled ? "On" : "Off"}</span>
  </div>
</div>

<div class="sep"></div>

<button class="reset" onclick="p({command:'resetTokens'})">Reset session tokens</button>

<script>
const vsc = acquireVsCodeApi();
function p(m){vsc.postMessage(m)}
function fmt(n){return n.toLocaleString('en')}

let _enabled = ${enabled};
function toggleEnabled(){
  _enabled = !_enabled;
  const t=document.getElementById('togTrack');
  const l=document.getElementById('togLabel');
  t.className='tog-track'+(_enabled?' on':'');
  l.className='tog-label'+(_enabled?' on':'');
  l.textContent=_enabled?'On':'Off';
  p({command:'toggleEnabled',value:_enabled});
}

window.addEventListener('message',e=>{
  const m=e.data;
  if(m.type!=='update')return;
  const s=m.stats;
  document.getElementById('total').textContent=fmt(s.total);
  document.getElementById('reqs').textContent=s.requests+' request'+(s.requests!==1?'s':'')+' this session';
  document.getElementById('prompt').textContent=fmt(s.prompt);
  document.getElementById('compl').textContent=fmt(s.completion);
  document.getElementById('bar').style.width=(s.total?Math.round(s.completion/s.total*100):0)+'%';
  document.getElementById('masked').textContent=m.masked;
  document.getElementById('ctx').value=m.context;
  _enabled=m.enabled;
  document.getElementById('togTrack').className='tog-track'+(m.enabled?' on':'');
  document.getElementById('togLabel').className='tog-label'+(m.enabled?' on':'');
  document.getElementById('togLabel').textContent=m.enabled?'On':'Off';
  document.getElementById('statusDot').style.background=m.enabled?'#007AFF':'rgba(128,128,128,.4)';
  document.getElementById('statusDot').style.boxShadow=m.enabled?'0 0 6px rgba(0,122,255,.6)':'none';
});
</script>
</body></html>`;
  }
}

function activate(context) {
  log("=== activate ===");

  statsProvider = new StatsViewProvider(context.extensionUri);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "keypilot.openStats";
  updateStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar);

  promptForApiKeyStartup();

  const provider = {
    async provideInlineCompletionItems(document, position, ctx, token) {
      if (ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && position.character === 0) return null;
      const text = await getCompletion(document, position, token);
      if (!text || token?.isCancellationRequested) return null;
      return [makeItem(document, position, text)];
    },
  };

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.window.registerWebviewViewProvider("keypilot.statsView", statsProvider),
    vscode.commands.registerCommand("keypilot.openStats", () =>
      vscode.commands.executeCommand("workbench.view.extension.keypilot")),
    vscode.commands.registerCommand("keypilot.setApiKey", promptForApiKey),
    vscode.commands.registerCommand("keypilot.resetTokens", () => {
      stats = { prompt: 0, completion: 0, total: 0, requests: 0 };
      updateStatusBar();
      statsProvider?.refresh();
    }),
    vscode.commands.registerCommand("keypilot.test", async () => {
      if (!cfg().get("apiKey")?.trim()) { await promptForApiKey(); return; }
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showErrorMessage("Open a file first."); return; }
      const text = await getCompletion(ed.document, ed.selection.active, undefined);
      if (text) vscode.window.showInformationMessage("OK: " + text.slice(0, 80));
      else vscode.window.showErrorMessage("Failed. Log: " + LOG);
    })
  );
}

module.exports = { activate, deactivate: () => {} };
