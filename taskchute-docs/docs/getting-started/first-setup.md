---
sidebar_position: 2
---

# First Setup

Configure TaskChute Plus for your workflow and create your first task.

## Initial Configuration

After installing TaskChute Plus, you'll need to configure it for your vault structure and preferences.

### 1. Access Plugin Settings

1. Go to **Settings** (⚙️)
2. Navigate to **Community plugins**
3. Find "TaskChute Plus" and click the ⚙️ settings icon
4. The TaskChute Plus settings panel will open

### 2. Configure Paths

Set up where TaskChute Plus will store and look for your data:

#### Task Directory
```
Default: tasks/
Example: tasks/ or Projects/Tasks/
```
- This is where your individual task files will be stored
- Can be any folder in your vault
- Will be created automatically if it doesn't exist

#### Project Directory
```
Default: projects/
Example: projects/ or Work/Projects/
```
- Where your project notes are stored
- Used for linking tasks to projects
- Optional - leave empty if you don't use projects

#### Log Directory
```
Default: logs/
Example: logs/ or Daily/Logs/
```
- Where time tracking data and daily reviews are stored
- Important for preserving your historical data

### 3. Time Slot Configuration

Configure how your day is organized:

#### Time Slots
- **Morning**: 06:00 - 12:00
- **Afternoon**: 12:00 - 18:00
- **Evening**: 18:00 - 22:00
- **Night**: 22:00 - 06:00

These can be customized based on your schedule and preferences.

#### Default Task Duration
```
Default: 25 minutes (Pomodoro-style)
```
Set the default estimated duration for new tasks.

### 4. Hotkey Setup (Optional)

TaskChute Plus comes with a default hotkey **Option+T** (⌥T) to quickly open today's task list. You can customize this:

1. Go to **Settings** → **Hotkeys**
2. Search for "TaskChute Plus"
3. Set your preferred key combination for "Show today's tasks"

## Creating Your First Task

Let's create your first task to ensure everything is working:

### Method 1: Using the Ribbon Icon

1. Click the TaskChute Plus icon in the left ribbon
2. The task panel will open showing today's schedule
3. Click "Add Task" or use the `+` button
4. Fill in the task details:
   - **Name**: "Setup TaskChute Plus documentation review"
   - **Estimated Duration**: 30 minutes
   - **Project**: (optional) "Learning"
   - **Scheduled Time**: (optional) or leave for next available slot

### Method 2: Using the Hotkey

1. Press **Option+T** (⌥T) or your custom hotkey
2. The task panel opens
3. Add your task as described above

### Method 3: Creating a Note with #task Tag

1. Create a new note anywhere in your vault
2. Add the `#task` tag somewhere in the note
3. TaskChute Plus will automatically detect it
4. Use the task panel to manage timing and status

## Verify Your Setup

After creating your first task:

1. **Check the task appears** in the TaskChute Plus panel
2. **Start the task** by clicking the play button
3. **Observe time tracking** - you should see the timer running
4. **Complete the task** and note the actual vs. estimated time
5. **Check the log files** in your configured log directory

## Understanding the Interface

### Task Panel Elements

- **Time Slots**: Morning, Afternoon, Evening, Night sections
- **Task Status**: Pending (⏸️), Running (▶️), Completed (✅)
- **Time Information**: Estimated vs. actual duration
- **Quick Actions**: Start, pause, complete, edit buttons

### Task States

- **Pending**: Task is scheduled but not started
- **Running**: Task is currently being worked on (timer active)
- **Completed**: Task is finished (shows actual duration)

## Common First-Time Issues

### Tasks Not Appearing

If your tasks don't appear in the panel:

1. Verify the task has the `#task` tag
2. Check that the file is in the correct directory (if specified)
3. Refresh the panel or restart Obsidian
4. Check the console for any error messages

### Time Tracking Not Working

If the timer isn't working:

1. Ensure you clicked the "Start" button on the task
2. Check that only one task can be running at a time
3. Verify the log directory is writable

### Hotkey Not Working

If **Option+T** doesn't open the task panel:

1. Check for conflicts with other plugins or system shortcuts
2. Try customizing the hotkey in Obsidian settings
3. Ensure TaskChute Plus is enabled and active

## Next Steps

Once you have TaskChute Plus working with your first task:

1. **Learn the basics**: [Basic Usage](./basic-usage.md)
2. **Understand concepts**: [TaskChute Methodology](../concepts/taskchute-methodology.md)
3. **Explore features**: [Task Management](../features/task-management.md)

---

**Next Step**: [Basic Usage](./basic-usage.md) - Learn the fundamental operations of TaskChute Plus.