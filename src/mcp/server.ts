/**
 * Nuntia's MCP service.
 *
 * A separate process from the web app, not a route inside it. The app is a
 * browser client for one person's mail; an MCP service is a long-running
 * endpoint that an agent talks to over HTTP, with a different lifecycle and a
 * different threat model. Keeping it separate means the app's request path is
 * untouched when nobody runs it.
 *
 * It shares the database file and `TOKEN_ENCRYPTION_KEY` with the app, which is
 * what lets it read real mail and, for a reply, hand the stored OAuth token to
 * the same mailbox client the app uses. It does not have its own credential
 * store: authentication is an agent token created in Settings → AI agents (the
 * app's session cookie is also accepted).
 *
 *   MCP_HOST=127.0.0.1 MCP_PORT=3333 bun run mcp
 *
 * The loopback default is deliberate. Binding this to a public interface turns
 * an agent token into a remote API key, and that token reaches the whole
 * mailbox.
 *
 * Transport is stateless Streamable HTTP: one MCP server and one transport are
 * built per authenticated request, so no request can inherit another user's
 * identity from a session map. Responses are JSON rather than SSE, which every
 * current MCP client accepts for request/response tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import { initDatabase } from '#/db/index.ts'
import { userFromMcpToken } from '#/lib/auth/mcp-tokens.ts'
import { sessionFromCredential } from '#/lib/auth/session.ts'

import { registerTools } from './tools.ts'

const DEFAULT_PORT = 3333
const DEFAULT_HOST = '127.0.0.1'

function port(): number {
  const raw = process.env.MCP_PORT?.trim()
  if (!raw) return DEFAULT_PORT

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`MCP_PORT must be a port number, not "${raw}".`)
  }
  return value
}

/** The `Authorization: Bearer` credential, or null when there is none. */
function credentialFrom(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null

  const [scheme, ...rest] = header.trim().split(/\s+/)
  if (scheme.toLowerCase() !== 'bearer') return null

  return rest.join(' ') || null
}

function json(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/**
 * Refusals are identical whatever went wrong.
 *
 * An invalid token, a revoked one and a browser session are the same answer on
 * purpose: this endpoint is reachable by anything on the host, and distinguishing
 * them would turn it into a way to test whether a credential exists.
 */
function unauthorized(): Response {
  return json(
    401,
    { error: 'A valid Nuntia agent token is required.' },
    { 'WWW-Authenticate': 'Bearer realm="nuntia-mcp"' },
  )
}

/** Build the server for one authenticated call and hand it the request. */
async function handleMcp(request: Request): Promise<Response> {
  const credential = credentialFrom(request)
  if (!credential) return unauthorized()

  // An agent token from Settings is the normal credential. The session cookie
  // stays accepted so an existing browser-derived setup keeps working.
  const userId =
    (await userFromMcpToken(credential)) ??
    (await sessionFromCredential(credential))?.userId ??
    null
  if (!userId) return unauthorized()

  const server = new McpServer({ name: 'nuntia', version: '1.0.0' })
  registerTools(server, userId)

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: the transport does not issue or validate session ids.
    sessionIdGenerator: undefined,
    // JSON instead of an SSE stream. Every tool here is request/response, so
    // there is nothing to deliver asynchronously.
    enableJsonResponse: true,
  })

  await server.connect(transport)

  try {
    return await transport.handleRequest(request)
  } finally {
    // The response is complete in JSON mode, so the per-request objects can go.
    // Nothing is kept between calls, which is also what keeps one user's
    // identity from leaking into another's request.
    await transport.close()
    await server.close()
  }
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if (url.pathname === '/healthz') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(405, { error: 'Method not allowed.' })
    }
    return json(200, { ok: true })
  }

  if (url.pathname !== '/mcp') {
    return json(404, { error: 'Not found.' })
  }

  // POST carries every JSON-RPC message in stateless mode. GET would ask for a
  // standalone event stream this server does not keep, and DELETE would end a
  // session it never created.
  if (request.method !== 'POST') {
    return json(
      405,
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      },
      { Allow: 'POST' },
    )
  }

  try {
    return await handleMcp(request)
  } catch (error) {
    console.error('[mcp] request failed:', error)
    return json(500, {
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null,
    })
  }
}

await initDatabase()

const host = process.env.MCP_HOST?.trim() || DEFAULT_HOST
const server = Bun.serve({ hostname: host, port: port(), fetch: route })

console.log(
  `[mcp] listening on http://${server.hostname}:${server.port}/mcp ` +
    '(create a token in Settings → AI agents)',
)
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  console.warn(
    '[mcp] WARNING: bound to a non-loopback address. Anyone who can reach ' +
      'this port with a valid session cookie can read and write the mailbox.',
  )
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[mcp] ${signal} received, shutting down`)
    server.stop(true)
    process.exit(0)
  })
}
