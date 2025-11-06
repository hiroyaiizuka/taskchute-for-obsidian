const SVG_NS = 'http://www.w3.org/2000/svg'

export function attachCloseButtonIcon(button: HTMLButtonElement): void {
  const existing = button.querySelector('svg')
  if (existing) {
    existing.remove()
  }

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')

  const line1 = document.createElementNS(SVG_NS, 'line')
  line1.setAttribute('x1', '6')
  line1.setAttribute('y1', '6')
  line1.setAttribute('x2', '18')
  line1.setAttribute('y2', '18')

  const line2 = document.createElementNS(SVG_NS, 'line')
  line2.setAttribute('x1', '6')
  line2.setAttribute('y1', '18')
  line2.setAttribute('x2', '18')
  line2.setAttribute('y2', '6')

  svg.append(line1, line2)
  button.append(svg)
}
