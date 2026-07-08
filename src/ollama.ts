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

async function chat(messages: ChatMessage[], format?: object, temperature = 0.2): Promise<string> {
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
        // num_ctx: Ollama defaults to a 4096-token window and silently truncates
        // beyond it — raise it so our prompts + examples always fit.
        options: { temperature, num_ctx: 8192 },
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

function parseJson<T>(content: string, what: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(`Ollama returned malformed JSON for the ${what}. Try again.`);
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

async function analyzePrompt(roughPrompt: string): Promise<Analysis> {
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

export async function generateQuestions(roughPrompt: string): Promise<ClarifyingQuestion[]> {
  const analysis = await analyzePrompt(roughPrompt);

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

export async function rewritePrompt(roughPrompt: string, answers: Answer[]): Promise<string> {
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
  );
}
