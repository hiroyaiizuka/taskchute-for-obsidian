---
sidebar_position: 3
---

# Basic Usage

Learn the fundamental operations of TaskChute Plus for daily task management.

## Daily Workflow Overview

TaskChute Plus follows a simple daily workflow:

1. **Plan** your day by adding tasks with time estimates
2. **Execute** tasks one by one, tracking actual time
3. **Review** your day to improve future estimates
4. **Repeat** the cycle for continuous improvement

## Core Operations

### Opening the Task Panel

**Hotkey Method (Recommended)**:
- Press **Option+T** (⌥T) to instantly open today's task list

**Ribbon Method**:
- Click the TaskChute Plus icon in the left ribbon

**Command Palette**:
- Press **Cmd+P** (Ctrl+P on Windows)
- Type "TaskChute" and select "Show today's tasks"

### Creating Tasks

#### Quick Task Creation

1. Open the task panel
2. Click **"Add Task"** or the `+` button
3. Fill in the basic information:
   - **Task Name**: Descriptive title
   - **Estimated Duration**: Your best guess in minutes
   - **Scheduled Time**: (Optional) specific time or leave blank

#### Creating Tasks from Notes

1. Create or edit any note in your vault
2. Add the `#task` tag anywhere in the note
3. The task will automatically appear in TaskChute Plus
4. Use the task panel to set timing and manage status

Example note with task:
```markdown
# Project Planning Meeting

#task

Need to plan the Q4 roadmap with the team.

## Agenda
- Review current progress
- Define Q4 objectives
- Assign responsibilities
```

### Managing Task Status

#### Starting a Task

1. Find your task in the appropriate time slot
2. Click the **Play button** (▶️) or double-click the task
3. The task status changes to "Running"
4. Timer starts automatically
5. Only one task can run at a time

#### Pausing a Task

1. Click the **Pause button** (⏸️) on the running task
2. Task returns to "Pending" status
3. Time tracking pauses
4. You can resume later or start a different task

#### Completing a Task

1. Click the **Checkmark button** (✅)
2. Task status changes to "Completed"
3. Actual duration is recorded
4. Task moves to the completed section
5. You can add completion notes if desired

### Time Slot Organization

Tasks are automatically organized into time slots:

#### Morning (6:00 AM - 12:00 PM)
- Perfect for deep work and important tasks
- Fresh mental energy
- Minimal distractions

#### Afternoon (12:00 PM - 6:00 PM)
- Great for meetings and collaborative work
- Administrative tasks
- Email and communication

#### Evening (6:00 PM - 10:00 PM)
- Learning and development
- Planning tomorrow
- Personal projects

#### Night (10:00 PM - 6:00 AM)
- Generally avoid scheduling tasks here
- Use for emergency or special circumstances
- Consider your sleep schedule

### Understanding Task Information

Each task displays key information:

#### Time Display
```
[Estimated: 30m] → [Actual: 45m]
```
- Shows your estimate vs. reality
- Helps improve future estimates
- Green = under estimate, Red = over estimate

#### Status Indicators
- **⏸️ Pending**: Not started yet
- **▶️ Running**: Currently active (timer running)
- **✅ Completed**: Finished
- **⏭️ Moved**: Rescheduled to another day

#### Task Priority
- Tasks are ordered by scheduled time
- Unscheduled tasks appear at the bottom of each time slot
- Overdue tasks are highlighted

## Essential Daily Practices

### Morning Planning (5-10 minutes)

1. Open TaskChute Plus with **Option+T**
2. Review yesterday's completed tasks
3. Add today's tasks with realistic estimates
4. Organize tasks by time slots
5. Start your first task immediately

### During the Day

1. **Work on one task at a time** - always have a running task
2. **Track actual time** - be honest about interruptions
3. **Update estimates** if a task will take much longer
4. **Move tasks** if your schedule changes
5. **Take breaks** between time slots

### Evening Review (10-15 minutes)

1. Complete your final task
2. Review actual vs. estimated times
3. Note what went well and what didn't
4. Plan tomorrow's priority tasks
5. Archive completed tasks

## Task Actions and Shortcuts

### Right-Click Context Menu

Right-clicking any task opens additional options:
- **Edit Task**: Modify name, estimate, or schedule
- **Duplicate Task**: Create a copy for recurring work
- **Move to Tomorrow**: Reschedule to next day
- **Delete Task**: Remove completely
- **View Note**: Open the associated note (if exists)

### Keyboard Shortcuts

While task panel is active:
- **Space**: Start/pause selected task
- **Enter**: Complete selected task
- **Delete**: Delete selected task
- **Arrow Keys**: Navigate between tasks
- **Escape**: Close task panel

### Drag and Drop

- **Drag tasks** between time slots to reschedule
- **Drop files** on the task panel to create linked tasks
- **Reorder tasks** within time slots by dragging

## Common Patterns

### Pomodoro Technique Integration

1. Set task estimates to 25 minutes
2. Work in focused 25-minute blocks
3. Take 5-minute breaks between tasks
4. Complete 4 tasks, then take a longer break

### Time Blocking

1. Schedule specific tasks at specific times
2. Group similar tasks together
3. Leave buffer time between meetings
4. Protect your deep work hours

### Energy Management

1. Schedule hard tasks during high-energy periods
2. Use low-energy times for routine tasks
3. Match task difficulty to your energy level
4. Take breaks when energy drops

## Troubleshooting Common Issues

### Tasks Not Updating

- Refresh the task panel (close and reopen)
- Check if the task note was modified
- Ensure the `#task` tag is present

### Timer Not Working

- Only one task can run at a time
- Check that you clicked "Start" not just selected the task
- Restart Obsidian if the timer appears stuck

### Tasks in Wrong Time Slot

- Check the scheduled time setting
- Drag the task to the correct time slot
- Unscheduled tasks appear at the bottom

---

**Next Step**: [TaskChute Methodology](../concepts/taskchute-methodology.md) - Understand the principles behind effective time-based task management.