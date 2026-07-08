# AskFirst

A VS Code extension that refines your AI prompts. Instead of guessing what you mean, AskFirst asks you a few targeted clarifying questions, then rewrites your prompt so any AI can understand exactly what you want.

**Bring your own API key** — AskFirst calls your chosen AI provider directly from your machine. Your key never leaves your computer (it's stored in your OS keychain via VS Code's SecretStorage).

## How it works

1. Select a rough prompt in your editor (or type one in) and run **AskFirst: Refine Prompt**
2. AskFirst sends it to your AI provider, which identifies ambiguities and generates clarifying questions
3. Answer the questions in a quick multiple-choice flow
4. AskFirst rewrites your prompt with the clarifications baked in — copy it anywhere

## Setup

1. Install the extension
2. Run **AskFirst: Set API Key** from the Command Palette (`Cmd/Ctrl+Shift+P`) and paste your Anthropic or OpenAI API key
3. Optionally pick your provider and model in Settings → AskFirst

## Commands

| Command | Description |
|---|---|
| `AskFirst: Refine Prompt` | Start the clarify-and-rewrite flow |
| `AskFirst: Set API Key` | Store your API key securely |
| `AskFirst: Clear API Key` | Remove the stored key |

## Development

```bash
npm install
npm run compile   # type-check + bundle
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## Status

🚧 Early development. The scaffold and key storage are in place; the question/rewrite flow is being built. Contributions welcome — open an issue or PR.

## License

[MIT](LICENSE)
