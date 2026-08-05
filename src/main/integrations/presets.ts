import type { IntegrationManifest } from '@shared/types'

export interface IntegrationPreset {
  manifest: IntegrationManifest
}

/**
 * Ready-made integrations.
 *
 * Every one of these is just a manifest — the same format the agent produces
 * when it builds an integration itself. They exist so the common cases are one
 * click, and so the agent has concrete examples of the shape to imitate.
 *
 * All ship disabled and reference credentials by ref; no secret is ever inlined.
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** Google requires these to return a refresh token to a desktop client. */
const GOOGLE_AUTH_PARAMS = { access_type: 'offline', prompt: 'consent' }

const GOOGLE_CLIENT_SECRETS = (id: string) => [
  {
    ref: `${id}.clientId`,
    label: 'Google OAuth client ID',
    hint: 'Google Cloud Console → APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app'
  },
  {
    ref: `${id}.clientSecret`,
    label: 'Google OAuth client secret',
    hint: 'Shown next to the client ID you just created'
  }
]

const gmail: IntegrationManifest = {
  id: 'gmail',
  name: 'Gmail',
  description:
    'Read, search and send mail. Messages can be captured into the vault as notes and linked to the people and projects they concern.',
  icon: 'mail',
  kind: 'rest',
  enabled: false,
  createdBy: 'preset',
  version: '1',
  requiredSecrets: GOOGLE_CLIENT_SECRETS('gmail'),
  baseUrl: 'https://gmail.googleapis.com/gmail/v1/users/me/',
  auth: {
    type: 'oauth2',
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    clientIdRef: 'gmail.clientId',
    clientSecretRef: 'gmail.clientSecret',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify'
    ],
    pkce: true,
    authParams: GOOGLE_AUTH_PARAMS,
    tokenRef: 'gmail.tokens'
  },
  operations: [
    {
      name: 'list_messages',
      description:
        'Search messages. Uses Gmail query syntax, e.g. "from:someone@example.com is:unread newer_than:7d". Returns ids only — follow up with get_message.',
      method: 'GET',
      path: 'messages',
      query: [
        { name: 'q', type: 'string', description: 'Gmail search query.' },
        { name: 'maxResults', type: 'number', default: 20 },
        { name: 'labelIds', type: 'string', description: 'Comma-separated label ids.' },
        { name: 'pageToken', type: 'string' }
      ],
      resultPath: 'messages'
    },
    {
      name: 'get_message',
      description:
        'Full message by id. Pass format=full for headers and body, or metadata for just the headers.',
      method: 'GET',
      path: 'messages/{id}',
      pathParams: [{ name: 'id', type: 'string', required: true }],
      query: [
        { name: 'format', type: 'string', default: 'full' },
        { name: 'metadataHeaders', type: 'string', description: 'Comma-separated header names.' }
      ]
    },
    {
      name: 'list_threads',
      description: 'Search conversation threads, same query syntax as list_messages.',
      method: 'GET',
      path: 'threads',
      query: [
        { name: 'q', type: 'string' },
        { name: 'maxResults', type: 'number', default: 20 }
      ],
      resultPath: 'threads'
    },
    {
      name: 'get_thread',
      description: 'Every message in one thread.',
      method: 'GET',
      path: 'threads/{id}',
      pathParams: [{ name: 'id', type: 'string', required: true }],
      query: [{ name: 'format', type: 'string', default: 'full' }]
    },
    {
      name: 'list_labels',
      description: 'All labels on the account, with their ids.',
      method: 'GET',
      path: 'labels',
      resultPath: 'labels'
    },
    {
      name: 'get_profile',
      description: 'The signed-in address and message counts. Useful as a connection check.',
      method: 'GET',
      path: 'profile'
    },
    {
      name: 'send_message',
      description:
        'Send an email. The body must be { "raw": "<base64url of a full RFC 2822 message>" }; set threadId alongside it to reply in place. Always show the user the exact message and get their agreement before calling this.',
      method: 'POST',
      path: 'messages/send',
      rawBody: true,
      mutating: true
    },
    {
      name: 'modify_message',
      description:
        'Add or remove labels on a message. Body: { "addLabelIds": [...], "removeLabelIds": [...] }. Removing "UNREAD" marks it read; adding "TRASH" is not how deletion works — use the trash operation.',
      method: 'POST',
      path: 'messages/{id}/modify',
      pathParams: [{ name: 'id', type: 'string', required: true }],
      rawBody: true,
      mutating: true
    }
  ]
}

const googleCalendar: IntegrationManifest = {
  id: 'google-calendar',
  name: 'Google Calendar',
  description:
    'Read and create calendar events, so meetings can land on the activity timeline and link to the notes they produced.',
  icon: 'calendar',
  kind: 'rest',
  enabled: false,
  createdBy: 'preset',
  version: '1',
  requiredSecrets: GOOGLE_CLIENT_SECRETS('google-calendar'),
  baseUrl: 'https://www.googleapis.com/calendar/v3/',
  auth: {
    type: 'oauth2',
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    clientIdRef: 'google-calendar.clientId',
    clientSecretRef: 'google-calendar.clientSecret',
    scopes: ['https://www.googleapis.com/auth/calendar'],
    pkce: true,
    authParams: GOOGLE_AUTH_PARAMS,
    tokenRef: 'google-calendar.tokens'
  },
  operations: [
    {
      name: 'list_calendars',
      description: 'Calendars this account can see.',
      method: 'GET',
      path: 'users/me/calendarList',
      resultPath: 'items'
    },
    {
      name: 'list_events',
      description:
        'Events in a time window. timeMin and timeMax are RFC3339 timestamps; calendarId is usually "primary".',
      method: 'GET',
      path: 'calendars/{calendarId}/events',
      pathParams: [{ name: 'calendarId', type: 'string', required: true, default: 'primary' }],
      query: [
        { name: 'timeMin', type: 'string' },
        { name: 'timeMax', type: 'string' },
        { name: 'q', type: 'string' },
        { name: 'maxResults', type: 'number', default: 50 },
        { name: 'singleEvents', type: 'boolean', default: true },
        { name: 'orderBy', type: 'string', default: 'startTime' }
      ],
      resultPath: 'items'
    },
    {
      name: 'create_event',
      description:
        'Create an event. Body is the Google Calendar event resource: { summary, description?, start: { dateTime, timeZone }, end: {...}, attendees? }. Confirm with the user first — attendees get invitations.',
      method: 'POST',
      path: 'calendars/{calendarId}/events',
      pathParams: [{ name: 'calendarId', type: 'string', required: true, default: 'primary' }],
      rawBody: true,
      mutating: true
    }
  ]
}

const github: IntegrationManifest = {
  id: 'github',
  name: 'GitHub',
  description:
    'Search repositories, issues and pull requests, and read file contents. Good for tying notes to the code they describe.',
  icon: 'github',
  kind: 'rest',
  enabled: false,
  createdBy: 'preset',
  version: '1',
  requiredSecrets: [
    {
      ref: 'github.token',
      label: 'GitHub personal access token',
      hint: 'github.com → Settings → Developer settings → Personal access tokens. Read-only scopes are enough for search and reading.'
    }
  ],
  baseUrl: 'https://api.github.com/',
  auth: { type: 'bearer', secretRef: 'github.token' },
  defaultHeaders: { 'x-github-api-version': '2022-11-28', accept: 'application/vnd.github+json' },
  operations: [
    {
      name: 'search_issues',
      description:
        'Search issues and pull requests, e.g. "repo:owner/name is:open label:bug" or "assignee:@me is:pr".',
      method: 'GET',
      path: 'search/issues',
      query: [
        { name: 'q', type: 'string', required: true },
        { name: 'per_page', type: 'number', default: 20 },
        { name: 'sort', type: 'string' }
      ],
      resultPath: 'items'
    },
    {
      name: 'search_repositories',
      description: 'Search repositories.',
      method: 'GET',
      path: 'search/repositories',
      query: [
        { name: 'q', type: 'string', required: true },
        { name: 'per_page', type: 'number', default: 10 }
      ],
      resultPath: 'items'
    },
    {
      name: 'get_issue',
      description: 'One issue or pull request with its body.',
      method: 'GET',
      path: 'repos/{owner}/{repo}/issues/{number}',
      pathParams: [
        { name: 'owner', type: 'string', required: true },
        { name: 'repo', type: 'string', required: true },
        { name: 'number', type: 'number', required: true }
      ]
    },
    {
      name: 'list_notifications',
      description: 'Unread notifications for the authenticated user.',
      method: 'GET',
      path: 'notifications',
      query: [{ name: 'all', type: 'boolean', default: false }]
    }
  ]
}

const slack: IntegrationManifest = {
  id: 'slack',
  name: 'Slack',
  description:
    'Search and read channel history so decisions made in chat can be captured as notes. Posting is available but always needs your confirmation.',
  icon: 'message-square',
  kind: 'rest',
  enabled: false,
  createdBy: 'preset',
  version: '1',
  requiredSecrets: [
    {
      ref: 'slack.token',
      label: 'Slack user or bot token',
      hint: 'api.slack.com/apps → your app → OAuth & Permissions. Needs search:read, channels:history and channels:read.'
    }
  ],
  baseUrl: 'https://slack.com/api/',
  auth: { type: 'bearer', secretRef: 'slack.token' },
  operations: [
    {
      name: 'search_messages',
      description: 'Search messages across the workspace (requires a user token with search:read).',
      method: 'GET',
      path: 'search.messages',
      query: [
        { name: 'query', type: 'string', required: true },
        { name: 'count', type: 'number', default: 20 }
      ],
      resultPath: 'messages.matches'
    },
    {
      name: 'list_channels',
      description: 'Channels visible to this token, with their ids.',
      method: 'GET',
      path: 'conversations.list',
      query: [
        { name: 'limit', type: 'number', default: 100 },
        { name: 'types', type: 'string', default: 'public_channel' }
      ],
      resultPath: 'channels'
    },
    {
      name: 'channel_history',
      description: 'Recent messages in a channel, newest first.',
      method: 'GET',
      path: 'conversations.history',
      query: [
        { name: 'channel', type: 'string', required: true },
        { name: 'limit', type: 'number', default: 50 },
        { name: 'oldest', type: 'string', description: 'Unix timestamp lower bound.' }
      ],
      resultPath: 'messages'
    },
    {
      name: 'post_message',
      description:
        'Post to a channel. Body: { "channel": "C…", "text": "…", "thread_ts"? }. Show the user the exact text and get their agreement first.',
      method: 'POST',
      path: 'chat.postMessage',
      rawBody: true,
      mutating: true
    }
  ]
}

const filesystemMcp: IntegrationManifest = {
  id: 'local-files',
  name: 'Local files (MCP)',
  description:
    'Read files from a folder you choose, through the reference MCP filesystem server. A working example of connecting any MCP server.',
  icon: 'folder',
  kind: 'mcp-stdio',
  enabled: false,
  createdBy: 'preset',
  version: '1',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
  env: {}
}

const inboundWebhook: IntegrationManifest = {
  id: 'inbox',
  name: 'Inbound webhook',
  description:
    'A local endpoint that turns any JSON POST into a note. Point automations, scripts or a tunnel at it to feed the brain from outside.',
  icon: 'webhook',
  kind: 'webhook',
  enabled: false,
  createdBy: 'preset',
  version: '1',
  path: 'inbox',
  requiredSecrets: [
    {
      ref: 'inbox.secret',
      label: 'Shared secret',
      hint: 'Any string. Senders must pass it as the X-Webhook-Secret header.'
    }
  ],
  secretRef: 'inbox.secret',
  capture: { titleField: 'title', bodyField: 'body', tags: ['inbox'], kind: 'source' }
}

export const INTEGRATION_PRESETS: IntegrationPreset[] = [
  { manifest: gmail },
  { manifest: googleCalendar },
  { manifest: github },
  { manifest: slack },
  { manifest: filesystemMcp },
  { manifest: inboundWebhook }
]
