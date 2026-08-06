import { StrictMode } from 'react'
import { captureRendererErrors } from '@/lib/errors'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import { App } from './App'
import { ToolWindow } from './ToolWindow'
import { LogWindow } from './LogWindow'

// One bundle, three entry points: the main shell, an interactive tool
// (#/tool/<toolId>), or a read-only generated view (#/spec/<specId>).
const toolMatch = window.location.hash.match(/^#\/tool\/([^?]+)(\?.*)?$/)
const specMatch = window.location.hash.match(/^#\/spec\/(.+)$/)
const logsMatch = /^#\/logs/.test(window.location.hash)
// A window opened by a global shortcut wants the cursor in the input already.
const focusInput = /[?&]focus=1/.test(window.location.hash)
// Rendered offscreen so the agent can look at what it built.
const previewMode = /[?&]preview=1/.test(window.location.hash)
if (/[?&]light=1/.test(window.location.hash)) {
  document.documentElement.classList.remove('dark')
}

// Before the first render, so a failure during mount is recorded rather than lost.
captureRendererErrors()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {logsMatch ? (
      <LogWindow />
    ) : toolMatch ? (
      <ToolWindow
        toolId={decodeURIComponent(toolMatch[1])}
        focusInput={focusInput}
        preview={previewMode}
      />
    ) : specMatch ? (
      <ToolWindow specId={decodeURIComponent(specMatch[1])} />
    ) : (
      <App />
    )}
  </StrictMode>
)
