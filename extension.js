const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Inline autocomplete via any OpenAI-compatible chat API (default: Groq, free, no billing).

const LOG = path.join(os.tmpdir(), "autocomplete.log");
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
}

function cfg() {
  return vscode.workspace.getConfiguration("geminiAutocomplete");
}

function sleep(ms, token) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    if (token) token.onCancellationRequested(() => { clearTimeout(t); resolve(false); });
  });
}

async function getCompletion(document, position, token) {
  const c = cfg();
  const apiKey = c.get("apiKey");
  if (!apiKey) { log("skip: no apiKey"); return null; }

  if (token) {
    if (!(await sleep(350, token))) { log("skip: debounced"); return null; }
    if (token.isCancellationRequested) { log("skip: cancelled"); return null; }
  }

  const maxChars = c.get("maxContextChars");
  const full = document.getText();
  const offset = document.offsetAt(position);
  const before = full.slice(Math.max(0, offset - maxChars), offset);
  const after = full.slice(offset, offset + maxChars);

  const system = `You are a code completion engine for ${document.languageId}. ` +
    `Output ONLY the raw code to insert at <CURSOR>. No markdown, no explanation, no repetition of existing code.`;
  const user = `${before}<CURSOR>${after}`;

  const url = c.get("endpoint");
  const model = c.get("model");
  log("request", model, url);

  const controller = new AbortController();
  if (token) token.onCancellationRequested(() => controller.abort());

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.2,
        max_tokens: 256,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    log("fetch error", e.name, e.message);
    return null;
  }

  if (!resp.ok) {
    log("http error", resp.status, (await resp.text().catch(() => "")).slice(0, 300));
    return null;
  }

  const data = await resp.json().catch(() => null);
  let text = data?.choices?.[0]?.message?.content;
  if (!text) { log("empty", JSON.stringify(data).slice(0, 300)); return null; }
  text = text.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "");
  log("ok", text.slice(0, 60).replace(/\n/g, "\\n"));
  return text;
}

function activate(context) {
  log("=== activate ===");
  const provider = {
    async provideInlineCompletionItems(document, position, ctx, token) {
      const text = await getCompletion(document, position, token);
      if (!text || (token && token.isCancellationRequested)) return null;
      return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
    },
  };

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.commands.registerCommand("geminiAutocomplete.test", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showErrorMessage("Apri un file prima."); return; }
      const text = await getCompletion(ed.document, ed.selection.active, undefined);
      if (text) vscode.window.showInformationMessage("OK: " + text.slice(0, 80));
      else vscode.window.showErrorMessage("Failed. Log: " + LOG);
    })
  );
}

module.exports = { activate, deactivate: () => {} };
