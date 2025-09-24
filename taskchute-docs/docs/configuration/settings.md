---
sidebar_position: 1
---

# Plugin Settings

Configure TaskChute Plus to match your workflow and preferences.

## Accessing Settings

1. Go to **Settings** (⚙️) in Obsidian
2. Navigate to **Community plugins**
3. Find "TaskChute Plus" in the installed plugins list
4. Click the ⚙️ **settings icon** next to the plugin name

## General Settings

### Default Task Duration
```
Default: 25 minutes
Range: 5-240 minutes
```

Sets the default estimated duration for new tasks. Based on the Pomodoro Technique's 25-minute work blocks, but can be adjusted to match your preferred work style.

**Recommendations:**
- **25 minutes**: Good for focused work sessions
- **30 minutes**: Standard meeting duration
- **60 minutes**: Deep work sessions
- **15 minutes**: Quick administrative tasks

### Auto-start First Task
```
Default: false
Options: true/false
```

When enabled, automatically starts the first pending task of the day when you open TaskChute Plus.

**Use Cases:**
- **Enable**: If you have consistent morning routines
- **Disable**: If you prefer manual control over task timing

### Hotkey Configuration
```
Default: Option+T (⌥T)
Customizable: Yes
```

Configure the hotkey to open today's task list. Can be customized in Obsidian's **Settings** → **Hotkeys** → "TaskChute Plus: Show today's tasks".

## Path Configuration

### Task Directory
```
Default: tasks/
Example: Projects/Tasks/, Work/Daily-Tasks/
```

Directory where individual task files are stored. This can be:
- A dedicated tasks folder
- Part of your existing project structure
- Any folder in your vault

**Important Notes:**
- Will be created automatically if it doesn't exist
- Supports nested directories
- Must be relative to your vault root

### Project Directory
```
Default: projects/
Example: Projects/, Work/Projects/, Areas/
```

Directory where project notes are stored. Used for:
- Linking tasks to projects
- Project progress tracking
- Time allocation analysis

**Leave blank** if you don't use project-based organization.

### Log Directory
```
Default: logs/
Example: Logs/, Daily/Logs/, Meta/TaskChute-Logs/
```

Directory where time tracking data and daily reviews are stored. Contains:
- Daily execution logs (JSON format)
- Weekly summary reports
- Historical performance data

**Critical for data preservation** - backup this directory regularly.

## Time Slot Configuration

### Morning Time Slot
```
Default: 06:00 - 12:00
Format: HH:mm - HH:mm
```

Define when your morning work period begins and ends.

**Customization Examples:**
- **Early Bird**: 05:00 - 11:00
- **Standard**: 06:00 - 12:00
- **Late Starter**: 08:00 - 14:00

### Afternoon Time Slot
```
Default: 12:00 - 18:00
Format: HH:mm - HH:mm
```

Your primary work hours, typically including lunch.

### Evening Time Slot
```
Default: 18:00 - 22:00
Format: HH:mm - HH:mm
```

Personal time, side projects, or extended work hours.

### Night Time Slot
```
Default: 22:00 - 06:00
Format: HH:mm - HH:mm
```

Generally not recommended for regular task scheduling. Use for:
- Emergency tasks
- Special circumstances
- Different time zones

## Display Settings

### Time Format
```
Options: 12-hour, 24-hour
Default: System preference
```

Choose how times are displayed throughout the interface.

### Task Duration Display
```
Options: Minutes only, Hours and minutes, Compact
Examples: "45 min", "1h 45m", "1:45"
```

How task durations appear in the interface.

### Show Completed Tasks
```
Default: true
Options: true/false
```

Whether to show completed tasks in the main task panel.

**Recommendations:**
- **Show**: Good for tracking daily accomplishments
- **Hide**: Cleaner interface, focus on remaining work

### Color Coding
```
Running Task: Green
Pending Task: Blue
Completed Task: Gray
Overdue Task: Red
```

Customize colors for different task states (if supported by your theme).

## Advanced Settings

### Auto-save Interval
```
Default: 30 seconds
Range: 10-300 seconds
```

How often TaskChute Plus saves your data to prevent loss.

**Balance Considerations:**
- **Shorter**: Better data protection, more disk activity
- **Longer**: Less disk activity, small risk of data loss

### Task Detection Pattern
```
Default: #task
Options: Custom tag, Frontmatter property
```

How TaskChute Plus identifies tasks in your notes.

**Examples:**
- `#task` - Simple tag in note content
- `#todo` - If you prefer different terminology
- `task: true` - Frontmatter property

### Maximum Running Tasks
```
Default: 1
Options: 1-3
```

How many tasks can run simultaneously.

**Recommendations:**
- **1**: Best for focused work (recommended)
- **2-3**: Only if you frequently multitask

### Notification Settings
```
Task Started: Optional notification
Task Completed: Optional notification
Time Estimates: Warning for long-running tasks
```

Configure desktop notifications for task events.

## Integration Settings

### Dataview Integration
```
Default: Enabled (if Dataview plugin is installed)
```

Enable integration with the Dataview plugin for advanced queries and reports.

**Features When Enabled:**
- Task queries in notes
- Automatic project progress tracking
- Custom dashboard creation

### Calendar Integration
```
Default: Enabled (if Calendar plugin is installed)
```

Show TaskChute Plus tasks in your daily calendar view.

### Template Integration
```
Template Directory: templates/taskchute/
Daily Review Template: daily-review.md
```

Configure templates for daily reviews and recurring task structures.

## Performance Settings

### Scan Interval
```
Default: 5 seconds
Range: 1-60 seconds
```

How often TaskChute Plus scans for new or modified tasks.

**Performance Considerations:**
- **Faster**: More responsive, higher CPU usage
- **Slower**: Lower CPU usage, slight delay in updates

### Large Vault Optimization
```
Default: Auto-detect
Options: Enable, Disable, Auto
```

Optimizations for vaults with thousands of notes.

**When to Enable:**
- Vault has >1000 notes
- Performance issues detected
- Slow task loading

## Export and Backup Settings

### Automatic Backup
```
Default: Weekly
Options: Daily, Weekly, Monthly, Disabled
```

Automatically backup your TaskChute Plus data.

**Backup Location**: Within your vault's log directory

### Export Format
```
Options: JSON, CSV, Markdown
Default: JSON (preserves all data)
```

Format for manual data exports.

### Data Retention
```
Default: 1 year
Options: 3 months, 6 months, 1 year, Forever
```

How long to keep detailed time tracking data.

## Troubleshooting Settings

### Debug Mode
```
Default: Disabled
Use: Only when troubleshooting issues
```

Enables detailed logging for diagnosing problems.

**When to Enable:**
- Tasks not appearing
- Time tracking issues
- Performance problems
- When reporting bugs

### Reset to Defaults
```
Action: Reset all settings
Warning: Cannot be undone
```

Restores all settings to their default values.

---

**Next**: [Path Configuration](./paths.md) - Detailed guide to organizing your TaskChute Plus files and directories.