import type { CSSProperties } from 'react'

/**
 * Set unico di icone a tratto: griglia 24, tratto 1,75, estremità arrotondate.
 * Tutti i tracciati stanno nell'area 2–22 così le icone hanno lo stesso peso visivo.
 */
const paths = {
  fork: 'M5 3v6a3 3 0 0 0 6 0V3M8 3v18M18 3c-3 3-3 8 0 9h2V3h-2Zm2 9v9',
  // Manubrio orizzontale: dischi e barra, leggibile anche a 16 px.
  dumbbell: 'M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11',
  chevron: 'm9 5 7 7-7 7',
  chevronDown: 'm6 9 6 6 6-6',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  back: 'M19 12H5m6-6-6 6 6 6',
  calendar: 'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  check: 'm5 12 4 4L19 6',
  clock: 'M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  user: 'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  leaf: 'M20 3c-9-1-17 3-16 10 1 7 11 9 15 0 1-3 1-6 1-10ZM4 21l11-12',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z',
  moon: 'M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10Z',
  cup: 'M4 9h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9Zm12 1h2a3 3 0 0 1 0 6h-2M6 3v2m4-2v2m4-2v2',
  history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2',
  close: 'm6 6 12 12M6 18 18 6',
  info: 'M12 11v6m0-10v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 7h16M4 12h16M4 17h10',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  pause: 'M8 5v14M16 5v14',
  play: 'm8 4 12 8-12 8V4Z',
  // Record personale: stella a cinque punte nell'area 2–22.
  star: 'm12 2.5 2.9 6 6.6.8-4.9 4.5 1.3 6.5L12 17l-5.9 3.3 1.3-6.5-4.9-4.5 6.6-.8Z',
  edit: 'M4 20h4L19 9l-4-4L4 16v4Zm10-14 4 4',
  skip: 'M8 12h8M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  swap: 'M4 8h15l-4-4M20 16H5l4 4',
  cloudCheck: 'M7 19a5 5 0 1 1 .9-9.9A6 6 0 0 1 19.5 11 4 4 0 0 1 18 19H7Zm2.5-4.5 2 2 4-4',
  cloudUp: 'M7 19a5 5 0 1 1 .9-9.9A6 6 0 0 1 19.5 11 4 4 0 0 1 18 19H7Zm5-2.5v-5m-2.2 2.2L12 11.5l2.2 2.2',
  cloudOff: 'M3 3l18 18M8.5 8.6A5 5 0 0 0 7 19h11M19.5 17.6A4 4 0 0 0 19.5 11 6 6 0 0 0 10.4 7.2',
  alert: 'M12 3.5 2.5 20h19L12 3.5ZM12 10v4.5m0 3v.1',
  sliders: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 5v4M9 15v4',
  more: 'M5 12h.5M11.75 12h.5M18.5 12h.5',
} satisfies Record<string, string>

export type IconName = keyof typeof paths
/** Solo quattro dimensioni: 16 dentro il testo, 20 nei controlli, 24 in evidenza, 32 negli stati vuoti. */
export type IconSize = 16 | 20 | 24 | 32

export function Icon({ name, size = 24, style, strokeWidth = 1.75 }: { name: IconName; size?: IconSize; style?: CSSProperties; strokeWidth?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>
}
