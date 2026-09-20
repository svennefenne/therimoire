import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { LuPlay, LuPause, LuVolume2, LuVolumeX } from 'react-icons/lu'
// Same numbered rewind/forward glyphs as the on-page skip buttons (see
// AudiobookDetailView/GlobalAudioPlayer), so the flashed confirmation icon
// matches the button that was actually pressed.
import { TbRewindBackward15, TbRewindForward15 } from 'react-icons/tb'

/**
 * Transient confirmation for the Audiobooks keyboard shortcuts (see
 * useAudiobookHotkeys) — the same idea as a video player's flashed
 * play/pause/seek icon, so a key press has visible proof it landed instead of
 * only being audible a beat later (or not noticeably at all for a ±15s skip
 * in a 16-hour file). `feedback` is `null` between presses; each new press
 * replaces it and the hook clears it again after ~900ms.
 *
 * Anchored bottom-center, just above the docked global player bar, and
 * nowhere else — a fixed spot that never moves regardless of which
 * Audiobooks page you're on or how tall its content is, rather than
 * fixed-center-of-viewport (which read as floating in an arbitrary spot with
 * nothing to anchor it to).
 *
 * Pure presentation — no state of its own — so AppShell can mount this next
 * to the hook without either one caring about the other's internals beyond
 * this one prop.
 */
export default function HotkeyFeedback({ feedback, bottomOffset = 0 }) {
  const { t } = useTranslation()
  if (!feedback) return null

  let icon = null
  let label = ''
  if (feedback.type === 'skip') {
    icon = feedback.direction < 0 ? <TbRewindBackward15 size={32} /> : <TbRewindForward15 size={32} />
    label = `${feedback.direction < 0 ? '-' : '+'}15s`
  } else if (feedback.type === 'volume') {
    icon = feedback.value === 0 ? <LuVolumeX size={32} /> : <LuVolume2 size={32} />
    label = `${Math.round(feedback.value * 100)}%`
  } else if (feedback.type === 'playpause') {
    icon = feedback.playing ? <LuPlay size={32} /> : <LuPause size={32} />
    label = feedback.playing ? t('audio.play') : t('audio.pause')
  } else {
    return null
  }

  return createPortal(
    <div
      // Re-keyed on ts so a repeated press (e.g. holding an arrow key)
      // restarts the fade-in instead of the box just sitting there static.
      key={feedback.ts}
      aria-hidden="true"
      style={{
        position: 'fixed',
        bottom: bottomOffset + 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2500,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        minWidth: 96,
        padding: '18px 26px',
        borderRadius: 16,
        background: 'var(--overlay)',
        color: 'var(--on-media)',
        boxShadow: '0 8px 28px var(--shadow)',
        animation: 'grimoire-hotkey-feedback 0.9s ease-out',
      }}
    >
      <style>{`
        /* The animated \`transform\` replaces the element's base transform for
           its duration, so the horizontal centering has to be repeated in
           every keyframe — omitting it (as an earlier version did) let the
           box drift off-center by half its own width while animating. */
        @keyframes grimoire-hotkey-feedback {
          0% { opacity: 0; transform: translateX(-50%) scale(0.9); }
          12% { opacity: 1; transform: translateX(-50%) scale(1); }
          70% { opacity: 1; transform: translateX(-50%) scale(1); }
          100% { opacity: 0; transform: translateX(-50%) scale(1); }
        }
      `}</style>
      {icon}
      <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {label}
      </span>
    </div>,
    document.body
  )
}
