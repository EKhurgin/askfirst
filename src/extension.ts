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
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(sparkle) AskFirst';
  statusBar.tooltip = 'Refine a prompt with clarifying questions';
  statusBar.command = 'askfirst.refinePrompt';
  statusBar.show();

  context.subscriptions.push(
    statusBar,
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

  // 3. Walk the user through the questions (with back navigation).
  const answers = await askAllQuestions(questions);
  if (answers === undefined) {
    return; // user aborted
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
  refined = refined.trim();

  // 5. Show the result beside the editor, with quick actions.
  const doc = await vscode.workspace.openTextDocument({
    content: refined,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });

  const autoCopy = vscode.workspace.getConfiguration('askfirst').get<boolean>('autoCopy', false);
  if (autoCopy) {
    await vscode.env.clipboard.writeText(refined);
  }
  const action = await vscode.window.showInformationMessage(
    autoCopy ? 'AskFirst: refined prompt ready (copied to clipboard).' : 'AskFirst: refined prompt ready.',
    ...(autoCopy ? ['Refine Again'] : ['Copy Prompt', 'Refine Again']),
  );
  if (action === 'Copy Prompt') {
    await vscode.env.clipboard.writeText(refined);
  } else if (action === 'Refine Again') {
    await vscode.commands.executeCommand('askfirst.refinePrompt');
  }
}

// ---------------------------------------------------------------------------
// Question flow
// ---------------------------------------------------------------------------

const SKIP = Symbol('skip');
type Given = string | typeof SKIP;
const OTHER_LABEL = '$(edit) Type my own answer…';
const SKIP_LABEL = '$(debug-step-over) Skip this question';

type StepResult =
  | { kind: 'answer'; value: Given }
  | { kind: 'back' }
  | { kind: 'retry' }
  | { kind: 'cancel' };

/** Runs the full question sequence. Returns undefined if the user aborts. */
async function askAllQuestions(questions: ClarifyingQuestion[]): Promise<Answer[] | undefined> {
  const given: Given[] = [];
  let i = 0;
  while (i < questions.length) {
    const step = await askQuestion(questions[i], i + 1, questions.length, i > 0);
    switch (step.kind) {
      case 'answer':
        given[i] = step.value;
        i++;
        break;
      case 'back':
        i--;
        break;
      case 'retry':
        break;
      case 'cancel': {
        const answered = given.filter((g) => g !== undefined && g !== SKIP).length;
        if (answered === 0) {
          return undefined; // nothing to lose — abort quietly
        }
        const choice = await vscode.window.showWarningMessage(
          `Discard your ${answered} answer${answered === 1 ? '' : 's'}?`,
          { modal: true },
          'Discard',
        );
        if (choice === 'Discard') {
          return undefined;
        }
        break; // resume on the same question
      }
    }
  }
  return questions
    .map((q, idx) => ({ question: q.question, answer: given[idx] }))
    .filter((a): a is Answer => typeof a.answer === 'string');
}

/** Shows one question as a QuickPick with an optional back button. */
async function askQuestion(
  q: ClarifyingQuestion,
  index: number,
  total: number,
  canGoBack: boolean,
): Promise<StepResult> {
  const picked = await new Promise<'back' | 'cancel' | string>((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.title = `AskFirst (${index}/${total})`;
    qp.placeholder = q.question;
    qp.ignoreFocusOut = true;
    qp.items = [
      ...q.options.map((o) => ({ label: o })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: OTHER_LABEL },
      { label: SKIP_LABEL },
    ];
    if (canGoBack) {
      qp.buttons = [vscode.QuickInputButtons.Back];
    }
    let settled = false;
    qp.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        settled = true;
        resolve('back');
        qp.hide();
      }
    });
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (sel && sel.label) {
        settled = true;
        resolve(sel.label);
        qp.hide();
      }
    });
    qp.onDidHide(() => {
      if (!settled) {
        resolve('cancel');
      }
      qp.dispose();
    });
    qp.show();
  });

  if (picked === 'back') {
    return { kind: 'back' };
  }
  if (picked === 'cancel') {
    return { kind: 'cancel' };
  }
  if (picked === SKIP_LABEL) {
    return { kind: 'answer', value: SKIP };
  }
  if (picked === OTHER_LABEL) {
    const custom = await vscode.window.showInputBox({
      title: `AskFirst (${index}/${total})`,
      prompt: q.question,
      ignoreFocusOut: true,
    });
    if (custom === undefined) {
      return { kind: 'retry' }; // escape from typing → back to this question's options
    }
    return { kind: 'answer', value: custom.trim() || SKIP };
  }
  return { kind: 'answer', value: picked };
}
