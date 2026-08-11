declare global {
  interface DomElementInfo {
    html?: string
  }

  interface SvgElementInfo {
    [key: string]: unknown
  }
}

export {}
