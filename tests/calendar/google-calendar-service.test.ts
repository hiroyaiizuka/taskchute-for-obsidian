import { GoogleCalendarService } from "../../src/features/calendar/services/GoogleCalendarService"
import type { TaskInstance } from "../../src/types"

const createInstance = (overrides: Partial<TaskInstance> = {}): TaskInstance => {
  const baseTask = {
    path: "Tasks/sample.md",
    name: "Sample task",
    displayTitle: "Display title",
    frontmatter: {},
    isRoutine: false,
    estimatedMinutes: 30,
    file: { path: "Tasks/sample.md" } as unknown as import("obsidian").TFile,
  }

  const inst: TaskInstance = {
    instanceId: "inst-1",
    state: "idle",
    slotKey: "8:00-12:00",
    date: "2025-12-17",
    task: baseTask,
    ...overrides,
  } as TaskInstance

  if (overrides.task) {
    inst.task = { ...baseTask, ...overrides.task }
  }

  return inst
}

const createService = (noteBody = "Body text") => {
  const app = {
    vault: {
      getName: jest.fn(() => "VaultName"),
      read: jest.fn(async () => noteBody),
    },
  } as unknown as import("obsidian").App

  return {
    app,
    service: new GoogleCalendarService(app),
  }
}

const settings = {
  enabled: true,
  defaultDurationMinutes: 60,
}

describe("GoogleCalendarService", () => {
  test("builds event from scheduled time and estimate", async () => {
    const { service } = createService("---\ntitle: test\n---\nBody text")
    const inst = createInstance({
      task: {
        path: "Tasks/sample.md",
        name: "Sample task",
        displayTitle: "Display title",
        frontmatter: { scheduled_time: "09:00" },
        isRoutine: false,
        estimatedMinutes: 30,
      },
      slotKey: "8:00-12:00",
    })

    const event = await service.buildEventFromTask(inst, settings, {
      viewDate: new Date("2025-12-17T00:00:00"),
      defaultDurationMinutes: 60,
    })

    expect(event.startTimeText).toBe("09:00")
    expect(event.endTimeText).toBe("09:30")
    expect(event.dateKey).toBe("2025-12-17")
    expect(event.description).toBe("Body text")
  })

  test("falls back to slot start when no scheduled time", async () => {
    const { service } = createService("")
    const inst = createInstance({
      task: {
        path: "Tasks/slot.md",
        name: "Slot task",
        displayTitle: "Slot task",
        frontmatter: {},
        isRoutine: false,
        estimatedMinutes: 45,
        file: { path: "Tasks/slot.md" } as unknown as import("obsidian").TFile,
      },
      slotKey: "12:00-16:00",
    })

    const event = await service.buildEventFromTask(inst, settings, {
      viewDate: new Date("2025-12-17T00:00:00"),
      defaultDurationMinutes: 45,
    })

    expect(event.startTimeText).toBe("12:00")
    expect(event.endTimeText).toBe("12:45")
    expect(event.description).toBe("")
  })

  test("buildEventUrl encodes title and details", async () => {
    const { service } = createService("")
    const inst = createInstance({
      task: {
        path: "Tasks/url.md",
        name: "URL Task",
        displayTitle: "URL Task",
        frontmatter: { scheduled_time: "10:00" },
        isRoutine: false,
      },
    })

    const event = await service.buildEventFromTask(inst, settings, {
      viewDate: new Date("2025-12-17T00:00:00"),
      defaultDurationMinutes: 60,
    })

    const url = service.buildEventUrl(event)
    expect(url).toContain("action=TEMPLATE")
    expect(url).toContain("text=URL+Task")
    expect(url).toContain("details=")
    expect(url).toContain("calendar.google.com")
  })

  test("adds RRULE for weekly routine", async () => {
    const { service } = createService("")
    const inst = createInstance({
      task: {
        path: "Tasks/routine.md",
        name: "Routine",
        displayTitle: "Routine",
        frontmatter: {
          routine_type: "weekly",
          routine_weekday: 0,
          routine_interval: 1,
          scheduled_time: "07:00",
        },
        isRoutine: true,
      },
      date: "2025-12-21",
    })

    const event = await service.buildEventFromTask(inst, settings, {
      viewDate: new Date("2025-12-21T00:00:00"),
      defaultDurationMinutes: 30,
    })

    const url = service.buildEventUrl(event)
    expect(url).toContain("recur=RRULE%3AFREQ%3DWEEKLY%3BINTERVAL%3D1%3BBYDAY%3DSU")
  })

  test("adds RRULE for monthly date routine", async () => {
    const { service } = createService("")
    const inst = createInstance({
      task: {
        path: "Tasks/routine-date.md",
        name: "Routine date",
        displayTitle: "Routine date",
        frontmatter: {
          routine_type: "monthly_date",
          routine_interval: 1,
          routine_monthdays: [1, 15, "last"],
          scheduled_time: "07:00",
        },
        isRoutine: true,
      },
      date: "2025-12-15",
    })

    const event = await service.buildEventFromTask(inst, settings, {
      viewDate: new Date("2025-12-15T00:00:00"),
      defaultDurationMinutes: 30,
    })

    const url = service.buildEventUrl(event)
    expect(url).toContain(
      "recur=RRULE%3AFREQ%3DMONTHLY%3BINTERVAL%3D1%3BBYMONTHDAY%3D1%2C15%2C-1",
    )
  })
})
