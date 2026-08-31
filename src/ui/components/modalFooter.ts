import { createElCompat } from './domCompat'

/**
 * The one place a dialog's action row is built.
 *
 * Every dialog used to hand-roll its own footer, and five different container
 * classes grew out of that: `.modal-button-container`, `.form-button-group`,
 * `.routine-editor__buttons`, `.routine-confirm__buttons` and a pair of
 * one-off `__actions` rows. Only the first is Obsidian's, and only the first
 * therefore got core's mobile treatment -- so on a phone some dialogs stacked
 * their buttons full-width while the rest stayed in a cramped right-aligned
 * row. Building the row here means the choice is made once.
 *
 * The container is core's `.modal-button-container`, so the layout is core's:
 * a right-aligned row on the desktop, a full-width stack on a phone
 * (`.is-mobile` sets `flex-direction: column-reverse`). Two of core's button
 * classes drive the order, which is why the roles below map onto them rather
 * than onto the plugin's own `.form-button` variants alone:
 *
 *   `mod-cancel`    -- `order: -1` inside the reversed column, so cancel is
 *                      always the bottom-most button on a phone and the
 *                      left-most on the desktop, whatever the DOM order.
 *   `mod-secondary` -- `margin-inline-end: auto` on the desktop, which pushes
 *                      an extra action ("Remove from routine", "Clear") away
 *                      from the confirm/cancel pair.
 *
 * `.form-button` and its `create` / `cancel` / `danger` / `secondary`
 * modifiers still carry the looks; they are shared with buttons outside
 * dialogs, so they are not core's to own.
 */
export type ModalFooterRole = 'primary' | 'cancel' | 'danger' | 'secondary'

export interface ModalFooterButtonSpec {
  text: string
  /**
   * Required: `secondary` pins the button to the far end of the desktop row
   * (`margin-inline-end: auto`), so it is not a safe default for a button that
   * simply did not say what it was. At most one button per row may take it.
   */
  role: ModalFooterRole
  /** Defaults to `button`. Use `submit` for the primary action inside a `<form>`. */
  type?: 'button' | 'submit'
  /**
   * Kept on the button in addition to the role's classes. Several dialogs are
   * addressed by a name of their own from elsewhere (tests, a controller that
   * enables the button later), and those hooks outlive this refactor.
   */
  cls?: string | string[]
  attr?: Record<string, string>
  /**
   * Handed the button as it is built. Callers that have to reach back into the
   * row -- to disable it while a save is in flight, or to focus it -- take it
   * here rather than counting positions in the returned array, which breaks
   * the moment a conditional button is added.
   */
  ref?: (button: HTMLButtonElement) => void
  onClick?: (event: MouseEvent) => void
}

const ROLE_CLASSES: Record<ModalFooterRole, string[]> = {
  primary: ['form-button', 'create'],
  cancel: ['form-button', 'cancel', 'mod-cancel'],
  danger: ['form-button', 'danger', 'mod-warning'],
  secondary: ['form-button', 'secondary', 'mod-secondary'],
}

export interface ModalFooter {
  footer: HTMLDivElement
  buttons: HTMLButtonElement[]
}

/**
 * Appends the action row to `parent` and returns it alongside the buttons, in
 * the order they were declared.
 *
 * Declare them in reading order for the desktop -- extra actions first, then
 * cancel, then the primary action. The phone ordering falls out of the classes
 * rather than the DOM, so it stays correct either way.
 */
export function createModalFooter(
  parent: HTMLElement,
  specs: ModalFooterButtonSpec[],
): ModalFooter {
  const footer = createElCompat(parent, 'div', { cls: 'modal-button-container' })

  const buttons = specs.map((spec) => {
    const extra = spec.cls === undefined ? [] : Array.isArray(spec.cls) ? spec.cls : [spec.cls]
    const button = createElCompat(footer, 'button', {
      cls: [...ROLE_CLASSES[spec.role], ...extra],
      text: spec.text,
      type: spec.type ?? 'button',
      attr: spec.attr,
    })
    if (spec.onClick) {
      const handler = spec.onClick
      button.addEventListener('click', (event) => {
        handler(event)
      })
    }
    spec.ref?.(button)
    return button
  })

  return { footer, buttons }
}
