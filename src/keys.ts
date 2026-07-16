import * as vscode from 'vscode';
import { Provider } from './llm';

/** API key storage and provider selection, shared by all UI surfaces. */

function secretKeyFor(provider: string): string {
  return `askfirst.apiKey.${provider}`;
}

export function currentProvider(): Provider {
  return vscode.workspace.getConfiguration('askfirst').get<Provider>('provider', 'ollama');
}

export async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
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

export async function clearApiKeys(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(secretKeyFor('anthropic'));
  await context.secrets.delete(secretKeyFor('openai'));
  vscode.window.showInformationMessage('AskFirst: all stored API keys cleared.');
}

/** Returns the API key for the active provider, prompting the user to set one if needed. */
export async function resolveApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
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

/** True when the flow can proceed: Ollama needs no key, cloud providers need one. */
export function keySatisfied(apiKey: string | undefined): boolean {
  return currentProvider() === 'ollama' || !!apiKey;
}
