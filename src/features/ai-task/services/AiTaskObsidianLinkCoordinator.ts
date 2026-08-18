import type { TaskInstance } from '../../../types'
import { resolveTaskDisplayTitle } from '../../../utils/taskDisplayTitle'
import { readAiTaskConfig } from './AiTaskFrontmatterReader'
import {
  matchesObsidianTaskTitle,
  readObsidianTaskLinkConfig,
} from './ObsidianTaskLinkConfig'

export interface AiTaskObsidianLinkCoordinatorHost {
  getTaskInstances: () => readonly TaskInstance[]
  /** Returns the concrete instance that actually started (a duplicate when needed). */
  startLinkedAiTask: (target: TaskInstance) => Promise<TaskInstance | null>
  stopLinkedAiTask: (target: TaskInstance) => Promise<boolean>
}

/**
 * Runtime-only ownership evidence keyed by the stable identity reconstructed
 * by TaskLoader. This survives closing/reopening the view (which creates new
 * TaskInstance objects), but intentionally resets on a full plugin reload.
 * Without evidence from this module lifetime, leaving an AI run alone is safer
 * than stopping a run the coordinator may not have started.
 */
const sourceInstanceIdsByOwnedTargetKey = new Map<string, Set<string>>()
let sourceInstanceIdsByEphemeralTarget = new WeakMap<
  TaskInstance,
  Set<string>
>()

/**
 * Couples a successfully started human task to the first matching AI routine.
 *
 * TaskChute for Agents crosses the process boundary through a watched
 * `running-task.json`. TaskChute Plus already owns both events, so this class
 * keeps the same matching semantics without an unauthenticated HTTP/file
 * bridge. Source-to-target ownership is recorded by instance id so duplicate
 * tasks do not collide.
 */
export class AiTaskObsidianLinkCoordinator {
  private readonly targetInstanceIdBySource = new Map<string, string>()
  private readonly targetInstanceBySource = new Map<string, TaskInstance>()
  private readonly sourceGenerationById = new Map<string, number>()
  private readonly pendingStartBySource = new Map<string, Promise<void>>()
  private readonly pendingStartByTargetPath = new Map<string, Promise<void>>()
  /**
   * Sources observed by this coordinator that did not start a target.
   *
   * This prevents a source that merely encountered an already-running target
   * from claiming it within the same coordinator lifetime. A recreated
   * coordinator additionally requires runtime ownership evidence on target.
   */
  private readonly sourceInstanceIdsWithoutOwnership = new Set<string>()

  constructor(private readonly host: AiTaskObsidianLinkCoordinatorHost) {}

  async handleSourceStarted(source: TaskInstance): Promise<void> {
    if (readAiTaskConfig(source.task.frontmatter)) return

    const pendingStart = this.pendingStartBySource.get(source.instanceId)
    if (pendingStart) {
      await pendingStart
      // A stop followed by a restart can arrive before the cancelled start
      // settles. Serialize the restart so the cancelled completion cannot
      // stop the newer generation's target.
      if (source.state === 'running') {
        await this.handleSourceStarted(source)
      }
      return
    }

    if (
      this.targetInstanceIdBySource.has(source.instanceId) ||
      this.sourceInstanceIdsWithoutOwnership.has(source.instanceId)
    ) {
      return
    }

    const sourceTitle = this.resolveTaskTitle(source)
    if (!sourceTitle) return

    const target = this.findMatchingTarget(sourceTitle)
    if (!target || target.state === 'running') {
      this.sourceInstanceIdsWithoutOwnership.add(source.instanceId)
      return
    }

    const targetPathKey = target.task.path || target.instanceId
    const pendingTargetStart = this.pendingStartByTargetPath.get(targetPathKey)
    if (pendingTargetStart) {
      await pendingTargetStart
      if (source.state === 'running') {
        await this.handleSourceStarted(source)
      }
      return
    }

    // Mark the source before awaiting so a failed/refused start never gains
    // ownership through the stop-time reload fallback.
    this.sourceInstanceIdsWithoutOwnership.add(source.instanceId)
    const generation = this.advanceSourceGeneration(source.instanceId)
    const operation = this.completeSourceStart(source, target, generation)
    this.pendingStartBySource.set(source.instanceId, operation)
    this.pendingStartByTargetPath.set(targetPathKey, operation)
    try {
      await operation
    } finally {
      if (this.pendingStartBySource.get(source.instanceId) === operation) {
        this.pendingStartBySource.delete(source.instanceId)
      }
      if (this.pendingStartByTargetPath.get(targetPathKey) === operation) {
        this.pendingStartByTargetPath.delete(targetPathKey)
      }
    }
  }

  async handleSourceStopped(source: TaskInstance): Promise<void> {
    if (readAiTaskConfig(source.task.frontmatter)) return

    // Invalidate an in-flight start before inspecting ownership. Its async
    // completion will stop the concrete target returned by the host.
    this.advanceSourceGeneration(source.instanceId)

    const instances = this.host.getTaskInstances()
    const explicitlyUnowned = this.sourceInstanceIdsWithoutOwnership.delete(
      source.instanceId,
    )
    const mappedId = this.targetInstanceIdBySource.get(source.instanceId)
    const mappedInstance = this.targetInstanceBySource.get(source.instanceId)
    this.targetInstanceIdBySource.delete(source.instanceId)
    this.targetInstanceBySource.delete(source.instanceId)

    if (explicitlyUnowned && !mappedId) return

    let target: TaskInstance | undefined
    let restoredRuntimeOwnership = false

    if (mappedId) {
      target = instances.find((candidate) => candidate.instanceId === mappedId)
      // A stale mapped id is explicit evidence that the formerly-owned
      // instance disappeared. Never redirect the stop to another run merely
      // because its title also matches.
      if (!target) {
        if (mappedInstance) {
          removeRuntimeOwnership(mappedInstance, source.instanceId)
        }
        return
      }
    }

    if (!target) {
      // Runtime ownership is authoritative. Titles, task paths, and linkage
      // settings may all be edited while a run is active, so restoring a stop
      // after view recreation must not depend on re-matching mutable metadata.
      target = instances.find((candidate) =>
        hasRuntimeOwnership(candidate, source.instanceId),
      )
      restoredRuntimeOwnership = Boolean(target)
    }

    if (target) {
      const successor = this.findAnotherMatchingRunningSource(source, target)
      if (successor) {
        this.transferRuntimeOwnership(source, successor, target)
        return
      }
      if (hasOtherRuntimeOwnership(target, source.instanceId)) {
        removeRuntimeOwnership(target, source.instanceId)
        return
      }
    }

    if (target?.state === 'running') {
      const stopped = await this.host.stopLinkedAiTask(target)
      if (stopped) {
        removeRuntimeOwnership(target, source.instanceId)
      }
    } else if (target && (mappedId || restoredRuntimeOwnership)) {
      removeRuntimeOwnership(target, source.instanceId)
    }
  }

  private async completeSourceStart(
    source: TaskInstance,
    target: TaskInstance,
    generation: number,
  ): Promise<void> {
    const startedTarget = await this.host.startLinkedAiTask(target)
    if (!startedTarget) return

    if (this.sourceGenerationById.get(source.instanceId) !== generation) {
      if (
        startedTarget.state === 'running' &&
        !hasAnyRuntimeOwnership(startedTarget)
      ) {
        await this.host.stopLinkedAiTask(startedTarget)
      }
      return
    }

    this.sourceInstanceIdsWithoutOwnership.delete(source.instanceId)
    this.targetInstanceIdBySource.set(
      source.instanceId,
      startedTarget.instanceId,
    )
    this.targetInstanceBySource.set(source.instanceId, startedTarget)
    addRuntimeOwnership(startedTarget, source.instanceId)
  }

  private advanceSourceGeneration(sourceInstanceId: string): number {
    const next = (this.sourceGenerationById.get(sourceInstanceId) ?? 0) + 1
    this.sourceGenerationById.set(sourceInstanceId, next)
    return next
  }

  private findMatchingTarget(
    sourceTitle: string,
    options: {
      runningOnly?: boolean
    } = {},
  ): TaskInstance | undefined {
    const candidates = this.host.getTaskInstances().filter((candidate) => {
      if (options.runningOnly && candidate.state !== 'running') return false
      if (!readAiTaskConfig(candidate.task.frontmatter)) return false
      if (
        candidate.task.isRoutine !== true &&
        candidate.task.frontmatter['isRoutine'] !== true
      ) {
        return false
      }
      if (
        candidate.task.routine_enabled === false ||
        candidate.task.frontmatter['routine_enabled'] === false
      ) {
        return false
      }
      const link = readObsidianTaskLinkConfig(candidate.task.frontmatter)
      return link ? matchesObsidianTaskTitle(sourceTitle, link) : false
    })

    const first = candidates[0]
    if (!first || options.runningOnly) return first

    // A visible/template instance can precede its running duplicate. Treat
    // all instances of the same task path as one logical AI task and prefer
    // the running concrete instance to avoid dispatching a second run.
    return (
      candidates.find(
        (candidate) =>
          candidate.task.path === first.task.path &&
          candidate.state === 'running',
      ) ?? first
    )
  }

  private findAnotherMatchingRunningSource(
    stoppedSource: TaskInstance,
    target: TaskInstance,
  ): TaskInstance | undefined {
    const link = readObsidianTaskLinkConfig(target.task.frontmatter)
    if (!link) return undefined

    return this.host.getTaskInstances().find((candidate) => {
      if (candidate.instanceId === stoppedSource.instanceId) return false
      if (candidate.state !== 'running') return false
      if (readAiTaskConfig(candidate.task.frontmatter)) return false
      const ownedTargetId = this.targetInstanceIdBySource.get(
        candidate.instanceId,
      )
      if (ownedTargetId && ownedTargetId !== target.instanceId) return false
      const title = this.resolveTaskTitle(candidate)
      return title.length > 0 && matchesObsidianTaskTitle(title, link)
    })
  }

  private transferRuntimeOwnership(
    source: TaskInstance,
    successor: TaskInstance,
    target: TaskInstance,
  ): void {
    removeRuntimeOwnership(target, source.instanceId)
    addRuntimeOwnership(target, successor.instanceId)
    this.sourceInstanceIdsWithoutOwnership.delete(successor.instanceId)
    this.targetInstanceIdBySource.set(
      successor.instanceId,
      target.instanceId,
    )
    this.targetInstanceBySource.set(successor.instanceId, target)
  }

  private resolveTaskTitle(instance: TaskInstance): string {
    return resolveTaskDisplayTitle(
      instance.task.frontmatter,
      instance.task.displayTitle,
      instance.task.file?.basename,
      instance.task.name,
    ) ?? ''
  }
}

function addRuntimeOwnership(
  target: TaskInstance,
  sourceInstanceId: string,
): void {
  const owners = getRuntimeOwners(target) ?? new Set<string>()
  owners.add(sourceInstanceId)
  setRuntimeOwners(target, owners)
}

function removeRuntimeOwnership(
  target: TaskInstance,
  sourceInstanceId: string,
): void {
  const owners = getRuntimeOwners(target)
  if (!owners) return
  owners.delete(sourceInstanceId)
  if (owners.size === 0) {
    deleteRuntimeOwners(target)
  }
}

function hasRuntimeOwnership(
  target: TaskInstance,
  sourceInstanceId: string,
): boolean {
  return getRuntimeOwners(target)?.has(sourceInstanceId) ?? false
}

function hasAnyRuntimeOwnership(target: TaskInstance): boolean {
  return (getRuntimeOwners(target)?.size ?? 0) > 0
}

function hasOtherRuntimeOwnership(
  target: TaskInstance,
  sourceInstanceId: string,
): boolean {
  const owners = getRuntimeOwners(target)
  if (!owners) return false
  for (const owner of owners) {
    if (owner !== sourceInstanceId) return true
  }
  return false
}

function getRuntimeTargetKey(target: TaskInstance): string | undefined {
  const instanceId = target.instanceId?.trim()
  if (!instanceId) return undefined
  return instanceId
}

function getRuntimeOwners(target: TaskInstance): Set<string> | undefined {
  const key = getRuntimeTargetKey(target)
  return key
    ? sourceInstanceIdsByOwnedTargetKey.get(key)
    : sourceInstanceIdsByEphemeralTarget.get(target)
}

function setRuntimeOwners(target: TaskInstance, owners: Set<string>): void {
  const key = getRuntimeTargetKey(target)
  if (key) {
    sourceInstanceIdsByOwnedTargetKey.set(key, owners)
  } else {
    sourceInstanceIdsByEphemeralTarget.set(target, owners)
  }
}

function deleteRuntimeOwners(target: TaskInstance): void {
  const key = getRuntimeTargetKey(target)
  if (key) {
    sourceInstanceIdsByOwnedTargetKey.delete(key)
  } else {
    sourceInstanceIdsByEphemeralTarget.delete(target)
  }
}

/** @internal Test isolation for the module-lifetime ownership registry. */
export function resetAiTaskObsidianLinkRuntimeOwnershipForTests(): void {
  sourceInstanceIdsByOwnedTargetKey.clear()
  sourceInstanceIdsByEphemeralTarget = new WeakMap<TaskInstance, Set<string>>()
}
