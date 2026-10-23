/**
 * Native DSH Desktop styles for @copylee/dsh-desktop-restart.
 * Uses DSH's own --dsw-alias-* design tokens and DesktopUpdateIndicator geometry
 * without altering any host colors or layouts.
 */

export const CSS = `
/* Prevent overlap between remote-control's absolute-positioned corner button (.dsrc-entry-corner),
   DSH Desktop's official update button (DesktopUpdateIndicator), and our triggerRow portal button. */
[class*="footArea"]:has(.dsrc-entry-corner) [class*="triggerRow"]:not([class*="railRow"]) {
  padding-right: 40px;
}

/* Sidebar footer icon button (idle / narrow rail state — matches native sidebar icon buttons) */
.dsdr-entry {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 0;
  color: var(--dsw-alias-label-primary, #1f2328);
  background: transparent;
  border-radius: var(--dsw-radius-sm, 8px);
  padding: 0;
  width: 34px;
  height: 34px;
  flex: none;
  font: inherit;
  cursor: pointer;
  transition: background .12s, color .12s;
}
.dsdr-entry:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
}
.dsdr-entry:disabled {
  cursor: default;
  opacity: .45;
}
.dsdr-entry:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color, var(--dsw-alias-brand-primary, #4D6BFE));
  outline-offset: 2px;
}
.dsdr-entry-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary-new-colorprimary-new-color, var(--dsw-alias-brand-primary, #4D6BFE));
}

/* Sidebar footer pill button (identical geometry & tokens to official DesktopUpdateIndicator .yiN2GW_indicator) */
.dsdr-pill {
  --dsdr-brand: var(--dsw-alias-brand-primary-new-colorprimary-new-color, var(--dsw-alias-brand-primary, #4D6BFE));
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid color-mix(in srgb, var(--dsdr-brand) 20%, transparent);
  background: color-mix(in srgb, var(--dsdr-brand) 8%, transparent);
  color: var(--dsdr-brand);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  flex: none;
  cursor: pointer;
  transition: background .12s, border-color .12s;
}
.dsdr-pill:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsdr-brand) 14%, transparent);
  border-color: color-mix(in srgb, var(--dsdr-brand) 32%, transparent);
}
.dsdr-pill[data-armed="true"] {
  background: var(--dsdr-brand);
  border-color: var(--dsdr-brand);
  color: #FFFFFF;
}
.dsdr-pill[data-warn="true"] {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 12%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 32%, transparent);
  color: var(--dsw-alias-state-warn-primary, #d97706);
}
.dsdr-pill:disabled {
  cursor: default;
  opacity: .55;
}
.dsdr-pill:focus-visible {
  outline: 2px solid var(--dsdr-brand);
  outline-offset: 2px;
}

/* Injected buttons inside dsh-market (matches native @deepseek-ai/dsh-client-ui-primitives Button size="sm") */
.dsdr-market-banner-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  margin-left: 4px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-label-primary, #1f2328);
  background: var(--dsw-alias-label-primary, #1f2328);
  color: var(--dsw-alias-bg-layer-1, #ffffff);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
  flex-shrink: 0;
}
.dsdr-market-banner-btn:hover:not(:disabled) {
  opacity: 0.88;
}
.dsdr-market-banner-btn:disabled {
  opacity: .45;
  cursor: default;
}

.dsdr-market-title-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}
.dsdr-market-title-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04));
}
.dsdr-market-title-btn-active {
  --dsdr-brand: var(--dsw-alias-brand-primary-new-colorprimary-new-color, var(--dsw-alias-brand-primary, #4D6BFE));
  border-color: color-mix(in srgb, var(--dsdr-brand) 28%, transparent);
  background: color-mix(in srgb, var(--dsdr-brand) 8%, transparent);
  color: var(--dsdr-brand);
}
.dsdr-market-title-btn:disabled {
  opacity: .45;
  cursor: default;
}

.dsdr-spin {
  animation: dsdr-rotate 1s linear infinite;
}
@keyframes dsdr-rotate {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .dsdr-spin { animation: none; }
}
`
