/**
 * Offline verification for dsh-sandbox-temp-guard.
 * Runs the real plugin against a mock Cordis host and a stubbed sandbox provider
 * whose cached temp directory is genuinely deleted on disk.
 *
 *   node test/run-test.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, findTempCapabilities, repairSandboxTemp } from '../src/index.js'

let passed = 0
let failed = 0
function check (label, condition, extra = '') {
  if (condition) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label} ${extra}`) }
}

// ---- mock cordis host -------------------------------------------------------
function makeHost (provider) {
  const handlers = new Map()
  const effects = []
  const logs = []
  return {
    handlers,
    effects,
    logs,
    on (event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
    },
    get (name) { return name === 'sandbox' ? provider : undefined },
    effect (fn) { effects.push(fn()); return () => {} },
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m])
    },
    async fire (event, ...args) {
      const fns = handlers.get(event) ?? []
      const next = async () => ({ kind: 'accept' })
      for (const fn of fns) await fn(...args, next)
    }
  }
}

// ---- fixture: a provider shaped like dsh-sandbox-local 0.1.7-rc.2 ----------
const root = mkdtempSync(join(tmpdir(), 'sbtest-'))
const staleDir = join(root, 'dsh-STALE1')
mkdirSync(staleDir, { recursive: true })
const liveDir = join(root, 'dsh-LIVE01')
mkdirSync(liveDir, { recursive: true })
const grantCalls = []
const grant = { add: (dir) => { grantCalls.push(dir) } }

const provider = {
  // real field name in 0.1.7-rc.2
  tempCapabilities: new Map([
    ['["s1","C:\\\\ws"]', { dir: staleDir, writeSid: 'S-1-5-...', grant }],
    ['["s1","C:\\\\ws2"]', { dir: liveDir, writeSid: 'S-1-5-...', grant }]
  ])
}

console.log('== 1. capability discovery ==')
const caps = findTempCapabilities(provider)
check('finds both cached capabilities', caps.length === 2, `got ${caps.length}`)
const renamed = { tempCaps: new Map([['k', { dir: staleDir, grant }]]) }
check('generic walk finds renamed cache', findTempCapabilities(renamed).length === 1)

console.log('== 2. repair recreates the deleted directory ==')
rmSync(staleDir, { recursive: true, force: true })
check('fixture: stale dir really deleted', !existsSync(staleDir))
const before = grantCalls.length
const outcome = repairSandboxTemp({ get: (n) => (n === 'sandbox' ? provider : undefined), logger: undefined })
check('directory recreated on disk', existsSync(staleDir))
check('capability ACE re-applied', grantCalls.length === before + 1 && grantCalls[before] === staleDir)
check('live dir untouched (no extra grant)', outcome.repaired.length === 1 && outcome.repaired[0] === staleDir)

console.log('== 3. repair is a no-op when everything exists ==')
const outcome2 = repairSandboxTemp({ get: (n) => (n === 'sandbox' ? provider : undefined) })
check('nothing repaired', outcome2.repaired.length === 0 && outcome2.failed.length === 0)

console.log('== 4. failing grant.add is contained ==')
const badDir = join(root, 'dsh-BADGRT')
mkdirSync(badDir, { recursive: true })
const badProvider = { tempCapabilities: new Map([['k', { dir: badDir, grant: { add: () => { throw new Error('ACE boom') } } }]]) }
rmSync(badDir, { recursive: true, force: true })
const outcome3 = repairSandboxTemp({ get: (n) => (n === 'sandbox' ? badProvider : undefined), logger: { warn: () => {} } })
check('failure recorded, not thrown', outcome3.failed.length === 1 && existsSync(badDir))

console.log('== 5. plugin wiring: pre-execute repairs, post-execute annotates ==')
// fresh stale dir for the wiring test
const stale2 = join(root, 'dsh-STALE2')
mkdirSync(stale2, { recursive: true })
const wireProvider = { tempCapabilities: new Map([['k', { dir: stale2, grant }]]) }
const host = makeHost(wireProvider)
apply(host, {
  // simulate DSH's volatile accessor wrapping for Schema-declared config values
  sweepIntervalMs: { get: () => 0 },
  repairBeforeToolExecution: { get: () => true },
  annotateBackendFailure: { get: () => true }
})
check('pre-execute hook registered', (host.handlers.get('tools/pre-execute') ?? []).length === 1)
check('post-execute hook registered', (host.handlers.get('tools/post-execute') ?? []).length === 1)
rmSync(stale2, { recursive: true, force: true })

let nextCalled = false
const pre = host.handlers.get('tools/pre-execute')[0]
await pre({ toolName: 'pwsh' }, async () => { nextCalled = true; return { kind: 'allow' } })
check('next() invoked (pipeline continues)', nextCalled)
check('pre-execute repaired the dir', existsSync(stale2))

// post-execute with a backend failure
const post = host.handlers.get('tools/post-execute')[0]
const failResult = {
  isError: true,
  content: [{ type: 'text', text: 'Error: sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; ... Runner failure: windows-acl-run: --temp is not an existing directory: C:\\Users\\x\\dsh-AAA' }],
  error: { name: 'SandboxUnavailableError', code: 'SANDBOX_UNAVAILABLE' }
}
const decision = await post({ toolName: 'pwsh' }, failResult, async () => ({ kind: 'accept' }))
check('backend failure annotated', decision.kind === 'accept' && Array.isArray(decision.content) && decision.content.length === 2)
check('annotation is the last block', /sandbox-temp-guard/.test(decision.content.at(-1)?.text ?? ''))

// post-execute with a normal result: untouched
const okResult = { isError: false, content: [{ type: 'text', text: 'hello' }] }
const decision2 = await post({ toolName: 'pwsh' }, okResult, async () => ({ kind: 'accept' }))
check('normal result untouched', decision2.kind === 'accept' && !Object.hasOwn(decision2, 'content'))

// post-execute when downstream decides block: untouched
const decision3 = await post({ toolName: 'pwsh' }, okResult, async () => ({ kind: 'block', feedback: [] }))
check('block decision untouched', decision3.kind === 'block')

console.log('== 6. plugin tolerates missing sandbox service ==')
const host2 = makeHost(undefined)
apply(host2, { sweepIntervalMs: { get: () => 0 } })
let next2 = false
await host2.handlers.get('tools/pre-execute')[0]({ toolName: 'pwsh' }, async () => { next2 = true; return { kind: 'allow' } })
check('no sandbox service: hook still passes through', next2)

console.log(`\n${passed} passed, ${failed} failed`)
rmSync(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
