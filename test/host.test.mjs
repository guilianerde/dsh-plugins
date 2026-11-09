import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { apply } from '../lib/index.js'

// Minimal fake host context: enough to mount the plugin and capture tools/routes.
const tools = new Map()
const routes = []
const disposers = []
const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index !== -1) routes.splice(index, 1)
      }
    },
  },
  connection: { requestRejection: () => undefined },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
}

apply(ctx)
assert.equal(tools.size, 16)
assert.ok(tools.has('sidebar_browser_open'))
assert.ok(tools.has('sidebar_browser_screenshot'))
assert.ok(routes.some((route) => route.kind === 'prefix' && route.path === '/dsh-sidebar-browser'))

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  const route = routes.find((candidate) => candidate.kind === 'prefix' && path.startsWith(candidate.path))
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  await route.handler(req, res)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const { port } = server.address()
const base = `http://127.0.0.1:${port}/dsh-sidebar-browser`

async function post(endpoint, body) {
  const response = await fetch(`${base}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await response.json()
}

const session = 'session-test'
const hello = await post('hello', { sessionId: session, mode: 'desktop', hasBrowser: true, tabs: [] })
assert.equal(hello.ok, true)

let polling = true
const poller = (async () => {
  while (polling) {
    const result = await post('poll', { sessionId: session, mode: 'desktop', hasBrowser: true, tabs: [], waitMs: 15_000 })
    if (!result.ok || result.value.request === null) continue
    const request = result.value.request
    assert.equal(request.sessionId, session)
    const value = request.name === 'tabs'
      ? { text: 'tabs: tab1' }
      : request.name === 'screenshot'
        ? { image: 'iVBORw0KGgo=', width: 1, height: 1, url: 'https://example.com/', title: 'Example' }
        : { text: `ok:${request.name}`, tabId: 'tab1' }
    await post('respond', { sessionId: session, requestId: request.id, ok: true, value })
  }
})()

// A second session's renderer polls independently: the host must route each
// tool call to its own session and never to whichever poller answered first.
const sessionB = 'session-other'
const helloB = await post('hello', { sessionId: sessionB, mode: 'desktop', hasBrowser: true, tabs: [] })
assert.equal(helloB.ok, true)
let pollingB = true
const pollerB = (async () => {
  while (pollingB) {
    const result = await post('poll', { sessionId: sessionB, mode: 'desktop', hasBrowser: true, tabs: [], waitMs: 15_000 })
    if (!result.ok || result.value.request === null) continue
    const request = result.value.request
    assert.equal(request.sessionId, sessionB)
    await post('respond', { sessionId: sessionB, requestId: request.id, ok: true, value: { text: `B:${request.name}` } })
  }
})()
const execB = { agent: { id: sessionB }, signal: new AbortController().signal }
const tabsB = await tools.get('sidebar_browser_tabs').execute({}, execB)
assert.equal(tabsB.text, 'B:tabs')

const exec = { agent: { id: session }, signal: new AbortController().signal }
const tabs = await tools.get('sidebar_browser_tabs').execute({}, exec)
assert.equal(tabs.text, 'tabs: tab1')

const opened = await tools.get('sidebar_browser_open').execute({ url: 'https://example.com' }, exec)
assert.equal(opened.text, 'ok:open')

const shot = await tools.get('sidebar_browser_screenshot').execute({}, exec)
assert.match(shot.text, /Screenshot saved to /)
const shotPath = shot.text.match(/Screenshot saved to (.+?) \(/)[1]
assert.equal(existsSync(shotPath), true)
rmSync(shotPath, { force: true })

// The host rejects private addresses before they reach the renderer.
await assert.rejects(
  () => tools.get('sidebar_browser_open').execute({ url: 'http://127.0.0.1:8080/' }, exec),
  /PERMISSION_DENIED/,
)

await assert.rejects(
  () => tools.get('sidebar_browser_tabs').execute({}, { agent: { id: 'other-session' } }),
  /SIDEBAR_UNAVAILABLE/,
)

// A renderer that stops serving a session says goodbye; its queued work is
// rejected immediately instead of hanging until the tool timeout.
pollingB = false
await post('bye', { sessionId: sessionB })
await Promise.race([pollerB, new Promise((resolve) => setTimeout(resolve, 500))])
await assert.rejects(
  () => tools.get('sidebar_browser_tabs').execute({}, execB),
  /SIDEBAR_UNAVAILABLE/,
)
const tabsAfterBye = await tools.get('sidebar_browser_tabs').execute({}, exec)
assert.equal(tabsAfterBye.text, 'tabs: tab1')

polling = false
await Promise.race([poller, new Promise((resolve) => setTimeout(resolve, 100))])
server.close()
for (const dispose of disposers.reverse()) {
  if (typeof dispose === 'function') dispose()
}
console.log('host.test.mjs: ok')
