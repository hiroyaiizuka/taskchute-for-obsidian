const { analyzeProjectMetrics } = require('../main');

describe('Project Metrics Analysis', () => {
  test('should calculate completed task count correctly', () => {
    const logs = {
      '2025-01-01': [
        { projectName: 'Project A', completed: true, actualDuration: 60 },
        { projectName: 'Project A', completed: true, actualDuration: 30 },
        { projectName: 'Project A', completed: false, actualDuration: 45 }
      ],
      '2025-01-02': [
        { projectName: 'Project A', completed: true, actualDuration: 90 }
      ]
    };

    const metrics = analyzeProjectMetrics('Project A', logs);
    expect(metrics.completedTasks).toBe(3);
  });

  test('should calculate total actual time correctly', () => {
    const logs = {
      '2025-01-01': [
        { projectName: 'Project B', completed: true, actualDuration: 60 },
        { projectName: 'Project B', completed: true, actualDuration: 30 },
        { projectName: 'Project B', completed: false, actualDuration: 45 }
      ]
    };

    const metrics = analyzeProjectMetrics('Project B', logs);
    expect(metrics.actualSpent).toBe(135); // 60 + 30 + 45 minutes
  });

  test('should count work days correctly', () => {
    const logs = {
      '2025-01-01': [
        { projectName: 'Project C', completed: true, actualDuration: 60 }
      ],
      '2025-01-02': [
        { projectName: 'Project C', completed: true, actualDuration: 30 }
      ],
      '2025-01-03': [
        { projectName: 'Project C', completed: false, actualDuration: 45 }
      ]
    };

    const metrics = analyzeProjectMetrics('Project C', logs);
    expect(metrics.workDaysCount).toBe(3);
  });

  test('should calculate task pace correctly', () => {
    const logs = {
      '2025-01-01': [
        { projectName: 'Project D', completed: true, actualDuration: 60 },
        { projectName: 'Project D', completed: true, actualDuration: 30 }
      ],
      '2025-01-02': [
        { projectName: 'Project D', completed: true, actualDuration: 90 },
        { projectName: 'Project D', completed: true, actualDuration: 45 }
      ]
    };

    const metrics = analyzeProjectMetrics('Project D', logs);
    expect(metrics.tasksPerDay).toBe(2); // 4 tasks / 2 days
    expect(metrics.hoursPerDay).toBeCloseTo(1.875, 2); // 225 minutes / 60 / 2 days
  });

  test('should handle empty logs gracefully', () => {
    const logs = {};
    const metrics = analyzeProjectMetrics('Project E', logs);
    
    expect(metrics.completedTasks).toBe(0);
    expect(metrics.actualSpent).toBe(0);
    expect(metrics.workDaysCount).toBe(0);
    expect(metrics.tasksPerDay).toBe(0);
    expect(metrics.hoursPerDay).toBe(0);
  });

  test('should filter tasks by project name', () => {
    const logs = {
      '2025-01-01': [
        { projectName: 'Project F', completed: true, actualDuration: 60 },
        { projectName: 'Project G', completed: true, actualDuration: 30 },
        { projectName: 'Project F', completed: true, actualDuration: 45 }
      ]
    };

    const metrics = analyzeProjectMetrics('Project F', logs);
    expect(metrics.completedTasks).toBe(2);
    expect(metrics.actualSpent).toBe(105); // 60 + 45
  });

  test('should handle missing actualDuration', () => {
    const logs = {
      '2025-01-01': [
        { projectName: 'Project H', completed: true, actualDuration: 60 },
        { projectName: 'Project H', completed: true }, // missing actualDuration
        { projectName: 'Project H', completed: true, actualDuration: 45 }
      ]
    };

    const metrics = analyzeProjectMetrics('Project H', logs);
    expect(metrics.completedTasks).toBe(3);
    expect(metrics.actualSpent).toBe(105); // 60 + 0 + 45
  });

  test('should track first and last task dates', () => {
    const logs = {
      '2025-01-01': [
        { projectName: 'Project I', completed: true, actualDuration: 60 }
      ],
      '2025-01-05': [
        { projectName: 'Project I', completed: true, actualDuration: 30 }
      ],
      '2025-01-03': [
        { projectName: 'Project I', completed: false, actualDuration: 45 }
      ]
    };

    const metrics = analyzeProjectMetrics('Project I', logs);
    expect(metrics.firstTaskDate).toBe('2025-01-01');
    expect(metrics.lastTaskDate).toBe('2025-01-05');
  });
});