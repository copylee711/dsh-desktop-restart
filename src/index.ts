/**
 * Host plugin for @copylee/dsh-desktop-restart.
 *
 * Registers:
 * - GET  /api/dsh-desktop-restart/status  — desktop topology, active tasks, install lock, pending plugin changes, last restart receipt
 * - POST /api/dsh-desktop-restart/restart — guarded one-click restart handoff to lib/helper.cjs
 * - /restart slash command
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import {
  captureProfileSnapshot,
  diffProfileSnapshot,
  inspectActiveTasks,
  inspectDesktopHost,
  inspectInstallLock,
  trustedLoopbackRequest,
  type PendingRestartInfo,
} from './guard.js'
import type { HandoffDescriptor } from './helper.js'

export const name = 'copylee-desktop-restart'
export const inject = ['webServer']

export interface PluginConfig {
  enabled?: boolean
}

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .volatile()
    .description('启用桌面版一键重启按钮')
    .i18n({ 'zh-CN': '启用桌面版一键重启按钮', 'en-US': 'Enable one-click desktop restart button' }),
})

export const ROUTE_STATUS = '/api/dsh-desktop-restart/status'
export const ROUTE_RESTART = '/api/dsh-desktop-restart/restart'

const HELPER_PATH = fileURLToPath(new URL('./helper.cjs', import.meta.url))
const STATE_KEEP = 20

export interface RestartReceipt {
  at: string
  downtimeMs: number
  previousHostPid: number
}

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

export function resolveProfileDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.DSH_PROFILE_DIR) return env.DSH_PROFILE_DIR
  if (existsSync(join(cwd, 'package.json')) && existsSync(join(cwd, 'cordis.yml'))) return cwd
  return join(resolveDshHome(env), 'profiles', env.DSH_PROFILE || 'desktop')
}

export function readRestartReceipt(markerFile: string, currentHostPid: number, nowMs: number = Date.now()): RestartReceipt | null {
  try {
    if (!existsSync(markerFile)) return null
    const parsed = JSON.parse(readFileSync(markerFile, 'utf8')) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return null
    const at = typeof parsed.at === 'string' ? parsed.at : ''
    const atMs = Date.parse(at)
    const previousHostPid = Number(parsed.hostPid)
    if (!Number.isFinite(atMs) || !Number.isInteger(previousHostPid)) return null
    if (previousHostPid === currentHostPid) return null
    return {
      at,
      downtimeMs: Math.max(0, nowMs - atMs),
      previousHostPid,
    }
  } catch {
    return null
  }
}

function pruneOldLogs(stateDir: string, keep: number = STATE_KEEP): void {
  try {
    if (!existsSync(stateDir)) return
    const files = readdirSync(stateDir)
      .filter(f => /^(?:restart|handoff)-\d/.test(f))
      .sort()
    const excess = files.length - keep * 2
    for (let i = 0; i < excess; i += 1) {
      try {
        unlinkSync(join(stateDir, files[i]!))
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

export interface HostContextLike {
  webServer: {
    port?: number
    registerRoute(entry: {
      kind: 'exact'
      path: string
      handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
    }): () => void
  }
  get?(name: string): unknown
  effect?(fn: () => (() => void) | void, label?: string): void
  on?(event: string, listener: (...args: unknown[]) => void): () => void
}

export function apply(ctx: HostContextLike, initialConfig: PluginConfig = {}): void {
  let liveConfig: PluginConfig = { ...initialConfig }
  const dshHome = resolveDshHome()
  const stateDir = join(dshHome, 'desktop-restart')
  const markerFile = join(stateDir, 'last-restart.json')
  const profileDir = resolveProfileDir()

  const baselineProfile = captureProfileSnapshot(profileDir)
  const receipt = readRestartReceipt(markerFile, process.pid)
  let restartInFlight = false

  ctx.on?.('loader/volatile-update', (next: unknown) => {
    if (next && typeof next === 'object') {
      liveConfig = { ...liveConfig, ...(next as PluginConfig) }
    }
  })

  const checkPlatformAuth = (request: IncomingMessage): 401 | 403 | undefined => {
    try {
      const connection = ctx.get?.('connection') as {
        requestRejection?: (req: IncomingMessage) => 401 | 403 | undefined
      } | undefined
      if (typeof connection?.requestRejection === 'function') {
        return connection.requestRejection(request)
      }
    } catch {
      /* ignore if connection service throws */
    }
    return undefined
  }

  const computePendingRestart = (): PendingRestartInfo => {
    const current = captureProfileSnapshot(profileDir)
    return diffProfileSnapshot(baselineProfile, current)
  }

  const scheduleDesktopRestart = (portHint: number | null): { handoffPath: string; logPath: string; helperPid?: number } => {
    const topology = inspectDesktopHost()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    mkdirSync(stateDir, { recursive: true })
    pruneOldLogs(stateDir)

    const handoffPath = join(stateDir, `handoff-${stamp}.json`)
    const logPath = join(stateDir, `restart-${stamp}.log`)
    const port = typeof ctx.webServer.port === 'number' && ctx.webServer.port > 0 ? ctx.webServer.port : portHint

    const handoff: HandoffDescriptor = {
      mainPid: topology.mainPid,
      hostPid: topology.hostPid,
      exe: topology.exe,
      port,
      logPath,
      delayMs: 1_000,
    }

    writeFileSync(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8')
    try {
      writeFileSync(
        markerFile,
        `${JSON.stringify({ at: new Date().toISOString(), hostPid: process.pid, mainPid: topology.mainPid }, null, 2)}\n`,
        'utf8',
      )
    } catch {
      /* ignore marker write error */
    }

    const child = spawn(topology.exe, [HELPER_PATH, handoffPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
    })
    child.unref()
    return { handoffPath, logPath, helperPid: child.pid }
  }

  const offStatus = ctx.webServer.registerRoute({
    kind: 'exact',
    path: ROUTE_STATUS,
    handler: (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      if (!trustedLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: '仅允许本机回环请求访问' })
        return
      }
      const topology = inspectDesktopHost()
      const installLock = inspectInstallLock(profileDir)
      const tasks = inspectActiveTasks(ctx.get?.('agents'), ctx.get?.('jobs'))
      const pendingRestart = computePendingRestart()

      sendJson(response, 200, {
        ok: true,
        enabled: liveConfig.enabled !== false,
        desktop: topology.desktop,
        desktopReason: topology.reason ?? null,
        mainPid: topology.mainPid,
        hostPid: topology.hostPid,
        exe: topology.exe,
        restarting: restartInFlight,
        installing: installLock.installing,
        installPid: installLock.pid,
        tasks,
        pendingRestart,
        receipt,
      })
    },
  })

  const offRestart = ctx.webServer.registerRoute({
    kind: 'exact',
    path: ROUTE_RESTART,
    handler: (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!trustedLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, code: 'forbidden', error: '仅允许来自本机页面的重启请求' })
        return
      }
      const rejection = checkPlatformAuth(request)
      if (rejection !== undefined) {
        sendJson(response, rejection, {
          ok: false,
          code: rejection === 401 ? 'unauthorized' : 'forbidden',
          error: rejection === 401 ? '缺少浏览器会话凭据' : '同源校验未通过',
        })
        return
      }
      if (liveConfig.enabled === false) {
        sendJson(response, 403, { ok: false, code: 'disabled', error: '重启功能已在配置中禁用' })
        return
      }
      const topology = inspectDesktopHost()
      if (!topology.desktop) {
        sendJson(response, 409, {
          ok: false,
          code: 'not-desktop',
          error: topology.reason ?? '当前不是 Electron 桌面客户端，无法执行桌面重启',
        })
        return
      }
      if (restartInFlight) {
        sendJson(response, 409, { ok: false, code: 'already-restarting', error: '重启已在执行中，请稍候…' })
        return
      }

      const installLock = inspectInstallLock(profileDir)
      if (installLock.installing) {
        sendJson(response, 409, {
          ok: false,
          code: 'installing',
          blocked: true,
          error: '插件正在安装或更新中，请等待操作完成后再重启（中断 pnpm 会损坏插件依赖）',
        })
        return
      }

      const urlObj = new URL(request.url ?? ROUTE_RESTART, 'http://127.0.0.1')
      const force = urlObj.searchParams.get('force') === '1'
      const tasks = inspectActiveTasks(ctx.get?.('agents'), ctx.get?.('jobs'))
      if (tasks.busy && !force) {
        sendJson(response, 409, {
          ok: false,
          code: 'busy-tasks',
          blocked: false,
          tasks,
          error: `${tasks.summary}。再次点击确认后将强制重启。`,
        })
        return
      }

      restartInFlight = true
      const hostHeader = request.headers.host
      const portMatch = typeof hostHeader === 'string' ? /:(\d{1,5})$/.exec(hostHeader) : null
      const portHint = portMatch ? Number(portMatch[1]) : null

      try {
        const result = scheduleDesktopRestart(portHint)
        sendJson(response, 202, {
          ok: true,
          scheduled: true,
          helperPid: result.helperPid ?? null,
          message: '已排程重启，DeepSeek Harness 即将关闭并自动重新打开…',
        })
      } catch (error) {
        restartInFlight = false
        sendJson(response, 500, {
          ok: false,
          code: 'spawn-failed',
          error: `启动重启助手失败：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    },
  })

  let offCommand: (() => void) | undefined
  try {
    // Only register /restart on verified Electron Desktop so Web deployments are completely untouched
    if (inspectDesktopHost().desktop) {
      const commands = ctx.get?.('commands') as {
        register?: (def: {
          name: string
          description: string
          execute: (args?: string) => Promise<string> | string
        }) => () => void
      } | undefined
      if (typeof commands?.register === 'function') {
        offCommand = commands.register({
          name: 'restart',
          description: '重启 DeepSeek Harness 桌面客户端（带 --force 跳过任务运行警告）',
          execute: (rawArgs = '') => {
            const topology = inspectDesktopHost()
            if (!topology.desktop) return topology.reason ?? '当前不是桌面客户端，无法执行桌面重启。'
            const installLock = inspectInstallLock(profileDir)
            if (installLock.installing) return '插件正在安装或更新中，请等待完成后再执行 /restart。'
            const force = /\bforce\b|--force|-f\b/i.test(rawArgs)
            const tasks = inspectActiveTasks(ctx.get?.('agents'), ctx.get?.('jobs'))
            if (tasks.busy && !force) {
              return `${tasks.summary}。如确认打断并立即重启，请执行 \`/restart --force\`。`
            }
            if (restartInFlight) return '重启已在执行中，请稍候…'
            restartInFlight = true
            scheduleDesktopRestart(null)
            return '已触发重启，DeepSeek Harness 窗口即将关闭并自动重新打开…'
          },
        })
      }
    }
  } catch {
    /* ignore if commands service unavailable */
  }

  ctx.effect?.(() => () => {
    offStatus()
    offRestart()
    offCommand?.()
  }, 'copylee-desktop-restart: routes')
}

export default { name, inject, Config, apply }
