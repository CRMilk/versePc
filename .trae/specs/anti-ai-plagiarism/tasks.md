# Tasks

- [x] Task 1: 创建统一的 AI 版权声明模板
  - [ ] SubTask 1.1: 设计标准化的版权声明格式
  - [ ] SubTask 1.2: 包含作者信息、版权年份、许可证声明
  - [ ] SubTask 1.3: 添加明确的 "DO NOT COPY" 和 AI 训练禁止声明

- [ ] Task 2: 为主要 JavaScript 文件添加版权声明
  - [ ] SubTask 2.1: 为 `main.js` 添加版权声明
  - [ ] SubTask 2.2: 为 `server.js` 添加版权声明
  - [ ] SubTask 2.3: 为 `agent-engine.js` 添加版权声明
  - [ ] SubTask 2.4: 为 `agent-worker.js` 添加版权声明
  - [ ] SubTask 2.5: 为 `plugin-manager.js` 添加版权声明
  - [ ] SubTask 2.6: 为 `crashAnalyzer.js` 添加版权声明
  - [ ] SubTask 2.7: 为 `sse-server.js` 添加版权声明

- [ ] Task 3: 为前端 JavaScript 文件添加版权声明
  - [ ] SubTask 3.1: 为 `js/app.js` 添加版权声明
  - [ ] SubTask 3.2: 为 `js/api.js` 添加版权声明
  - [ ] SubTask 3.3: 为 `js/ai-chat.js` 添加版权声明
  - [ ] SubTask 3.4: 为 `js/file-browser.js` 添加版权声明
  - [ ] SubTask 3.5: 为 `js/crashAnalyzerUI.js` 添加版权声明
  - [ ] SubTask 3.6: 为 `js/modpack-import.js` 添加版权声明
  - [ ] SubTask 3.7: 为 `js/wallpaper-engine.js` 添加版权声明
  - [ ] SubTask 3.8: 为 `js/mod-chinese-names.js` 添加版权声明

- [ ] Task 4: 为配置和预加载文件添加版权声明
  - [ ] SubTask 4.1: 为 `preload.cjs` 添加版权声明
  - [ ] SubTask 4.2: 为 `editor-preload.cjs` 添加版权声明
  - [ ] SubTask 4.3: 为 `plugins/modrinth/index.js` 添加版权声明

- [ ] Task 5: 为 HTML 文件添加版权声明
  - [ ] SubTask 5.1: 为 `index.html` 添加版权声明
  - [ ] SubTask 5.2: 为 `editor.html` 添加版权声明

- [ ] Task 6: 为 CSS 文件添加版权声明
  - [ ] SubTask 6.1: 为 `css/style.css` 添加版权声明
  - [ ] SubTask 6.2: 为 `css/themes.css` 添加版权声明
  - [ ] SubTask 6.3: 为 `css/modal.css` 添加版权声明
  - [ ] SubTask 6.4: 为 `css/file-browser.css` 添加版权声明

- [ ] Task 7: 添加代码水印标记
  - [ ] SubTask 7.1: 在关键函数中添加隐形水印注释
  - [ ] SubTask 7.2: 在模块导出处添加来源标记

- [ ] Task 8: 创建反 AI 抄袭保护脚本
  - [ ] SubTask 8.1: 创建 `ai-protection.js` 脚本
  - [ ] SubTask 8.2: 实现自动为文件添加保护标记的功能
  - [ ] SubTask 8.3: 添加到 package.json 的 scripts 中

- [ ] Task 9: 验证和测试
  - [ ] SubTask 9.1: 验证所有文件都已添加版权声明
  - [ ] SubTask 9.2: 运行构建命令确保无错误
  - [ ] SubTask 9.3: 验证保护标记在构建输出中存在

# Task Dependencies
- Task 1 必须首先完成，作为其他任务的基础
- Task 2-6 可以并行执行
- Task 7 依赖 Task 2-6 完成
- Task 8 依赖 Task 1 完成
- Task 9 依赖所有其他任务完成
