# The tool runtime

Everything a tool can do, in one place. This is the reference for `kind: "code"`
tools — HTML, CSS and JavaScript you write, running in a sandboxed frame inside the
app, with `window.brain` as the only connection to it.

If you are about to build a tool, read this first and `design_principles` second.
This tells you what is possible; that tells you what it should look like.

---

## The shape of a tool

A tool is three things:

| | |
| --- | --- |
| `source` | The interface. HTML with your own `<style>` and `<script>`. No `<html>`, `<head>` or `<body>` — your source *is* the body. |
| `state` | The document. Any JSON shape you like. Persisted, shared with the user and with you, survives closing the app. |
| `actions` | Buttons that run you. Each is one job with one prompt. The interface decides when to call them. |

Nothing else is stored. There is no server, no build step, no framework — a tool is
one HTML document and a JSON object.

## `window.brain`

Available before your code runs. No import, no waiting.

### The document

```js
brain.state                     // the current document. Never mutate it in place.
await brain.setState(next)      // replace it wholesale. Resolves with what was stored.
await brain.patch({ a: 1 })     // shallow merge over the current document.
brain.onState(fn)               // fn(state) whenever it changes — your saves, and mine.
```

`onState` fires for **your own** saves too, so a single `draw(state)` function can be
the only thing that touches the DOM. That is the pattern to reach for: change state,
let the listener redraw. It also means the tool updates itself when the agent
rewrites the document from a chat message or an action with `target: "state"`.

Writes are revision-checked. If the user typed while you were writing, your write is
replayed on top of theirs rather than clobbering it — you do not need to handle that.

### Running an action

```js
const reply = await brain.run('translate', { text: 'merhaba' })
```

Resolves with the agent's reply as text. Values in the second argument fill `{{name}}`
placeholders in that action's prompt, and anything in `brain.state` is available to
the prompt by dot path (`{{opts.tone}}`).

**Always show progress.** A model can take twenty seconds. A button that goes quiet
for twenty seconds is indistinguishable from a broken one — this is the single most
common way a tool feels bad:

```js
const reply = await brain.run('translate', { text }, {
  onText: (soFar) => { out.textContent = soFar },      // the reply, as it is written
  onStep: (step) => { hint.textContent = step + '…' }  // "Searching your notes"
})
```

Or subscribe globally, which is better when several parts of the interface react:

```js
brain.onRun((e) => {
  // e.actionId, e.status, e.step, e.text, e.elapsedMs, e.message, e.question
  switch (e.status) {
    case 'start': setBusy(true); break
    case 'step':  hint.textContent = e.step + '…'; break
    case 'delta': out.textContent = e.text; break     // cumulative, not a chunk
    case 'ask':   showQuestion(e.question); break     // I need an answer to continue
    case 'done':  setBusy(false); break
    case 'error': setBusy(false); showError(e.message); break
  }
})
```

`brain.running` is the id of the running action or `null`. `brain.elapsedMs` is how
long it has been going. Past about eight seconds, say so — "still working, 12s" is
reassuring in a way a spinner is not.

```js
await brain.cancel()   // stop it. The run's promise rejects.
```

Give the user a way out whenever a run can take real time. The app's own header has
a stop button, but a tool that shows its own is better: it is where they are looking.

**Serial, but queued.** Turns run one at a time — two writing the same document would
race — but a second `brain.run` while one is in flight does *not* fail. It waits its
turn and resolves normally, so `Promise.all([brain.run('a'), brain.run('b')])` is fine
and so is a user pressing twice. Up to eight wait; past that the call rejects.

Still disable your buttons while `brain.running` is set, or reflect the queue somehow.
A press that appears to do nothing for thirty seconds is the problem whether or not it
eventually works. The base stylesheet already dims `disabled` buttons.

### When I need an answer

Some actions cannot finish without asking. The run stays open and you get an `ask`:

```js
brain.onRun((e) => {
  if (e.status !== 'ask') return
  // e.question = { id, question, options: string[], allowFreeText: boolean }
  const pick = document.createElement('button')
  pick.textContent = e.question.options[0]
  pick.onclick = () => brain.answer(e.question.id, e.question.options[0])
  panel.append(pick)
})
```

Handling it is optional — the app draws the question above your interface either way,
so a run can always be unblocked. Draw it yourself when the question belongs inside
the tool rather than above it.

### The clipboard

```js
await brain.copy(out.textContent)   // resolves when it is on the clipboard
```

Use this, not `navigator.clipboard`. The frame is sandboxed onto an opaque origin,
which the Clipboard API refuses outright — the app copies on your behalf. A copy
button is worth adding to anything that produces text the user will paste elsewhere.

### Theme

```js
brain.theme     // { '--primary': 'oklch(...)', ... } the app's tokens
brain.dark      // true when the app is in dark mode
```

The tokens are also set as CSS variables on `:root`, and `data-theme` is `dark` or
`light` on the root element. **They change live** — if the user switches theme while
your tool is open, the variables update underneath you. So:

- Use `var(--foreground)`, `var(--primary)`, `var(--border)` and friends. Never a
  hardcoded colour: `#1e1e28` is right in dark and invisible in light.
- If you need a shade that does not exist, derive it:
  `color-mix(in oklab, var(--foreground) 8%, transparent)`.
- Only read `brain.dark` for things CSS cannot express — picking an image, say.
  Anything you can do with a variable, do with a variable.

Plain HTML is already themed (see the stylesheet below), so the cheapest way to be
correct in both appearances is to write less CSS.

### About itself

```js
brain.tool      // { id, name, description }
brain.ready()   // "I have drawn." Called for you on load; call it earlier if you paint sooner.
```

### Errors

Anything your code throws — including unhandled rejections and `console.error` — is
captured and handed back to me by `preview_tool` and `inspect_tool`. You do not need
to report failures yourself. You *do* need to show them to the user; a caught error
that goes nowhere is worse than one that crashes.

---

## What you get for free

The frame is styled before your CSS runs, so an unstyled tool is already themed and
already looks like the app. Only override what you actually want different.

**Elements.** `h1`–`h4`, `p`, `small`, `a`, `code`, `pre`, `hr`, `ul`/`ol`, `table`
(with `th`/`td` borders), `input`, `select`, `textarea`, `button`, `fieldset`.

**Classes.**

| | |
| --- | --- |
| `.primary` | the one important button. One per surface. |
| `.ghost` | a quiet button — a stop, a dismiss. |
| `.card` | a bordered, filled surface. |
| `.row` `.col` | flex row / column with an 8px gap. |
| `.grow` | fill the remaining space (`flex: 1` plus the min-size fixes). |
| `.scroll` | `overflow: auto`. |
| `.badge` | a small pill. |
| `.muted` | secondary text. |
| `.ok` `.warn` `.danger` | outcome colours. |
| `.empty` | centred, muted, padded — for an empty state. |

**Behaviour.** Buttons scale slightly on press. Focus rings are drawn. Reduced-motion
is honoured. Text is selectable. The body is transparent over the app's background
and fills the panel — give your root `height: 100%` if you want to own the area.

---

## Limits

These are not negotiable, and two of them are why tools are safe to run at all.

- **No network.** No `fetch`, no `XMLHttpRequest`, no WebSocket, no remote script,
  stylesheet, font or image. Inline your CSS and JS, use inline SVG for icons and
  `data:` URIs for images. Anything that needs the outside world goes through an
  action — when *I* run, I have the whole brain and every connector.
- **No storage.** No `localStorage`, no cookies, no IndexedDB. `brain.state` is where
  things live, and it is better: it persists properly and the agent can see it.
- **No reaching out.** The frame cannot touch the app's DOM, other tools, or the
  filesystem.
- **Actions are the only way to reach me.** There is no way to call the model
  directly from tool code.

## Available in the frame

Ordinary browser APIs that need nothing external: the DOM, `canvas`, SVG, Web
Animations, `navigator.clipboard.writeText`, `crypto.randomUUID`, `Intl`,
`requestAnimationFrame`, CSS custom properties, `color-mix`, container queries,
`ResizeObserver`, drag and drop.

---

## Patterns

### Read the document, draw, repeat

The only structure most tools need:

```html
<div id="app"></div>
<script>
  const app = document.getElementById('app')

  function draw(state) {
    app.innerHTML = ''
    // build from state...
  }

  brain.onState(draw)
  window.addEventListener('brain:init', () => draw(brain.state))
</script>
```

`brain:init` fires once, when the document has arrived. Draw from there rather than
at the top level, or your first paint has no data.

### Persist what the user types

```js
input.addEventListener('input', () => brain.patch({ draft: input.value }))
```

Cheap, and it means closing the tool never loses a half-written thought. Do not
redraw on your own `onState` for the field you are typing in — guard it, or the
cursor jumps:

```js
brain.onState((s) => { if (document.activeElement !== input) input.value = s.draft || '' })
```

### Several results from one press

Fire the actions together and let each pane fill as it lands:

```js
const [casual, formal] = await Promise.all([
  brain.run('casual', { text }, { onText: (t) => (paneA.textContent = t) }),
  brain.run('formal', { text }, { onText: (t) => (paneB.textContent = t) })
])
```

They queue, so the second starts when the first finishes; both panes still fill
progressively.

### A board the agent can rewrite

Give the action `target: "state"` and it rewrites the document instead of replying
with text. Your `onState` listener redraws. That is how "pull today's tasks in from
Slack" works — you write no syncing code at all.

### Every state, not just the good one

A surface is not finished until all four exist. Empty (`.empty`, saying what to do
first), running (progress, elapsed, a way out), failed (the actual message, next to
the thing that failed), and full (holding real content without falling apart).

---

## Actions

Declared alongside the source, not in it.

| field | |
| --- | --- |
| `id` | what `brain.run` calls. |
| `label` | two or three words, for a button you draw yourself. |
| `prompt` | what I am asked. `{{name}}` from `brain.run` inputs, `{{a.b}}` from the document. |
| `target` | `"output"` — the reply comes back as text *and* is stored (see below). `"state"` — I rewrite the whole document instead. |
| `writeTo` | with `target: "output"`, the dot path in the document the reply is stored at. Defaults to `output`. |
| `hint` | optional, one line, for a tooltip. |

`target: "output"` does two things, and the second one surprises people: as well as
resolving your `brain.run`, the reply is written into the document at `writeTo` (or
`output` if you left it out), and `lastAction` is set to the action's label. So do not
keep your own unrelated value at that path — it will be overwritten. Either read the
result from the document and let the write be the mechanism, or point `writeTo` at a
path you have set aside for it.

Write prompts that produce the finished thing, not a conversation about it: "Rewrite
as natural casual English. One version, text only." A prompt that invites preamble
puts preamble in your interface.

## Building one

1. `design_principles` — what it should look like.
2. `create_interactive_tool` with `kind: "code"`.
3. `preview_tool` — a real screenshot, plus anything your code threw. Pass
   `sampleState` so you see it full rather than empty.
4. Read the errors. Look at the picture properly.
5. `update_tool_definition` with a whole new `source`. The document survives.
6. Preview again. Two or three rounds is normal.

Do not tell the user a tool is ready before you have looked at a picture of it.
