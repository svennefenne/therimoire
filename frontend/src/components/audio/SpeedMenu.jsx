import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { LuGauge } from 'react-icons/lu'
import { useAudioPlayer } from '../../context/AudioPlayerContext'

const MENU_WIDTH = 160
// 0.25 steps read as fussy in practice; audiobook apps (Audible, Overcast,
// Google Play Books) converge on quarter-to-half steps across 0.5x-2x, so
// that's the range and grain used here too. Listed fastest-first (2x at the
// top, 0.5x at the bottom), matching the sleep timer menu's convention of
// putting the "more" option first.
const SPEED_STEPS = [2, 1.75, 1.5, 1.25, 1, 0.75, 0.5]

/**
 * Playback speed trigger + menu, styled and positioned exactly like
 * SleepTimerMenu (a portalled menu that flips upward when the bar is near the
 * bottom of the screen, which it always is here).
 */
export default function SpeedMenu() {
  const { t } = useTranslation()
  const { rate, setRate } = useAudioPlayer()
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  const place = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 8
    const left = Math.max(
      margin,
      Math.min(r.right - MENU_WIDTH, window.innerWidth - margin - MENU_WIDTH)
    )
    const menuHeight = 36 * SPEED_STEPS.length + 8
    const below = window.innerHeight - r.bottom
    const top = below < menuHeight ? Math.max(margin, r.top - 4 - menuHeight) : r.bottom + 4
    setCoords({ top, left })
  }, [])

  useEffect(() => {
    if (!open) return
    place()
    const onDoc = (e) => {
      if (triggerRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    const onReposition = () => place()
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [open, place])

  const active = rate !== 1

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('audio.player.playbackSpeed')}
        title={t('audio.player.playbackSpeed')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: active || open ? 'var(--gold)' : 'var(--text-dim)',
          padding: 6,
          fontSize: 11,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <LuGauge size={17} />
        <span>{rate}×</span>
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              zIndex: 2000,
              width: MENU_WIDTH,
              padding: '4px 0',
              borderRadius: 8,
              background: 'var(--bg-panel)',
              border: '1px solid var(--border)',
              boxShadow: '0 6px 20px var(--shadow)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '8px 12px 6px',
                fontSize: 11,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              {t('audio.player.playbackSpeed')}
            </div>
            {SPEED_STEPS.map((step) => (
              <button
                key={step}
                role="menuitem"
                type="button"
                onClick={() => {
                  setRate(step)
                  setOpen(false)
                }}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '9px 12px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  color: step === rate ? 'var(--gold)' : 'var(--text)',
                  textAlign: 'left',
                }}
              >
                <span>{step}×</span>
                {step === 1 && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                    {t('audio.player.speedNormal')}
                  </span>
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
