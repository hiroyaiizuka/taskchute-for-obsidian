const { predictCompletion } = require('../main');

describe('Project Completion Prediction', () => {
  test('should predict completion based on current pace', () => {
    const currentProgress = {
      completedTasks: 10,
      totalTasks: 50,
      workDaysCount: 5,
      tasksPerDay: 2
    };
    
    const similarProjects = [
      { projectName: 'Similar A', tasksPerDay: 2.5, completedTasks: 100 },
      { projectName: 'Similar B', tasksPerDay: 1.8, completedTasks: 80 }
    ];
    
    const prediction = predictCompletion(currentProgress, similarProjects);
    
    expect(prediction.remainingTasks).toBe(40); // 50 - 10
    expect(prediction.remainingDays).toBeGreaterThan(0);
    expect(prediction.completionDate).toBeInstanceOf(Date);
    expect(prediction.confidence).toBeGreaterThan(0);
    expect(prediction.confidence).toBeLessThanOrEqual(1);
  });

  test('should handle no similar projects', () => {
    const currentProgress = {
      completedTasks: 10,
      totalTasks: 50,
      workDaysCount: 5,
      tasksPerDay: 2
    };
    
    const similarProjects = [];
    
    const prediction = predictCompletion(currentProgress, similarProjects);
    
    // 類似プロジェクトがない場合は現在のペースで計算
    expect(prediction.remainingDays).toBe(20); // 40 tasks / 2 per day
    expect(prediction.confidence).toBeLessThan(0.5); // 低い信頼度
  });

  test('should handle completed project', () => {
    const currentProgress = {
      completedTasks: 50,
      totalTasks: 50,
      workDaysCount: 25,
      tasksPerDay: 2
    };
    
    const similarProjects = [];
    
    const prediction = predictCompletion(currentProgress, similarProjects);
    
    expect(prediction.remainingTasks).toBe(0);
    expect(prediction.remainingDays).toBe(0);
    expect(prediction.isCompleted).toBe(true);
  });

  test('should adjust pace based on similar projects', () => {
    const currentProgress = {
      completedTasks: 10,
      totalTasks: 50,
      workDaysCount: 5,
      tasksPerDay: 2
    };
    
    // 類似プロジェクトが速いペース
    const fasterSimilarProjects = [
      { projectName: 'Fast A', tasksPerDay: 4, completedTasks: 100 },
      { projectName: 'Fast B', tasksPerDay: 3.5, completedTasks: 80 }
    ];
    
    const fasterPrediction = predictCompletion(currentProgress, fasterSimilarProjects);
    
    // 類似プロジェクトが遅いペース
    const slowerSimilarProjects = [
      { projectName: 'Slow A', tasksPerDay: 1, completedTasks: 100 },
      { projectName: 'Slow B', tasksPerDay: 0.8, completedTasks: 80 }
    ];
    
    const slowerPrediction = predictCompletion(currentProgress, slowerSimilarProjects);
    
    // 速いペースの方が早く完了する
    expect(fasterPrediction.remainingDays).toBeLessThan(slowerPrediction.remainingDays);
  });

  test('should handle projects without total tasks', () => {
    const currentProgress = {
      completedTasks: 10,
      totalTasks: null, // 不明
      workDaysCount: 5,
      tasksPerDay: 2
    };
    
    const similarProjects = [
      { projectName: 'Similar A', tasksPerDay: 2, completedTasks: 100 },
      { projectName: 'Similar B', tasksPerDay: 2, completedTasks: 80 }
    ];
    
    const prediction = predictCompletion(currentProgress, similarProjects);
    
    // 類似プロジェクトの平均完了タスク数を推定値として使用
    expect(prediction.estimatedTotalTasks).toBe(90); // (100 + 80) / 2
    expect(prediction.remainingTasks).toBe(80); // 90 - 10
  });

  test('should calculate confidence based on similar project count', () => {
    const currentProgress = {
      completedTasks: 10,
      totalTasks: 50,
      workDaysCount: 5,
      tasksPerDay: 2
    };
    
    const manyProjects = Array(10).fill({
      projectName: 'Similar',
      tasksPerDay: 2,
      completedTasks: 100
    });
    
    const predictionMany = predictCompletion(currentProgress, manyProjects);
    
    const fewProjects = [{
      projectName: 'Similar',
      tasksPerDay: 2,
      completedTasks: 100
    }];
    
    const predictionFew = predictCompletion(currentProgress, fewProjects);
    
    // より多くの類似プロジェクトがある方が信頼度が高い
    expect(predictionMany.confidence).toBeGreaterThan(predictionFew.confidence);
  });
});