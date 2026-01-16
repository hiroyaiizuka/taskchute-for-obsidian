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

export function attachCalendarButtonIcon(button: HTMLButtonElement): void {
  const existing = button.querySelector('svg')
  if (existing) {
    existing.remove()
  }

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')

  const frame = document.createElementNS(SVG_NS, 'rect')
  frame.setAttribute('x', '3')
  frame.setAttribute('y', '4')
  frame.setAttribute('width', '18')
  frame.setAttribute('height', '17')
  frame.setAttribute('rx', '2')

  const header = document.createElementNS(SVG_NS, 'line')
  header.setAttribute('x1', '3')
  header.setAttribute('y1', '9')
  header.setAttribute('x2', '21')
  header.setAttribute('y2', '9')

  const leftPin = document.createElementNS(SVG_NS, 'line')
  leftPin.setAttribute('x1', '8')
  leftPin.setAttribute('y1', '2')
  leftPin.setAttribute('x2', '8')
  leftPin.setAttribute('y2', '6')

  const rightPin = document.createElementNS(SVG_NS, 'line')
  rightPin.setAttribute('x1', '16')
  rightPin.setAttribute('y1', '2')
  rightPin.setAttribute('x2', '16')
  rightPin.setAttribute('y2', '6')

  svg.append(frame, header, leftPin, rightPin)
  button.append(svg)
}
