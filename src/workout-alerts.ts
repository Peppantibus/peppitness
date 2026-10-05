import { useEffect } from 'react'

/**
 * Avvisi della seduta: suono e vibrazione a fine recupero, schermo acceso mentre ci si allena.
 * Come il tema, le scelte valgono solo per questo dispositivo (localStorage) e sono attive di default.
 * Limiti noti: Safari su iPhone non vibra; il suono non esce con l'interruttore silenzioso attivo né a
 * schermo bloccato (nessuna notifica push); lo schermo acceso richiede il supporto di Screen Wake Lock.
 */
export interface AlertPreferences { restAlert: boolean; wakeLock: boolean }

const keys = { restAlert: 'peppitness:rest-alert', wakeLock: 'peppitness:wake-lock' } as const

export function readAlertPreferences(): AlertPreferences {
  try { return { restAlert: localStorage.getItem(keys.restAlert) !== 'off', wakeLock: localStorage.getItem(keys.wakeLock) !== 'off' } }
  catch { return { restAlert: true, wakeLock: true } }
}

export function saveAlertPreference(name: keyof AlertPreferences, enabled: boolean) {
  try { if (enabled) localStorage.removeItem(keys[name]); else localStorage.setItem(keys[name], 'off') }
  catch { /* archivio non disponibile: la scelta vale fino alla chiusura */ }
}

let audio: AudioContext | null = null

/** iOS suona solo con un contesto audio sbloccato da un tocco: basta un qualsiasi tocco in seduta (es. «Fatto»). */
function unlock() {
  if (!readAlertPreferences().restAlert || typeof AudioContext === 'undefined') return
  try {
    if (!audio) {
      audio = new AudioContext()
      const silent = audio.createBufferSource()
      silent.buffer = audio.createBuffer(1, 1, 22050)
      silent.connect(audio.destination)
      silent.start()
    }
    if (audio.state === 'suspended') void audio.resume()
  } catch { audio = null }
}

/** Ascolta i tocchi della seduta per sbloccare l'audio; restituisce la funzione di pulizia. */
export function installAudioUnlock(): () => void {
  const events = ['touchend', 'click', 'keydown'] as const
  events.forEach(name => document.addEventListener(name, unlock, { passive: true }))
  return () => events.forEach(name => document.removeEventListener(name, unlock))
}

/** Due bip brevi e una vibrazione (dove supportata). Silenzioso se l'avviso è disattivato. */
export function playRestEnd() {
  if (!readAlertPreferences().restAlert) return
  try { navigator.vibrate?.([200, 100, 200]) } catch { /* vibrazione non disponibile */ }
  if (!audio || audio.state !== 'running') return
  const start = audio.currentTime + 0.02
  for (const offset of [0, 0.22]) {
    const tone = audio.createOscillator(), gain = audio.createGain()
    tone.type = 'sine'
    tone.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, start + offset)
    gain.gain.exponentialRampToValueAtTime(0.35, start + offset + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16)
    tone.connect(gain).connect(audio.destination)
    tone.start(start + offset)
    tone.stop(start + offset + 0.18)
  }
}

/** Schermo acceso finché `active`; il blocco viene richiesto di nuovo quando l'app torna visibile. */
export function useScreenWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !readAlertPreferences().wakeLock || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let stopped = false
    const request = async () => {
      if (stopped || lock || document.visibilityState !== 'visible') return
      try {
        const sentinel = await navigator.wakeLock.request('screen')
        if (stopped) { await sentinel.release(); return }
        lock = sentinel
        sentinel.addEventListener('release', () => { if (lock === sentinel) lock = null })
      } catch { /* negato (batteria scarica, impostazioni): lo schermo segue il sistema */ }
    }
    const onVisible = () => { void request() }
    void request()
    document.addEventListener('visibilitychange', onVisible)
    return () => { stopped = true; document.removeEventListener('visibilitychange', onVisible); void lock?.release() }
  }, [active])
}
