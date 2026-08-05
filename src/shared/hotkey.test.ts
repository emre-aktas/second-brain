import { formatHotkey, normaliseHotkey } from './hotkey'

let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` → got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`
  )
}

const accel = (input: string): string | undefined => normaliseHotkey(input).accelerator

console.log('--- forms the agent or user will actually write ---')
check('canonical', accel('CommandOrControl+Shift+T'), 'CommandOrControl+Shift+T')
check('lower case with spaces', accel('ctrl + shift + t'), 'CommandOrControl+Shift+T')
check('cmd alias', accel('Cmd+Alt+K'), 'CommandOrControl+Alt+K')
check('control spelled out', accel('Control+Shift+Space'), 'CommandOrControl+Shift+Space')
check('option alias', accel('Option+Shift+P'), 'Alt+Shift+P')
check('modifier order normalised', accel('Shift+Ctrl+Alt+J'), 'CommandOrControl+Alt+Shift+J')
check('digit key', accel('ctrl+shift+1'), 'CommandOrControl+Shift+1')
check('function key', accel('Alt+F9'), 'Alt+F9')
check('named key case-insensitive', accel('ctrl+alt+escape'), 'CommandOrControl+Alt+Escape')

console.log('\n--- two spellings must collide, so conflicts are caught ---')
check('same combination', accel('ctrl+shift+t') === accel('Shift+CommandOrControl+T'), true)

console.log('\n--- rejected ---')
check('no modifier', normaliseHotkey('T').ok, false)
check('modifiers only', normaliseHotkey('Ctrl+Shift').ok, false)
check('two real keys', normaliseHotkey('Ctrl+A+B').ok, false)
check('unknown key', normaliseHotkey('Ctrl+Frobnicate').ok, false)
check('empty', normaliseHotkey('   ').ok, false)
check('rejections explain themselves', (normaliseHotkey('T').error ?? '').length > 0, true)

console.log('\n--- display ---')
check('windows', formatHotkey('CommandOrControl+Shift+T', 'win32'), 'Ctrl + Shift + T')
check('mac', formatHotkey('CommandOrControl+Shift+T', 'darwin'), '⌘ + Shift + T')
check('super', formatHotkey('Super+K', 'win32'), 'Win + K')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
