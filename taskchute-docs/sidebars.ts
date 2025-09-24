import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
const sidebars: SidebarsConfig = {
  // TaskChute Plus documentation sidebar
  docsSidebar: [
    'introduction',
    {
      type: 'category',
      label: 'Getting Started',
      items: [
        'getting-started/installation',
        'getting-started/first-setup',
        'getting-started/basic-usage',
      ],
    },
    {
      type: 'category',
      label: 'Core Concepts',
      items: [
        'concepts/taskchute-methodology',
        'concepts/task-lifecycle',
        'concepts/time-tracking',
        'concepts/routine-tasks',
      ],
    },
    {
      type: 'category',
      label: 'Features',
      items: [
        'features/task-management',
        'features/time-tracking',
        'features/daily-review',
        'features/progress-monitoring',
        'features/procrastination-heatmap',
        'features/routine-tasks',
        'features/hotkeys',
      ],
    },
    {
      type: 'category',
      label: 'Configuration',
      items: [
        'configuration/settings',
        'configuration/paths',
        'configuration/customization',
      ],
    },
    {
      type: 'category',
      label: 'Advanced Usage',
      items: [
        'advanced/project-management',
        'advanced/integration-tips',
        'advanced/dataview-queries',
        'advanced/templates',
      ],
    },
    {
      type: 'category',
      label: 'Troubleshooting',
      items: [
        'troubleshooting/common-issues',
        'troubleshooting/performance',
        'troubleshooting/migration',
      ],
    },
    {
      type: 'category',
      label: 'Developer Guide',
      items: [
        'developer/architecture',
        'developer/api-reference',
        'developer/contributing',
        'developer/building',
      ],
    },
  ],
};

export default sidebars;
