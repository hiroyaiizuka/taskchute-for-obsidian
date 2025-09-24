---
sidebar_position: 1
---

# Task Management

Comprehensive guide to creating, organizing, and managing tasks in TaskChute Plus.

## Task Creation Methods

TaskChute Plus offers multiple ways to create tasks, fitting naturally into your existing Obsidian workflow.

### Method 1: Quick Task Panel

The fastest way to add tasks:

1. Press **Option+T** (⌥T) to open the task panel
2. Click **"Add Task"** or the `+` button
3. Fill in the task details:
   - **Name**: Descriptive title for the task
   - **Estimated Duration**: Time in minutes (e.g., 30, 45, 60)
   - **Scheduled Time**: Specific time or leave blank for next available slot
   - **Project**: (Optional) Link to an existing project
   - **Priority**: High, Medium, Low (affects ordering)

### Method 2: Note-Based Tasks

Create tasks directly in your notes:

```markdown
# Weekly Planning Session

#task

Planning for next week's priorities and deadlines.

## Agenda
- Review last week's progress
- Set priorities for coming week
- Update project timelines
```

**Key Points:**
- Any note with `#task` becomes a TaskChute Plus task
- The note content becomes the task description
- You can add additional metadata in the note frontmatter

### Method 3: Frontmatter Tasks

For advanced users, create tasks with detailed metadata:

```markdown
---
task: true
estimate: 45
scheduled: "14:30"
project: "Website Redesign"
priority: high
tags: [design, review]
---

# Design Review Meeting

Review the new homepage mockups with the design team.
```

### Method 4: Template-Based Tasks

Create task templates for recurring work:

```markdown
---
task: true
estimate: 60
project: "{{project_name}}"
---

# {{task_type}}: {{task_name}}

## Objective
{{objective}}

## Deliverables
- [ ] {{deliverable_1}}
- [ ] {{deliverable_2}}

## Notes
{{notes}}
```

## Task Properties and Metadata

### Core Properties

#### Task Name
- **Purpose**: Clear identification and description
- **Best Practices**:
  - Use action verbs ("Review", "Write", "Analyze")
  - Be specific but concise
  - Include context when helpful

```markdown
Good: "Review Q3 budget report for accuracy"
Avoid: "Budget stuff"
```

#### Estimated Duration
- **Purpose**: Time allocation and planning
- **Best Practices**:
  - Start with your gut feeling
  - Round to 15-minute increments
  - Include buffer time for complex tasks
  - Track actuals to improve estimates

#### Scheduled Time
- **Purpose**: Time-based organization
- **Options**:
  - Specific time: "14:30" or "2:30 PM"
  - Time slot: "morning", "afternoon", "evening"
  - Blank: Auto-assigned to next available slot

#### Project Linkage
- **Purpose**: Connect tasks to larger goals
- **Benefits**:
  - Automatic progress tracking
  - Context switching awareness
  - Project time allocation analysis

### Advanced Properties

#### Priority Levels
- **High**: Must be completed today
- **Medium**: Should be completed today
- **Low**: Can be moved if necessary

#### Task Categories
- **Deep Work**: Requires sustained concentration
- **Administrative**: Quick, low-energy tasks
- **Communication**: Meetings, emails, calls
- **Learning**: Study, research, skill development

#### Energy Requirements
- **High Energy**: Creative work, problem-solving
- **Medium Energy**: Routine analysis, writing
- **Low Energy**: Email, filing, simple edits

## Task Organization Systems

### Time-Based Organization (Default)

Tasks are automatically organized by time slots:

```
Morning (6:00 AM - 12:00 PM)
├── 09:00 - Team standup (15 min)
├── 09:30 - Code review (45 min)
└── 10:30 - Feature development (90 min)

Afternoon (12:00 PM - 6:00 PM)
├── 13:00 - Lunch break (60 min)
├── 14:00 - Client meeting (30 min)
└── 15:00 - Documentation update (60 min)
```

### Project-Based Grouping

View tasks grouped by project:

```
Website Redesign
├── Design review meeting
├── Update homepage copy
└── Test mobile responsiveness

Marketing Campaign
├── Write blog post
├── Design social media graphics
└── Schedule newsletter
```

### Priority-Based Sorting

Order tasks by importance:

```
🔴 High Priority
├── Fix production bug (30 min)
├── Prepare board presentation (120 min)

🟡 Medium Priority
├── Update team wiki (45 min)
├── Review job applications (60 min)

🟢 Low Priority
├── Organize bookmarks (15 min)
├── Clean up desktop (10 min)
```

## Task Status Management

### Status Lifecycle

Tasks progress through clearly defined states:

#### 1. Pending (⏸️)
- **Definition**: Task is scheduled but not started
- **Appearance**: Gray or muted colors
- **Actions**: Start, edit, reschedule, delete

#### 2. Running (▶️)
- **Definition**: Task is currently being worked on
- **Appearance**: Green highlight, timer visible
- **Actions**: Pause, complete, add time
- **Constraints**: Only one task can run at a time

#### 3. Completed (✅)
- **Definition**: Task is finished
- **Appearance**: Struck through, green checkmark
- **Actions**: View details, reopen, archive
- **Data**: Shows actual vs. estimated time

#### 4. Moved (⏭️)
- **Definition**: Task was rescheduled to another day
- **Appearance**: Dimmed with forward arrow
- **Actions**: Move back, delete, edit schedule

### Status Transitions

#### Starting a Task
1. **Single-click** the play button (▶️)
2. **Double-click** the task name
3. **Keyboard shortcut**: Space (when task is selected)
4. **Right-click menu**: "Start Task"

**What Happens:**
- Timer starts automatically
- Task moves to "Running" status
- Any other running task is paused
- Time tracking begins

#### Pausing a Task
1. **Click** the pause button (⏸️)
2. **Keyboard shortcut**: Space (when running task is selected)
3. **Start another task** (auto-pauses current)

**What Happens:**
- Timer stops
- Task returns to "Pending" status
- Elapsed time is saved
- Can be resumed later

#### Completing a Task
1. **Click** the complete button (✅)
2. **Keyboard shortcut**: Enter (when task is selected)
3. **Right-click menu**: "Complete Task"

**What Happens:**
- Final time is recorded
- Task moves to completed section
- Actual vs. estimated comparison is calculated
- Optional completion notes can be added

## Advanced Task Management

### Batch Operations

#### Bulk Scheduling
Select multiple tasks and:
- Assign to same time slot
- Set similar durations
- Apply same project
- Move to different day

#### Template Application
Apply templates to multiple tasks:
- Standard meeting template
- Code review checklist
- Writing task structure

### Task Dependencies

#### Sequential Tasks
Link tasks that must be completed in order:
```markdown
Task A → Task B → Task C
```

#### Parallel Tasks
Tasks that can be worked on simultaneously:
```markdown
Task A ┐
       ├→ Task C
Task B ┘
```

#### Prerequisite Tasks
Tasks that must be completed before others can start:
```markdown
[Prerequisite] → [Dependent Task]
```

### Recurring Task Management

#### Daily Routines
- Morning planning session
- Email processing blocks
- End-of-day review

#### Weekly Patterns
- Team meetings
- Weekly planning
- Status reports

#### Project Milestones
- Sprint planning
- Code reviews
- Client check-ins

## Task Analysis and Insights

### Time Tracking Analysis

#### Accuracy Metrics
- **Estimation Accuracy**: How close estimates are to actuals
- **Completion Rate**: Percentage of planned tasks completed
- **Time Variance**: Average difference between estimated and actual

#### Pattern Recognition
- **Best Performance Times**: When you're most accurate
- **Problem Task Types**: Which tasks consistently run over
- **Energy Patterns**: How task difficulty affects duration

### Productivity Insights

#### Daily Patterns
- Peak performance hours
- Common interruption times
- Energy level fluctuations

#### Weekly Trends
- Most productive days
- Meeting density impact
- Context switching frequency

#### Project Analysis
- Time allocation by project
- Project completion rates
- Resource utilization

---

**Next**: [Time Tracking](./time-tracking.md) - Learn how TaskChute Plus tracks and analyzes your time usage.