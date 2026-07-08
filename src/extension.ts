import * as vscode from 'vscode';
import { generateQuestions, rewritePrompt, Answer, ClarifyingQuestion } from './ollama';

const API_KEY_SECRET = 'askfirst.apiKey';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('askfirst.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('askfirst.clearApiKey', () => clearApiKey(context)),
    vscode.commands.registerCommand('askfirst.refinePrompt', () => refinePrompt()),
  );
}

export function deactivate() {}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const provider = vscode.workspace.getConfiguration('askfirst').get<string>('provider', 'ollama');
  if (provider === 'ollama') {
    vscode.window.showInformationMessage('AskFirst: Ollama runs locally and needs no API key.');
    return;
  }
  const key = await vscode.window.showInputBox({
    prompt: `Enter your ${provider} API key (stored securely in your OS keychain)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (key) {
    await context.secrets.store(API_KEY_SECRET, key);
    vscode.window.showInformationMessage('AskFirst: API key saved.');
  }
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(API_KEY_SECRET);
  vscode.window.showInformationMessage('AskFirst: API key cleared.');
}

async function refinePrompt(): Promise<void> {
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

  // 2. Ask Ollama for clarifying questions.
  let questions: ClarifyingQuestion[];
  try {
    questions = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'AskFirst: analyzing your prompt…',
        cancellable: false,
      },
      () => generateQuestions(roughPrompt),
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
      () => rewritePrompt(roughPrompt, answers),
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
