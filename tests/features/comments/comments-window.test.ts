import { createCommentsWindow, pointAtCommentButton } from '@/features/comments/ui/DayCommentsWindow'

const rect = (left: number, width: number): DOMRect => ({
  left,
  right: left + width,
  width,
  top: 0,
  bottom: 0,
  height: 0,
  x: left,
  y: 0,
  toJSON: () => ({}),
})

const options = { title: 'Write the plan', count: '', label: 'Comments', closeLabel: 'Close', onClose: () => undefined }

describe('createCommentsWindow', () => {
  afterEach(() => document.body.empty())

  it("gives a task's popover a root of its own, so it is never taken for the day's window", () => {
    const parent = document.body.createDiv()
    const popover = createCommentsWindow(parent, { ...options, kind: 'popover' })
    expect(popover.el.className).toBe('taskchute-task-comments-popover')
    expect(popover.el.querySelector('.taskchute-day-comments-window__body')).toBe(popover.body)

    const day = createCommentsWindow(parent, { ...options, kind: 'drawer' })
    expect(day.el.className).toBe('taskchute-day-comments-window is-drawer')
  })
})

describe('pointAtCommentButton', () => {
  afterEach(() => document.body.empty())

  it("lines the popover's right edge and point up with the 💬 of the row before its anchor", () => {
    const list = document.body.createDiv()
    const row = list.createDiv({ cls: 'task-item' })
    const button = row.createEl('button', { cls: 'comment-button' })
    const anchor = list.createDiv({ cls: 'taskchute-task-comments-anchor' })
    const popover = anchor.createEl('section')
    anchor.getBoundingClientRect = () => rect(0, 1000)
    button.getBoundingClientRect = () => rect(848, 64)

    pointAtCommentButton(anchor, popover)

    expect(popover.style.getPropertyValue('--tc-comments-popover-right')).toBe('88px')
    expect(popover.style.getPropertyValue('--tc-comments-caret-right')).toBe('32px')
  })

  it("keeps the stylesheet's defaults when there is no 💬 to point at, or it is not laid out", () => {
    const list = document.body.createDiv()
    const row = list.createDiv({ cls: 'task-item' })
    const anchor = list.createDiv()
    const popover = anchor.createEl('section')
    pointAtCommentButton(anchor, popover)
    expect(popover.style.getPropertyValue('--tc-comments-popover-right')).toBe('')

    row.createEl('button', { cls: 'comment-button' })
    pointAtCommentButton(anchor, popover)
    expect(popover.style.getPropertyValue('--tc-comments-popover-right')).toBe('')
  })
})
