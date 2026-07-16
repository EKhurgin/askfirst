import * as vscode from 'vscode';
import { setApiKey, clearApiKeys } from './keys';
import { refineViaQuickPick } from './quickpick';
import { AskFirstViewProvider } from './panel/provider';

export function activate(context: vscode.ExtensionContext) {
  const panelProvider = new AskFirstViewProvider(context);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(sparkle) AskFirst';
  statusBar.tooltip = 'Open the AskFirst panel';
  statusBar.command = 'askfirst.openPanel';
  statusBar.show();

  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider(AskFirstViewProvider.viewId, panelProvider),
    vscode.commands.registerCommand('askfirst.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('askfirst.clearApiKey', () => clearApiKeys(context)),
    vscode.commands.registerCommand('askfirst.refinePrompt', () => refineViaQuickPick(context)),
    vscode.commands.registerCommand('askfirst.openPanel', () => {
      const editor = vscode.window.activeTextEditor;
      const selection = editor?.document.getText(editor.selection)?.trim();
      return panelProvider.openWithPrompt(selection || undefined);
    }),
  );
}

export function deactivate() {}
