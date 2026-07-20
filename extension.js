const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOG = path.join(os.tmpdir(), "keypilot.log");
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`;
  try { fs.appendFileSync(LOG, line); } catch { }
}

function cfg() {
  return vscode.workspace.getConfiguration("keypilot");
}

function sleep(ms, token) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    if (token) token.onCancellationRequested(() => { clearTimeout(t); resolve(false); });
  });
}

async function promptForApiKeyStartup() {
  const c = cfg();
  let apiKey = c.get("apiKey");

  if (!apiKey || apiKey.trim() === "") {
    log("startup: missing apiKey, prompting user");
    const docLink = "Get your API Key (Google AI Studio)";
    const selection = await vscode.window.showInformationMessage(
      "Welcome to Keypilot! Add your API Key to unlock AI-powered features",
      "Put here your API Key",
      docLink
    );

    if (selection === docLink) {
      vscode.env.openExternal(vscode.Uri.parse("https://aistudio.google.com/"));
      const input = await vscode.window.showInputBox({
        prompt: "Great! When your API Key is ready, just paste it here",
        placeHolder: "AIzaSy...",
        ignoreFocusOut: true,
        password: true
      });
      if (input && input.trim() !== "") {
        await c.update("apiKey", input.trim(), vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage("Great! Your API Key is saved and Keypilot is ready to go.");
      }
    } else if (selection === "Put here your API Key") {
      const input = await vscode.window.showInputBox({
        prompt: "write your API Key",
        placeHolder: "your key...",
        ignoreFocusOut: true,
        password: true
      });
      if (input && input.trim() !== "") {
        await c.update("apiKey", input.trim(), vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage("Great! Your API Key is saved and Keypilot is ready to go.");
      }
    }
  }
}

async function getCompletion(document, position, token) {
  const c = cfg();

  if (!c.get("enabled")) return null;

  const apiKey = c.get("apiKey");
  if (!apiKey || apiKey.trim() === "") return null;

  if (token) {
    if (!(await sleep(200, token))) { log("skip: debounced"); return null; }
    if (token.isCancellationRequested) { log("skip: cancelled"); return null; }
  }

  const maxChars = c.get("maxContextChars") || 10000;
  const full = document.getText();
  const offset = document.offsetAt(position);
  const before = full.slice(Math.max(0, offset - maxChars), offset);
  const after = full.slice(offset, offset + maxChars);

  if (!before.trim() && !after.trim()) return null;

  const system = `You are a professional IDE inline code completion agent like GitHub Copilot. ` +
    `Your task is to generate the exact code that belongs at the <CURSOR> position inside the ${document.languageId} file. ` +
    `Review what comes BEFORE and AFTER <CURSOR>. Output ONLY the code to be inserted. ` +
    `Do NOT wrap in markdown code blocks. Do NOT explain. Do NOT repeat code that already exists after <CURSOR>.`;

  const user = `--- FILE BEFORE CURSOR ---\n${before}\n<CURSOR>\n--- FILE AFTER CURSOR ---\n${after}`;

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
        temperature: 0.1,
        max_tokens: 512,
        stop: ["--- FILE AFTER CURSOR ---", "<CURSOR>"]
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

  const lineEnd = document.lineAt(position.line).text.slice(position.character);
  if (lineEnd.trim() && text.startsWith(lineEnd.trim())) {
    text = text.slice(text.indexOf(lineEnd.trim()) + lineEnd.trim().length);
  }

  log("ok", text.slice(0, 60).replace(/\n/g, "\\n"));
  return text;
}

function activate(context) {
  log("=== activate ===");

  promptForApiKeyStartup();

  const provider = {
    async provideInlineCompletionItems(document, position, ctx, token) {
      if (ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && position.character === 0) {
        return null;
      }
      const text = await getCompletion(document, position, token);
      if (!text || (token && token.isCancellationRequested)) return null;
      return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
    },
  };

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.commands.registerCommand("keypilot.test", async () => {
      const c = cfg();
      if (!c.get("apiKey") || c.get("apiKey").trim() === "") {
        await promptForApiKeyStartup();
        return;
      }
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showErrorMessage("Apri un file prima."); return; }
      const text = await getCompletion(ed.document, ed.selection.active, undefined);
      if (text) vscode.window.showInformationMessage("OK: " + text.slice(0, 80));
      else vscode.window.showErrorMessage("Failed. Log: " + LOG);
    })
  );
}

module.exports = { activate, deactivate: () => { } };