import {
  AI_SIDEBAR_MAX_WIDTH_PX,
  AI_SIDEBAR_MIN_WIDTH_PX,
  AI_SIDEBAR_SNAP_CLOSE_PX,
  AiSidebarResizer,
  resolveSidebarDrag,
  sidebarWidthBounds,
  type AiSidebarResizerOptions,
  type SidebarDragResolution,
} from '@/features/ai-task/ui/AiSidebarResizer'

describe('sidebarWidthBounds', () => {
  test('caps the width at half the row, never past the absolute maximum', () => {
    expect(sidebarWidthBounds(600).max).toBe(300)
    expect(sidebarWidthBounds(2000).max).toBe(AI_SIDEBAR_MAX_WIDTH_PX)
  })

  test('keeps the minimum on a row too narrow for half of it', () => {
    expect(sidebarWidthBounds(200).max).toBe(100)
    expect(sidebarWidthBounds(50).max).toBe(AI_SIDEBAR_MIN_WIDTH_PX)
  })

  test('narrows all the way to the snap point: minimum and snap are both 35px', () => {
    expect(AI_SIDEBAR_MIN_WIDTH_PX).toBe(35)
    expect(AI_SIDEBAR_SNAP_CLOSE_PX).toBe(35)
  })

  test('leaves the reserved width to the rest of the row, never below the minimum', () => {
    expect(sidebarWidthBounds(1000, 640).max).toBe(360)
    expect(sidebarWidthBounds(700, 640).max).toBe(60)
    expect(sidebarWidthBounds(660, 640).max).toBe(AI_SIDEBAR_MIN_WIDTH_PX)
    // An unmeasurable row cannot tell what is left: the absolute cap applies.
    expect(sidebarWidthBounds(0, 640).max).toBe(AI_SIDEBAR_MAX_WIDTH_PX)
  })

  test('applies the absolute cap alone when the row cannot be measured', () => {
    expect(sidebarWidthBounds(0)).toEqual({
      min: AI_SIDEBAR_MIN_WIDTH_PX,
      snap: AI_SIDEBAR_SNAP_CLOSE_PX,
      max: AI_SIDEBAR_MAX_WIDTH_PX,
    })
  })
})

describe('resolveSidebarDrag', () => {
  const bounds = sidebarWidthBounds(1000)

  test('closes below the snap point', () => {
    expect(resolveSidebarDrag(34, bounds)).toEqual({ collapsed: true })
    expect(resolveSidebarDrag(-20, bounds)).toEqual({ collapsed: true })
    expect(resolveSidebarDrag(Number.NaN, bounds)).toEqual({ collapsed: true })
  })

  test('stays open, following the pointer, from the snap point up', () => {
    expect(resolveSidebarDrag(35, bounds)).toEqual({ collapsed: false, width: 35 })
    expect(resolveSidebarDrag(36.4, bounds)).toEqual({ collapsed: false, width: 36 })
    expect(resolveSidebarDrag(100, bounds)).toEqual({ collapsed: false, width: 100 })
  })

  test('holds a larger minimum between the snap point and it', () => {
    const held = { min: 140, snap: 35, max: 480 }
    expect(resolveSidebarDrag(35, held)).toEqual({ collapsed: false, width: 140 })
    expect(resolveSidebarDrag(100, held)).toEqual({ collapsed: false, width: 140 })
  })

  test('follows the pointer inside the range and stops at the maximum', () => {
    expect(resolveSidebarDrag(212.4, bounds)).toEqual({ collapsed: false, width: 212 })
    expect(resolveSidebarDrag(900, bounds)).toEqual({ collapsed: false, width: 480 })
    expect(resolveSidebarDrag(900, sidebarWidthBounds(500))).toEqual({
      collapsed: false,
      width: 250,
    })
  })
})

describe('AiSidebarResizer', () => {
  let layout: HTMLElement
  let sidebar: HTMLElement
  let width: number
  let collapsed: boolean
  let options: AiSidebarResizerOptions & {
    getBounds: jest.Mock
    getWidth: jest.Mock
    onPreview: jest.Mock
    onCommit: jest.Mock
    onCancel: jest.Mock
    onReset: jest.Mock
    onToggle: jest.Mock
  }
  let resizer: AiSidebarResizer

  /** jsdom has no PointerEvent; a MouseEvent carrying pointerId is enough. */
  const pointer = (type: string, clientX: number): Event => {
    const event = new MouseEvent(type, { clientX, bubbles: true, button: 0 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    return event
  }
  const key = (name: string): KeyboardEvent =>
    new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  const handle = (): HTMLElement => resizer.element
  const previews = (): SidebarDragResolution[] =>
    options.onPreview.mock.calls.map((call) => call[0] as SidebarDragResolution)

  beforeEach(() => {
    document.body.replaceChildren()
    layout = document.body.createDiv()
    sidebar = layout.createDiv()
    layout.createDiv({ cls: 'content' })
    width = 180
    collapsed = false
    options = {
      sidebar,
      label: 'Resize terminal sidebar',
      getBounds: jest.fn(() => sidebarWidthBounds(1000)),
      getWidth: jest.fn(() => width),
      isCollapsed: () => collapsed,
      onPreview: jest.fn(),
      onCommit: jest.fn(),
      onCancel: jest.fn(),
      onReset: jest.fn(),
      onToggle: jest.fn(),
    }
    resizer = new AiSidebarResizer(options)
  })

  test('sits right after the sidebar as an accessible vertical separator', () => {
    expect(sidebar.nextElementSibling).toBe(handle())
    expect(handle().getAttribute('role')).toBe('separator')
    expect(handle().getAttribute('aria-orientation')).toBe('vertical')
    expect(handle().getAttribute('tabindex')).toBe('0')
    expect(handle().getAttribute('aria-label')).toBe('Resize terminal sidebar')
    // 0 is the closed sidebar.
    expect(handle().getAttribute('aria-valuemin')).toBe('0')
    expect(handle().getAttribute('aria-valuemax')).toBe('480')
    expect(handle().getAttribute('aria-valuenow')).toBe('180')
  })

  test('previews each new position and commits where the pointer is released', () => {
    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 570))
    handle().dispatchEvent(pointer('pointermove', 570))
    expect(previews()).toEqual([{ collapsed: false, width: 250 }])
    expect(options.onCommit).not.toHaveBeenCalled()

    handle().dispatchEvent(pointer('pointerup', 600))
    expect(options.onCommit).toHaveBeenCalledWith({ collapsed: false, width: 280 })
  })

  test('closes live past the snap point and reopens when the pointer comes back', () => {
    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 400))
    // 180 - 146 = 34: past the snap point.
    handle().dispatchEvent(pointer('pointermove', 354))
    handle().dispatchEvent(pointer('pointermove', 355))
    handle().dispatchEvent(pointer('pointermove', 400))
    expect(previews()).toEqual([
      { collapsed: false, width: 80 },
      { collapsed: true },
      { collapsed: false, width: 35 },
      { collapsed: false, width: 80 },
    ])

    handle().dispatchEvent(pointer('pointerup', 340))
    expect(options.onCommit).toHaveBeenCalledWith({ collapsed: true })
  })

  test('a press without movement commits nothing', () => {
    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointerup', 500))
    expect(options.onPreview).not.toHaveBeenCalled()
    expect(options.onCommit).not.toHaveBeenCalled()
  })

  test('jitter under 3px stays a click; 3px starts the drag from the press point', () => {
    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 502))
    handle().dispatchEvent(pointer('pointermove', 498))
    handle().dispatchEvent(pointer('pointerup', 502))
    expect(options.onPreview).not.toHaveBeenCalled()
    expect(options.onCommit).not.toHaveBeenCalled()
    expect(options.onCancel).not.toHaveBeenCalled()

    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 503))
    handle().dispatchEvent(pointer('pointerup', 503))
    expect(previews()).toEqual([{ collapsed: false, width: 183 }])
    expect(options.onCommit).toHaveBeenCalledWith({ collapsed: false, width: 183 })
  })

  test('a drag reads layout once, at the press, and reports values it already has', () => {
    handle().dispatchEvent(pointer('pointerdown', 500))
    expect(options.getBounds).toHaveBeenCalledTimes(2) // construction + press
    expect(options.getWidth).toHaveBeenCalledTimes(2)
    for (const x of [520, 560, 600, 340]) handle().dispatchEvent(pointer('pointermove', x))
    expect(options.getBounds).toHaveBeenCalledTimes(2)
    expect(options.getWidth).toHaveBeenCalledTimes(2)
    expect(handle().getAttribute('aria-valuenow')).toBe('0')
    handle().dispatchEvent(pointer('pointermove', 600))
    expect(handle().getAttribute('aria-valuenow')).toBe('280')

    // A refresh asked for mid-drag (the controller's own state changes) waits.
    resizer.refresh()
    expect(options.getWidth).toHaveBeenCalledTimes(2)
  })

  test('a cancelled gesture asks for the starting state back', () => {
    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 300))
    handle().dispatchEvent(pointer('pointercancel', 300))
    expect(options.onCancel).toHaveBeenCalledTimes(1)
    expect(options.onCommit).not.toHaveBeenCalled()
  })

  test('losing the pointer capture mid-drag cancels the gesture', () => {
    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 300))
    handle().dispatchEvent(pointer('lostpointercapture', 300))
    expect(options.onCancel).toHaveBeenCalledTimes(1)
    expect(handle().classList.contains('is-dragging')).toBe(false)

    // The released pointer no longer drives the sidebar.
    handle().dispatchEvent(pointer('pointermove', 600))
    handle().dispatchEvent(pointer('pointerup', 600))
    expect(options.onPreview).toHaveBeenCalledTimes(1)
    expect(options.onCommit).not.toHaveBeenCalled()
  })

  test('the capture released by a normal pointerup changes nothing', () => {
    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 600))
    handle().dispatchEvent(pointer('pointerup', 600))
    handle().dispatchEvent(pointer('lostpointercapture', 600))
    expect(options.onCommit).toHaveBeenCalledTimes(1)
    expect(options.onCancel).not.toHaveBeenCalled()
  })

  test('dragged while closed, it opens from the panels edge', () => {
    collapsed = true
    handle().dispatchEvent(pointer('pointerdown', 10))
    handle().dispatchEvent(pointer('pointermove', 30))
    handle().dispatchEvent(pointer('pointermove', 230))
    expect(previews()).toEqual([{ collapsed: true }, { collapsed: false, width: 220 }])
    handle().dispatchEvent(pointer('pointerup', 230))
    expect(options.onCommit).toHaveBeenCalledWith({ collapsed: false, width: 220 })
  })

  test('ignores buttons other than the primary one', () => {
    const event = new MouseEvent('pointerdown', { clientX: 500, bubbles: true, button: 2 })
    handle().dispatchEvent(event)
    handle().dispatchEvent(pointer('pointermove', 600))
    expect(options.onPreview).not.toHaveBeenCalled()
  })

  test('arrow keys step the width by 16px within the bounds', () => {
    handle().dispatchEvent(key('ArrowRight'))
    expect(options.onCommit).toHaveBeenLastCalledWith({ collapsed: false, width: 196 })

    width = 100
    handle().dispatchEvent(key('ArrowLeft'))
    expect(options.onCommit).toHaveBeenLastCalledWith({ collapsed: false, width: 84 })

    // The arrows never close the sidebar: they stop at the minimum.
    width = 40
    handle().dispatchEvent(key('ArrowLeft'))
    expect(options.onCommit).toHaveBeenLastCalledWith({ collapsed: false, width: 35 })
  })

  test('closed, ArrowRight opens the sidebar and ArrowLeft does nothing', () => {
    collapsed = true
    handle().dispatchEvent(key('ArrowLeft'))
    expect(options.onToggle).not.toHaveBeenCalled()
    handle().dispatchEvent(key('ArrowRight'))
    expect(options.onToggle).toHaveBeenCalledTimes(1)
    expect(options.onCommit).not.toHaveBeenCalled()
  })

  test('Enter toggles, Home and a double click reset', () => {
    handle().dispatchEvent(key('Enter'))
    expect(options.onToggle).toHaveBeenCalledTimes(1)
    handle().dispatchEvent(key('Home'))
    handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(options.onReset).toHaveBeenCalledTimes(2)
  })

  test('reports a closed sidebar as zero wide', () => {
    collapsed = true
    resizer.refresh()
    expect(handle().getAttribute('aria-valuenow')).toBe('0')
  })

  test('dispose removes the handle and stops listening', () => {
    const el = handle()
    resizer.dispose()
    expect(el.isConnected).toBe(false)
    el.dispatchEvent(pointer('pointerdown', 500))
    el.dispatchEvent(pointer('pointermove', 600))
    expect(options.onPreview).not.toHaveBeenCalled()
  })
})
