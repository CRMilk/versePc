# Tasks

- [ ] Task 1: 重设计陶瓦联机页面 HTML 结构
  - [ ] SubTask 1.1: 重写 `#page-lan-terracotta` 的 HTML 结构，保留所有 ID 和 onclick 属性
  - [ ] SubTask 1.2: 优化状态卡片布局（渐变边框、图标、状态指示器）
  - [ ] SubTask 1.3: 优化操作卡片区域（图标、描述、hover 效果）
  - [ ] SubTask 1.4: 优化房间面板（创建、加入、已连接三个状态面板）

- [ ] Task 2: 重设计端口映射联机页面 HTML 结构
  - [ ] SubTask 2.1: 重写 `#page-lan-portmap` 的 HTML 结构，保留所有 ID 和 onclick 属性
  - [ ] SubTask 2.2: 优化状态卡片、操作区域、创建/加入面板
  - [ ] SubTask 2.3: 优化 UPnP 诊断区域和日志区域样式

- [ ] Task 3: 重写联机页面 CSS 样式
  - [ ] SubTask 3.1: 重写 `.lan-container`、`.lan-status-card`、`.lan-status-dot` 样式
  - [ ] SubTask 3.2: 重写 `.lan-actions`、`.lan-action-card` 样式
  - [ ] SubTask 3.3: 重写 `.lan-room-panel`、`.lan-room-header`、`.lan-room-info` 样式
  - [ ] SubTask 3.4: 重写表单元素（input、textarea、button、checkbox）样式
  - [ ] SubTask 3.5: 重写 `.lan-room-log` 日志区域样式
  - [ ] SubTask 3.6: 添加暗色主题适配样式

- [ ] Task 4: 重设计 AI 设置页面 HTML 结构
  - [ ] SubTask 4.1: 重写 `#ai-settings-page` 的 HTML 结构，保留所有 ID 和数据属性
  - [ ] SubTask 4.2: 优化设置头部（返回按钮、标题、搜索框、保存按钮）
  - [ ] SubTask 4.3: 优化标签导航和内容区域布局

- [ ] Task 5: 重写 AI 设置页面 CSS 样式
  - [ ] SubTask 5.1: 重写 `.rc-settings-panel`、`.rc-settings-tab` 容器样式
  - [ ] SubTask 5.2: 重写 `.rc-settings-header` 头部样式
  - [ ] SubTask 5.3: 重写 `.rc-settings-tab-list` 标签导航样式
  - [ ] SubTask 5.4: 重写 `.rc-settings-tab-content` 内容区域样式
  - [ ] SubTask 5.5: 重写设置项组件（checkbox、slider、select、textarea）样式
  - [ ] SubTask 5.6: 添加暗色主题适配样式

- [ ] Task 6: 构建和验证
  - [ ] SubTask 6.1: 运行构建命令 `npm run build:win`
  - [ ] SubTask 6.2: 验证陶瓦联机页面功能正常
  - [ ] SubTask 6.3: 验证端口映射联机页面功能正常
  - [ ] SubTask 6.4: 验证 AI 设置页面功能正常

# Task Dependencies
- Task 1 和 Task 2 可并行执行
- Task 3 依赖 Task 1 和 Task 2 完成
- Task 4 可与 Task 1/2 并行执行
- Task 5 依赖 Task 4 完成
- Task 6 依赖 Task 3 和 Task 5 完成
