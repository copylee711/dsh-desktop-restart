/**
 * Client half of @copylee/dsh-desktop-restart.
 *
 * Mounts zero-config restart buttons in two places:
 * 1. Sidebar footer triggerRow portal button (sits cleanly beside the official
 *    DesktopUpdateIndicator and avoids overlapping @copylee/dsh-remote-control).
 *    Shows a compact "↻" icon button when idle, and switches to an eye-catching
 *    "↻ 需重启" pill whenever dsh-market or the host profile has pending plugin changes.
 * 2. In-place restart buttons inside dsh-market's pending-restart banner ("立即重启")
 *    and top titleActions bar ("↻ 重启应用").
 */

import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { createMarketBridge, type MarketBridgeState } from './market-bridge.js'
import { CSS } from './style.js'

const h = React.createElement

const ROUTE_STATUS = '/api/dsh-desktop-restart/status'
const ROUTE_RESTART = '/api/dsh-desktop-restart/restart'

const ARM_TIMEOUT_MS = 5_000

export interface HostStatus {
  ok: boolean
  enabled: boolean
  desktop: boolean
  desktopReason: string | null
  mainPid: number
  hostPid: number
  exe: string
  restarting: boolean
  installing: boolean
  installPid: number | null
  tasks: {
    runningTurns: number
    queuedSessions: number
    runningJobs: number
    busy: boolean
    summary: string
  }
  pendingRestart: {
    count: number
    names: string[]
  }
  receipt: {
    at: string
    downtimeMs: number
    previousHostPid: number
  } | null
}

export type ActionPhase = 'idle' | 'armed' | 'warn-tasks' | 'restarting' | 'error'

interface StoreSnapshot {
  status: HostStatus | null
  market: MarketBridgeState
  phase: ActionPhase
  message: string
}

function refreshIcon(size = 15, spin = false): React.ReactElement {
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className: spin ? 'dsdr-spin' : undefined,
      'aria-hidden': true,
    },
    h('path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
    h('path', { d: 'M3 3v5h5' }),
  )
}

class RestartController {
  private snapshot: StoreSnapshot = {
    status: null,
    market: { marketPendingCount: 0, marketPendingNames: [], marketBusy: false },
    phase: 'idle',
    message: '',
  }
  private listeners = new Set<() => void>()
  private armTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private marketBridge: ReturnType<typeof createMarketBridge> | null = null

  getSnapshot = (): StoreSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    this.marketBridge?.syncDom()
    for (const listener of this.listeners) listener()
  }

  private update(patch: Partial<StoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.emit()
  }

  private clearArmTimer(): void {
    if (this.armTimer !== null) {
      clearTimeout(this.armTimer)
      this.armTimer = null
    }
  }

  private scheduleDisarm(): void {
    this.clearArmTimer()
    this.armTimer = setTimeout(() => {
      if (this.snapshot.phase === 'armed' || this.snapshot.phase === 'warn-tasks' || this.snapshot.phase === 'error') {
        this.update({ phase: 'idle', message: '' })
      }
    }, ARM_TIMEOUT_MS)
  }

  totalPendingCount(): number {
    const hostCount = this.snapshot.status?.pendingRestart.count ?? 0
    const marketCount = this.snapshot.market.marketPendingCount
    return Math.max(hostCount, marketCount)
  }

  isInstalling(): boolean {
    return Boolean(this.snapshot.status?.installing) || this.snapshot.market.marketBusy
  }

  async refreshStatus(): Promise<void> {
    try {
      const res = await fetch(ROUTE_STATUS, { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as HostStatus
      if (data && data.ok) {
        if (!data.desktop && this.pollTimer !== null) {
          clearInterval(this.pollTimer)
          this.pollTimer = null
        }
        this.update({
          status: data,
          phase: data.restarting ? 'restarting' : this.snapshot.phase === 'restarting' ? 'idle' : this.snapshot.phase,
        })
      }
    } catch {
      /* Host is restarting or temporarily unreachable */
    }
  }

  handleButtonClick = (): void => {
    const { status, phase } = this.snapshot
    if (phase === 'restarting') return
    if (status && !status.desktop) {
      this.update({ phase: 'error', message: status.desktopReason ?? '仅支持在桌面版客户端中使用' })
      this.scheduleDisarm()
      return
    }
    if (this.isInstalling()) {
      this.update({ phase: 'error', message: '插件正在安装或更新中，请等待完成后再重启' })
      this.scheduleDisarm()
      return
    }

    if (phase === 'idle') {
      this.update({
        phase: 'armed',
        message: status?.tasks.busy ? `${status.tasks.summary}，再点一次确认重启` : '再点一次确认重启桌面应用',
      })
      this.scheduleDisarm()
      return
    }

    if (phase === 'armed') {
      void this.executeRestart(false)
      return
    }

    if (phase === 'warn-tasks' || phase === 'error') {
      void this.executeRestart(true)
    }
  }

  async executeRestart(force: boolean): Promise<void> {
    this.clearArmTimer()
    try {
      const url = force ? `${ROUTE_RESTART}?force=1` : ROUTE_RESTART
      const res = await fetch(url, { method: 'POST' })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        code?: string
        error?: string
        message?: string
      }
      if (res.status === 202 || data.ok) {
        this.update({
          phase: 'restarting',
          message: data.message ?? '正在重启 DeepSeek Harness，窗口即将关闭并自动重开…',
        })
        return
      }
      if (res.status === 409 && data.code === 'busy-tasks') {
        this.update({
          phase: 'warn-tasks',
          message: data.error ?? '当前有任务正在运行，再点一次将强制重启',
        })
        this.scheduleDisarm()
        return
      }
      this.update({
        phase: 'error',
        message: data.error ?? `重启请求未通过（HTTP ${res.status}）`,
      })
      this.scheduleDisarm()
    } catch (error) {
      this.update({
        phase: 'error',
        message: error instanceof Error ? error.message : '网络请求失败',
      })
      this.scheduleDisarm()
    }
  }

  start(): () => void {
    this.marketBridge = createMarketBridge({
      isEnabled: () => Boolean(this.snapshot.status?.desktop && this.snapshot.status.enabled !== false),
      isMarketButtonsEnabled: () => true,
      isRestartDisabled: () => this.snapshot.phase === 'restarting' || !this.snapshot.status?.desktop,
      getButtonLabel: (kind, pendingCount) => {
        const { phase } = this.snapshot
        if (phase === 'restarting') return '重启中…'
        if (phase === 'armed') return '确认重启？'
        if (phase === 'warn-tasks') return '仍要重启？'
        if (phase === 'error') return '重试重启'
        if (kind === 'banner') return '立即重启'
        return pendingCount > 0 ? `↻ 需重启 (${pendingCount})` : '↻ 重启应用'
      },
      onTriggerRestart: () => this.handleButtonClick(),
      onChange: marketState => {
        this.snapshot = { ...this.snapshot, market: marketState }
        for (const listener of this.listeners) listener()
      },
    })

    void this.refreshStatus()
    void this.marketBridge.refreshFromApi()
    this.marketBridge.syncDom()

    this.pollTimer = setInterval(() => {
      void this.refreshStatus()
      void this.marketBridge?.refreshFromApi()
    }, 3_500)

    return () => {
      this.clearArmTimer()
      if (this.pollTimer !== null) clearInterval(this.pollTimer)
      this.marketBridge?.dispose()
    }
  }
}

const controller = new RestartController()

function useRestartStore(): StoreSnapshot {
  return React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

/** Locate the official bottom-left account row (`.wCInkW_triggerRow`) for clean flex portal mounting. */
function useTriggerRowHost(wide: boolean): HTMLElement | null {
  const [host, setHost] = React.useState<HTMLElement | null>(null)
  React.useEffect(() => {
    if (!wide || typeof document === 'undefined') {
      setHost(null)
      return
    }
    const find = (): void => {
      const el = document.querySelector<HTMLElement>('[class*="triggerRow"]:not([class*="railRow"])')
      setHost(prev => (prev === el ? prev : el))
    }
    find()
    const obs = new MutationObserver(find)
    obs.observe(document.body, { childList: true, subtree: true })
    return () => obs.disconnect()
  }, [wide])
  return host
}

function SidebarFooterEntry({ wide = true }: { wide?: boolean }): React.ReactElement | null {
  const snap = useRestartStore()
  const triggerRowHost = useTriggerRowHost(wide)

  // Only render inside verified DSH Desktop (Electron on Windows); silently no-op on Web version or remote browser.
  if (!snap.status?.desktop || snap.status.enabled === false) return null

  const pendingCount = controller.totalPendingCount()
  const installing = controller.isInstalling()
  const { phase, message } = snap
  const showPill =
    wide &&
    (pendingCount > 0 || phase === 'armed' || phase === 'warn-tasks' || phase === 'restarting' || phase === 'error')

  const tooltip =
    message ||
    (installing
      ? '插件正在安装或更新中，请等待完成后再重启'
      : pendingCount > 0
        ? `有 ${pendingCount} 项插件变更需重启 DeepSeek Harness 后生效，点击重启`
        : snap.status?.tasks.busy
          ? `${snap.status.tasks.summary} · 点击重启桌面应用`
          : '一键重启 DeepSeek Harness 桌面应用')

  let pillLabel = pendingCount > 1 ? `需重启 (${pendingCount})` : '需重启'
  if (phase === 'armed') pillLabel = '确认重启？'
  else if (phase === 'warn-tasks') pillLabel = '仍要重启？'
  else if (phase === 'restarting') pillLabel = '重启中…'
  else if (phase === 'error') pillLabel = '重试'

  const buttonNode = showPill
    ? h(
        'button',
        {
          type: 'button',
          className: 'dsdr-pill',
          'data-armed': phase === 'armed' ? 'true' : undefined,
          'data-warn': phase === 'warn-tasks' || phase === 'error' ? 'true' : undefined,
          disabled: phase === 'restarting' || installing,
          title: tooltip,
          'aria-label': '重启应用',
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation()
            controller.handleButtonClick()
          },
        },
        refreshIcon(13, phase === 'restarting'),
        h('span', null, pillLabel),
      )
    : h(
        'button',
        {
          type: 'button',
          className: 'dsdr-entry',
          disabled: phase === 'restarting' || installing,
          title: tooltip,
          'aria-label': '重启应用',
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation()
            controller.handleButtonClick()
          },
        },
        refreshIcon(16, phase === 'restarting'),
        pendingCount > 0 || phase === 'armed' || phase === 'warn-tasks'
          ? h('span', { className: 'dsdr-entry-dot' })
          : null,
      )

  if (wide && triggerRowHost) {
    return ReactDOM.createPortal(buttonNode, triggerRowHost)
  }
  return buttonNode
}

export interface ClientContext {
  effect(fn: () => (() => void) | void, label?: string): void
  slots: {
    inject(name: string, fn: () => unknown): void
    register(
      options: { name: string; id?: string; order?: number; label?: () => string },
      component: React.ComponentType<any>,
    ): unknown
  }
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshDesktopRestart = 'true'
    style.textContent = CSS
    document.head.append(style)
    return () => style.remove()
  }, 'desktop-restart: styles')
  ctx.effect(() => controller.start(), 'desktop-restart: controller')

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'copylee-desktop-restart', order: 64 },
      (props: { wide?: boolean }) => h(SidebarFooterEntry, { wide: props?.wide }),
    ),
  )
}
