/**
 * Human-readable names for tool calls.
 *
 * The agent's internal step names are not something the user should have to read.
 * These are phrased as things a person did, so the single progress line reads as
 * activity rather than as an API log.
 */
const BRAIN_LABELS: Record<string, string> = {
  search_notes: 'Searching your notes',
  get_note: 'Reading a note',
  list_recent_notes: 'Checking recent notes',
  graph_overview: 'Looking at the whole graph',
  graph_neighborhood: 'Exploring connections',
  create_note: 'Writing a note',
  update_note: 'Updating a note',
  trash_note: 'Moving a note to trash',
  link_notes: 'Connecting notes',
  unlink_notes: 'Removing a connection',
  render_ui: 'Building an interface',
  focus_graph: 'Focusing the graph',
  remember: 'Remembering something',
  recall: 'Recalling something',
  list_activity: 'Reviewing your activity',
  log_activity: 'Logging activity',
  suggest: 'Leaving a suggestion',
  list_integrations: 'Checking connected tools',
  call_integration: 'Using a connected tool',
  register_integration: 'Proposing an integration',
  test_integration: 'Testing an integration',
  save_tool: 'Saving a reusable tool',
  list_saved_tools: 'Checking your saved tools'
}

const BUILTIN_LABELS: Record<string, string> = {
  ToolSearch: 'Finding the right tool',
  Read: 'Reading a file',
  Write: 'Writing a file',
  Edit: 'Editing a file',
  Bash: 'Running a command',
  Grep: 'Searching files',
  Glob: 'Looking for files',
  WebFetch: 'Fetching a page',
  WebSearch: 'Searching the web',
  TodoWrite: 'Planning'
}

/** Turn a raw tool name into something worth showing a person. */
export function friendlyToolLabel(name: string): string {
  const brain = name.match(/^mcp__brain__(.+)$/)
  if (brain) return BRAIN_LABELS[brain[1]] ?? humanise(brain[1])

  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/)
  if (mcp) {
    // e.g. mcp__claude_ai_Slack__slack_search_public -> "Slack: search public"
    const server = humaniseServer(mcp[1])
    return `${server}: ${humanise(mcp[2]).toLowerCase()}`
  }

  return BUILTIN_LABELS[name] ?? humanise(name)
}

function humanise(raw: string): string {
  const words = raw.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Strip the connector prefix the CLI adds to account-level MCP servers. */
function humaniseServer(raw: string): string {
  const cleaned = raw
    .replace(/^claude[_-]?ai[_-]?/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (!cleaned) return 'Connected tool'
  return cleaned
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
