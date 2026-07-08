import * as vscode from 'vscode';

export interface ClarifyingQuestion {
  question: string;
  options: string[];
}

export interface Answer {
  question: string;
  answer: string;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('askfirst');
  return {
    baseUrl: cfg.get<string>('ollamaUrl', 'http://localhost:11434').replace(/\/$/, ''),
    model: cfg.get<string>('model', '') || 'llama3.2',
  };
}

async function chat(messages: ChatMessage[], format?: object): Promise<string> {
  const { baseUrl, model } = getConfig();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(format ? { format } : {}),
        options: { temperature: 0.3 },
      }),
    });
  } catch {
    throw new Error(
      `Could not reach Ollama at ${baseUrl}. Is it running? Start it with \`ollama serve\` (install from ollama.com).`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 404 && body.includes('model')) {
      throw new Error(`Model "${model}" not found. Pull it first: \`ollama pull ${model}\``);
    }
    throw new Error(`Ollama error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content;
  if (!content) {
    throw new Error('Ollama returned an empty response.');
  }
  return content;
}

const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['question', 'options'],
      },
    },
  },
  required: ['questions'],
};

export async function generateQuestions(roughPrompt: string): Promise<ClarifyingQuestion[]> {
  const content = await chat(
    [
      {
        role: 'system',
        content: [
          'You help users clarify vague AI prompts. Given a rough prompt, identify what is',
          'ambiguous or underspecified and produce 3 to 5 clarifying questions that would most',
          'narrow down what the user actually wants. Each question must include 2 to 4 short,',
          'concrete answer options covering the most likely intents. Ask about things like:',
          'goal/purpose, target audience, desired format or length, tone, scope, constraints,',
          'and technical context. Only ask questions whose answers would change the final output.',
          'Respond in JSON.',
        ].join(' '),
      },
      { role: 'user', content: `Rough prompt:\n"""\n${roughPrompt}\n"""` },
    ],
    QUESTIONS_SCHEMA,
  );

  let parsed: { questions?: ClarifyingQuestion[] };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Ollama returned malformed JSON for the questions. Try again or use a larger model.');
  }
  const questions = (parsed.questions ?? []).filter(
    (q) => q.question && Array.isArray(q.options) && q.options.length > 0,
  );
  if (questions.length === 0) {
    throw new Error('No usable clarifying questions were generated. Try rephrasing your prompt.');
  }
  return questions.slice(0, 5);
}

export async function rewritePrompt(roughPrompt: string, answers: Answer[]): Promise<string> {
  const qaBlock = answers
    .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');

  return chat([
    {
      role: 'system',
      content: [
        'You rewrite rough AI prompts into clear, detailed, self-contained prompts that any',
        'LLM can understand without further context. Use the user\'s answers to the clarifying',
        'questions to resolve ambiguity. The rewritten prompt should state the goal, audience,',
        'format, tone, scope, and constraints explicitly where known. Write it in second person',
        '("You are...", "Write...") as instructions to an AI. Output ONLY the rewritten prompt —',
        'no preamble, no explanation, no markdown code fences around it.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Rough prompt:\n"""\n${roughPrompt}\n"""\n\nClarifications from the user:\n${qaBlock}`,
    },
  ]);
}
