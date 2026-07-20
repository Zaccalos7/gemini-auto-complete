<img width="172" height="171" alt="image" src="https://github.com/user-attachments/assets/65efa974-409a-45c8-9899-e542c77194b4" />

# Gemini Autocomplete

Copilot-style inline completion for VSCode, powered by Gemini's `generateContent` API.

## Install

1. `code --install-extension` needs a packaged `.vsix`, or just run it live:
2. Open this folder in VSCode → press `F5` → "Extension Development Host" window opens with the extension loaded.
3. (Package instead: `npm i -g @vscode/vsce && vsce package`, then install the `.vsix`.)

## Setup (Google login — OAuth)

One-time Google Cloud setup (needed because there's no hosted backend):

1. Google Cloud Console → **APIs & Services → Enable APIs** → enable **Generative Language API**.
2. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app**.
3. Copy the **Client ID** and **Client secret** into settings:
   - `geminiAutocomplete.clientId`
   - `geminiAutocomplete.clientSecret`
     (Desktop-app secrets are not treated as confidential — fine to store locally.)
4. Run command **Gemini Autocomplete: Login with Google** → browser opens → approve.
   Tokens are saved encrypted in VSCode SecretStorage and auto-refreshed. Log out anytime with **Gemini Autocomplete: Logout**.

If a request returns **403**, adjust `geminiAutocomplete.scope`.

## 🔧 Quick Test (Autocomplete Check)

### Open the Command Palette

1. macOS → Cmd + Shift + P
2. Windows → Ctrl + Shift + P
3. Linux → Ctrl + Shift + P

- `Then type “Autocomplete Test” and press Enter.`
- `If the extension is active, you’ll see a confirmation message.`

### Fallback: plain API key

Prefer no OAuth? Set `geminiAutocomplete.apiKey` (from https://aistudio.google.com/apikey) and it's used instead of login.

Other settings: `model` (default `gemini-2.0-flash`), `endpoint`, `enabled` (toggle command), `maxContextChars`.

Type code — ghost-text suggestions appear inline. `Tab` accepts.

## Notes

- Sends up to `maxContextChars` before/after the cursor to the API. Your code leaves your machine — check Google's data terms before use on private repos.
- OAuth is a loopback PKCE flow (`127.0.0.1:<random port>`), no client secret in source.
- Naive 300ms debounce, single-file provider, no build step.

## Support the team

<a href="https://buymeacoffee.com/zaccalos" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="40">
</a>
