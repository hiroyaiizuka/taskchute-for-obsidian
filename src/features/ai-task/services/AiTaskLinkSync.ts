import type { TaskInstance } from '@/types'
import { resolveTaskDisplayTitle } from '@/utils/taskDisplayTitle'
import { readAiTaskConfig } from './AiTaskFrontmatterReader'
import {
  matchesObsidianTaskTitle,
  readObsidianTaskLinkConfig,
} from './ObsidianTaskLinkConfig'

export interface AiTaskLinkSyncHost {
  /** Every instance the view knows for its date, linked AI candidates included. */
  getTaskInstances: () => readonly TaskInstance[]
  startInstance: (inst: TaskInstance) => Promise<void>
  stopInstance: (inst: TaskInstance) => Promise<void>
  resetToIdle: (inst: TaskInstance) => Promise<void>
  deleteInstance: (inst: TaskInstance) => Promise<void>
  /** Moves without its own notice or reload; resolves whether it moved. */
  moveToDate: (inst: TaskInstance, dateStr: string) => Promise<boolean>
}

type InstanceState = TaskInstance['state']

/**
 * Keeps a human task and its linked AI routine in step (#183).
 *
 * An AI routine is linked to a human task by its `obsidian_sync` title
 * match. The pair is one-to-one, so the partner is found again from that
 * match every time instead of being stored. Whatever happens to one side —
 * start, stop, reset to idle, delete, move to another date — is applied to
 * the other.
 *
 * Starting the AI routine from the human task stays with
 * AiTaskObsidianLinkCoordinator, which already handles duplicates and
 * racing starts; this class covers every other direction.
 *
 * Applying an operation to the partner raises the same event for the
 * partner. Both ids are marked while that runs, so the echo is ignored.
 */
export class AiTaskLinkSync {
  private readonly syncing = new Set<string>()

  constructor(private readonly host: AiTaskLinkSyncHost) {}

  /** The linked partner of `inst` in the view, or undefined when it has none. */
  partnerOf(
    inst: TaskInstance,
    preferredState: InstanceState = inst.state,
  ): TaskInstance | undefined {
    const instances = this.host.getTaskInstances()
    const aiLink = isAiTask(inst) ? readLinkedRoutineConfig(inst) : null
    let candidates: TaskInstance[]
    if (aiLink) {
      candidates = instances.filter((candidate) => {
        if (candidate === inst || isAiTask(candidate)) return false
        const title = resolveTitle(candidate)
        return title.length > 0 && matchesObsidianTaskTitle(title, aiLink)
      })
    } else if (!isAiTask(inst)) {
      const title = resolveTitle(inst)
      if (!title) return undefined
      candidates = instances.filter((candidate) => {
        if (candidate === inst || !isAiTask(candidate)) return false
        const link = readLinkedRoutineConfig(candidate)
        return link ? matchesObsidianTaskTitle(title, link) : false
      })
    } else {
      return undefined
    }
    // A routine can show several instances of the same note (duplicates);
    // the one in the same state is the one that moved with this side.
    return (
      candidates.find((candidate) => candidate.state === preferredState) ??
      candidates[0]
    )
  }

  isSyncing(inst: TaskInstance): boolean {
    return this.syncing.has(inst.instanceId)
  }

  /** The AI side started: start its human task too. */
  async afterStarted(inst: TaskInstance): Promise<void> {
    if (!isAiTask(inst) || this.isSyncing(inst)) return
    const partner = this.partnerOf(inst, 'idle')
    if (!partner || partner.state === 'running') return
    await this.applyToPartner(inst, partner, () =>
      this.host.startInstance(partner),
    )
  }

  /** Either side stopped (finished): finish the other. */
  async afterStopped(inst: TaskInstance): Promise<void> {
    if (this.isSyncing(inst)) return
    const partner = this.partnerOf(inst, 'running')
    if (!partner || partner.state !== 'running') return
    await this.applyToPartner(inst, partner, () =>
      this.host.stopInstance(partner),
    )
  }

  /** Either side went back to idle: reset the other as well. */
  async afterResetToIdle(
    inst: TaskInstance,
    previousState: InstanceState,
  ): Promise<void> {
    if (this.isSyncing(inst)) return
    const partner = this.partnerOf(inst, previousState)
    if (!partner || partner.state === 'idle') return
    await this.applyToPartner(inst, partner, () =>
      this.host.resetToIdle(partner),
    )
  }

  /**
   * Either side was deleted: delete the other. The partner has to be found
   * before the deletion removes `inst` from the view, so callers pass it.
   */
  async afterDeleted(
    inst: TaskInstance,
    partner: TaskInstance | undefined,
  ): Promise<void> {
    if (!partner || this.isSyncing(inst)) return
    await this.applyToPartner(inst, partner, () =>
      this.host.deleteInstance(partner),
    )
  }

  /**
   * Either side moved to another date: move the other to the same date.
   * Resolves how many tasks moved along (0 or 1) for the move notice.
   */
  async afterMoved(inst: TaskInstance, dateStr: string): Promise<number> {
    if (this.isSyncing(inst)) return 0
    const partner = this.partnerOf(inst)
    if (!partner) return 0
    const moved = await this.applyToPartner(inst, partner, () =>
      this.host.moveToDate(partner, dateStr),
    )
    return moved ? 1 : 0
  }

  private async applyToPartner<T>(
    inst: TaskInstance,
    partner: TaskInstance,
    apply: () => Promise<T>,
  ): Promise<T | undefined> {
    const ids = [inst.instanceId, partner.instanceId].filter(Boolean)
    for (const id of ids) this.syncing.add(id)
    try {
      return await apply()
    } catch (error) {
      console.error('[AiTaskLinkSync] Failed to keep the linked task in step', error)
      return undefined
    } finally {
      for (const id of ids) this.syncing.delete(id)
    }
  }
}

function isAiTask(inst: TaskInstance): boolean {
  return readAiTaskConfig(inst.task?.frontmatter) !== null
}

/** The link of an enabled AI routine, matching the coordinator's candidates. */
function readLinkedRoutineConfig(inst: TaskInstance) {
  const task = inst.task
  if (!task || !isAiTask(inst)) return null
  if (task.isRoutine !== true && task.frontmatter?.['isRoutine'] !== true) {
    return null
  }
  if (
    task.routine_enabled === false ||
    task.frontmatter?.['routine_enabled'] === false
  ) {
    return null
  }
  return readObsidianTaskLinkConfig(task.frontmatter)
}

function resolveTitle(inst: TaskInstance): string {
  return (
    resolveTaskDisplayTitle(
      inst.task?.frontmatter,
      inst.task?.displayTitle,
      inst.task?.file?.basename,
      inst.task?.name,
    ) ?? ''
  )
}
