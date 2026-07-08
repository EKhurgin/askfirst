import * as vscode from 'vscode';
import {
  generateQuestions,
  rewritePrompt,
  Answer,
  ClarifyingQuestion,
  Provider,
} from './llm';

function secretKeyFor(provider: string): string {
  return `askfirst.apiKey.${provider}`;
}

function currentProvider(): Provider {
  return vscode.workspace.getConfiguration('askfirst').get<Provider>('provider', 'ollama');
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('askfirst.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('askfirst.clearApiKey', () => clearApiKey(context)),
    vscode.commands.registerCommand('askfirst.refinePrompt', () => refinePrompt(context)),
  );
}

export function deactivate() {}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const provider = await vscode.window.showQuickPick(['anthropic', 'openai'], {
    title: 'AskFirst: which provider is this key for?',
    placeHolder: 'Ollama runs locally and needs no key',
  });
  if (!provider) {
    return;
  }
  const key = await vscode.window.showInputBox({
    prompt: `Enter your ${provider} API key (stored securely in your OS keychain)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (key) {
    await context.secrets.store(secretKeyFor(provider), key.trim());
    vscode.window.showInformationMessage(
      `AskFirst: ${provider} API key saved. Set "askfirst.provider" to "${provider}" to use it.`,
    );
  }
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(secretKeyFor('anthropic'));
  await context.secrets.delete(secretKeyFor('openai'));
  vscode.window.showInformationMessage('AskFirst: all stored API keys cleared.');
}

/** Returns the API key for the active provider, prompting the user to set one if needed. */
async function resolveApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const provider = currentProvider();
  if (provider === 'ollama') {
    return undefined; // local — no key needed
  }
  let key = await context.secrets.get(secretKeyFor(provider));
  if (!key) {
    const choice = await vscode.window.showWarningMessage(
      `AskFirst: provider is set to "${provider}" but no API key is stored. Set one now?`,
      'Set API Key',
    );
    if (choice !== 'Set API Key') {
      return undefined;
    }
    await vscode.commands.executeCommand('askfirst.setApiKey');
    key = await context.secrets.get(secretKeyFor(provider));
  }
  return key;
}

async function refinePrompt(context: vscode.ExtensionContext): Promise<void> {
  // 0. Cloud providers need a key; Ollama doesn't.
  const provider = currentProvider();
  const apiKey = await resolveApiKey(context);
  if (provider !== 'ollama' && !apiKey) {
    return; // user declined to set a key
  }

  // 1. Get the rough prompt: current selection, or ask for it.
  const editor = vscode.window.activeTextEditor;
  const selection = editor?.document.getText(editor.selection)?.trim();
  const roughPrompt =
    selection ||
    (await vscode.window.showInputBox({
      prompt: 'Paste the prompt you want to refine',
      placeHolder: 'e.g. "write a blog post about AI"',
      ignoreFocusOut: true,
    }));
  if (!roughPrompt) {
    return;
  }

  // 2. Generate clarifying questions.
  let questions: ClarifyingQuestion[];
  try {
    questions = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'AskFirst: analyzing your prompt…',
        cancellable: false,
      },
      () => generateQuestions(roughPrompt, apiKey),
    );
  } catch (e) {
    vscode.window.showErrorMessage(`AskFirst: ${(e as Error).message}`);
    return;
  }

  // 3. Walk the user through the questions.
  const answers: Answer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = await askQuestion(q, i + 1, questions.length);
    if (answer === undefined) {
      return; // user pressed Escape — abort quietly
    }
    if (answer !== SKIP) {
      answers.push({ question: q.question, answer: answer as string });
    }
  }

  // 4. Rewrite the prompt with the clarifications.
  let refined: string;
  try {
    refined = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'AskFirst: rewriting your prompt…',
        cancellable: false,
      },
      () => rewritePrompt(roughPrompt, answers, apiKey),
    );
  } catch (e) {
    vscode.window.showErrorMessage(`AskFirst: ${(e as Error).message}`);
    return;
  }

  // 5. Show the result in a new editor tab beside the current one.
  const doc = await vscode.workspace.openTextDocument({
    content: refined.trim(),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}

const SKIP = Symbol('skip');
const OTHER_LABEL = '$(edit) Type my own answer…';
const SKIP_LABEL = '$(debug-step-over) Skip this question';

async function askQuestion(
  q: ClarifyingQuestion,
  index: number,
  total: number,
): Promise<string | typeof SKIP | undefined> {
  const items: vscode.QuickPickItem[] = [
    ...q.options.map((o) => ({ label: o })),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: OTHER_LABEL },
    { label: SKIP_LABEL },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `AskFirst (${index}/${total})`,
    placeHolder: q.question,
    ignoreFocusOut: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.label === SKIP_LABEL) {
    return SKIP;
  }
  if (picked.label === OTHER_LABEL) {
    const custom = await vscode.window.showInputBox({
      title: `AskFirst (${index}/${total})`,
      prompt: q.question,
      ignoreFocusOut: true,
    });
    if (custom === undefined) {
      return undefined;
    }
    return custom.trim() || SKIP;
  }
  return picked.label;
}
