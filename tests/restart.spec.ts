import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  captureProfileSnapshot,
  diffProfileSnapshot,
  inspectActiveTasks,
  inspectDesktopHost,
  inspectInstallLock,
  trustedLoopbackRequest,
} from '../src/guard.js'
import {
  launchEnvFrom,
  leftoverPids,
  normalizePath,
  parseNetstatListeners,
  relaunchArgsFrom,
  tokenizeCommandLine,
} from '../src/helper.js'
import {
  apply as applyHost,
  readRestartReceipt,
  ROUTE_RESTART,
  ROUTE_STATUS,
} from '../src/index.js'
import { extractMarketRestartNames } from '../src/client/market-bridge.js'

describe('helper pure functions', () => {
  it('normalizes Windows and POSIX paths case-insensitively', () => {
    expect(normalizePath('D:/dev/DeepSeek Harness/DeepSeek Harness.exe\\')).toBe(
      'd:\\dev\\deepseek harness\\deepseek harness.exe',
    )
  })

  it('tokenizes Windows command lines and extracts safe relaunch arguments', () => {
    const exe = 'D:\\dev\\DeepSeek Harness\\DeepSeek Harness.exe'
    const cmd = `"${exe}" --user-data-dir="C:\\Users\\Example\\AppData\\Roaming\\@deepseek-ai/dsh-desktop" --flag`
    expect(tokenizeCommandLine(cmd)).toEqual([
      exe,
      '--user-data-dir=C:\\Users\\Example\\AppData\\Roaming\\@deepseek-ai/dsh-desktop',
      '--flag',
    ])
    expect(relaunchArgsFrom(cmd, exe)).toEqual([
      '--user-data-dir=C:\\Users\\Example\\AppData\\Roaming\\@deepseek-ai/dsh-desktop',
      '--flag',
    ])
    // Rejects Chromium child and Node host command lines
    expect(relaunchArgsFrom(`"${exe}" --type=renderer`, exe)).toBeNull()
    expect(relaunchArgsFrom(`"${exe}" --expose-internals index.js`, exe)).toBeNull()
  })

  it('strips ELECTRON_RUN_AS_NODE and stale session env vars while keeping DSH_HOME/PROFILE', () => {
    const cleaned = launchEnvFrom({
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP_NODE_EXECUTABLE: 'D:\\DeepSeek Harness.exe',
      DSH_SESSION_ID: 'abc',
      DSH_WEB_URL: 'http://127.0.0.1:19387',
      DSH_SHELL: '1',
      DSH_HOME: 'C:\\Users\\Example\\.dsh',
      DSH_PROFILE: 'desktop',
    })
    expect(cleaned.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(cleaned.DSH_DESKTOP_NODE_EXECUTABLE).toBeUndefined()
    expect(cleaned.DSH_SESSION_ID).toBeUndefined()
    expect(cleaned.DSH_WEB_URL).toBeUndefined()
    expect(cleaned.DSH_SHELL).toBeUndefined()
    expect(cleaned.DSH_HOME).toBe('C:\\Users\\Example\\.dsh')
    expect(cleaned.DSH_PROFILE).toBe('desktop')
  })

  it('filters leftover PIDs belonging to the same executable while skipping main/host/helper', () => {
    const exe = 'D:\\dev\\DeepSeek Harness\\DeepSeek Harness.exe'
    const pids = leftoverPids(
      [
        { pid: 100, path: exe },
        { pid: 200, path: exe },
        { pid: 300, path: exe },
        { pid: 400, path: 'C:\\other\\DeepSeek Harness.exe' },
      ],
      exe,
      [100, 200],
    )
    expect(pids).toEqual([300])
  })

  it('parses netstat loopback listening ports', () => {
    const sample = [
      'Active Connections',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:19387        0.0.0.0:0              LISTENING       22312',
      '  TCP    192.168.1.5:8080       0.0.0.0:0              LISTENING       9999',
      '  TCP    [::1]:14246            [::]:0                 LISTENING       33445',
    ].join('\n')
    expect(parseNetstatListeners(sample)).toEqual([
      { port: 19387, pid: 22312 },
      { port: 14246, pid: 33445 },
    ])
  })
})

describe('guards and profile change detection', () => {
  it('identifies Electron desktop host vs plain node', () => {
    const nonDesktop = inspectDesktopHost({}, 'C:\\Program Files\\nodejs\\node.exe', process.ppid, process.pid, 'win32')
    expect(nonDesktop.desktop).toBe(false)

    const desktop = inspectDesktopHost(
      { ELECTRON_RUN_AS_NODE: '1' },
      'D:\\dev\\DeepSeek Harness\\DeepSeek Harness.exe',
      process.pid,
      process.pid,
      'win32',
    )
    expect(desktop.desktop).toBe(true)
  })

  it('checks .plugin-manager/run.json lock liveness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsdr-test-'))
    try {
      expect(inspectInstallLock(dir).installing).toBe(false)
      mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
      writeFileSync(join(dir, '.plugin-manager', 'run.json'), JSON.stringify({ pid: 424242 }), 'utf8')
      expect(inspectInstallLock(dir, () => true)).toEqual({
        installing: true,
        pid: 424242,
        stalePid: null,
        parseError: false,
      })
      expect(inspectInstallLock(dir, () => false)).toEqual({
        installing: false,
        pid: null,
        stalePid: 424242,
        parseError: false,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('summarizes active agents and background jobs', () => {
    const idle = inspectActiveTasks({ list: () => [{ id: 's1', status: 'idle', inbox: { nextTurn: [], nextStep: [] } }] }, { list: () => [] })
    expect(idle.busy).toBe(false)

    const busy = inspectActiveTasks(
      {
        list: () => [
          { id: 's1', status: 'running', inbox: { nextTurn: [], nextStep: [] } },
          { id: 's2', status: 'idle', inbox: { nextTurn: ['msg'], nextStep: [] } },
        ],
      },
      {
        list: () => [{ id: 'j1', status: 'running' }],
      },
    )
    expect(busy.busy).toBe(true)
    expect(busy.runningTurns).toBe(1)
    expect(busy.queuedSessions).toBe(1)
    expect(busy.runningJobs).toBe(1)
    expect(busy.summary).toContain('1 个会话正在生成或运行工具')
  })

  it('detects profile dependency and bundle changes requiring restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsdr-prof-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          dependencies: { dshmarket: '^1.66.45' },
          dsh: { profile: { bundles: ['dshmarket'] } },
        }),
        'utf8',
      )
      const base = captureProfileSnapshot(dir)
      expect(diffProfileSnapshot(base, captureProfileSnapshot(dir)).count).toBe(0)

      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          dependencies: { dshmarket: '^1.66.45', '@copylee/dsh-desktop-restart': '^0.1.0' },
          dsh: { profile: { bundles: ['dshmarket', '@copylee/dsh-desktop-restart'] } },
        }),
        'utf8',
      )
      const diff = diffProfileSnapshot(base, captureProfileSnapshot(dir))
      expect(diff.count).toBe(1)
      expect(diff.names).toEqual(['@copylee/dsh-desktop-restart'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validates loopback and desktop proxy requests', () => {
    expect(
      trustedLoopbackRequest({
        socket: { remoteAddress: '127.0.0.1' } as any,
        headers: {},
      }),
    ).toBe(true)

    expect(
      trustedLoopbackRequest({
        socket: { remoteAddress: '127.0.0.1' } as any,
        headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
      }),
    ).toBe(true)

    expect(
      trustedLoopbackRequest({
        socket: { remoteAddress: '127.0.0.1' } as any,
        headers: { host: 'evil.example.com', origin: 'http://evil.example.com' },
      }),
    ).toBe(false)

    expect(
      trustedLoopbackRequest({
        socket: { remoteAddress: '127.0.0.1' } as any,
        headers: { 'x-forwarded-for': '1.2.3.4' },
      }),
    ).toBe(false)
  })

  it('extracts restart-pending package names from dsh-market /installed payload', () => {
    expect(
      extractMarketRestartNames({
        activation: {
          '@copylee/dsh-academic': { state: 'live' },
          'dsh-tool-antigravity': { state: 'restart' },
        },
      }),
    ).toEqual(['dsh-tool-antigravity'])
  })

  it('computes restart receipts only when hostPid changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsdr-state-'))
    try {
      const marker = join(dir, 'last-restart.json')
      writeFileSync(marker, JSON.stringify({ at: new Date(Date.now() - 4000).toISOString(), hostPid: 1111 }), 'utf8')
      expect(readRestartReceipt(marker, 1111)).toBeNull()
      const rec = readRestartReceipt(marker, 2222)
      expect(rec).not.toBeNull()
      expect(rec?.previousHostPid).toBe(1111)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('registers status and restart routes on host webServer', async () => {
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
    applyHost(
      {
        webServer: {
          port: 19387,
          registerRoute(entry) {
            routes.set(entry.path, entry.handler)
            return () => routes.delete(entry.path)
          },
        },
      },
      { enabled: true },
    )
    expect(routes.has(ROUTE_STATUS)).toBe(true)
    expect(routes.has(ROUTE_RESTART)).toBe(true)

    let statusCode = 0
    let bodyText = ''
    const mockRes = {
      writeHead(code: number) {
        statusCode = code
      },
      end(chunk?: string) {
        bodyText = chunk ?? ''
      },
    } as unknown as ServerResponse

    await routes.get(ROUTE_STATUS)!(
      {
        method: 'GET',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as IncomingMessage,
      mockRes,
    )
    expect(statusCode).toBe(200)
    const parsed = JSON.parse(bodyText) as { ok: boolean; enabled: boolean; desktop: boolean }
    expect(parsed.ok).toBe(true)
    expect(parsed.enabled).toBe(true)
    expect(parsed.desktop).toBe(false)

    // Verify POST /api/dsh-desktop-restart/restart safely refuses with 409 not-desktop when run in plain Node/Web mode
    await routes.get(ROUTE_RESTART)!(
      {
        method: 'POST',
        headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as IncomingMessage,
      mockRes,
    )
    expect(statusCode).toBe(409)
    const restartParsed = JSON.parse(bodyText) as { ok: boolean; code: string }
    expect(restartParsed.ok).toBe(false)
    expect(restartParsed.code).toBe('not-desktop')
  })
})
