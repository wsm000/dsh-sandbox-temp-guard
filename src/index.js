/**
 * dsh-sandbox-temp-guard — a zero-dependency DeepSeek Harness (Cordis) plugin.
 *
 * Problem (deepseek-ai/deepseek-harness Discussion #8550):
 *   On Windows, `@deepseek-ai/dsh-sandbox-local` materializes one private temp
 *   directory per (session, workspace) pair — `mkdtempSync(join(tmpdir(), 'dsh-'))`
 *   plus a revocable capability-SID ACL grant — and caches it for the provider's
 *   lifetime. The cache is trusted blindly: when OS temp cleanup (Storage Sense,
 *   disk cleaners, manual removal) deletes `%TEMP%\dsh-XXXXXX` mid-session, every
 *   subsequent `confine()` still passes the stale path as `--temp`, the
 *   windows-acl-run runner refuses to start (`--temp is not an existing
 *   directory`, exit 127), and the seam fails closed with SANDBOX_UNAVAILABLE —
 *   so every command in that session fails until DSH restarts.
 *
 * What this plugin does (a stopgap until the framework fix lands):
 *   1. Repair (the fix): before every tool execution — and on a periodic sweep —
 *      locate the live sandbox provider's cached temp capabilities, recreate any
 *      missing directory, and re-apply its capability ACE (the ACE died with the
 *      directory). Commands then run without the failure ever surfacing.
 *   2. Annotate (hygiene): if a SANDBOX_UNAVAILABLE / `windows-acl-run: --temp`
 *      failure still reaches a tool result, append a remediation block that tells
 *      the model this is a backend infrastructure failure — NOT a policy denial —
 *      so it stops asking for `danger-full-access` escalation.
 *
 * Design notes:
 *   - Zero runtime dependencies (node builtins only): installs cleanly via npm
 *     package, local tarball, or even a `file:///` source overlay.
 *   - The provider-internals access (`tempCapabilities`) is discovered
 *     generically (walk for Map-shaped caches whose entries expose
 *     `{ dir, grant.add }`), so a framework rename degrades to a no-op instead of
 *     a crash. Versions tested: DSH 0.1.7-rc.2 (dsh-sandbox-local).
 *   - All failure paths are fail-safe: never throws into the tool pipeline.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

export const name = 'sandbox-temp-guard'

/** Services resolved through `ctx.get`; kept optional so the plugin loads anywhere. */
const SERVICES = ['sandbox', 'tools']

/** Defaults; overridden by the profile's cordis.patch.yml config block. */
const DEFAULTS = {
  repairBeforeToolExecution: true,
  sweepIntervalMs: 60_000,
  annotateBackendFailure: true
}

/**
 * Read a config value that may arrive plain or wrapped in a volatile accessor
 * (`{ get() }` — DSH wraps Schema-declared config values; community plugins hit
 * the same shape). Numbers/booleans pass through untouched.
 * @param {unknown} value
 * @returns {unknown}
 */
function readConfigValue (value) {
  if (value !== null && typeof value === 'object' && 'get' in value && typeof value.get === 'function') {
    return value.get()
  }
  return value
}

/** Result-text signatures that identify a backend-unavailable failure. */
const BACKEND_FAILURE_MARKERS = [
  'SANDBOX_UNAVAILABLE',
  'windows-acl-run: --temp',
  'no sandbox backend is usable'
]

/**
 * The remediation block appended to backend-failure results. Wording matters:
 * the model must read this as infrastructure, not policy, and must not burn an
 * approval on a permission escalation that cannot help.
 */
const REMEDIATION_TEXT = [
  '[sandbox-temp-guard] This is a sandbox BACKEND infrastructure failure, not a policy denial.',
  'Do NOT retry with sandbox_permissions / danger-full-access — wider permissions cannot fix a missing backend directory.',
  'The guard has already recreated the per-session temp directory; retry the same command once.',
  'If it still fails, the composition needs a restart (new conversation or DSH restart); report the error verbatim to the user.'
].join('\n')

/**
 * Discover cached temp capabilities on a sandbox provider instance.
 * Shape discovered in dsh-sandbox-local 0.1.7-rc.2: `provider.tempCapabilities`
 * is a Map keyed by JSON([sessionId, workspaceRoot]) whose values are
 * `{ dir, writeSid, grant }` with `grant.add(dir)` re-applying the ACE.
 * The walk is generic so renamed/reshaped caches still match.
 * @param {unknown} provider - the live `sandbox` service instance (may be an accessor).
 * @returns {Array<{ dir: string, grant: { add: (dir: string) => unknown } }>}
 */
export function findTempCapabilities (provider) {
  /** @type {Array<{ dir: string, grant: { add: (dir: string) => unknown } }>} */
  const found = []
  const seen = new Set()
  const isCapability = (value) =>
    !!value && typeof value === 'object' &&
    typeof value.dir === 'string' && value.dir.length > 0 &&
    !!value.grant && typeof value.grant.add === 'function'

  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return
    seen.add(value)
    if (value instanceof Map) {
      for (const entry of value.values()) {
        if (isCapability(entry)) found.push(entry)
        else visit(entry, depth + 1)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isCapability(entry)) found.push(entry)
        else visit(entry, depth + 1)
      }
      return
    }
    for (const child of Object.values(value)) visit(child, depth + 1)
  }
  visit(provider, 0)
  return found
}

/**
 * Recreate every missing cached temp directory (and re-apply its ACE).
 * Fail-safe: per-entry problems are logged and skipped, never thrown.
 * @param {{ get?: (name: string) => unknown, logger?: { warn?: Function, info?: Function } }} ctx
 * @param {{ logRepairs?: boolean }} [options]
 * @returns {{ scanned: number, repaired: string[], failed: Array<{ dir: string, error: string }> }}
 */
export function repairSandboxTemp (ctx, options = {}) {
  const repaired = []
  const failed = []
  let scanned = 0
  const log = options.logRepairs === false ? null : ctx?.logger

  const root = tmpdir()
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
  } catch (error) {
    log?.warn?.(`sandbox-temp-guard: cannot ensure temp root ${root}: ${error.message}`)
  }

  let provider
  try {
    provider = ctx?.get?.('sandbox')
  } catch (error) {
    log?.warn?.(`sandbox-temp-guard: ctx.get('sandbox') failed: ${error.message}`)
  }
  if (!provider) return { scanned, repaired, failed }

  let caps = []
  try {
    caps = findTempCapabilities(provider)
  } catch (error) {
    log?.warn?.(`sandbox-temp-guard: capability discovery failed: ${error.message}`)
    return { scanned, repaired, failed }
  }
  scanned = caps.length

  for (const cap of caps) {
    if (existsSync(cap.dir)) continue
    try {
      mkdirSync(cap.dir, { recursive: true })
      // The capability ACE lived on the deleted directory; re-grant it on the
      // fresh one. Without this the confined child still cannot write its temp.
      cap.grant.add(cap.dir)
      repaired.push(cap.dir)
      log?.info?.(`sandbox-temp-guard: recreated missing sandbox temp dir ${cap.dir}`)
    } catch (error) {
      failed.push({ dir: cap.dir, error: String(error?.message ?? error) })
      log?.warn?.(`sandbox-temp-guard: failed to recreate ${cap.dir}: ${error?.message ?? error}`)
    }
  }
  return { scanned, repaired, failed }
}

/** Pull the display text out of a tool result's content blocks. */
function resultText (result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const parts = []
  for (const block of blocks) {
    if (typeof block === 'string') parts.push(block)
    else if (block && typeof block.text === 'string') parts.push(block.text)
  }
  const message = result?.error?.message
  if (typeof message === 'string') parts.push(message)
  return parts.join('\n')
}

/**
 * The Cordis plugin entry.
 * @param {any} ctx - Cordis context (event bus, service registry, effect scope).
 * @param {Partial<typeof DEFAULTS>} [rawConfig] - config from cordis.patch.yml.
 */
export function apply (ctx, rawConfig) {
  const config = {
    repairBeforeToolExecution: readConfigValue(rawConfig?.repairBeforeToolExecution) ?? DEFAULTS.repairBeforeToolExecution,
    sweepIntervalMs: readConfigValue(rawConfig?.sweepIntervalMs) ?? DEFAULTS.sweepIntervalMs,
    annotateBackendFailure: readConfigValue(rawConfig?.annotateBackendFailure) ?? DEFAULTS.annotateBackendFailure
  }
  const logger = ctx?.logger

  // 1. The fix: repair stale temp dirs before every tool execution.
  if (config.repairBeforeToolExecution) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        repairSandboxTemp(ctx)
      } catch (error) {
        logger?.warn?.(`sandbox-temp-guard: pre-execute sweep failed: ${error?.message ?? error}`)
      }
      return next()
    })
  }

  // 2. Hygiene: annotate backend-unavailable failures that still surface.
  if (config.annotateBackendFailure) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      let decision
      try {
        decision = await next()
      } catch (error) {
        logger?.warn?.(`sandbox-temp-guard: post-execute downstream failed: ${error?.message ?? error}`)
        throw error
      }
      try {
        if (decision?.kind !== 'accept' || Object.hasOwn(decision, 'value') || Object.hasOwn(decision, 'content')) return decision
        const text = resultText(result)
        if (!BACKEND_FAILURE_MARKERS.some((marker) => text.includes(marker))) return decision
        const original = Array.isArray(result?.content) ? result.content : []
        return { kind: 'accept', content: [...original, { type: 'text', text: REMEDIATION_TEXT }] }
      } catch (error) {
        logger?.warn?.(`sandbox-temp-guard: annotation failed: ${error?.message ?? error}`)
        return decision
      }
    })
  }

  // 3. Periodic backstop for background sessions that execute no tools.
  if (config.sweepIntervalMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          repairSandboxTemp(ctx)
        } catch (error) {
          logger?.warn?.(`sandbox-temp-guard: periodic sweep failed: ${error?.message ?? error}`)
        }
      }, config.sweepIntervalMs)
      return () => clearInterval(timer)
    })
  }

  // 4. Best-effort one-shot sweep at activation.
  try {
    repairSandboxTemp(ctx)
  } catch (error) {
    logger?.warn?.(`sandbox-temp-guard: activation sweep failed: ${error?.message ?? error}`)
  }
}

export default apply
