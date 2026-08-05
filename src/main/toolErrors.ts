export interface ToolError {
  message: string
  stack: string | null
  where: string | null
  at: number
}

/**
 * Recent runtime failures from code tools, in memory only.
 *
 * The agent writes the JavaScript inside a code tool, which means it also writes
 * the bugs. Without this it would learn about them as "the panel is empty" — so
 * every throw, rejection and console.error from a tool's frame is kept here and
 * handed back by inspect_tool and preview_tool. Not persisted: a stale error from
 * two versions ago is worse than none.
 */
const MAX_PER_TOOL = 12
const errors = new Map<string, ToolError[]>()

export function recordToolError(toolId: string, error: ToolError): void {
  const list = errors.get(toolId) ?? []

  // The same bug in a render loop would otherwise flood out everything else.
  const last = list[list.length - 1]
  if (last && last.message === error.message && error.at - last.at < 1000) return

  list.push(error)
  if (list.length > MAX_PER_TOOL) list.splice(0, list.length - MAX_PER_TOOL)
  errors.set(toolId, list)
}

export function readToolErrors(toolId: string): ToolError[] {
  return errors.get(toolId) ?? []
}

/** Called when a tool's code is replaced, so old failures are not blamed on new code. */
export function clearToolErrors(toolId: string): void {
  errors.delete(toolId)
}
