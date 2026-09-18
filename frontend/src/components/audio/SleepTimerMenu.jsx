import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { LuMoon } from 'react-icons/lu'
import { formatDuration } from '../../utils'
import { useAudioPlayer } from '../../context/AudioPlayerContext'

const MENU_WIDTH = 220
// Matches Spotify's own audiobook sleep timer preset list exactly (5/10/15/
// 30/45 minutes, then a distinct "1 hour" rather than "60 minutes").
const PRESET_MINUTES = [5, 10, 15, 30, 45]

/**
 * Spotify-style sleep timer: a trigger that opens a small menu of presets
 * ("in 15 min", "end of chapter", "off"). The timer itself lives in
 * AudioPlayerContext (it's a property of the whole playback session, not of
 * this button), so this component is just presentation — it reads
 * `sleepTimer`/`sleepTimerRemaining` and calls the three actions.
 *
 * Follows CalendarMenu's shape: a portalled, fixed-position menu that flips
 * to open upward when there isn't room below, which is the common case here
 * since this button normally lives in the bottom-docked player bar.
 */
export default function SleepTimerMenu() {
  const { t } = useTranslation()
  const {
    sleepTimer,
    sleepTimerRemaining,
    hasChapters,
    startSleepTimer,
    startSleepTimerEndOfChapter,
    cancelSleepTimer,
  } = useAudioPlayer()
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
    const itemCount = PRESET_MINUTES.length + 1 + (hasChapters ? 1 : 0) + (sleepTimer ? 1 : 0)
    const menuHeight = 44 * itemCount + 8
    const below = window.innerHeight - r.bottom
    const top =
      below < menuHeight ? Math.max(margin, r.top - 4 - menuHeight) : r.bottom + 4
    setCoords({ top, left })
  }, [hasChapters, sleepTimer])

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

  const active = Boolean(sleepTimer)

  const items = [
    ...PRESET_MINUTES.map((minutes) => ({
      key: `min-${minutes}`,
      label: t('audio.player.sleepTimerMinutes', { minutes }),
      onClick: () => {
        startSleepTimer(minutes)
        setOpen(false)
      },
    })),
    {
      key: 'hour',
      label: t('audio.player.sleepTimerHour'),
      onClick: () => {
        startSleepTimer(60)
        setOpen(false)
      },
    },
    hasChapters && {
      key: 'chapter',
      label: t('audio.player.sleepTimerEndOfChapter'),
      onClick: () => {
        startSleepTimerEndOfChapter()
        setOpen(false)
      },
    },
    active && {
      key: 'off',
      label: t('audio.player.sleepTimerOff'),
      onClick: () => {
        cancelSleepTimer()
        setOpen(false)
      },
    },
  ].filter(Boolean)

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
        aria-label={t('audio.player.sleepTimer')}
        title={t('audio.player.sleepTimer')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: active || open ? 'var(--gold)' : 'var(--text-dim)',
          padding: 6,
          fontSize: 11,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <LuMoon size={17} />
        {sleepTimer?.type === 'duration' && sleepTimerRemaining != null && (
          <span>{formatDuration(sleepTimerRemaining)}</span>
        )}
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
              {t('audio.player.sleepTimer')}
            </div>
            {items.map(({ key, label, onClick }) => (
              <button
                key={key}
                role="menuitem"
                type="button"
                onClick={onClick}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '9px 12px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  color: key === 'off' ? 'var(--gold)' : 'var(--text)',
                  textAlign: 'left',
                }}
              >
                {label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
