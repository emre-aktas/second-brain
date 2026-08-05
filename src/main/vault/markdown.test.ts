import {
  parseNote,
  serializeNote,
  extractWikiLinks,
  extractInlineTags,
  deriveSummary
} from './markdown'

let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n     got      ${a}\n     expected ${e}`}`)
}

console.log('--- wikilinks ---')
check('simple', extractWikiLinks('See [[Graph Physics]] today'), [{ target: 'Graph Physics' }])
check(
  'alias + heading',
  extractWikiLinks('[[Note A#Section|the bit]]'),
  [{ target: 'Note A', heading: 'Section', alias: 'the bit' }]
)
check('dedupes', extractWikiLinks('[[A]] and [[A]]'), [{ target: 'A' }])
check('turkish target', extractWikiLinks('[[Öğrenme Günlüğü]]'), [{ target: 'Öğrenme Günlüğü' }])
check('ignores fenced code', extractWikiLinks('```\n[[Not A Link]]\n```\n[[Real]]'), [
  { target: 'Real' }
])
check('ignores inline code', extractWikiLinks('`[[Nope]]` but [[Yes]]'), [{ target: 'Yes' }])

console.log('--- inline tags ---')
check('basic', extractInlineTags('about #graph and #ui-design'), ['graph', 'ui-design'])
check('nested', extractInlineTags('#work/clients note'), ['work/clients'])
check('not a heading', extractInlineTags('# Heading\n#realtag'), ['realtag'])
check('not a url fragment', extractInlineTags('see http://x.com/a#frag here'), [])
check('not a bare number', extractInlineTags('issue #123 and #bug'), ['bug'])
check('turkish tag', extractInlineTags('#öğrenme notu'), ['öğrenme'])
check('ignores code', extractInlineTags('```\n#nope\n```\n#yep'), ['yep'])

console.log('--- parseNote ---')
const withFm = parseNote(
  `---
title: Knowledge Graph
kind: source
tags: [graph, physics]
created: 2026-01-15T10:00:00Z
summary: A short summary
---

Body text linking [[Ideas]] and tagging #extra.
`,
  'fallback'
)
check('title', withFm.title, 'Knowledge Graph')
check('kind', withFm.kind, 'source')
check('tags merge fm + inline', withFm.tags, ['graph', 'physics', 'extra'])
check('links', withFm.links, [{ target: 'Ideas' }])
check('summary', withFm.summary, 'A short summary')
check('created parsed', withFm.created, Date.parse('2026-01-15T10:00:00Z'))
check('body excludes frontmatter', withFm.body.includes('title:'), false)

const noFm = parseNote('# Derived Title\n\nSome prose here.\n', 'file-name')
check('title from heading', noFm.title, 'Derived Title')
check('kind defaults', noFm.kind, 'note')

const noTitle = parseNote('Just prose, no heading.\n', 'My File Name')
check('title from filename', noTitle.title, 'My File Name')

const badKind = parseNote('---\nkind: bogus\n---\nx\n', 'f')
check('unknown kind falls back', badKind.kind, 'note')

const badYaml = parseNote('---\ntitle: [unclosed\n---\n\nStill readable body.\n', 'f')
check('malformed yaml still yields body', badYaml.body.includes('Still readable body'), true)

const commaTags = parseNote('---\ntags: graph, ui\n---\nx\n', 'f')
check('comma tag string', commaTags.tags, ['graph', 'ui'])

const hashTags = parseNote('---\ntags: ["#graph"]\n---\nx\n', 'f')
check('strips leading hash in fm tags', hashTags.tags, ['graph'])

console.log('--- deriveSummary ---')
check('skips heading', deriveSummary('# Title\n\nThe real first line.\n'), 'The real first line.')
check('unwraps wikilink alias', deriveSummary('See [[Target|the alias]] now.'), 'See the alias now.')
check('unwraps bare wikilink', deriveSummary('See [[Target]] now.'), 'See Target now.')

console.log('--- serializeNote round trip ---')
const serialized = serializeNote({
  title: 'Round Trip',
  body: 'Body with [[Link]] and #tag.',
  kind: 'project',
  tags: ['a', 'b'],
  created: Date.parse('2026-02-01T00:00:00Z'),
  updated: Date.parse('2026-02-02T00:00:00Z'),
  extra: { author: 'emre', title: 'should be ignored' }
})
console.log('--- serialized ---')
console.log(serialized)

const reparsed = parseNote(serialized, 'f')
check('rt title', reparsed.title, 'Round Trip')
check('rt kind', reparsed.kind, 'project')
check('rt tags include fm + inline', reparsed.tags.sort(), ['a', 'b', 'tag'])
check('rt links', reparsed.links, [{ target: 'Link' }])
check('rt created', reparsed.created, Date.parse('2026-02-01T00:00:00Z'))
check('rt extra preserved', reparsed.frontmatter['author'], 'emre')
check('rt managed key not overridden by extra', reparsed.title, 'Round Trip')

const turkish = serializeNote({ title: 'Öğrenme Günlüğü', body: 'çalışma ışık', tags: ['öğrenme'] })
const turkishBack = parseNote(turkish, 'f')
check('turkish title round trip', turkishBack.title, 'Öğrenme Günlüğü')
check('turkish body round trip', turkishBack.body.includes('çalışma ışık'), true)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
