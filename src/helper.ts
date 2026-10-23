/**
 * Detached restart helper for DeepSeek Harness Desktop.
 *
 * Spawned with the application's own executable (`process.execPath`) under
 * `ELECTRON_RUN_AS_NODE=1` so it never depends on a system Node or `dsh` in PATH.
 *
 * Sequence:
 * 1. Wait briefly so the HTTP 202 response reaches the renderer first.
 * 2. Read the Electron main process command line so original flags (e.g.
 *    `--user-data-dir`) can be preserved on relaunch.
 * 3. Terminate the Electron main process (`taskkill /PID <mainPid> /F` WITHOUT `/T`).
 *    The host child receives an IPC `disconnect` event and runs its own graceful
 *    `application.shutdown.shutdown(0)`, flushing session logs to disk.
 * 4. Wait for the main process to exit and the listening port to be released.
 *    If the port remains held past the timeout, clean up leftover processes from
 *    the same executable path.
 * 5. Strip `ELECTRON_RUN_AS_NODE`, `DSH_DESKTOP_NODE_EXECUTABLE`, `DSH_SESSION_ID`,
 *    `DSH_WEB_URL`, and `DSH_SHELL`, then launch a fresh `DeepSeek Harness.exe`
 *    instance and verify that it stays alive.
 */

import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'

export const MAIN_EXIT_TIMEOUT_MS = 15_000
export const PORT_FREE_TIMEOUT_MS = 30_000
export const DEFAULT_DELAY_MS = 1_200
export const DEFAULT_RELAUNCH_ATTEMPTS = 3
export const DEFAULT_RELAUNCH_VERIFY_MS = 2_500
export const RELAUNCH_RETRY_GAP_MS = 1_500
export const PORT_RELISTEN_TIMEOUT_MS = 20_000
export const PROCESS_QUERY_TIMEOUT_MS = 8_000

export interface HandoffDescriptor {
  mainPid: number
  hostPid: number
  exe: string
  port?: number | null
  logPath?: string
  delayMs?: number
  relaunchAttempts?: number
  relaunchVerifyMs?: number
  mainExitTimeoutMs?: number
  portFreeTimeoutMs?: number
  portRelistenTimeoutMs?: number
  alertOnFailure?: boolean
}

export interface ProcessEntry {
  pid: number
  path: string | null
  commandLine?: string | null
}

export interface NetstatListener {
  port: number
  pid: number
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Normalize Windows/POSIX file paths for case-insensitive comparison. */
export function normalizePath(value: string | null | undefined): string {
  return String(value ?? '').replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
}

/** Tokenize a Windows command line into arguments. */
export function tokenizeCommandLine(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (ch === '\\' && text[i + 1] === '"') {
      current += '"'
      started = true
      i += 1
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes
      started = true
      continue
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * Extract safe launch arguments from the Electron main process command line.
 * Refuses Chromium child flags (`--type=`) and host flags (`--expose-internals`).
 */
export function relaunchArgsFrom(commandLine: string | null | undefined, exe: string): string[] | null {
  if (typeof commandLine !== 'string' || commandLine.trim() === '') return null
  if (commandLine.includes('\\"')) return null
  const tokens = tokenizeCommandLine(commandLine)
  if (tokens.length === 0) return null
  if (normalizePath(tokens[0]) !== normalizePath(exe)) return null
  const args = tokens.slice(1)
  for (const arg of args) {
    if (/^--type=/u.test(arg) || arg === '--expose-internals') return null
  }
  return args
}

/**
 * Strip Node-mode and stale host session environment variables before launching
 * the replacement Electron GUI process.
 */
export function launchEnvFrom(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    if (
      upper === 'ELECTRON_RUN_AS_NODE' ||
      upper === 'DSH_DESKTOP_NODE_EXECUTABLE' ||
      upper === 'DSH_SESSION_ID' ||
      upper === 'DSH_WEB_URL' ||
      upper === 'DSH_SHELL'
    ) {
      delete env[key]
    }
  }
  return env
}

/** Select leftover PIDs belonging to the exact same executable path, excluding skipped PIDs. */
export function leftoverPids(
  processes: readonly ProcessEntry[],
  exe: string,
  skip: readonly (number | undefined)[] = [],
): number[] {
  const wanted = normalizePath(exe)
  const skipSet = new Set(skip.filter((pid): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0))
  const pids: number[] = []
  for (const entry of Array.isArray(processes) ? processes : []) {
    if (!Number.isInteger(entry?.pid) || entry.pid <= 0) continue
    if (typeof entry.path !== 'string' || entry.path === '') continue
    if (normalizePath(entry.path) !== wanted) continue
    if (skipSet.has(entry.pid)) continue
    pids.push(entry.pid)
  }
  return pids
}

/** Parse `netstat -ano` output into loopback listening TCP entries. */
export function parseNetstatListeners(text: string): NetstatListener[] | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  const rows: NetstatListener[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/u.exec(line)
    if (match === null) continue
    const addr = match[1]!
    if (!/^(?:127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|\[::\])$/u.test(addr)) continue
    const port = Number(match[2])
    const pid = Number(match[3])
    if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(pid) || pid <= 0) continue
    rows.push({ port, pid })
  }
  return rows
}

/** Query running processes matching `exeName` via PowerShell CIM. */
export function queryApplicationProcesses(exeName: string): ProcessEntry[] | null {
  const safeName = String(exeName).replace(/'/gu, "''")
  const script = [
    "$ProgressPreference='SilentlyContinue'",
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    `Get-CimInstance Win32_Process -Filter "Name='${safeName}'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  let out = ''
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      out = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        encoding: 'utf8',
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
      break
    } catch (error) {
      out = ''
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return null
    }
  }
  const trimmed = out.trim()
  if (trimmed === '') return []
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list
      .map(entry => {
        const rec = entry as Record<string, unknown> | null
        return {
          pid: Number(rec?.ProcessId),
          path: typeof rec?.ExecutablePath === 'string' ? rec.ExecutablePath : null,
          commandLine: typeof rec?.CommandLine === 'string' ? rec.CommandLine : null,
        }
      })
      .filter(entry => Number.isInteger(entry.pid) && entry.pid > 0)
  } catch {
    return null
  }
}

function alertUser(text: string): boolean {
  const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${JSON.stringify(text)}, 'DeepSeek Harness') | Out-Null`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      return true
    } catch {
      /* try next shell */
    }
  }
  return false
}

export async function performRestart(handoff: HandoffDescriptor, note: (line: string) => void): Promise<void> {
  const mainPid = Number(handoff.mainPid)
  const exe = String(handoff.exe ?? '')
  const hostPid = Number(handoff.hostPid)
  const port = Number(handoff.port)
  const delayMs = Number(handoff.delayMs) > 0 ? Number(handoff.delayMs) : DEFAULT_DELAY_MS
  const attempts = Number(handoff.relaunchAttempts) > 0 ? Number(handoff.relaunchAttempts) : DEFAULT_RELAUNCH_ATTEMPTS
  const verifyMs = Number(handoff.relaunchVerifyMs) > 0 ? Number(handoff.relaunchVerifyMs) : DEFAULT_RELAUNCH_VERIFY_MS
  const mainExitTimeoutMs =
    Number(handoff.mainExitTimeoutMs) > 0 ? Number(handoff.mainExitTimeoutMs) : MAIN_EXIT_TIMEOUT_MS
  const portFreeTimeoutMs =
    Number(handoff.portFreeTimeoutMs) > 0 ? Number(handoff.portFreeTimeoutMs) : PORT_FREE_TIMEOUT_MS
  const portRelistenTimeoutMs =
    Number(handoff.portRelistenTimeoutMs) > 0 ? Number(handoff.portRelistenTimeoutMs) : PORT_RELISTEN_TIMEOUT_MS
  const alertOnFailure = handoff.alertOnFailure !== false

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  const listening = (p: number): Promise<boolean> =>
    new Promise(resolve => {
      let settled = false
      const probe = net.connect({ host: '127.0.0.1', port: p })
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        probe.destroy()
        resolve(value)
      }
      probe.on('connect', () => finish(true))
      probe.on('error', () => finish(false))
      probe.setTimeout(500, () => finish(false))
    })

  const killPid = (pid: number): boolean => {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
      return true
    } catch {
      return false
    }
  }

  const tasklist = (args: string[]): Array<{ image: string; pid: number }> | null => {
    try {
      const out = execFileSync('tasklist', args, { encoding: 'utf8', windowsHide: true })
      return [...out.matchAll(/"([^"]*)","(\d+)"/gu)]
        .map(m => ({ image: m[1]!, pid: Number(m[2]) }))
        .filter(e => Number.isInteger(e.pid) && e.pid > 0)
    } catch {
      return null
    }
  }

  const imageNameOf = (pid: number): { known: boolean; image: string | null } => {
    const rows = tasklist(['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'])
    if (rows === null) return { known: false, image: null }
    const found = rows.find(e => e.pid === pid)
    return { known: true, image: found === undefined ? null : found.image }
  }

  const applicationPids = (): number[] | null => {
    if (exe === '') return []
    const rows = tasklist(['/FI', `IMAGENAME eq ${path.basename(exe)}`, '/FO', 'CSV', '/NH'])
    return rows === null ? null : rows.map(e => e.pid)
  }

  const listListening = (): NetstatListener[] | null => {
    try {
      const out = execFileSync('netstat', ['-ano'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
      })
      return parseNetstatListeners(out)
    } catch {
      return null
    }
  }

  note(`helper started: helper=${process.pid} host=${hostPid} main=${mainPid} port=${port} exe=${exe}`)

  if (!Number.isInteger(mainPid) || mainPid <= 1) {
    note('refusing: the handoff carries no usable main process id')
    return
  }
  if (exe === '') {
    note('refusing: the handoff carries no application executable')
    return
  }

  await sleep(delayMs)

  const processes = queryApplicationProcesses(path.basename(exe))
  const mainEntry = Array.isArray(processes) ? processes.find(e => e.pid === mainPid) ?? null : null
  const relaunchArgs = relaunchArgsFrom(mainEntry?.commandLine, exe)
  note(
    relaunchArgs === null
      ? 'launch arguments unavailable; relaunching with no arguments'
      : `preserving ${String(relaunchArgs.length)} launch argument(s): ${JSON.stringify(relaunchArgs)}`,
  )

  const expected = path.basename(exe).toLowerCase()
  const probe = imageNameOf(mainPid)
  if (probe.known && probe.image !== null && probe.image.toLowerCase() !== expected) {
    note(`refusing: pid ${mainPid} is "${probe.image}", not "${expected}"`)
    return
  }
  if (!probe.known) {
    note(`could not read the process table; ending pid ${mainPid} without an image-name check`)
    note(killPid(mainPid) ? `taskkill /PID ${mainPid} /F ok` : `taskkill /PID ${mainPid} /F reported an error`)
  } else if (probe.image === null) {
    note(`main process ${mainPid} is already gone; skipping the kill`)
  } else {
    note(`ending the Electron main process ${mainPid} ("${probe.image}") without /T, so the host can close gracefully`)
    note(killPid(mainPid) ? `taskkill /PID ${mainPid} /F ok` : `taskkill /PID ${mainPid} /F reported an error`)
  }

  const goneBy = Date.now() + mainExitTimeoutMs
  while (Date.now() < goneBy && alive(mainPid)) await sleep(200)
  note(alive(mainPid) ? `main process still alive after ${mainExitTimeoutMs}ms` : 'main process exited')

  if (Number.isInteger(port) && port > 0) {
    const freeBy = Date.now() + portFreeTimeoutMs
    while (Date.now() < freeBy && (await listening(port))) await sleep(300)
    if (await listening(port)) {
      note(`port ${port} is still held; terminating leftover application processes`)
      const skip = [process.pid, mainPid, hostPid]
      const own = Array.isArray(processes) ? leftoverPids(processes, exe, skip) : null
      let candidates: number[]
      if (own !== null && own.length > 0) {
        candidates = own
      } else {
        const byImage = applicationPids()
        if (byImage === null) {
          note('the process table is unavailable; no leftover process could be identified')
          candidates = []
        } else {
          candidates = byImage.filter(pid => !skip.includes(pid))
        }
      }
      for (const pid of candidates) {
        note(`killing leftover pid ${pid}`)
        killPid(pid)
      }
      await sleep(1_200)

      if (
        Number.isInteger(hostPid) &&
        hostPid > 1 &&
        hostPid !== process.pid &&
        hostPid !== mainPid &&
        (await listening(port)) &&
        alive(hostPid)
      ) {
        note(`the host (pid ${hostPid}) still holds port ${port}; ending it as a last resort`)
        killPid(hostPid)
        await sleep(1_200)
      }
    } else {
      note(`port ${port} released`)
    }
  }

  await sleep(600)

  const env = launchEnvFrom(process.env)
  let childPid: number | null = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      note(`relaunch attempt ${attempt}/${attempts} in ${RELAUNCH_RETRY_GAP_MS}ms`)
      await sleep(RELAUNCH_RETRY_GAP_MS)
    }
    let spawned: number | undefined
    try {
      const child = spawn(exe, relaunchArgs ?? [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: path.dirname(exe),
        env,
      })
      child.on('error', err => note(`relaunch failed: ${String(err?.message || err)}`))
      spawned = child.pid
      child.unref()
      note(`relaunched "${exe}" as pid ${String(spawned)}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
    } catch (error) {
      note(`relaunch threw: ${String((error as Error)?.stack || error)}`)
      continue
    }

    await sleep(verifyMs)
    if (typeof spawned === 'number' && Number.isInteger(spawned) && alive(spawned)) {
      note(`relaunched process (pid ${String(spawned)}) is still alive after ${verifyMs}ms`)
      childPid = spawned
      break
    }
    note(`the relaunched process (pid ${String(spawned)}) is already gone — attempt ${attempt} did not take`)
  }

  if (childPid === null) {
    note(`the restart did not take after ${attempts} attempt(s); the application is not running`)
    if (alertOnFailure) {
      note(
        alertUser(
          `重启失败：DeepSeek Harness 未能自动重新打开。\n\n请手动启动应用（诊断日志：${String(handoff.logPath ?? '')}）。`,
        )
          ? 'failure notice dispatched to the user'
          : 'could not dispatch the failure notice',
      )
    }
    return
  }

  const quietPids = [process.pid, mainPid, hostPid]
  const listenBy = Date.now() + portRelistenTimeoutMs
  let readyPort: number | null = null
  let tableReadable = false
  while (Date.now() < listenBy) {
    const entries = listListening()
    if (entries !== null) {
      tableReadable = true
      const sameImage = applicationPids()
      if (sameImage !== null) {
        const candidates = entries.filter(e => sameImage.includes(e.pid) && !quietPids.includes(e.pid))
        if (candidates.length > 0) {
          readyPort = candidates[0]!.port
          break
        }
      }
    }
    await sleep(500)
  }
  if (readyPort !== null) {
    note(`the new instance is listening on port ${readyPort} — restart complete`)
  } else if (tableReadable) {
    note(`the new instance is alive but no listening port belongs to "${expected}" within ${portRelistenTimeoutMs}ms`)
  } else {
    note('the new instance is alive; the listening port table could not be read')
  }
}

async function start(): Promise<void> {
  const handoffPath = process.argv[2]
  if (typeof handoffPath !== 'string' || handoffPath === '') {
    process.exit(1)
  }
  let handoff: HandoffDescriptor
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8')) as HandoffDescriptor
  } catch {
    process.exit(1)
  }
  const logPath = String(handoff.logPath ?? '')
  const note = (line: string): void => {
    try {
      if (logPath !== '') fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* ignore logging errors */
    }
  }
  try {
    await performRestart(handoff, note)
  } catch (error) {
    note(`helper failed: ${String((error as Error)?.stack || error)}`)
  }
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  start().catch(() => {
    process.exitCode = 0
  })
}
