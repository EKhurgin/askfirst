import * as vscode from 'vscode';
import { generateQuestions, rewritePrompt, Answer } from '../llm';
import { keySatisfied, resolveApiKey } from '../keys';

/** Messages the webview sends to the extension. */
type InboundMessage =
  | { type: 'generateQuestions'; prompt: string }
  | { type: 'rewrite'; prompt: string; answers: Answer[] }
  | { type: 'copy'; text: string }
  | { type: 'insert'; text: string }
  | { type: 'requestHistory' }
  | { type: 'clearHistory' };

/** Messages the extension sends to the webview. */
type OutboundMessage =
  | { type: 'questions'; questions: { question: string; options: string[] }[] }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string }
  | { type: 'prefill'; prompt: string }
  | { type: 'busy'; what: 'questions' | 'result' }
  | { type: 'history'; items: HistoryItem[] };

export interface HistoryItem {
  prompt: string;
  result: string;
  when: number;
}

const HISTORY_KEY = 'askfirst.history';
const HISTORY_MAX = 10;

export class AskFirstViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'askfirst.panel';
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel')],
    };
    webview.html = this.renderHtml(webview);
    webview.onDidReceiveMessage((msg: InboundMessage) => this.onMessage(msg));
  }

  /** Opens the panel and loads the given text as the rough prompt. */
  async openWithPrompt(prompt?: string): Promise<void> {
    await vscode.commands.executeCommand(`${AskFirstViewProvider.viewId}.focus`);
    if (prompt) {
      // The view may have just been created; give resolveWebviewView a beat.
      setTimeout(() => this.post({ type: 'prefill', prompt }), 150);
    }
  }

  private post(msg: OutboundMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private async onMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'generateQuestions':
        return this.handleGenerateQuestions(msg.prompt);
      case 'rewrite':
        return this.handleRewrite(msg.prompt, msg.answers);
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.showInformationMessage('AskFirst: prompt copied.');
        return;
      case 'insert':
        return this.handleInsert(msg.text);
      case 'requestHistory':
        this.post({ type: 'history', items: this.history() });
        return;
      case 'clearHistory':
        await this.context.globalState.update(HISTORY_KEY, []);
        this.post({ type: 'history', items: [] });
        return;
    }
  }

  private async handleGenerateQuestions(prompt: string): Promise<void> {
    const apiKey = await resolveApiKey(this.context);
    if (!keySatisfied(apiKey)) {
      this.post({ type: 'error', message: 'An API key is required for the selected provider.' });
      return;
    }
    this.post({ type: 'busy', what: 'questions' });
    try {
      const questions = await generateQuestions(prompt, apiKey);
      this.post({ type: 'questions', questions });
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    }
  }

  private async handleRewrite(prompt: string, answers: Answer[]): Promise<void> {
    const apiKey = await resolveApiKey(this.context);
    if (!keySatisfied(apiKey)) {
      this.post({ type: 'error', message: 'An API key is required for the selected provider.' });
      return;
    }
    this.post({ type: 'busy', what: 'result' });
    try {
      const result = (await rewritePrompt(prompt, answers, apiKey)).trim();
      await this.pushHistory({ prompt, result, when: Date.now() });
      this.post({ type: 'result', text: result });
      this.post({ type: 'history', items: this.history() });
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    }
  }

  private async handleInsert(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
    if (!editor) {
      vscode.window.showWarningMessage('AskFirst: open a file to insert into.');
      return;
    }
    await editor.edit((edit) => edit.replace(editor.selection, text));
  }

  private history(): HistoryItem[] {
    return this.context.globalState.get<HistoryItem[]>(HISTORY_KEY, []);
  }

  private async pushHistory(item: HistoryItem): Promise<void> {
    const items = [item, ...this.history()].slice(0, HISTORY_MAX);
    await this.context.globalState.update(HISTORY_KEY, items);
  }

  private renderHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'style.css'));
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 62)),
    ).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
