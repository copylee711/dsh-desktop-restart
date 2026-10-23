/**
 * Safety guards, desktop topology detection, and profile change tracking.
 */

import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { basename, join } from 'node:path'

export interface DesktopTopology {
  desktop: boolean
  reason?: string
  mainPid: number
  hostPid: number
  exe: string
}

export interface InstallLockStatus {
  installing: boolean
  pid: number | null
  stalePid: number | null
  parseError: boolean
}

export interface TaskSnapshot {
  runningTurns: number
  queuedSessions: number
  runningJobs: number
  busy: boolean
  summary: string
}

export interface ProfileSnapshot {
  dependencies: Record<string, string>
  bundles: string[]
  patchRaw: string
}

export interface PendingRestartInfo {
  count: number
  names: string[]
}

/** Check whether a PID is currently alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM on Windows/POSIX still means the process exists.
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

/**
 * Determine whether this host process is running inside the official DSH
 * Electron desktop shell.
 */
export function inspectDesktopHost(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  ppid: number = process.ppid,
  pid: number = process.pid,
  platform: NodeJS.Platform = process.platform,
): DesktopTopology {
  if (platform !== 'win32') {
    return {
      desktop: false,
      reason: '当前仅支持 Windows 桌面版',
      mainPid: ppid,
      hostPid: pid,
      exe: execPath,
    }
  }
  const exeName = basename(execPath).toLowerCase()
  const isPlainNode = exeName === 'node.exe' || exeName === 'node'
  const runAsNode = env.ELECTRON_RUN_AS_NODE === '1' || Boolean(env.DSH_DESKTOP_NODE_EXECUTABLE)
  if (isPlainNode && !runAsNode) {
    return {
      desktop: false,
      reason: '当前运行在普通 Node (dsh web) 环境，非 Electron 桌面客户端',
      mainPid: ppid,
      hostPid: pid,
      exe: execPath,
    }
  }
  if (!Number.isInteger(ppid) || ppid <= 1 || !isPidAlive(ppid)) {
    return {
      desktop: false,
      reason: '未找到存活的 Electron 主进程',
      mainPid: ppid,
      hostPid: pid,
      exe: execPath,
    }
  }
  return {
    desktop: true,
    mainPid: ppid,
    hostPid: pid,
    exe: env.DSH_DESKTOP_NODE_EXECUTABLE || execPath,
  }
}

/**
 * Inspect `<profileDir>/.plugin-manager/run.json` to see if `pnpm` is actively
 * modifying the profile.
 */
export function inspectInstallLock(
  profileDir: string,
  aliveCheck: (pid: number) => boolean = isPidAlive,
): InstallLockStatus {
  const runFile = join(profileDir, '.plugin-manager', 'run.json')
  if (!existsSync(runFile)) {
    return { installing: false, pid: null, stalePid: null, parseError: false }
  }
  try {
    const raw = readFileSync(runFile, 'utf8').trim()
    if (raw === '') return { installing: false, pid: null, stalePid: null, parseError: false }
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    const pid = Number(parsed?.pid ?? parsed?.processId)
    if (!Number.isInteger(pid) || pid <= 1) {
      return { installing: false, pid: null, stalePid: null, parseError: true }
    }
    if (aliveCheck(pid)) {
      return { installing: true, pid, stalePid: null, parseError: false }
    }
    return { installing: false, pid: null, stalePid: pid, parseError: false }
  } catch {
    return { installing: false, pid: null, stalePid: null, parseError: true }
  }
}

/**
 * Inspect `agents` and `jobs` services to see if restarting now would interrupt
 * running turns, queued messages, or background jobs.
 */
export function inspectActiveTasks(agentsService: unknown, jobsService: unknown): TaskSnapshot {
  let runningTurns = 0
  let queuedSessions = 0
  let runningJobs = 0

  const agentIds: (string | undefined)[] = [undefined]

  try {
    const listFn = (agentsService as { list?: () => unknown[] } | null | undefined)?.list
    if (typeof listFn === 'function') {
      const list = listFn.call(agentsService)
      if (Array.isArray(list)) {
        for (const item of list) {
          const agent = item as {
            id?: string
            status?: string
            inbox?: { nextTurn?: unknown[]; nextStep?: unknown[] }
          } | null
          if (!agent || typeof agent !== 'object') continue
          if (typeof agent.id === 'string' && agent.id !== '') agentIds.push(agent.id)
          if (agent.status === 'running') runningTurns += 1
          const nextTurn = Array.isArray(agent.inbox?.nextTurn) ? agent.inbox.nextTurn.length : 0
          const nextStep = Array.isArray(agent.inbox?.nextStep) ? agent.inbox.nextStep.length : 0
          if (nextTurn + nextStep > 0) queuedSessions += 1
        }
      }
    }
  } catch {
    /* ignore missing service */
  }

  try {
    const listJobsFn = (jobsService as { list?: (agentId?: string) => unknown[] } | null | undefined)?.list
    if (typeof listJobsFn === 'function') {
      const seenJobIds = new Set<string>()
      for (const agentId of agentIds) {
        const jobs = listJobsFn.call(jobsService, agentId)
        if (!Array.isArray(jobs)) continue
        for (const item of jobs) {
          const job = item as { id?: string; status?: string } | null
          if (!job || typeof job !== 'object') continue
          if (job.status !== 'running' && job.status !== 'stopping') continue
          const key = typeof job.id === 'string' && job.id !== '' ? job.id : `${String(agentId)}:${runningJobs}`
          if (seenJobIds.has(key)) continue
          seenJobIds.add(key)
          runningJobs += 1
        }
      }
    }
  } catch {
    /* ignore missing service */
  }

  const parts: string[] = []
  if (runningTurns > 0) parts.push(`${runningTurns} 个会话正在生成或运行工具`)
  if (queuedSessions > 0) parts.push(`${queuedSessions} 个会话有排队消息`)
  if (runningJobs > 0) parts.push(`${runningJobs} 个后台任务正在运行`)

  const busy = runningTurns > 0 || queuedSessions > 0 || runningJobs > 0
  return {
    runningTurns,
    queuedSessions,
    runningJobs,
    busy,
    summary: busy ? `当前有任务正在运行（${parts.join('、')}）` : '',
  }
}

/** Capture the current on-disk state of a DSH profile directory. */
export function captureProfileSnapshot(profileDir: string): ProfileSnapshot {
  const dependencies: Record<string, string> = {}
  const bundles: string[] = []
  let patchRaw = ''

  try {
    const pkgPath = join(profileDir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, unknown>
        dsh?: { profile?: { bundles?: unknown[] } }
      }
      if (pkg?.dependencies && typeof pkg.dependencies === 'object') {
        for (const [k, v] of Object.entries(pkg.dependencies)) {
          if (typeof v === 'string') {
            // Also include installed version in node_modules if present so in-place updates are detected
            let installedVer = ''
            try {
              const modPkgPath = join(profileDir, 'node_modules', k, 'package.json')
              if (existsSync(modPkgPath)) {
                const modPkg = JSON.parse(readFileSync(modPkgPath, 'utf8')) as { version?: unknown }
                if (typeof modPkg?.version === 'string') installedVer = `@${modPkg.version}`
              }
            } catch {
              /* ignore */
            }
            dependencies[k] = `${v}${installedVer}`
          }
        }
      }
      if (Array.isArray(pkg?.dsh?.profile?.bundles)) {
        for (const b of pkg.dsh.profile.bundles) {
          if (typeof b === 'string') bundles.push(b)
        }
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const patchPath = join(profileDir, 'cordis.patch.yml')
    if (existsSync(patchPath)) {
      patchRaw = readFileSync(patchPath, 'utf8').trim()
    }
  } catch {
    /* ignore */
  }

  return { dependencies, bundles, patchRaw }
}

/** Compare baseline profile snapshot against current disk state to detect pending plugin restarts. */
export function diffProfileSnapshot(baseline: ProfileSnapshot, current: ProfileSnapshot): PendingRestartInfo {
  const changed = new Set<string>()
  const allDeps = new Set([...Object.keys(baseline.dependencies), ...Object.keys(current.dependencies)])
  for (const name of allDeps) {
    if (baseline.dependencies[name] !== current.dependencies[name]) {
      changed.add(name)
    }
  }
  const baseBundles = new Set(baseline.bundles)
  const currBundles = new Set(current.bundles)
  for (const b of new Set([...baseBundles, ...currBundles])) {
    if (baseBundles.has(b) !== currBundles.has(b)) {
      changed.add(b)
    }
  }
  if (changed.size === 0 && baseline.patchRaw !== current.patchRaw) {
    changed.add('cordis.patch.yml')
  }
  const names = [...changed]
  return { count: names.length, names }
}

function isLoopbackHostHeader(host: string | undefined): boolean {
  if (typeof host !== 'string' || host.trim() === '') return false
  const trimmed = host.trim().toLowerCase()
  return (
    /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d{1,5})?$/u.test(trimmed)
  )
}

/**
 * Verify that a request comes from the local loopback peer without proxy
 * forwarding headers, and matches either same-origin browser headers or the
 * headerless DSH Desktop proxy shape.
 */
export function trustedLoopbackRequest(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
): boolean {
  const addr = request.socket?.remoteAddress
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
  const headers = request.headers ?? {}
  if (
    headers.forwarded !== undefined ||
    headers['x-forwarded-for'] !== undefined ||
    headers['x-real-ip'] !== undefined
  ) {
    return false
  }
  const secFetchSite = headers['sec-fetch-site']
  if (
    typeof secFetchSite === 'string' &&
    secFetchSite !== 'same-origin' &&
    secFetchSite !== 'none'
  ) {
    return false
  }
  const host = headers.host
  const origin = headers.origin
  // DSH Desktop's internal protocol proxy strips both Host and Origin
  if (host === undefined && origin === undefined) return true
  if (!isLoopbackHostHeader(host)) return false
  if (origin === undefined) return true
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}
