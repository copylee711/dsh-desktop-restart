/**
 * Bridge with dsh-market:
 * 1. Detects when dsh-market reports pending plugin restarts (both via DOM banner
 *    when the market panel is open and via `/dsh-market/installed` activations).
 * 2. Injects a native-looking "立即重启" button into dsh-market's restart banner
 *    (which dsh-market hides on Desktop because its own web restart cannot restart Electron)
 *    and a "↻ 重启应用" button into dsh-market's top titleActions row next to the market update button.
 * 3. Completely no-ops on Web version (when `isEnabled()` is false or when dsh-market
 *    already renders its own native web restart button).
 */

export interface MarketBridgeState {
  marketPendingCount: number
  marketPendingNames: string[]
  marketBusy: boolean
}

const BANNER_BTN_ATTR = 'data-dsdr-market-banner-btn'
const TITLE_BTN_ATTR = 'data-dsdr-market-title-btn'

const RESTART_BANNER_RE = /(\d+)\s*(?:项变更需重启\s*DeepSeek\s*Harness\s*后生效|change\(s\)\s*require\s*restarting\s*DeepSeek\s*Harness)/i

/** Parse a `/dsh-market/installed` JSON payload to extract packages with `state === 'restart'`. */
export function extractMarketRestartNames(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const activation = (payload as { activation?: Record<string, { state?: string }> }).activation
  if (!activation || typeof activation !== 'object') return []
  const names: string[] = []
  for (const [name, info] of Object.entries(activation)) {
    if (info && typeof info === 'object' && info.state === 'restart') {
      names.push(name)
    }
  }
  return names
}

/** Check if dsh-market's banner already has its own native restart button (e.g. on DSH Web). */
export function hasNativeBannerRestartButton(bannerEl: HTMLElement): boolean {
  const buttons = bannerEl.querySelectorAll<HTMLButtonElement>('button')
  for (const btn of buttons) {
    if (btn.hasAttribute(BANNER_BTN_ATTR)) continue
    const text = (btn.textContent ?? '').trim()
    if (/重启|Restart/i.test(text)) return true
  }
  return false
}

/** Inspect a root DOM element for dsh-market's pending-restart banner and busy indicators. */
export function inspectMarketDom(root: ParentNode): {
  bannerCount: number
  bannerEl: HTMLElement | null
  titleActionsEl: HTMLElement | null
  busy: boolean
} {
  const marketRoot =
    root instanceof HTMLElement && root.hasAttribute('data-dsh-market-root')
      ? root
      : root.querySelector<HTMLElement>('[data-dsh-market-root]')
  if (!marketRoot) {
    return { bannerCount: 0, bannerEl: null, titleActionsEl: null, busy: false }
  }

  let bannerCount = 0
  let bannerEl: HTMLElement | null = null
  const candidates = marketRoot.querySelectorAll<HTMLElement>('div[class*="banner"]')
  for (const el of candidates) {
    const text = el.textContent ?? ''
    const match = RESTART_BANNER_RE.exec(text)
    if (match) {
      bannerCount = Math.max(1, Number(match[1]) || 1)
      bannerEl = el
      break
    }
  }

  const titleActionsEl = marketRoot.querySelector<HTMLElement>('div[class*="titleActions"]')

  let busy = false
  const buttons = marketRoot.querySelectorAll<HTMLButtonElement>('button')
  for (const btn of buttons) {
    const t = (btn.textContent ?? '').trim()
    if (/^(?:正在安装|更新中|卸载中|Installing|Updating|Removing)/.test(t)) {
      busy = true
      break
    }
  }

  return { bannerCount, bannerEl, titleActionsEl, busy }
}

export interface MarketControllerOptions {
  isEnabled: () => boolean
  isMarketButtonsEnabled: () => boolean
  getButtonLabel: (kind: 'banner' | 'title', pendingCount: number) => string
  isRestartDisabled: () => boolean
  onTriggerRestart: () => void
  onChange: (state: MarketBridgeState) => void
}

export function createMarketBridge(options: MarketControllerOptions): {
  refreshFromApi: () => Promise<void>
  syncDom: () => void
  dispose: () => void
} {
  let apiNames: string[] = []
  let domCount = 0
  let domBusy = false
  let disposed = false
  let frame = 0

  const emit = (): void => {
    const count = Math.max(domCount, apiNames.length)
    options.onChange({
      marketPendingCount: count,
      marketPendingNames: apiNames,
      marketBusy: domBusy,
    })
  }

  const removeInjectedButtons = (): void => {
    if (typeof document === 'undefined') return
    document.querySelectorAll(`[${BANNER_BTN_ATTR}], [${TITLE_BTN_ATTR}]`).forEach(el => el.remove())
  }

  const syncDom = (): void => {
    frame = 0
    if (disposed || typeof document === 'undefined') return
    if (!options.isEnabled() || !options.isMarketButtonsEnabled()) {
      removeInjectedButtons()
      return
    }

    const info = inspectMarketDom(document)
    const changed = info.bannerCount !== domCount || info.busy !== domBusy
    domCount = info.bannerCount
    domBusy = info.busy

    const totalPending = Math.max(domCount, apiNames.length)
    const disabled = options.isRestartDisabled() || domBusy

    // 1. Inject or update button inside dsh-market's pending-restart banner
    if (info.bannerEl && !hasNativeBannerRestartButton(info.bannerEl)) {
      let btn = info.bannerEl.querySelector<HTMLButtonElement>(`[${BANNER_BTN_ATTR}]`)
      if (!btn) {
        btn = document.createElement('button')
        btn.type = 'button'
        btn.setAttribute(BANNER_BTN_ATTR, 'true')
        btn.className = 'dsdr-market-banner-btn'
        btn.addEventListener('click', e => {
          e.stopPropagation()
          options.onTriggerRestart()
        })
        // Insert before the "知道了 / Dismiss" ghost button if present so ordering matches native dsh-market
        const dismissBtn = info.bannerEl.querySelector<HTMLButtonElement>('button')
        if (dismissBtn) {
          info.bannerEl.insertBefore(btn, dismissBtn)
        } else {
          info.bannerEl.appendChild(btn)
        }
      }
      btn.textContent = options.getButtonLabel('banner', totalPending)
      btn.disabled = disabled
      btn.title = domBusy ? '插件正在安装或更新中，请等待完成后再重启' : '一键重启 DeepSeek Harness 桌面应用使变更生效'
    }

    // 2. Inject or update button inside dsh-market's top titleActions row (next to dsh-market's update button)
    if (info.titleActionsEl) {
      let titleBtn = info.titleActionsEl.querySelector<HTMLButtonElement>(`[${TITLE_BTN_ATTR}]`)
      if (!titleBtn) {
        titleBtn = document.createElement('button')
        titleBtn.type = 'button'
        titleBtn.setAttribute(TITLE_BTN_ATTR, 'true')
        titleBtn.addEventListener('click', e => {
          e.stopPropagation()
          options.onTriggerRestart()
        })
        info.titleActionsEl.appendChild(titleBtn)
      }
      const highlight = totalPending > 0
      titleBtn.className = highlight ? 'dsdr-market-title-btn dsdr-market-title-btn-active' : 'dsdr-market-title-btn'
      titleBtn.textContent = options.getButtonLabel('title', totalPending)
      titleBtn.disabled = disabled
      titleBtn.title = domBusy
        ? '插件正在安装或更新中，请等待完成后再重启'
        : highlight
          ? `有 ${totalPending} 项插件变更待重启生效，点击重启桌面应用`
          : '一键重启 DeepSeek Harness 桌面应用'
    }

    if (changed) emit()
  }

  const refreshFromApi = async (): Promise<void> => {
    if (disposed || typeof fetch === 'undefined' || !options.isEnabled()) return
    try {
      const res = await fetch('/dsh-market/installed', { cache: 'no-store' })
      if (!res.ok) return
      const data: unknown = await res.json()
      const nextNames = extractMarketRestartNames(data)
      if (nextNames.join(',') !== apiNames.join(',')) {
        apiNames = nextNames
        syncDom()
        emit()
      }
    } catch {
      /* dsh-market not installed or host restarting */
    }
  }

  const observer =
    typeof MutationObserver !== 'undefined' && typeof document !== 'undefined'
      ? new MutationObserver(() => {
          if (frame === 0) frame = requestAnimationFrame(syncDom)
        })
      : null

  if (observer && document.body) {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }

  return {
    refreshFromApi,
    syncDom,
    dispose: () => {
      disposed = true
      if (frame !== 0) cancelAnimationFrame(frame)
      observer?.disconnect()
      removeInjectedButtons()
    },
  }
}
