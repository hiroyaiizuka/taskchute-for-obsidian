const SVG_NS = 'http://www.w3.org/2000/svg'

export function appendRecipeFileIcon(container: HTMLElement, className = 'recipe-file-icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')

  const page = document.createElementNS(SVG_NS, 'path')
  page.setAttribute('d', 'M7 3h7l4 4v14H7z')

  const fold = document.createElementNS(SVG_NS, 'path')
  fold.setAttribute('d', 'M14 3v5h5')

  const line1 = document.createElementNS(SVG_NS, 'path')
  line1.setAttribute('d', 'M10 12h6')

  const line2 = document.createElementNS(SVG_NS, 'path')
  line2.setAttribute('d', 'M10 16h6')

  svg.append(page, fold, line1, line2)
  container.appendChild(svg)
  return svg
}
