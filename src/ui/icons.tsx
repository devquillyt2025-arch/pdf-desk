import type { SVGProps } from 'react'

// One icon family: 24px grid, 1.75 stroke, round caps/joins.
const PATHS = {
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5',
  upload: 'M12 16V4 M7 9l5-5 5 5 M5 20h14',
  download: 'M12 4v12 M7 11l5 5 5-5 M5 20h14',
  undo: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3',
  zoomIn: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3 M11 8v6 M8 11h6',
  zoomOut: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3 M8 11h6',
  type: 'M4 7V5h16v2 M9 20h6 M12 5v15',
  cursorText: 'M9 4h1a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H9 M15 4h-1a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h1',
  pencil: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z M14 6l4 4',
  eraser: 'M20 20H9l-5-5a2 2 0 0 1 0-2.8l8.2-8.2a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.8L12 20 M8 8l8 8',
  scan: 'M4 8V6a2 2 0 0 1 2-2h2 M16 4h2a2 2 0 0 1 2 2v2 M20 16v2a2 2 0 0 1-2 2h-2 M8 20H6a2 2 0 0 1-2-2v-2 M8 12h8 M8 8.5h8 M8 15.5h5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12.5l3 3 5-6',
  shield: 'M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6z M8.5 12l2.5 2.5L16 9.5',
  alert: 'M12 3l10 18H2z M12 10v4.5 M12 17.5v.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 8v.01',
  x: 'M6 6l12 12 M18 6L6 18',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  panel: 'M4 5h16v14H4z M15 5v14',
  sidebar: 'M4 5h16v14H4z M9 5v14',
  list: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  arrowRight: 'M5 12h14 M13 6l6 6-6 6',
  loader: 'M12 3a9 9 0 1 0 9 9',
  rotate: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5',
  font: 'M4 20L10 5h1l6 15 M6.5 15h8 M17 20l3-8',
  lock: 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3',
  box: 'M4 4h16v16H4z',
  flag: 'M5 21V4 M5 4h11l-2 4 2 4H5',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18, className, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...rest}
    >
      {PATHS[name].split(' M').map((d, i) => (
        <path key={i} d={i === 0 ? d : 'M' + d} />
      ))}
    </svg>
  )
}
