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
  home: 'M3 11l9-8 9 8 M5 9.5V20h5v-6h4v6h5V9.5',
  arrowLeft: 'M19 12H5 M11 6l-6 6 6 6',
  arrowUp: 'M12 19V5 M6 11l6-6 6 6',
  arrowDown: 'M12 5v14 M6 13l6 6 6-6',
  arrowLeftRight: 'M4 12h16 M8 8l-4 4 4 4 M16 8l4 4-4 4',
  plus: 'M12 5v14 M5 12h14',
  copy: 'M8 8h11v12H8z M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h3',
  pages: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M9 9.5h.01',
  images: 'M7 7h13v13H7z M4 17V4h13 M7 17l4-4 3 3 2-2 4 4',
  hash: 'M5 9h14 M5 15h14 M10 4L8 20 M16 4l-2 16',
  rotateCw: 'M21 12a9 9 0 1 1-3-6.7L21 8 M21 3v5h-5',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M20 4L8.1 15.9 M14.5 14.5L20 20 M8.1 8.1L12 12',
  unlock: 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 7.6-1.7',
  pointer: 'M5 3l5.5 17 3-7 7-3z',
  highlighter: 'M14 4l6 6-9 9H5v-6z M4 21h7',
  underline: 'M6 4v7a6 6 0 0 0 12 0V4 M4 21h16',
  strike: 'M4 12h16 M16.5 7C16 5.3 14.3 4.5 12 4.5c-2.4 0-4 1.2-4 3 0 1.5 1.2 2.3 4 3 M7.5 17c.5 1.7 2.2 2.5 4.5 2.5 2.6 0 4.2-1.2 4.2-3',
  ellipse: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z',
  line: 'M5 19L19 5',
  pen: 'M3 18c4 0 4-7 8-7s3 5 6 5 3-6 4-10',
  sign: 'M3 16c2-6 4-10 6-8s-2 8 0 8 3-5 5-4-1 4 1 4 3-1.500 5-1.500 M3 21h18',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3',
  replace: 'M4 8h13l-3-3 M20 16H7l3 3',
  cloud: 'M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 9a4.500 4.500 0 0 1-.5 9z',
  cloudUp: 'M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 9a4.500 4.500 0 0 1-.5 9 M12 17v-5 M9.500 14L12 11.500 14.500 14',
  cloudCheck: 'M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 9a4.500 4.500 0 0 1-.5 9 M9.500 13.500l2 2 3.500-4',
  logout: 'M10 4H5v16h5 M15 8l4 4-4 4 M19 12H9',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  move: 'M12 3v18 M3 12h18 M12 3l-2.500 2.500 M12 3l2.500 2.500 M12 21l-2.500-2.500 M12 21l2.500-2.500 M3 12l2.500-2.500 M3 12l2.500 2.500 M21 12l-2.500-2.500 M21 12l-2.500 2.500',
  table: 'M3 5h18v14H3z M3 10h18 M3 15h18 M9 5v14 M15 5v14',
  rowAbove: 'M4 13h16v7H4z M12 3v6 M9 6h6',
  rowBelow: 'M4 4h16v7H4z M12 15v6 M9 18h6',
  colLeft: 'M13 4h7v16h-7z M3 12h6 M6 9v6',
  colRight: 'M4 4h7v16H4z M15 12h6 M18 9v6',
  alignLeft: 'M4 6h16 M4 10h10 M4 14h16 M4 18h10',
  alignCenter: 'M4 6h16 M7 10h10 M4 14h16 M7 18h10',
  alignRight: 'M4 6h16 M10 10h10 M4 14h16 M10 18h10',
  bold: 'M7 4h6a3.500 3.500 0 0 1 0 7H7z M7 11h7a3.500 3.500 0 0 1 0 7H7z',
  italic: 'M10 4h8 M6 20h8 M14 4l-4 16',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  more: 'M5 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0 M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0 M17 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
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
