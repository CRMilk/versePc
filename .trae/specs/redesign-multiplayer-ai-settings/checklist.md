# Checklist

## 陶瓦联机页面
- [ ] 状态卡片显示连接状态（未连接/连接中/已连接）并有视觉指示
- [ ] 创建房间面板包含端口输入和开始创建按钮
- [ ] 加入房间面板包含房间码输入和加入按钮
- [ ] 已连接面板显示房间码、连接地址、状态和断开按钮
- [ ] 所有 API 调用（terracotta-host、terracotta-join、terracotta-disconnect、terracotta-status）正常工作
- [ ] 复制房间码和连接地址功能正常
- [ ] 状态轮询正常工作

## 端口映射联机页面
- [ ] 状态卡片显示连接状态并有视觉指示
- [ ] 创建房间面板包含房间名、端口、玩家名、UPnP 选项
- [ ] 加入房间面板包含服务器地址和玩家名输入
- [ ] UPnP 诊断按钮和结果显示正常
- [ ] 日志区域正常显示带时间戳的日志
- [ ] 所有 API 调用（remote-create、upnp-diagnose）正常工作

## AI 设置页面
- [ ] 设置面板可通过设置按钮打开/关闭
- [ ] 标签导航正常切换（providers、autoApprove、notifications、context、terminal、prompts、ui、experimental、language、about、mcp）
- [ ] 搜索功能可跨标签搜索设置项
- [ ] 保存按钮在有未保存更改时可点击
- [ ] 所有设置项（checkbox、slider、select、textarea）交互正常
- [ ] 暗色主题下样式正确

## 通用
- [ ] 所有页面在亮色主题下样式正确
- [ ] 所有页面在暗色主题下样式正确
- [ ] 构建成功（`npm run build:win`）
- [ ] 所有 ID 和 onclick 属性保持不变，无功能回归
