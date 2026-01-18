# 思考级别功能测试指南

## 修改内容总结

### 前端修改
1. ✅ `SessionTabBar.tsx`: 修复智能体选择器位置计算,在每次渲染时更新位置

### 后端修改
1. ✅ `models.rs`: 将 `thinking_enabled: Option<bool>` 改为 `thinking_level: Option<String>`
2. ✅ `commands/chat.rs`: 修改参数接受 `thinking: Option<serde_json::Value>`,支持 boolean 和 string
3. ✅ `ai_client/openai_responses.rs`: 使用 `thinking_level` 字符串设置 `reasoning.effort`
4. ✅ `ai_client/openai.rs`: 更新 thinking 配置逻辑以使用 `thinking_level`
5. ✅ `commands/config.rs`: 更新字段名为 `thinking_level`
6. ✅ `commands/conversation.rs`: 更新字段名为 `thinking_level`

## 测试步骤

### 1. 编译检查
```bash
cd TauriAI-thinking-context/tauri-ai/src-tauri
cargo check
```
✅ 通过

### 2. 前端测试
```bash
cd TauriAI-thinking-context/tauri-ai
npm test
```
✅ 所有 288 个测试通过
✅ ThinkingSelector 测试已修复(将 '超高' 改为 '最少')

### 3. 手动功能测试

#### 测试智能体选择器下拉菜单
1. 启动应用: `npm run dev`
2. 点击右上角的 "+" 按钮创建新对话
3. 观察智能体选择器下拉菜单是否完整显示,不被裁剪
4. 尝试滚动页面,下拉菜单应该跟随按钮位置

**预期结果**: 下拉菜单完整显示,不被 `#root { overflow: hidden }` 裁剪

#### 测试思考级别参数传递 (Responses API)
1. 配置一个使用 `openai_responses` API 的模型 (如 gpt-5.2)
2. 创建新对话并选择该模型
3. 在输入框中,点击思考按钮,选择不同的级别:
   - 无 (null)
   - 最少 (minimal)
   - 低 (low)
   - 中 (medium)
   - 高 (high)
4. 发送消息
5. 在开发者工具中查看网络请求,检查 `reasoning.effort` 字段

**预期结果**:
- 选择"无": `reasoning` 字段为 `null` 或不存在
- 选择"最少": `reasoning.effort = "minimal"`
- 选择"低": `reasoning.effort = "low"`
- 选择"中": `reasoning.effort = "medium"`
- 选择"高": `reasoning.effort = "high"`

#### 测试思考开关 (Chat Completions API)
1. 配置一个使用 `chat_completions` API 的模型 (如 deepseek-v3)
2. 创建新对话并选择该模型
3. 在输入框中,点击思考按钮切换开/关
4. 发送消息
5. 在开发者工具中查看网络请求,检查 `thinking` 字段

**预期结果**:
- 思考开启: `thinking.thinking_type = "enabled"`
- 思考关闭: `thinking.thinking_type = "disabled"` 或不存在

## 数据流验证

### 前端 → 后端
1. **前端 UI**: 用户选择思考级别 (ThinkingLevel)
2. **ChatView.tsx**: 转换为字符串或 boolean
   - `null` → `false`
   - `'minimal'` → `'minimal'`
   - `'low'` → `'low'`
   - `'medium'` → `'medium'`
   - `'high'` → `'high'`
3. **sessionStore.ts**: 直接传递 `thinking` 参数
4. **invoke('chat_stream')**: 传递给 Rust 后端

### 后端处理
1. **chat.rs**: 接收 `thinking: Option<serde_json::Value>`
2. **类型转换**:
   - `Bool(true)` → `"medium"`
   - `Bool(false)` → `"disabled"`
   - `String(level)` → `level`
   - `Null` → `"disabled"`
3. **ModelConfig**: 设置 `thinking_level: Option<String>`
4. **AI Client**:
   - **openai_responses.rs**: 使用 `thinking_level` 设置 `reasoning.effort`
   - **openai.rs**: 将 `thinking_level` 转换为 `enabled`/`disabled`

## 调试技巧

### 前端调试
```javascript
// 在 sessionStore.ts 的 sendMessage 中添加:
console.log('[DEBUG] Sending thinking parameter:', thinking);
```

### 后端调试
```rust
// 在 chat.rs 的 chat_stream 中添加:
println!("[DEBUG] Received thinking parameter: {:?}", thinking);
println!("[DEBUG] Converted thinking_level: {:?}", model_config.thinking_level);
```

### 网络请求调试
1. 打开浏览器开发者工具
2. 切换到 Network 标签
3. 发送消息
4. 查找 `/v1/responses` 或 `/v1/chat/completions` 请求
5. 检查 Request Payload 中的 `reasoning` 或 `thinking` 字段

## 已知问题

### TypeScript 编译警告
- `SessionTabBar.tsx:337`: RefObject 类型警告 (不影响功能)
- 其他未使用变量警告 (不影响功能)

这些警告不影响运行时功能,可以在后续清理。

## 回归测试清单

- [x] 所有单元测试通过
- [x] 所有属性测试通过
- [x] Rust 编译通过
- [x] ThinkingSelector 测试修复完成
- [ ] 智能体选择器下拉菜单显示正常
- [ ] Responses API 思考级别正确传递
- [ ] Chat Completions API 思考开关正常工作
- [ ] 不同模型之间切换正常
- [ ] 会话持久化正常

## 相关文件

### 前端
- `tauri-ai/src/components/Session/SessionTabBar.tsx`
- `tauri-ai/src/components/Chat/ChatView.tsx`
- `tauri-ai/src/components/Chat/ThinkingSelector.tsx`
- `tauri-ai/src/stores/sessionStore.ts`
- `tauri-ai/src/utils/apiUtils.ts`

### 后端
- `src-tauri/src/models.rs`
- `src-tauri/src/commands/chat.rs`
- `src-tauri/src/ai_client/openai_responses.rs`
- `src-tauri/src/ai_client/openai.rs`
- `src-tauri/src/commands/config.rs`
- `src-tauri/src/commands/conversation.rs`
