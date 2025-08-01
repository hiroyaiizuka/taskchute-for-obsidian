const { calculateSimilarity, findSimilarProjects } = require('../main');

describe('Project Similarity Calculation', () => {
  test('should calculate exact match as 1.0', () => {
    expect(calculateSimilarity('Project A', 'Project A')).toBe(1.0);
  });

  test('should calculate completely different names as 0', () => {
    expect(calculateSimilarity('ABC', 'XYZ')).toBe(0);
  });

  test('should calculate partial similarity correctly', () => {
    // "Project" の7文字が共通
    const similarity = calculateSimilarity('Project A', 'Project B');
    expect(similarity).toBeGreaterThan(0.7);
    expect(similarity).toBeLessThan(0.9);
  });

  test('should handle different length strings', () => {
    const similarity = calculateSimilarity('Blog', 'Blog Writing');
    // "Blog" の4文字が共通、最大長は12
    expect(similarity).toBeCloseTo(4/12, 1);
  });

  test('should be case sensitive', () => {
    expect(calculateSimilarity('Project', 'project')).toBeLessThan(1);
  });

  test('should handle empty strings', () => {
    expect(calculateSimilarity('', '')).toBe(0);
    expect(calculateSimilarity('Project', '')).toBe(0);
    expect(calculateSimilarity('', 'Project')).toBe(0);
  });

  test('should handle Japanese characters', () => {
    expect(calculateSimilarity('ブログ執筆', 'ブログ執筆')).toBe(1.0);
    expect(calculateSimilarity('ブログ執筆', 'ブログ更新')).toBeGreaterThan(0.5);
    expect(calculateSimilarity('プラグイン開発', 'プラグイン更新')).toBeGreaterThan(0.6);
  });
});

describe('Find Similar Projects', () => {
  test('should find similar projects above threshold', () => {
    const projects = {
      'Blog Writing v1': { completedTasks: 10, workDaysCount: 5 },
      'Blog Writing v2': { completedTasks: 15, workDaysCount: 7 },
      'Plugin Development': { completedTasks: 20, workDaysCount: 10 },
      'Email Newsletter': { completedTasks: 5, workDaysCount: 2 }
    };

    const similar = findSimilarProjects('Blog Writing v3', projects, 0.6);
    expect(similar).toHaveLength(3); // Plugin Developmentも0.6以上の類似度
    
    // Blog Writing v1とv2が上位2つに含まれることを確認
    const blogProjects = similar.filter(p => p.projectName.includes('Blog Writing'));
    expect(blogProjects).toHaveLength(2);
    expect(blogProjects[0].projectName).toMatch(/Blog Writing v[12]/);
    expect(blogProjects[1].projectName).toMatch(/Blog Writing v[12]/);
  });

  test('should return empty array when no similar projects', () => {
    const projects = {
      'Project A': { completedTasks: 10, workDaysCount: 5 },
      'Project B': { completedTasks: 15, workDaysCount: 7 }
    };

    const similar = findSimilarProjects('XYZ Task', projects, 0.6);
    expect(similar).toHaveLength(0);
  });

  test('should exclude the same project', () => {
    const projects = {
      'Blog Writing': { completedTasks: 10, workDaysCount: 5 },
      'Blog Writing Copy': { completedTasks: 15, workDaysCount: 7 }
    };

    const similar = findSimilarProjects('Blog Writing', projects, 0.6);
    expect(similar).toHaveLength(1);
    expect(similar[0].projectName).toBe('Blog Writing Copy');
  });

  test('should sort by similarity score descending', () => {
    const projects = {
      'Blog A': { completedTasks: 10, workDaysCount: 5 },
      'Blog Writing': { completedTasks: 15, workDaysCount: 7 },
      'Blog B': { completedTasks: 20, workDaysCount: 10 }
    };

    const similar = findSimilarProjects('Blog Writing Task', projects, 0.3);
    expect(similar[0].projectName).toBe('Blog Writing');
    expect(similar[0].similarity).toBeGreaterThan(similar[1].similarity);
  });

  test('should handle Japanese project names', () => {
    const projects = {
      'ブログ執筆 v1': { completedTasks: 10, workDaysCount: 5 },
      'ブログ執筆 v2': { completedTasks: 15, workDaysCount: 7 },
      'プラグイン開発': { completedTasks: 20, workDaysCount: 10 }
    };

    const similar = findSimilarProjects('ブログ執筆 v3', projects, 0.6);
    expect(similar).toHaveLength(2);
    expect(similar.some(p => p.projectName === 'ブログ執筆 v1')).toBe(true);
    expect(similar.some(p => p.projectName === 'ブログ執筆 v2')).toBe(true);
  });
});