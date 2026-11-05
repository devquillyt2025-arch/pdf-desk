import { memo } from 'react'
import { overlayPrims, segsToSvg } from '../engine/overlay.ts'
import type { Overlay, PageSize, Rgb } from '../engine/types.ts'
import type { PicInfo } from './types.ts'

const css = (c: Rgb) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`

/**
 * Draws the page's overlays as SVG on top of the page picture. The geometry is the very same that is written to the
 * saved PDF (overlay.ts), so what you see here is what ends up in the file — and it moves with the mouse with no
 * re-render of the page.
 */
export const OverlayLayer = memo(function OverlayLayer(p: { size: PageSize; items: { id: string; overlay: Overlay }[]; images: ReadonlyMap<string, PicInfo> }) {
  return (
    <svg className="ov-svg" viewBox={`0 0 ${p.size.width} ${p.size.height}`} width="100%" height="100%" aria-hidden="true" focusable="false">
      {p.items.map((it) => (
        <g key={it.id}>
          {overlayPrims(it.overlay).map((pr, i) => {
            if (pr.kind === 'image') {
              const pic = p.images.get(pr.imageId)
              if (!pic) return null
              const [x0, y0, x1, y1] = pr.rect
              return <image key={i} href={pic.url} x={x0} y={y0} width={x1 - x0} height={y1 - y0} preserveAspectRatio="none" opacity={pr.alpha} />
            }
            return (
              <path
                key={i}
                d={segsToSvg(pr.segs)}
                fill={pr.fill ? css(pr.fill) : 'none'}
                stroke={pr.stroke ? css(pr.stroke) : 'none'}
                strokeWidth={pr.stroke ? pr.width : 0}
                strokeLinecap={pr.round ? 'round' : 'butt'}
                strokeLinejoin={pr.round ? 'round' : 'miter'}
                opacity={pr.alpha < 1 ? pr.alpha : undefined}
                style={pr.multiply ? { mixBlendMode: 'multiply' } : undefined}
              />
            )
          })}
        </g>
      ))}
    </svg>
  )
})
