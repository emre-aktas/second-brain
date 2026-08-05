import { protocol } from 'electron'
import type { SavedTool } from '@shared/types'
import type { BrainCore } from './core'
import { createLogger } from './logger'

const log = createLogger('tool-protocol')

export const TOOL_SCHEME = 'brain-tool'

/**
 * Serves a code tool's interface on its own scheme.
 *
 * The agent writes HTML, CSS and JavaScript for each tool, and it has to run
 * somewhere that is not this application's document. A `srcdoc` frame inherits
 * the parent's Content-Security-Policy, and ours forbids inline script — so the
 * tool gets its own URL, its own origin, and the policy below instead of the
 * app's. That policy is deliberately narrower than the app's own: no network at
 * all, no remote anything, images and fonts only from inline data.
 *
 * The frame is also sandboxed without `allow-same-origin`, which puts it on an
 * opaque origin: no storage, no cookies, no reach into the app. Everything it can
 * actually do — read the document, save it, run an action — goes through
 * postMessage to the host, which is the whole surface it gets.
 */
const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "media-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

/** Must run before `app.whenReady`. */
export function registerToolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: TOOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        allowServiceWorkers: false,
        stream: false
      }
    }
  ])
}

export function serveToolScheme(core: BrainCore): void {
  protocol.handle(TOOL_SCHEME, (request) =>
    serveResponseFor(request.url, (id) => core.tools.get(id))
  )
}

/** Exported so verification can serve the same document without a whole BrainCore. */
export function serveResponseFor(
  url: string,
  lookup: (id: string) => SavedTool | undefined
): Response {
  // brain-tool://tool/<id> — the id lives in the path because Chromium lowercases
  // hosts and a ULID is uppercase.
  const id = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, '').split('/')[0] ?? '')
  const tool = id ? lookup(id) : undefined

  if (!tool) {
    log.warn(`no tool for ${url}`)
    return new Response(page('<p>This tool no longer exists.</p>', ''), {
      status: 404,
      headers: headers()
    })
  }

  return new Response(page(tool.source, tool.name), { status: 200, headers: headers() })
}

function headers(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': FRAME_CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }
}

/**
 * Wraps the agent's source.
 *
 * Only three things are added: a reset thin enough not to impose a look, the
 * host bridge, and error reporting. Everything visible is the agent's.
 */
function page(source: string, title: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<script>${BRIDGE}</script>
${source}
</body>
</html>`
}

/**
 * The baseline every tool starts from.
 *
 * Two jobs. First, a reset thin enough not to impose a look — the interface is the
 * agent's, not ours. Second, and the reason it is this long: **plain HTML has to
 * already be themed.** A tool must work in the app's light and dark appearance, and
 * the reliable way to get that is for an unstyled `<button>`, `<input>` or `<table>`
 * to come out right without the author thinking about it. Left to hand-styling,
 * every tool is one forgotten colour away from white text on white.
 *
 * Everything here is expressed in the app's tokens, which arrive as CSS variables
 * and change live with the theme, so a tool that adds no CSS at all still follows
 * the app. Fallbacks are dark-mode values, used only in the instant before the host
 * sends the real ones — and the reveal rule below means that instant is never seen.
 */
const BASE_CSS = String.raw`
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }

  /*
   * Nothing paints until the app's real colours have arrived — one frame, in
   * practice, since the host pushes them on load. In light appearance the
   * dark-value fallbacks above would otherwise flash black-on-white for that frame,
   * and the alternative — duplicating the whole palette into the main process so
   * the document could be served pre-themed — puts two copies of it out of sync.
   * The animation is the failsafe: if init never lands, the tool still appears.
   */
  body { opacity: 0; animation: brain-reveal 1ms linear 400ms forwards; }
  html[data-theme] body { opacity: 1; animation: none; }
  @keyframes brain-reveal { to { opacity: 1; } }
  body {
    font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--foreground, #e8e8ef);
    background: transparent;
    -webkit-font-smoothing: antialiased;
    overflow-wrap: break-word;
    user-select: text;
  }

  /* --- type ------------------------------------------------------------- */
  h1, h2, h3, h4 { margin: 0 0 0.4em; line-height: 1.25; letter-spacing: -0.01em; text-wrap: balance; }
  h1 { font-size: 20px; font-weight: 650; }
  h2 { font-size: 15px; font-weight: 600; }
  h3 { font-size: 13.5px; font-weight: 600; }
  p { margin: 0 0 0.7em; text-wrap: pretty; }
  p:last-child { margin-bottom: 0; }
  small, .muted { color: var(--muted-foreground, #8a8a98); font-size: 12px; }
  a { color: var(--primary, #8b8bf0); text-underline-offset: 2px; }
  code, pre, kbd { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; }
  code { background: var(--secondary, #25252f); border-radius: 4px; padding: 0.1em 0.35em; }
  pre { background: var(--secondary, #25252f); border-radius: var(--radius-md, 10px); padding: 10px 12px; overflow: auto; }
  pre code { background: none; padding: 0; }
  hr { border: 0; border-top: 1px solid var(--border, #2f2f3a); margin: 12px 0; }

  /* --- controls, themed without being asked ----------------------------- */
  button, input, select, textarea { font: inherit; color: inherit; }
  input, select, textarea {
    background: var(--secondary, #25252f);
    color: var(--foreground, #e8e8ef);
    border: 1px solid var(--border, #2f2f3a);
    border-radius: var(--radius-md, 10px);
    padding: 8px 10px;
    transition: border-color 150ms var(--ease-out, ease-out), box-shadow 150ms var(--ease-out, ease-out);
  }
  input:hover, select:hover, textarea:hover { border-color: var(--ring, #7c6cf5); }
  input::placeholder, textarea::placeholder { color: var(--muted-foreground, #8a8a98); }
  textarea { resize: vertical; }

  button {
    cursor: pointer;
    background: var(--secondary, #25252f);
    color: var(--foreground, #e8e8ef);
    border: 1px solid var(--border, #2f2f3a);
    border-radius: var(--radius-md, 10px);
    padding: 7px 13px;
    font-weight: 500;
    transition: background-color 150ms var(--ease-out, ease-out), transform 140ms var(--ease-out, ease-out);
  }
  button:hover:not(:disabled) { background: var(--accent, #2b2b3a); }
  /* Pressables scale on press: it is the cheapest way to feel responsive. */
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; cursor: default; }

  /* One class, because "the primary action" is the most common thing to want and
     re-deriving it per tool is how tools end up with three of them. */
  button.primary {
    background: var(--primary, #8b8bf0);
    color: var(--primary-foreground, #16161f);
    border-color: transparent;
  }
  button.primary:hover:not(:disabled) { filter: brightness(1.07); }
  button.ghost { background: transparent; border-color: transparent; color: var(--muted-foreground, #8a8a98); }
  button.ghost:hover:not(:disabled) { color: var(--foreground, #e8e8ef); background: var(--accent, #2b2b3a); }

  /* --- surfaces --------------------------------------------------------- */
  .card, fieldset {
    background: var(--card, #1f1f29);
    border: 1px solid var(--border, #2f2f3a);
    border-radius: var(--radius-lg, 12px);
    padding: 12px 14px;
  }
  .row { display: flex; align-items: center; gap: 8px; }
  .col { display: flex; flex-direction: column; gap: 8px; }
  .grow { flex: 1; min-width: 0; min-height: 0; }
  .scroll { overflow: auto; }

  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border, #2f2f3a); }
  th { font-size: 11px; font-weight: 600; color: var(--muted-foreground, #8a8a98); letter-spacing: 0.02em; }
  tr:last-child td { border-bottom: 0; }

  ul, ol { margin: 0 0 0.7em; padding-left: 1.3em; }
  li { margin: 0.15em 0; }

  /* --- states ----------------------------------------------------------- */
  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    border: 1px solid var(--border, #2f2f3a); border-radius: 999px;
    padding: 1px 8px; font-size: 11.5px; font-weight: 500;
  }
  .ok      { color: var(--success, #6ee7b7); }
  .warn    { color: var(--warning, #fbbf7d); }
  .danger  { color: var(--destructive, #f87171); }
  .empty {
    color: var(--muted-foreground, #8a8a98);
    text-align: center;
    padding: 24px 12px;
    text-wrap: pretty;
  }

  ::selection { background: color-mix(in oklab, var(--primary, #8b8bf0) 30%, transparent); }
  :focus-visible { outline: 2px solid var(--ring, #7c6cf5); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
`

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char
  )
}

/**
 * The host bridge, injected before the agent's code.
 *
 * Written as a plain string rather than a bundled module so it stays readable as
 * the contract the agent is told about: `brain.state`, `brain.setState`,
 * `brain.patch`, `brain.run`, `brain.onState`, `brain.onRun`, `brain.ready`.
 */
const BRIDGE = String.raw`
(function () {
  var pending = {};
  var seq = 0;
  var stateListeners = [];
  var runListeners = [];
  var runHandlers = {};
  var readySent = false;

  /**
   * Which document generation this frame is.
   *
   * Request ids restart at r1 in every frame, so without this a reply meant for the
   * previous document could resolve this one's first request — a save would report
   * as done when nothing had been written. The host stamps every message with the
   * generation it belongs to; the first one we see is ours, and anything else is
   * addressed to a document that no longer exists.
   */
  var gen = null;

  function post(message) {
    parent.postMessage(message, '*');
  }

  function call(kind, payload) {
    var id = 'r' + ++seq;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      post({ brain: kind, id: id, payload: payload });
    });
  }

  var brain = {
    /** The tool's document. Replaced whenever it changes; never mutate in place. */
    state: {},
    tool: { id: '', name: '', description: '' },
    /** The app's design tokens, also set as CSS variables on :root. */
    theme: {},
    dark: true,
    /** The id of the action currently running, or null. */
    running: null,
    /** Milliseconds since the running action started. 0 when nothing is running. */
    elapsedMs: 0,

    /** Persist the whole document. Resolves with what was stored. */
    setState: function (next) {
      brain.state = next;
      return call('setState', { state: next });
    },

    /** Shallow-merge convenience over setState. */
    patch: function (partial) {
      var next = Object.assign({}, brain.state, partial);
      return brain.setState(next);
    },

    /**
     * Run one of the tool's actions. Resolves with the agent's reply as text.
     * Anything in inputs is available to the action's prompt as {{name}}.
     *
     * The third argument is where progress goes. onText fires as the reply is
     * written, onStep when the agent starts a lookup: without them a press is
     * followed by silence for as long as the model takes, and silence is
     * indistinguishable from broken.
     */
    run: function (actionId, inputs, handlers) {
      if (handlers) {
        runHandlers[actionId] = handlers;
      }
      return call('run', { actionId: actionId, inputs: inputs || {} }).then(
        function (text) {
          delete runHandlers[actionId];
          return text;
        },
        function (err) {
          delete runHandlers[actionId];
          throw err;
        }
      );
    },

    /** Stop whatever is running. Rejects that run's promise. */
    cancel: function () {
      return call('cancel', {});
    },

    /**
     * Answer a question the agent asked mid-run.
     *
     * The run does not finish until it is answered, so a tool that wants the prompt
     * inline can take it from onRun's 'ask' status — or from run()'s onAsk handler —
     * and call this. Ignoring it is fine: the app draws the question above the tool
     * either way, so the run can always be unblocked.
     */
    answer: function (questionId, text) {
      return call('answer', { id: String(questionId), answer: String(text == null ? '' : text) });
    },

    /**
     * Put text on the clipboard.
     *
     * Through the host because navigator.clipboard is unavailable here: the frame is
     * sandboxed onto an opaque origin, which the Clipboard API refuses. A copy
     * button is the single most common thing a tool wants, so it cannot be left to
     * an API that silently rejects.
     */
    copy: function (text) {
      return call('copy', { text: String(text == null ? '' : text) });
    },

    /** Called with the new document whenever it changes, including your own saves. */
    onState: function (fn) {
      stateListeners.push(fn);
      return function () {
        stateListeners = stateListeners.filter(function (l) { return l !== fn; });
      };
    },

    /**
     * Progress for a running action: { actionId, status: 'start'|'step'|'done'|'error',
     * step?, text?, message? }. Use it to show your own spinner.
     */
    onRun: function (fn) {
      runListeners.push(fn);
      return function () {
        runListeners = runListeners.filter(function (l) { return l !== fn; });
      };
    },

    /** Say the interface has drawn. Called for you on first paint if you do not. */
    ready: function () {
      if (readySent) return;
      readySent = true;
      post({ brain: 'ready' });
    }
  };

  window.brain = brain;

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object' || !data.host) return;

    if (typeof data.gen === 'number') {
      if (gen === null) gen = data.gen;
      else if (data.gen !== gen) return;
    }

    if (data.host === 'init' || data.host === 'state') {
      brain.state = data.state || {};
      if (data.tool) brain.tool = data.tool;
      if (data.theme) {
        // The app's own tokens, so a tool can look native by using them — or
        // ignore them entirely and set its own colours.
        var root = document.documentElement;
        Object.keys(data.theme).forEach(function (name) {
          root.style.setProperty(name, data.theme[name]);
        });
        brain.theme = data.theme;
        brain.dark = !!data.dark;
      }
      // Outside the theme branch: this attribute is also what reveals the page, so
      // a host that sent no tokens must not leave the tool invisible. It is the
      // hook for a tool's own light/dark rules — html[data-theme="light"] — and
      // reading it is how CSS can branch without touching JavaScript.
      document.documentElement.setAttribute('data-theme', data.dark ? 'dark' : 'light');
      stateListeners.forEach(function (fn) {
        try { fn(brain.state); } catch (err) { report(err); }
      });
      if (data.host === 'init') {
        window.dispatchEvent(new Event('brain:init'));
      }
      return;
    }

    if (data.host === 'run') {
      brain.running = data.status === 'done' || data.status === 'error' ? null : data.actionId;
      brain.elapsedMs = data.elapsedMs || 0;

      // Per-call handlers first, because that is the ergonomic path: the code that
      // pressed the button is the code that wants to show the answer arriving.
      var handlers = runHandlers[data.actionId];
      if (handlers) {
        try {
          if (data.status === 'delta' && handlers.onText) handlers.onText(data.text || '');
          if (data.status === 'step' && handlers.onStep) handlers.onStep(data.step || '');
          if (data.status === 'ask' && handlers.onAsk) handlers.onAsk(data.question);
        } catch (err) { report(err); }
      }

      runListeners.forEach(function (fn) {
        try { fn(data); } catch (err) { report(err); }
      });
      return;
    }

    if (data.host === 'reply') {
      var entry = pending[data.id];
      if (!entry) return;
      delete pending[data.id];
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data.result);
    }
  });

  function report(error, where) {
    post({
      brain: 'error',
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? String(error.stack).slice(0, 2000) : null,
      where: where || null
    });
  }

  window.addEventListener('error', function (event) {
    report(event.error || new Error(event.message), event.lineno ? 'line ' + event.lineno : null);
  });

  window.addEventListener('unhandledrejection', function (event) {
    report(event.reason || new Error('unhandled rejection'), 'promise');
  });

  var nativeError = console.error;
  console.error = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      parts.push(value instanceof Error ? value.message : safeString(value));
    }
    post({ brain: 'error', message: parts.join(' '), stack: null, where: 'console' });
    nativeError.apply(console, arguments);
  };

  function safeString(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (err) { return String(value); }
  }

  // A task after load rather than an animation frame: a frame rendered offscreen
  // for a screenshot is not painting, so requestAnimationFrame there never fires
  // and the tool would look like it never finished loading.
  window.addEventListener('load', function () {
    setTimeout(function () { brain.ready(); }, 0);
  });
})();
`
