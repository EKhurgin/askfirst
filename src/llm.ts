import * as vscode from 'vscode';

export type Provider = 'ollama' | 'anthropic' | 'openai';

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

const DEFAULT_MODELS: Record<Provider, string> = {
  ollama: 'llama3.2',
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o-mini',
};

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('askfirst');
  const provider = cfg.get<Provider>('provider', 'ollama');
  return {
    provider,
    model: cfg.get<string>('model', '') || DEFAULT_MODELS[provider],
    ollamaUrl: cfg.get<string>('ollamaUrl', 'http://localhost:11434').replace(/\/$/, ''),
  };
}

// ---------------------------------------------------------------------------
// Provider backends
// ---------------------------------------------------------------------------

async function chat(
  messages: ChatMessage[],
  schema: object | undefined,
  temperature: number,
  apiKey?: string,
): Promise<string> {
  const { provider } = getConfig();
  switch (provider) {
    case 'anthropic':
      return anthropicChat(messages, schema, temperature, apiKey);
    case 'openai':
      return openaiChat(messages, schema, temperature, apiKey);
    default:
      return ollamaChat(messages, schema, temperature);
  }
}

async function ollamaChat(
  messages: ChatMessage[],
  schema: object | undefined,
  temperature: number,
): Promise<string> {
  const { ollamaUrl, model } = getConfig();
  let res: Response;
  try {
    res = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(schema ? { format: schema } : {}),
        // num_ctx: Ollama defaults to a 4096-token window and silently truncates
        // beyond it — raise it so our prompts + examples always fit.
        options: { temperature, num_ctx: 8192 },
      }),
    });
  } catch {
    throw new Error(
      `Could not reach Ollama at ${ollamaUrl}. Is it running? Start it with \`ollama serve\` (install from ollama.com).`,
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

/** Cloud models don't take a schema parameter the way Ollama does — embed it in the prompt instead. */
function withSchemaInstruction(messages: ChatMessage[], schema: object | undefined): ChatMessage[] {
  if (!schema) {
    return messages;
  }
  const out = messages.map((m) => ({ ...m }));
  out[out.length - 1].content +=
    `\n\nRespond with ONLY valid JSON conforming to this JSON schema — no prose, no code fences:\n${JSON.stringify(schema)}`;
  return out;
}

async function anthropicChat(
  messages: ChatMessage[],
  schema: object | undefined,
  temperature: number,
  apiKey?: string,
): Promise<string> {
  if (!apiKey) {
    throw new Error('No Anthropic API key set. Run "AskFirst: Set API Key" first.');
  }
  const { model } = getConfig();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature,
      messages: withSchemaInstruction(messages, schema),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error('Anthropic rejected the API key. Run "AskFirst: Set API Key" to update it.');
    }
    throw new Error(`Anthropic error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((b) => b.type === 'text')?.text;
  if (!text) {
    throw new Error('Anthropic returned an empty response.');
  }
  return text;
}

async function openaiChat(
  messages: ChatMessage[],
  schema: object | undefined,
  temperature: number,
  apiKey?: string,
): Promise<string> {
  if (!apiKey) {
    throw new Error('No OpenAI API key set. Run "AskFirst: Set API Key" first.');
  }
  const { model } = getConfig();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: withSchemaInstruction(messages, schema),
      ...(schema ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error('OpenAI rejected the API key. Run "AskFirst: Set API Key" to update it.');
    }
    throw new Error(`OpenAI error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('OpenAI returned an empty response.');
  }
  return text;
}

function parseJson<T>(content: string, what: string): T {
  // Tolerate code fences or stray prose around the JSON.
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    text = fence[1];
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`The model returned malformed JSON for the ${what}. Try again.`);
  }
}

// ---------------------------------------------------------------------------
// Step 1: analyze the rough prompt — small, focused job for a small model.
// ---------------------------------------------------------------------------

const ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    missing: {
      type: 'array',
      items: { type: 'string' },
      minItems: 3,
      maxItems: 5,
    },
  },
  required: ['goal', 'missing'],
};

interface Analysis {
  goal: string;
  missing: string[];
}

async function analyzePrompt(roughPrompt: string, apiKey?: string): Promise<Analysis> {
  const content = await chat(
    [
      {
        role: 'user',
        content: `Here is a rough prompt someone wants to send to an AI:

"""
${roughPrompt}
"""

1. "goal": In one sentence, what is this person fundamentally trying to get?
2. "missing": List 3-5 specific pieces of information NOT stated in the prompt that would most change what a good response looks like. Be concrete and specific to THIS prompt. Never list something the prompt already answers.

Example — for "write a blog post about AI", good missing items are:
"which aspect of AI to focus on", "who will read the post and their technical level", "what the post should achieve (SEO traffic, authority, education)", "how long it should be".
Bad missing items (too generic): "more details", "the context", "the requirements".

Respond in JSON.`,
      },
    ],
    ANALYZE_SCHEMA,
    0.1,
    apiKey,
  );
  return parseJson<Analysis>(content, 'analysis');
}

// ---------------------------------------------------------------------------
// Step 2: turn each missing item into one multiple-choice question.
// ---------------------------------------------------------------------------

const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'string' },
            minItems: 3,
            maxItems: 4,
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  required: ['questions'],
};

export async function generateQuestions(
  roughPrompt: string,
  apiKey?: string,
): Promise<ClarifyingQuestion[]> {
  const analysis = await analyzePrompt(roughPrompt, apiKey);

  const missingList = analysis.missing.map((m, i) => `${i + 1}. ${m}`).join('\n');
  const content = await chat(
    [
      {
        role: 'user',
        content: `Someone wrote this rough AI prompt:

"""
${roughPrompt}
"""

Their goal: ${analysis.goal}

This information is missing:
${missingList}

Write one multiple-choice question for each of the most important missing items (3-4 questions total). Each question gets 3-4 answer options.

Options must be concrete, realistic choices — describe real situations, not abstract categories.
Bad options: "Formal", "Informal", "Neutral"
Good options: "Executives deciding whether to fund this", "Engineers who will build it", "Customers with no technical background"

Each option should be a full, specific phrase the person can recognize as "yes, that's my situation".

Respond in JSON.`,
      },
    ],
    QUESTIONS_SCHEMA,
    0.3,
    apiKey,
  );

  const parsed = parseJson<{ questions?: ClarifyingQuestion[] }>(content, 'questions');
  const questions = (parsed.questions ?? []).filter(
    (q) => q.question && Array.isArray(q.options) && q.options.length >= 2,
  );
  if (questions.length === 0) {
    throw new Error('No usable clarifying questions were generated. Try rephrasing your prompt.');
  }
  return questions.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Step 3: rewrite the prompt using the answers — template filling, which
// small models handle far better than freeform composition.
// ---------------------------------------------------------------------------

export async function rewritePrompt(
  roughPrompt: string,
  answers: Answer[],
  apiKey?: string,
): Promise<string> {
  const qaBlock = answers.map((a) => `- ${a.question}\n  Answer: ${a.answer}`).join('\n');

  return chat(
    [
      {
        role: 'user',
        content: `Rewrite this rough AI prompt into a detailed prompt, using the person's answers below. The result will be pasted into another AI, so it must be complete and self-contained.

Rough prompt:
"""
${roughPrompt}
"""

The person answered these clarifying questions:
${qaBlock}

Write the improved prompt using EXACTLY this structure:

# Task
[2-3 sentences: exactly what to produce, incorporating the person's answers about what they want]

# Audience & Purpose
[Who will consume the output and what it must achieve — from their answers]

# Requirements
[4-6 bullet points of specific, checkable requirements: format, length, structure, what must be included. Derive each from the rough prompt or an answer.]

# Constraints
[2-3 bullet points: what to avoid]

# Success Criteria
[2-3 bullet points: what makes the result excellent]

Rules:
- Use EVERY answer the person gave. Do not drop or contradict any.
- Do not invent requirements they didn't imply.
- Write directives: "Write...", "Include...", "Avoid...".
- Output ONLY the prompt in that structure — no introduction, no commentary after.`,
      },
    ],
    undefined,
    0.4,
    apiKey,
  );
}
