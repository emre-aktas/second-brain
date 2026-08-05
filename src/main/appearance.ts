import { nativeTheme } from 'electron'

/**
 * Whether the app is currently dark, and the colours a window should open with.
 *
 * One place, because it was read from `nativeTheme.shouldUseDarkColors` in four —
 * which is the *operating system's* preference, not the app's. With the app set to
 * light on a dark-mode machine, every tool window and every preview screenshot came
 * out dark: the agent would then look at a picture of a tool in a theme the user is
 * not using, and judge it against that.
 *
 * The window chrome colours have to be concrete rather than tokens: they are handed
 * to the OS before any stylesheet exists. They match `--background` closely enough
 * that the frame does not flash a different colour on open.
 */
export interface Appearance {
  dark: boolean
  background: string
  symbol: string
}

type ThemeSetting = 'dark' | 'light' | 'system'

let readSetting: () => ThemeSetting = () => 'system'

/** Called once at bootstrap, so every window can ask without reaching for settings. */
export function useAppearanceFrom(read: () => ThemeSetting): void {
  readSetting = read
}

export function appearance(): Appearance {
  const setting = readSetting()
  const dark = setting === 'system' ? nativeTheme.shouldUseDarkColors : setting === 'dark'

  return {
    dark,
    background: dark ? '#191a24' : '#f7f7fa',
    symbol: dark ? '#c8c8d4' : '#3a3a44'
  }
}
