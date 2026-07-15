# AskFirst

A VS Code extension that refines your AI prompts. Instead of guessing what you mean, AskFirst asks you a few targeted clarifying questions, then rewrites your prompt so any AI can understand exactly what you want.

**Local-first, free by default** — AskFirst runs on [Ollama](https://ollama.com) out of the box, so your prompts never leave your machine and there are no token costs. Prefer a stronger model? Anthropic and OpenAI are supported using your own account credentials, stored in the OS keychain via VS Code SecretStorage.

## How it works

1. Select a rough prompt in your editor (or type one in) and run **AskFirst: Refine Prompt**
2. The model analyzes what's missing and generates 3–4 clarifying questions, each with concrete answer options
3. Answer them in a quick multiple-choice flow (pick an option, type your own, or skip)
4. AskFirst rewrites your prompt into a structured, self-contained prompt (Task / Audience / Requirements / Constraints / Success Criteria) and opens it beside your editor — copy it into any AI

## Setup

### Option A: Ollama (default — free, local, no API key)

1. Install [Ollama](https://ollama.com) and pull a model:
   ```bash
   ollama pull llama3.2
   ```
2. Install the extension — that's it. Run **AskFirst: Refine Prompt** from the Command Palette (`Cmd/Ctrl+Shift+P`)

### Option B: Anthropic or OpenAI

1. Run **AskFirst: Set API Key** from the Command Palette and choose the provider
2. In Settings → AskFirst, set `askfirst.provider` to `anthropic` or `openai`

## Settings

| Setting | Default | Description |
|---|---|---|
| `askfirst.provider` | `ollama` | `ollama`, `anthropic`, or `openai` |
| `askfirst.model` | *(empty)* | Model name. Empty = provider default (ollama: `llama3.2`, anthropic: `claude-sonnet-5`, openai: `gpt-4o-mini`) |
| `askfirst.ollamaUrl` | `http://localhost:11434` | Base URL of your Ollama server |

## Commands

| Command | Description |
|---|---|
| `AskFirst: Refine Prompt` | Start the clarify-and-rewrite flow |
| `AskFirst: Set API Key` | Store an Anthropic or OpenAI key securely (not needed for Ollama) |
| `AskFirst: Clear API Key` | Remove all stored keys |

## Development

```bash
npm install
npm run compile   # type-check + bundle
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## Status

🚧 Early development. Working: the full clarify-and-rewrite flow on Ollama, Anthropic, and OpenAI. Contributions welcome — open an issue or PR.

## License

[MIT](LICENSE)
