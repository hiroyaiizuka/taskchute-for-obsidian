---
sidebar_position: 1
---

# Installation

Learn how to install TaskChute Plus in your Obsidian vault.

## Prerequisites

Before installing TaskChute Plus, ensure you have:

- **Obsidian** version 1.0.0 or higher
- **Community plugins enabled** in Obsidian settings
- A basic understanding of Obsidian notes and folders

## Installation Methods

### Method 1: Community Plugin Store (Recommended)

1. Open Obsidian and go to **Settings** (⚙️)
2. Navigate to **Community plugins**
3. Click **Browse** to open the community plugin browser
4. Search for "**TaskChute Plus**"
5. Click **Install** on the TaskChute Plus plugin
6. Once installed, click **Enable** to activate the plugin

### Method 2: Manual Installation (Beta/Development)

For beta versions or if you want to use the latest development version:

1. Download the latest release from [GitHub Releases](https://github.com/taskchute-plus/taskchute-plus/releases)
2. Extract the zip file
3. Copy the extracted folder to your vault's `.obsidian/plugins/` directory
4. Restart Obsidian
5. Go to **Settings** → **Community plugins**
6. Find "TaskChute Plus" in the installed plugins list
7. Click the toggle to enable it

### Method 3: BRAT Plugin (Beta Testing)

If you want to test beta versions using the BRAT plugin:

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) first
2. Open BRAT settings
3. Click "Add Beta plugin"
4. Enter: `taskchute-plus/taskchute-plus`
5. Click "Add Plugin"
6. Enable TaskChute Plus in Community plugins

## Verification

After installation, verify TaskChute Plus is working:

1. Check that "TaskChute Plus" appears in your **Community plugins** list
2. Look for the TaskChute Plus icon in your Obsidian ribbon (left sidebar)
3. Try the hotkey **Option+T** (⌥T) to open the task list
4. You should see "TaskChute Plus activated" in the Obsidian console (Ctrl+Shift+I → Console)

## Initial Setup

After successful installation, proceed to [First Setup](./first-setup.md) to configure TaskChute Plus for your workflow.

## Troubleshooting Installation

### Plugin Not Appearing

If TaskChute Plus doesn't appear in your plugin list:

1. Ensure **Community plugins** are enabled in Settings
2. Restart Obsidian completely
3. Check that you're using Obsidian version 1.0.0 or higher
4. Verify the plugin files are in the correct directory: `.obsidian/plugins/taskchute-plus/`

### Plugin Won't Enable

If the plugin installs but won't enable:

1. Check the Obsidian console for error messages (Ctrl+Shift+I → Console)
2. Ensure no other task management plugins are conflicting
3. Try disabling other plugins temporarily to isolate the issue
4. Report the issue on [GitHub](https://github.com/taskchute-plus/taskchute-plus/issues)

### Performance Issues

If Obsidian becomes slow after installation:

1. Check your vault size - very large vaults may need optimization
2. Review the [Performance Guide](../troubleshooting/performance.md)
3. Consider adjusting scan intervals in plugin settings

## Uninstallation

To remove TaskChute Plus:

1. Go to **Settings** → **Community plugins**
2. Find "TaskChute Plus" and click the toggle to disable it
3. Click the ⚙️ icon next to TaskChute Plus
4. Click **Uninstall**
5. Optionally, delete any TaskChute Plus data files from your vault

---

**Next Step**: [First Setup](./first-setup.md) - Configure TaskChute Plus for your workflow.