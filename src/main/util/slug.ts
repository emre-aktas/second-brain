/**
 * Filenames mirror note titles so the vault stays readable in Obsidian and in
 * Explorer, and so `[[Wikilinks]]` resolve by filename the way users expect.
 * Only characters Windows actually forbids are replaced — spaces are kept.
 */

// Built with the RegExp constructor so every escape stays plain ASCII in source:
// < > : " / \ | ? * plus control characters, and the combining-mark block.
const WINDOWS_ILLEGAL = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001F]', 'g')
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036F]', 'g')
const TURKISH_CHARS = new RegExp('[\\u00E7\\u00C7\\u011F\\u011E\\u0131\\u0130\\u00F6\\u00D6\\u015F\\u015E\\u00FC\\u00DC]', 'g')

const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
])

/** Turn a title into a safe filename stem, preserving readable Unicode. */
export function titleToFilename(title: string): string {
  let name = title
    .replace(WINDOWS_ILLEGAL, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently strips trailing dots and spaces; do it explicitly so the
    // path we record matches the path that actually lands on disk.
    .replace(/[. ]+$/, '')

  if (!name) name = 'Untitled'
  if (RESERVED.has(name.toUpperCase())) name = `${name}-note`

  // Leave room for a collision suffix and the .md extension.
  if (name.length > 120) name = name.slice(0, 120).trimEnd()
  return name
}

// NFD decomposition mishandles Turkish dotted/dotless i and does not decompose
// g-breve or s-cedilla at all, so those are transliterated before normalising.
const TURKISH_MAP: Record<string, string> = {
  'ç': 'c', 'Ç': 'c', // c cedilla
  'ğ': 'g', 'Ğ': 'g', // g breve
  'ı': 'i', 'İ': 'i', // dotless i, dotted I
  'ö': 'o', 'Ö': 'o', // o umlaut
  'ş': 's', 'Ş': 's', // s cedilla
  'ü': 'u', 'Ü': 'u' // u umlaut
}

function deturkish(input: string): string {
  return input.replace(TURKISH_CHARS, (ch) => TURKISH_MAP[ch] ?? ch)
}

/** ASCII slug used for anchors and comparison keys. */
export function slugify(input: string): string {
  return deturkish(input)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** Comparison key for matching wikilink targets against note titles. */
export function titleKey(input: string): string {
  return deturkish(input)
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}
