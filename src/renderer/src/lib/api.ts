import type { ApiChannel, ApiPayload, ApiResult, EventChannel, EventMap } from '@shared/ipc'

/**
 * Typed client over the preload bridge.
 *
 * `call` is the only place that touches `window.brain`, so every channel name and
 * payload is checked against the shared ApiMap at compile time.
 */
function call<K extends ApiChannel>(
  channel: K,
  ...args: ApiPayload<K> extends void ? [] : [ApiPayload<K>]
): Promise<ApiResult<K>> {
  return window.brain.invoke(channel, args[0]) as Promise<ApiResult<K>>
}

export function onEvent<K extends EventChannel>(
  channel: K,
  listener: (payload: EventMap[K]) => void
): () => void {
  return window.brain.on(channel, (payload) => listener(payload as EventMap[K]))
}

export const api = {
  /* system */
  bootstrap: () => call('app:bootstrap'),
  getSettings: () => call('app:settings:get'),
  updateSettings: (patch: ApiPayload<'app:settings:update'>) => call('app:settings:update', patch),
  openWorkspace: () => call('app:openWorkspace'),
  chooseWorkspace: () => call('app:chooseWorkspace'),
  reindex: () => call('app:reindex'),
  reportUserActivity: () => call('app:userActivity'),
  openExternal: (url: string) => call('app:openExternal', { url }),

  /* the model engine */
  engineState: () => call('engine:state'),
  engineModels: (providerId: string, force?: boolean) =>
    call('engine:models', { providerId, force }),
  // `effort` was declared here and never forwarded, which made the whole Codex thinking-level
  // picker inert: every chip saved nothing and the refresh that followed put the old value back.
  // Nothing failed to compile, and nothing in the panel could have revealed it.
  selectEngine: (providerId: string, model?: string, baseUrl?: string, effort?: string) =>
    call('engine:select', { providerId, model, baseUrl, effort }),
  // Stores a provider's settings without switching to it, which is what setup needs while the
  // user is still deciding. `selectEngine` is the deliberate act at the end.
  configureEngine: (providerId: string, model?: string, baseUrl?: string, effort?: string) =>
    call('engine:configure', { providerId, model, baseUrl, effort }),
  setEngineKey: (providerId: string, key: string) => call('engine:setKey', { providerId, key }),
  clearEngineKey: (providerId: string) => call('engine:clearKey', { providerId }),
  testEngine: (providerId: string, model?: string) => call('engine:test', { providerId, model }),
  verifyEngine: (providerId: string, model?: string) => call('engine:verify', { providerId, model }),
  cliStatus: (providerId: string, recheck?: boolean) =>
    call('engine:cliStatus', { providerId, recheck }),

  /* updates */
  updateStatus: () => call('update:status'),
  checkForUpdate: () => call('update:check'),
  installUpdate: () => call('update:install'),
  openReleasePage: () => call('update:openRelease'),
  whatsNew: () => call('update:whatsNew'),

  /* graph and notes */
  getGraph: () => call('graph:get'),
  getStats: () => call('graph:stats'),
  savePositions: (positions: { id: string; x: number; y: number; z: number }[]) =>
    call('graph:savePositions', { positions }),
  getNeighborhood: (id: string, depth?: number) => call('graph:neighborhood', { id, depth }),
  getNode: (id: string) => call('node:get', { id }),
  getNodeEdges: (id: string) => call('node:edges', { id }),
  search: (query: string, limit?: number, includeVirtual?: boolean) =>
    call('node:search', { query, limit, includeVirtual }),
  createNote: (input: ApiPayload<'node:create'>) => call('node:create', input),
  updateNote: (input: ApiPayload<'node:update'>) => call('node:update', input),
  trashNote: (ref: string) => call('node:trash', { ref }),
  setPinned: (id: string, pinned: boolean) => call('node:setPinned', { id, pinned }),
  linkNotes: (input: ApiPayload<'node:link'>) => call('node:link', input),
  unlinkNotes: (input: ApiPayload<'node:unlink'>) => call('node:unlink', input),
  revealNote: (id: string) => call('node:reveal', { id }),
  recentNotes: (limit?: number) => call('node:recent', { limit }),

  /* activity and suggestions */
  getActivity: (input: ApiPayload<'activity:list'>) => call('activity:list', input),
  getDailyActivity: (days?: number) => call('activity:daily', { days }),
  getSuggestions: (status?: 'pending' | 'all') => call('suggestions:list', { status }),
  applySuggestion: (id: string) => call('suggestions:apply', { id }),
  dismissSuggestion: (id: string) => call('suggestions:dismiss', { id }),
  runCurator: () => call('curator:run'),

  /* chat */
  listSessions: () => call('chat:sessions'),
  getSession: (id: string) => call('chat:session', { id }),
  createSession: () => call('chat:createSession'),
  renameSession: (id: string, title: string) => call('chat:renameSession', { id, title }),
  deleteSession: (id: string) => call('chat:deleteSession', { id }),
  getMessages: (sessionId: string) => call('chat:messages', { sessionId }),
  getGenUi: (id: string) => call('chat:genui', { id }),
  send: (input: ApiPayload<'chat:send'>) => call('chat:send', input),
  interrupt: (sessionId: string) => call('chat:interrupt', { sessionId }),
  setCapability: (input: ApiPayload<'chat:setCapability'>) => call('chat:setCapability', input),
  getCapability: (sessionId: string) => call('chat:capability', { sessionId }),
  agentStatus: () => call('agent:status'),
  reportRendererError: (payload: {
    kind: string
    message: string
    stack: string | null
    where: string | null
  }) => call('app:reportError', payload),
  turnState: (sessionId: string) => call('agent:turn', { sessionId }),
  budgetStatus: () => call('agent:budget'),
  usage: () => call('usage:get'),

  /* saved tools */
  listTools: () => call('tools:list'),
  setToolPinned: (id: string, pinned: boolean) => call('tools:setPinned', { id, pinned }),
  removeTool: (id: string) => call('tools:remove', { id }),
  reorderTools: (ids: string[]) => call('tools:reorder', { ids }),
  renderTool: (id: string, values: Record<string, string>) => call('tools:render', { id, values }),
  answerQuestion: (id: string, answer: string) => call('chat:answerQuestion', { id, answer }),
  accountServers: () => call('integrations:accountServers'),

  /* tool windows */
  openSpecWindow: (specId: string, title: string) => call('window:openTool', { specId, title }),
  openToolWindow: (toolId: string, title: string, alwaysOnTop?: boolean) =>
    call('window:openTool', { toolId, title, alwaysOnTop }),
  getTool: (id: string) => call('tools:get', { id }),
  reportToolError: (id: string, message: string, stack: string | null, where: string | null) =>
    call('tools:reportError', { id, message, stack, where }),
  setToolModelPrefs: (payload: ApiPayload<'tools:setModelPrefs'>) =>
    call('tools:setModelPrefs', payload),
  toolSession: (id: string) => call('tools:session', { id }),

  /* diagnostics */
  logTail: (limit?: number) => call('logs:tail', { limit }),
  clearLogs: () => call('logs:clear'),
  openLogWindow: () => call('logs:openWindow'),
  revealLogFile: () => call('logs:reveal'),
  writeToolState: (id: string, state: Record<string, unknown>, rev: number) =>
    call('tools:writeState', { id, state, rev }),
  askTool: (id: string, text: string) => call('tools:ask', { id, text }),
  listTasks: () => call('tasks:list'),
  taskRuns: (id: string, limit?: number) => call('tasks:runs', { id, limit }),
  listInbox: () => call('inbox:list'),
  readInbox: (id?: string) => call('inbox:read', { id }),
  saveTask: (payload: {
    id?: string
    name: string
    prompt: string
    schedule: unknown
    enabled?: boolean
  }) => call('tasks:save', payload),
  setTaskEnabled: (id: string, enabled: boolean) => call('tasks:setEnabled', { id, enabled }),
  removeTask: (id: string) => call('tasks:remove', { id }),
  runTaskNow: (id: string) => call('tasks:runNow', { id }),
  openTaskSession: (id: string) => call('tasks:openSession', { id }),

  runToolAction: (id: string, actionId: string, inputs: Record<string, string>) =>
    call('tools:runAction', { id, actionId, inputs }),
  setToolHotkey: (id: string, hotkey: string | null) => call('tools:setHotkey', { id, hotkey }),
  setToolWindowPrefs: (input: { id: string; openInWindow?: boolean; alwaysOnTop?: boolean }) =>
    call('tools:setWindowPrefs', input),
  toolShortcutStates: () => call('tools:shortcutStates'),
  toggleAlwaysOnTop: () => call('window:toggleAlwaysOnTop'),
  isAlwaysOnTop: () => call('window:isAlwaysOnTop'),
  previewReady: () => call('window:previewReady'),

  /* integrations */
  listIntegrations: () => call('integrations:list'),
  listIntegrationTools: () => call('integrations:tools'),
  listPresets: () => call('integrations:presets'),
  installPreset: (id: string) => call('integrations:installPreset', { id }),
  setIntegrationEnabled: (id: string, enabled: boolean) =>
    call('integrations:setEnabled', { id, enabled }),
  removeIntegration: (id: string) => call('integrations:remove', { id }),
  testIntegration: (id: string) => call('integrations:test', { id }),
  authorizeIntegration: (id: string) => call('integrations:authorize', { id }),
  listIntegrationSummaries: () => call('integrations:summaries'),
  setSecret: (ref: string, value: string, expiresAt?: number | null, setFor?: string | null) =>
    call('integrations:setSecret', { ref, value, expiresAt, setFor }),
  deleteSecret: (ref: string) => call('integrations:deleteSecret', { ref }),
  setSecretExpiry: (ref: string, expiresAt: number | null) =>
    call('integrations:setSecretExpiry', { ref, expiresAt }),
  revealSecret: (ref: string) => call('integrations:revealSecret', { ref }),
  probeIntegration: (id: string) => call('integrations:probe', { id }),
  integrationAudit: (id?: string | null, limit?: number) =>
    call('integrations:audit', { id, limit }),
  listSecretRefs: () => call('integrations:secretRefs'),
  callIntegration: (input: ApiPayload<'integrations:call'>) => call('integrations:call', input)
}

/** Human-readable message from a rejected IPC call. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Electron prefixes IPC rejections with the handler location; strip it.
    return err.message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
  }
  return String(err)
}
