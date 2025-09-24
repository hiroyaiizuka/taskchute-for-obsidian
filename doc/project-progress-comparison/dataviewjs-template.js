// プロジェクト進捗比較 Dataviewjsテンプレート
// Version: 1.0.0
// 
// 使い方：
// 1. このコードをプロジェクトノートの適切な場所にDataviewjsコードブロックとして埋め込む
// 2. プロジェクトノートには「## タスク（次の一手）」セクションが必要
// 3. DataviewとObsidian Chartsプラグインが必要

// プラグイン依存チェック
if (!app.plugins.plugins.dataview) {
    dv.paragraph('❌ Dataviewプラグインがインストールされていません。');
    return;
}

if (!app.plugins.plugins['obsidian-charts']) {
    dv.paragraph('❌ Obsidian Chartsプラグインがインストールされていません。');
    return;
}

// メイン処理
async function generateProgressComparison() {
    try {
        // 現在のプロジェクトファイル情報
        const currentFile = dv.current().file;
        const currentPath = currentFile.path;
        const currentName = currentFile.name;
        const projectFolder = currentPath.substring(0, currentPath.lastIndexOf('/'));

        // 現在のプロジェクトのチェックリスト解析
        const currentContent = await app.vault.read(app.vault.getAbstractFileByPath(currentPath));
        const currentProgress = parseChecklist(currentContent);
        
        if (currentProgress.totalTasks === 0) {
            dv.paragraph('ℹ️ タスクが見つかりませんでした。「## タスク（次の一手）」セクションにチェックリストを追加してください。');
            return;
        }

        // 類似プロジェクトを検索
        const similarProjects = await findSimilarProjects(currentPath, currentName, projectFolder);
        
        // 進捗データを収集
        const projectDataList = [];
        
        // 最初のタスク完了日を取得
        const firstCompletedTask = currentProgress.tasks
            .filter(t => t.completed && t.completedAt)
            .sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt))[0];
        
        const startDate = firstCompletedTask 
            ? new Date(firstCompletedTask.completedAt) 
            : new Date(currentFile.ctime);
        
        // 現在のプロジェクトデータ
        projectDataList.push({
            name: currentName.replace('.md', ''),
            path: currentPath,
            isCurrent: true,
            startDate: startDate,
            progress: currentProgress,
            file: currentFile
        });
        
        // 類似プロジェクトのデータを収集
        for (const project of similarProjects) {
            try {
                const projectFile = app.vault.getAbstractFileByPath(project.file.path);
                const content = await app.vault.read(projectFile);
                const progress = parseChecklist(content);
                
                if (progress.totalTasks > 0) {
                    // 最初のタスク完了日を取得
                    const firstCompletedTask = progress.tasks
                        .filter(t => t.completed && t.completedAt)
                        .sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt))[0];
                    
                    const startDate = firstCompletedTask 
                        ? new Date(firstCompletedTask.completedAt) 
                        : new Date(project.file.ctime);
                    
                    projectDataList.push({
                        name: project.file.name.replace('.md', ''),
                        path: project.file.path,
                        isCurrent: false,
                        startDate: startDate,
                        progress: progress,
                        file: project.file
                    });
                }
            } catch (err) {
                console.error(`プロジェクト読み込みエラー: ${project.file.name}`, err);
            }
        }
        
        // グラフを生成
        generateChart(projectDataList);
        
        // 完了予測を表示
        if (currentProgress.completionRate < 100) {
            const prediction = predictCompletion(projectDataList[0], projectDataList.slice(1));
            if (prediction) {
                dv.paragraph(`📅 **完了予測**: ${prediction.predictedDate.toLocaleDateString('ja-JP')} (あと${prediction.daysRemaining}日)`);
                dv.paragraph(`　　(現在のペース: 1日あたり${prediction.currentPace}%)`);
            }
        }
        
    } catch (error) {
        dv.paragraph(`❌ エラーが発生しました: ${error.message}`);
        console.error('プロジェクト進捗比較エラー:', error);
    }
}

// チェックリスト解析関数
function parseChecklist(content) {
    const lines = content.split('\n');
    let inTaskSection = false;
    let tasks = [];
    let completedCount = 0;
    
    for (const line of lines) {
        // タスクセクションの開始を検出
        if (line.includes('## タスク（次の一手）')) {
            inTaskSection = true;
            continue;
        }
        
        // 次のセクションに到達したら終了
        if (inTaskSection && line.startsWith('#')) {
            break;
        }
        
        if (inTaskSection) {
            // 未完了タスク
            const uncheckedMatch = line.match(/^- \[ \] (.+)$/);
            if (uncheckedMatch) {
                tasks.push({
                    name: uncheckedMatch[1].trim(),
                    completed: false,
                    completedAt: null
                });
                continue;
            }
            
            // 完了タスク（✅または☑️の両方に対応）
            // 時刻ありパターン: 2025-01-15T10:30
            const checkedMatchWithTime = line.match(/^- \[x\] (.+?)(?:\s*[✅☑️]\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}))?$/);
            // 日付のみパターン: 2025-01-15
            const checkedMatchDateOnly = line.match(/^- \[x\] (.+?)(?:\s*[✅☑️]\s*(\d{4}-\d{2}-\d{2}))?$/);
            
            if (checkedMatchWithTime && checkedMatchWithTime[2]) {
                tasks.push({
                    name: checkedMatchWithTime[1].trim(),
                    completed: true,
                    completedAt: checkedMatchWithTime[2]
                });
                completedCount++;
            } else if (checkedMatchDateOnly && checkedMatchDateOnly[2]) {
                tasks.push({
                    name: checkedMatchDateOnly[1].trim(),
                    completed: true,
                    completedAt: checkedMatchDateOnly[2] + 'T00:00' // 時刻がない場合は00:00を追加
                });
                completedCount++;
            } else if (checkedMatchWithTime || checkedMatchDateOnly) {
                // 日付情報がない完了タスク
                const match = checkedMatchWithTime || checkedMatchDateOnly;
                tasks.push({
                    name: match[1].trim(),
                    completed: true,
                    completedAt: null
                });
                completedCount++;
            }
        }
    }
    
    return {
        totalTasks: tasks.length,
        completedTasks: completedCount,
        completionRate: tasks.length > 0 ? (completedCount / tasks.length * 100) : 0,
        tasks: tasks
    };
}

// 類似プロジェクト検索関数（similar to記法のみ）
async function findSimilarProjects(currentPath, currentName, projectFolder) {
    const similarProjects = [];
    const currentFile = dv.current();
    
    // similar to 指定のみをチェック
    if (currentFile['similar to']) {
        // similar to の値を配列化（単一の値の場合も配列に）
        const similarToLinks = Array.isArray(currentFile['similar to']) 
            ? currentFile['similar to'] 
            : [currentFile['similar to']];
        
        for (const link of similarToLinks) {
            if (link && link.path) {
                const linkedPage = dv.page(link.path);
                if (linkedPage) {
                    similarProjects.push(linkedPage);
                }
            }
        }
    }
    
    return similarProjects;
}

// Obsidian Charts形式のグラフ生成
function generateChart(projectDataList) {
    // 各プロジェクトの最終タスク完了日を取得
    const projectEndDays = projectDataList.map(p => {
        // 完了タスクの最後の日付を取得
        const lastCompletedTask = p.progress.tasks
            .filter(t => t.completed && t.completedAt)
            .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))[0];
        
        if (lastCompletedTask) {
            const lastDate = new Date(lastCompletedTask.completedAt);
            return Math.floor((lastDate - p.startDate) / (1000 * 60 * 60 * 24));
        }
        
        // 完了タスクがない場合は現在までの日数
        const today = new Date();
        return Math.floor((today - p.startDate) / (1000 * 60 * 60 * 24));
    });
    
    // 最大日数を計算（最も長いプロジェクトの期間）
    const maxDays = Math.max(...projectEndDays, 1); // 最低1日
    
    // X軸ラベル（日数）- 最大30ポイントに制限
    const step = Math.max(1, Math.floor(maxDays / 30));
    const labelCount = Math.ceil(maxDays / step) + 1;
    const labels = [];
    for (let i = 0; i < labelCount; i++) {
        labels.push(`Day ${i * step}`);
    }
    
    // 類似プロジェクトのタスク総数の平均を計算
    const similarProjects = projectDataList.filter(p => !p.isCurrent);
    let avgTotalTasks = 0;
    if (similarProjects.length > 0) {
        const totalTasksSum = similarProjects.reduce((sum, p) => sum + p.progress.totalTasks, 0);
        avgTotalTasks = totalTasksSum / similarProjects.length;
    }
    
    // 各プロジェクトのデータ系列
    const chartSeries = projectDataList.map(project => {
        const color = project.isCurrent ? '#FF6B6B' : '#888888';
        const lineWidth = project.isCurrent ? 3 : 1;
        
        // 進捗率データを生成（Day0は必ず0%）
        const progressData = [];
        const totalDays = Math.floor((new Date() - project.startDate) / (1000 * 60 * 60 * 24));
        
        // 完了タスクを日付でソート
        const tasksWithDates = project.progress.tasks
            .filter(t => t.completed && t.completedAt)
            .sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));
        
        // 分母の決定（現在のプロジェクトは類似プロジェクトの平均タスク数、それ以外は自分のタスク数）
        const denominator = project.isCurrent && avgTotalTasks > 0 ? avgTotalTasks : project.progress.totalTasks;
        
        // 最後の完了タスクまでの日数を計算
        const lastCompletedTask = tasksWithDates.length > 0 
            ? tasksWithDates[tasksWithDates.length - 1]
            : null;
        const projectEndDay = lastCompletedTask
            ? Math.floor((new Date(lastCompletedTask.completedAt) - project.startDate) / (1000 * 60 * 60 * 24))
            : 0; // 完了タスクがない場合は0日
        
        // このプロジェクトの進捗データを生成
        for (let day = 0; day <= projectEndDay; day++) {
            // stepに合わせてデータを追加
            if (day % step !== 0 && day !== projectEndDay) {
                continue;
            }
            
            // Day 0は必ず0%
            if (day === 0) {
                progressData.push(0);
                continue;
            }
            
            // 対象日を計算
            const checkDate = new Date(project.startDate);
            checkDate.setDate(checkDate.getDate() + day);
            
            // この日までに完了したタスク数を計算
            const completedByDate = tasksWithDates.filter(t => {
                const taskDate = new Date(t.completedAt);
                return taskDate <= checkDate;
            }).length;
            
            // 進捗率の計算（分母は現在のプロジェクトなら類似プロジェクトの平均タスク数）
            const rate = (completedByDate / denominator) * 100;
            progressData.push(Math.round(rate * 10) / 10);
        }
        
        // maxDaysまでnullで埋める
        const currentLength = progressData.length;
        for (let i = currentLength; i <= Math.ceil(maxDays / step); i++) {
            progressData.push(null);
        }
        
        return {
            title: project.name,
            data: progressData,
            color: color
        };
    });
    
    // Obsidian Charts形式で出力
    // chartConfigは使用していないので削除
    
    // グラフを表示
    dv.paragraph('### 📈 進捗比較グラフ');
    
    // シリーズデータの文字列を生成
    const seriesStrings = chartSeries.map(s => {
        const dataStr = s.data.map(v => v !== null ? v : 0).join(', ');
        return `  - title: ${s.title}
    data: [${dataStr}]`;
    }).join('\n');
    
    // デバッグ用にデータを確認
    console.log('Labels:', labels);
    console.log('ChartSeries:', chartSeries);
    console.log('SeriesStrings:', seriesStrings);
    
    // データの存在チェック
    if (labels.length === 0 || chartSeries.length === 0) {
        dv.paragraph('❌ グラフデータの生成に失敗しました。');
        dv.paragraph(`- ラベル数: ${labels.length}`);
        dv.paragraph(`- シリーズ数: ${chartSeries.length}`);
        return;
    }
    
    dv.paragraph(`\`\`\`chart

type: bar
labels: [${labels.join(', ')}]

series:
${seriesStrings}

width: 80%
labelColors: false
beginAtZero: true
stacked: false

\`\`\``);
}

// 完了予測関数（シンプルな線形予測）
function predictCompletion(currentProject, similarProjects) {
    // 現在の進捗率と経過日数
    const currentRate = currentProject.progress.completionRate;
    const daysPassed = Math.floor((new Date() - currentProject.startDate) / (1000 * 60 * 60 * 24));
    
    if (daysPassed === 0 || currentRate === 0) {
        return null; // 予測不可
    }
    
    // 100%までに必要な総日数を計算
    // 現在の進捗率 / 経過日数 = 1日あたりの進捗率
    // 100% / 1日あたりの進捗率 = 総日数
    const dailyRate = currentRate / daysPassed;
    const totalDaysNeeded = 100 / dailyRate;
    const remainingDays = Math.ceil(totalDaysNeeded - daysPassed);
    
    return {
        predictedDays: Math.round(totalDaysNeeded),
        daysRemaining: Math.max(1, remainingDays),
        predictedDate: new Date(Date.now() + Math.max(1, remainingDays) * 24 * 60 * 60 * 1000),
        currentPace: Math.round(dailyRate * 10) / 10 // 1日あたりの進捗率
    };
}

// 実行
generateProgressComparison();