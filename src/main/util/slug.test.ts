import { titleToFilename, slugify, titleKey } from './slug'

let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

console.log('--- titleToFilename: spaces must survive ---')
check('plain', titleToFilename('Knowledge Graph Physics'), 'Knowledge Graph Physics')
check('turkish kept', titleToFilename('Öğrenme Günlüğü'), 'Öğrenme Günlüğü')
check('illegal chars', titleToFilename('Q3: revenue/costs <draft>'), 'Q3- revenue-costs -draft-')
check('trailing dot', titleToFilename('Note...'), 'Note')
check('empty', titleToFilename('   '), 'Untitled')
check('reserved', titleToFilename('CON'), 'CON-note')

console.log('--- slugify ---')
check('turkish slug', slugify('Öğrenme Günlüğü'), 'ogrenme-gunlugu')
check('dotless i', slugify('Işık Hızı'), 'isik-hizi')
check('dotted I', slugify('İstanbul'), 'istanbul')
check('accents', slugify('Café Naïve'), 'cafe-naive')
check('symbols', slugify('C++ & Rust!'), 'c-rust')

console.log('--- titleKey ---')
check('case+space fold', titleKey('  Knowledge   Graph  '), 'knowledge graph')
check('turkish fold', titleKey('ÖĞRENME'), 'ogrenme')
check('matches variant', titleKey('Işık') === titleKey('isik'), true)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
