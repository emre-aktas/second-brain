# Design principles

This is the design brief for Second Brain — for whoever works on the app, and for
the agent inside it when it builds a tool.

It is not a component catalogue. It is the set of decisions already made, so that
the next screen does not have to relitigate them, and the arguments that decide the
cases it does not cover.

The live copy lives at `<vault>/.brain/DESIGN.md`. Edit it. The agent reads that
file, not this one, so a change takes effect on the next tool it builds.

---

## What the app is

A dark room with a graph glowing in the middle of it. The knowledge graph is the
home screen, not a feature — everything else is arranged around it and gets out of
its way. The chat is a column at the side. Tools take the graph's place when opened,
because a tool deserves the whole table.

Three consequences:

- **Dark is the primary appearance.** Glowing nodes need a dark field. Light is a
  full peer and must be checked, never an afterthought.
- **Chrome is quiet.** Borders at low contrast, surfaces separated by a shade
  rather than a line where possible, no shadows on things that are not lifted.
- **Content is loud.** A note's text, a tool's result, a card's title: these get
  the contrast and the size. Labels around them do not compete.

## Principles

**Say the true thing.** A spinner that spins after the answer arrived is a lie. An
empty panel that claims to be a tool is a lie. Progress must reflect real progress,
counts must be real counts, and a failure must be visible where it happened.

**One primary action.** Every surface has exactly one obvious next move, styled as
such. If two things look equally primary, neither is.

**The user's data is theirs mid-flight.** They can drag a card while the agent
rewrites the board. Nothing locks, nothing modal-blocks, and the loser of a write
race re-reads rather than clobbering.

**Nothing appears from nowhere.** Elements enter from a state that already had a
shape — `scale(0.95)` and `opacity: 0`, never `scale(0)`.

**Density is earned.** Start roomier than feels necessary and tighten only where the
content is genuinely scannable at that size. Cramped is harder to fix later than
airy, because airy is a spacing change and cramped is a rethink.

**Unseen details compound.** The copy button that sits inside its pane instead of at
the edge of the next column; the label that does not uppercase Turkish; the button
that scales on press. No user will name any of them. They add up to whether the app
feels made or generated.

---

## Tools are not one product

The most important rule in this document, and the easiest to break.

Two tools sitting next to each other should be recognisable as **different things**.
A translator wants a large text area and results you compare at a glance. A task
board wants density and colour by status. A workout log wants big numbers and
thumb-sized targets. A reading queue wants covers and progress. These are not one
layout with different labels in it.

So when you build a tool: decide what *this* tool should feel like before writing a
line of it. Ask what the user is actually doing — reading, comparing, entering,
scanning, deciding — and let that set the proportions, the type sizes, the rhythm,
the colour.

**Match the app, or depart from it — on purpose.**

- **Match** when the tool is part of the user's working surface: something they open
  beside a note, glance at, and close. Use the tokens, use the app's radii and type
  sizes, and let it feel built in.
- **Depart** when the tool has its own subject and deserves its own character: a
  recipe card, a mood log, a reading shelf. Take your own palette, your own type,
  your own proportions. The frame is yours.

What you may never do is reach for the same arrangement twice because it worked
last time. If the last three tools all came out as a header, a form, and a results
pane, the fourth is wrong before you start.

---

## Colour

Values live in `src/renderer/src/styles/globals.css`, in OKLCH so lightness is
perceptually even and dark mode is a lightness change rather than a re-pick. Inside
a tool they arrive as CSS variables on `:root` and as `brain.theme`.

**Use them semantically, never as shades.**

| Token | Means |
| --- | --- |
| `--background` / `--foreground` | the page, and text on it |
| `--card`, `--popover` | a surface lifted off the page |
| `--secondary`, `--muted` | a recessed surface; `--muted-foreground` for secondary text |
| `--primary` | the one action, the active state, the accent |
| `--border`, `--input`, `--ring` | separators, field edges, focus |
| `--success` `--warning` `--destructive` `--info` | outcomes, and nothing else |
| `--chart-1…8` | series and categories, in order |

Rules that are not negotiable:

- **Never hardcode a grey.** `#2a2a33` is correct in dark and invisible in light.
  If you need a shade that does not exist, derive it: `color-mix(in oklab,
  var(--foreground) 8%, transparent)`.
- **Colour is never the only signal.** Status gets a word or an icon as well.
- **`--destructive` is for destruction**, not for emphasis. Red on a save button is
  a bug.
- Body text needs 4.5:1 against its surface, and `--muted-foreground` is the floor
  for anything a user has to read. Decorative strokes may go lower.
- Eight chart hues exist because a ninth series would not be separable. Past eight,
  group the tail into "other".

## Type

`InterVariable` for everything, `JetBrains Mono` for code and identifiers. The app's
working scale, in px because that is how it is written in the code:

| Size | Used for |
| --- | --- |
| 20–24 | a screen's own title, a number the user is meant to read across the room |
| 15 | a tool's own heading, a primary input |
| 13.5 | body — notes, results, card titles |
| 12–12.5 | secondary text, chat side panels |
| 11 | labels, meta, counts |

- **Do not uppercase agent-written or user-written text.** CSS `text-transform:
  uppercase` turns Turkish "istiyorsun" into "ISTIYORSUN" and "Bitti" into "BITTI",
  losing the dotted İ. Uppercase is allowed only on fixed English chrome. Prefer
  `tracking-wide` at small sizes instead — it reads as a label without the damage.
- Line height 1.5–1.6 for prose, 1.2 or below for headings and numbers.
- `font-variant-numeric: tabular-nums` on anything that changes in place.
- `text-wrap: balance` on headings, `pretty` on paragraphs.
- Never centre more than about two lines of text.
- A number the user is scanning for is not 13px. Make it large enough that they do
  not have to look for it.

## Space and shape

- Radius scale is derived from one value: `--radius: 0.75rem`, with `sm` −4px,
  `md` −2px, `lg` =, `xl` +4px. A 4px radius next to a 12px one looks like a mistake.
  Nested corners: the inner radius is smaller than the outer.
- Spacing in multiples of 4, and consistently inside one surface. Two paddings that
  differ by 2px read as misalignment, not as hierarchy.
- Group by proximity before reaching for a border. A gap says "related" more quietly
  and more clearly than a line.
- Optical alignment beats mathematical: an icon next to text usually needs a pixel
  of nudge, and a glyph-heavy button is balanced by eye.
- Let long content scroll inside its own region. The page itself never scrolls
  sideways.

## Motion

Ask three questions before animating anything.

**1. How often will the user see it?**

| Frequency | Decision |
| --- | --- |
| Hundreds of times a day — command palette, shortcuts | no animation, ever |
| Dozens — hover, list navigation | reduce it or remove it |
| Occasional — modals, drawers, toasts, results arriving | animate normally |
| Rare — first run, a celebration | delight is allowed |

**Nothing keyboard-initiated animates.** The command palette deliberately has no
transition. A key press repeated all day must feel instant, and animation is the
only thing that can make it feel slow.

**2. What is it for?** Spatial consistency, state change, feedback, or preventing a
jarring appearance. "It looks nice" is not a purpose for something seen often.

**3. How is it timed?**

- Entering or exiting → `var(--ease-out)`. Moving or morphing → `var(--ease-in-out)`.
  Constant motion → `linear`. **`ease-in` is never used for UI**: delaying the first
  frame is exactly what makes an interface feel sluggish.
- Press feedback 100–160ms. Tooltips 125–200ms. Dropdowns 150–250ms. Drawers and
  modals 200–500ms. **Everything the user triggers stays under 300ms.**
- Animate `transform` and `opacity` only. `height`, `margin` and `padding` trigger
  layout on every frame.
- `active:scale-[0.97]` on anything pressable. It is the cheapest way to make an
  interface feel like it heard you.
- A popover scales from its trigger, not from its centre. A modal is centred and
  scales from its centre.
- Honour `prefers-reduced-motion`: keep the state change, drop the movement.

## Every state, not just the good one

A surface is not finished until all four exist:

- **Empty** — says what this is for and what to do first. Never a blank rectangle,
  never "No data".
- **Loading** — for a tool's own work, show it where the result will appear, not as
  an overlay that hides context. A fast spinner reads as faster than a slow one.
- **Running** — the agent is working: name the step if you know it, and keep the
  interface usable meanwhile.
- **Failed** — the actual message, next to the thing that failed, with a way
  forward. Not a toast that disappears before it is read.

## Accessibility floor

Not a polish pass; these are defects when missing.

- Everything reachable by keyboard, in a sane order, with a visible
  `:focus-visible` ring (`--ring`, 2px, 2px offset).
- Real semantics: `<button>` for actions, `<a>` for navigation, a `<label>` for
  every field. A clickable `<div>` is a bug.
- Hit targets at least 32px in dense chrome, 44px anywhere touch is plausible.
- Every icon-only control gets an `aria-label`.
- Never convey state by colour alone.

## Words

- Sentence case for everything — labels, buttons, headings. Title Case is noise.
- Buttons say what happens: "Save note", not "OK". "Delete permanently", not "Yes".
- Errors say what went wrong and what to do, in the user's terms. No error codes,
  no blame.
- Write in the language the user is writing in. Mixing English chrome with Turkish
  content is fine and normal; mangled Turkish is not.
- No exclamation marks, no "Oops!", no apologising to the user in UI copy.

## Before you call it done

1. Look at it. A screenshot, at the size it will actually be used.
2. Is there exactly one obvious primary action?
3. Does anything wrap badly, crowd its neighbour, or float in empty space?
4. Does it hold up with real content in it, and empty on first open?
5. Does it read in light as well as dark?
6. Can you reach every control with the keyboard?
7. Does it look like the last tool you built? If yes, that is the bug.
