// AskFirst sidebar panel. State machine: input → questions → result.
// State survives hide/show via vscode.setState.
(function () {
  const vscode = acquireVsCodeApi();
  const SKIP = '__skip__';

  let state = vscode.getState() || {
    phase: 'input', // input | busy-questions | questions | busy-result | result
    prompt: '',
    questions: [], // { question, options, answer?: string|SKIP, open: bool }
    result: '',
    error: '',
    history: [],
    showHistory: false,
  };

  // ------------------------------------------------------------ messaging

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'busy':
        state.phase = msg.what === 'questions' ? 'busy-questions' : 'busy-result';
        state.error = '';
        break;
      case 'questions':
        state.questions = msg.questions.map((q, i) => ({ ...q, answer: undefined, open: i === 0 }));
        state.phase = 'questions';
        state.error = '';
        break;
      case 'result':
        state.result = msg.text;
        state.phase = 'result';
        state.error = '';
        break;
      case 'error':
        state.error = msg.message;
        if (state.phase === 'busy-questions') state.phase = 'input';
        if (state.phase === 'busy-result') state.phase = 'questions';
        break;
      case 'prefill':
        state = { ...state, phase: 'input', prompt: msg.prompt, questions: [], result: '', error: '', showHistory: false };
        break;
      case 'history':
        state.history = msg.items;
        break;
    }
    save();
    render();
  });

  function save() {
    vscode.setState(state);
  }

  // ------------------------------------------------------------ actions

  function startQuestions() {
    const prompt = document.getElementById('prompt-input').value.trim();
    if (!prompt) return;
    state.prompt = prompt;
    save();
    vscode.postMessage({ type: 'generateQuestions', prompt });
  }

  function answer(i, value) {
    state.questions[i].answer = value;
    state.questions[i].open = false;
    const next = state.questions.findIndex((q) => q.answer === undefined);
    if (next >= 0) state.questions[next].open = true;
    save();
    render();
  }

  function reopen(i) {
    state.questions.forEach((q, idx) => (q.open = idx === i));
    save();
    render();
  }

  function refine() {
    const answers = state.questions
      .filter((q) => typeof q.answer === 'string' && q.answer !== SKIP)
      .map((q) => ({ question: q.question, answer: q.answer }));
    vscode.postMessage({ type: 'rewrite', prompt: state.prompt, answers });
  }

  function startOver() {
    state = { ...state, phase: 'input', questions: [], result: '', error: '', showHistory: false };
    save();
    render();
  }

  // ------------------------------------------------------------ rendering

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'onclick') node.addEventListener('click', v);
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const child of children) {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function render() {
    const app = document.getElementById('app');
    app.textContent = '';

    app.appendChild(renderHeader());
    if (state.error) {
      app.appendChild(el('div', { class: 'error', text: state.error }));
    }
    if (state.showHistory) {
      app.appendChild(renderHistory());
      return;
    }
    switch (state.phase) {
      case 'input':
        app.appendChild(renderInput());
        break;
      case 'busy-questions':
        app.appendChild(renderPromptSummary());
        app.appendChild(el('p', { class: 'busy', text: 'Analyzing your prompt…' }));
        break;
      case 'questions':
      case 'busy-result':
        app.appendChild(renderPromptSummary());
        app.appendChild(renderQuestions());
        break;
      case 'result':
        app.appendChild(renderResult());
        break;
    }
  }

  function renderHeader() {
    return el(
      'div',
      { class: 'header' },
      el('span', { class: 'title', text: 'AskFirst' }),
      el('button', {
        class: 'icon-btn',
        title: state.showHistory ? 'Back to refine' : 'History',
        text: state.showHistory ? '←' : '⟲',
        onclick: () => {
          state.showHistory = !state.showHistory;
          if (state.showHistory) vscode.postMessage({ type: 'requestHistory' });
          save();
          render();
        },
      }),
    );
  }

  function renderInput() {
    const textarea = el('textarea', {
      id: 'prompt-input',
      rows: '5',
      placeholder: 'Paste your rough prompt…\ne.g. "write a blog post about AI"',
    });
    textarea.value = state.prompt;
    const btn = el('button', { class: 'primary', text: 'Ask me questions', onclick: startQuestions });
    return el('div', {}, el('p', { class: 'label', text: 'Your rough prompt' }), textarea, btn);
  }

  function renderPromptSummary() {
    return el(
      'div',
      {},
      el('p', { class: 'label', text: 'Your rough prompt' }),
      el('div', { class: 'prompt-summary', text: state.prompt, title: 'Click to edit', onclick: startOver }),
    );
  }

  function renderQuestions() {
    const answered = state.questions.filter((q) => q.answer !== undefined).length;
    const wrap = el('div', {});
    wrap.appendChild(
      el('p', { class: 'label', text: `Clarifying questions · ${answered} of ${state.questions.length} answered` }),
    );

    state.questions.forEach((q, i) => {
      const card = el('div', { class: 'card' + (q.open ? ' open' : '') });
      const title = el('p', {
        class: 'q-title' + (q.answer !== undefined ? ' answered' : ''),
        text: (q.answer !== undefined ? '✓ ' : '') + q.question,
        onclick: () => reopen(i),
      });
      card.appendChild(title);

      if (q.open) {
        q.options.forEach((o) => {
          card.appendChild(el('button', { class: 'option', text: o, onclick: () => answer(i, o) }));
        });
        const custom = el('input', { class: 'custom', type: 'text', placeholder: 'Type my own answer…' });
        custom.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && custom.value.trim()) answer(i, custom.value.trim());
        });
        card.appendChild(custom);
        card.appendChild(el('button', { class: 'link', text: 'Skip this question', onclick: () => answer(i, SKIP) }));
      } else if (q.answer !== undefined && q.answer !== SKIP) {
        card.appendChild(el('span', { class: 'pill', text: q.answer, onclick: () => reopen(i) }));
      } else if (q.answer === SKIP) {
        card.appendChild(el('span', { class: 'pill muted', text: 'Skipped', onclick: () => reopen(i) }));
      }
      wrap.appendChild(card);
    });

    if (state.phase === 'busy-result') {
      wrap.appendChild(el('p', { class: 'busy', text: 'Rewriting your prompt…' }));
    } else {
      const ready = answered === state.questions.length;
      wrap.appendChild(
        el('button', {
          class: 'primary',
          text: ready ? 'Refine prompt' : `Refine now (${state.questions.length - answered} unanswered)`,
          onclick: refine,
        }),
      );
    }
    return wrap;
  }

  function renderResult() {
    const pre = el('pre', { class: 'result', text: state.result });
    return el(
      'div',
      {},
      el('p', { class: 'label', text: 'Refined prompt' }),
      pre,
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'primary', text: 'Copy', onclick: () => vscode.postMessage({ type: 'copy', text: state.result }) }),
        el('button', { text: 'Insert at cursor', onclick: () => vscode.postMessage({ type: 'insert', text: state.result }) }),
        el('button', { text: 'Start over', onclick: startOver }),
      ),
    );
  }

  function renderHistory() {
    const wrap = el('div', {});
    wrap.appendChild(el('p', { class: 'label', text: 'Recent refinements' }));
    if (!state.history.length) {
      wrap.appendChild(el('p', { class: 'busy', text: 'Nothing here yet.' }));
      return wrap;
    }
    state.history.forEach((item) => {
      wrap.appendChild(
        el('div', {
          class: 'card history-item',
          text: item.prompt,
          title: 'Load this result',
          onclick: () => {
            state.prompt = item.prompt;
            state.result = item.result;
            state.phase = 'result';
            state.showHistory = false;
            save();
            render();
          },
        }),
      );
    });
    wrap.appendChild(
      el('button', { class: 'link', text: 'Clear history', onclick: () => vscode.postMessage({ type: 'clearHistory' }) }),
    );
    return wrap;
  }

  render();
})();
