/**
 * Wikilinks in prose become links, and nothing else changes.
 *
 * The interesting cases are all the ones a string rewrite gets wrong: a title with a
 * bracket or a star in it, a link inside a link, and `[[…]]` written inside code, where
 * the user meant the characters rather than a link.
 *
 *   node scripts/run-ts.mjs src/shared/wikilinks.test.ts --node
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { toMarkdown } from 'mdast-util-to-markdown'
import type { Root } from 'mdast'
import { remarkWikiLinks, wikiLinkTarget, NODE_LINK_PREFIX } from '../renderer/src/lib/wikilinks'

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    console.log(`  ok    ${label}`)
    return
  }
  failures++
  console.log(`  FAIL  ${label}`)
  console.log(`        expected ${JSON.stringify(expected)}`)
  console.log(`        actual   ${JSON.stringify(actual)}`)
}

/** Every link the plugin produced, as [target, label] pairs. */
function links(markdown: string): [string, string][] {
  const tree = fromMarkdown(markdown) as Root
  remarkWikiLinks()(tree)

  const found: [string, string][] = []
  const walk = (node: { type?: string; url?: string; value?: string; children?: unknown[] }): void => {
    if (node.type === 'link' && typeof node.url === 'string') {
      const target = wikiLinkTarget(node.url)
      if (target !== null) {
        const label = (node.children ?? [])
          .map((child) => (child as { value?: string }).value ?? '')
          .join('')
        found.push([target, label])
      }
    }
    for (const child of node.children ?? []) walk(child as never)
  }
  walk(tree)
  return found
}

/** What the tree renders back to, for asserting nothing else moved. */
function roundTrip(markdown: string): string {
  const tree = fromMarkdown(markdown) as Root
  remarkWikiLinks()(tree)
  return toMarkdown(tree).trim()
}

console.log('wikilinks\n')

check('a plain wikilink becomes a link', links('See [[Graph Physics]] today'), [
  ['Graph Physics', 'Graph Physics']
])
check('two in one line', links('[[One]] and [[Two]]'), [
  ['One', 'One'],
  ['Two', 'Two']
])
check('no wikilink, no links', links('Nothing to see here'), [])
check('an empty target is ignored', links('[[]] and [[ ]]'), [])

// The alias form the vault's own parser accepts.
check('an alias shows the alias', links('[[Real Title|what to show]]'), [
  ['Real Title', 'what to show']
])

// Titles that would break a hand-built `[label](url)` string. None of these need
// escaping here, because the label and the destination are separate fields of a node.
console.log('\ntitles that break string rewriting')
check('a closing paren', links('[[Plan (v2)]]'), [['Plan (v2)', 'Plan (v2)']])
check('an unbalanced paren', links('[[Şey :) notu]]'), [['Şey :) notu', 'Şey :) notu']])
// The one accepted limitation. Markdown parses `*star*` as emphasis before this plugin
// sees the tree, so the brackets end up in different text nodes and no link is made. It
// is the right trade: matching across nodes would mean rewriting the string before
// parsing, which brings back every escaping bug the tree-based approach removes — and a
// note whose title contains literal asterisks is not a real case.
check('emphasis inside a wikilink wins, and no link is made', links('[[*star* note]]'), [])
check('a title with a lone star still links', links('[[5 star note]]'), [
  ['5 star note', '5 star note']
])
check('a backslash', links('[[back\\slash]]'), [['back\\slash', 'back\\slash']])
check('an underscore', links('[[snake_case note]]'), [['snake_case note', 'snake_case note']])

// Turkish, which is the whole reason titles are hard in this app.
check('Turkish characters survive', links('[[Öğrenme Günlüğü]]'), [
  ['Öğrenme Günlüğü', 'Öğrenme Günlüğü']
])
check('and the dotted capital I', links('[[İstanbul notu]]'), [['İstanbul notu', 'İstanbul notu']])

/* ------------------------------------------------------------------ code */

console.log('\ncode is never touched')

// This is the class of bug the plugin exists to avoid: it walks text nodes, and code is
// a different node type, so there is no fence-matching regex to keep in step.
check('a fenced block is left alone', links('```\n[[Not a link]]\n```'), [])
check('a tilde-fenced block too', links('~~~\n[[Not a link]]\n~~~'), [])
check('inline code is left alone', links('use `[[Not a link]]` here'), [])
check(
  'an indented code block is left alone',
  links('text\n\n    [[Not a link]]\n'),
  []
)
check(
  'a real link beside code still works',
  links('`[[code]]` but [[Real]] counts'),
  [['Real', 'Real']]
)

/* ------------------------------------------------------------------ links */

console.log('\nnesting')

// A wikilink inside a markdown link would nest one link in another, which is invalid.
check('inside a link, it is left as text', links('[[[Inner]]](https://example.com)'), [])
check(
  'an ordinary link is untouched',
  roundTrip('[label](https://example.com)'),
  '[label](https://example.com)'
)

/* ------------------------------------------------------------- surroundings */

console.log('\nthe rest of the text')
check(
  'text either side is kept',
  roundTrip('before [[Note]] after').includes('before ') &&
    roundTrip('before [[Note]] after').includes(' after'),
  true
)
check(
  'the destination carries the scheme',
  roundTrip('[[Note]]').includes(NODE_LINK_PREFIX),
  true
)
check(
  'a heading with a wikilink still renders as a heading',
  roundTrip('## [[Note]] here').startsWith('##'),
  true
)
check(
  'a list item is still a list item',
  /^[-*]\s/.test(roundTrip('- [[Note]]')),
  true
)

/* ------------------------------------------------------------- the target */

console.log('\nreading the target back')
check('an ordinary href is not a wikilink', wikiLinkTarget('https://example.com'), null)
check('undefined is not a wikilink', wikiLinkTarget(undefined), null)
check('the prefix alone resolves to nothing', wikiLinkTarget(NODE_LINK_PREFIX), null)
check(
  'an encoded title comes back decoded',
  wikiLinkTarget(`${NODE_LINK_PREFIX}${encodeURIComponent('Öğrenme Günlüğü')}`),
  'Öğrenme Günlüğü'
)
check(
  'a malformed escape yields the raw text rather than throwing',
  wikiLinkTarget(`${NODE_LINK_PREFIX}%E0%A4%A`),
  '%E0%A4%A'
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
