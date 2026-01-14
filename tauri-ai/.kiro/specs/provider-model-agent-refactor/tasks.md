# Implementation Plan: Provider-Model-Agent Refactor

## Overview

将模型配置系统从扁平结构重构为三层架构：Provider → Model → Agent

## Tasks

- [x] 1. 更新数据模型定义
  - [x] 1.1 更新 Rust 后端数据结构 (src-tauri/src/models.rs)
    - 新增 ProviderType 枚举
    - 新增 Model 结构体（不含 systemPrompt）
    - 新增 Provider 结构体（内嵌 models[]）
    - 新增 Agent 结构体
    - 更新 AppConfig 结构体
    - _Requirements: 1.1, 2.2, 2.3, 3.2, 4.1_

  - [x] 1.2 更新 TypeScript 前端类型 (src/types/index.ts)
    - 同步 Rust 的类型定义
    - _Requirements: 1.1, 2.2, 3.2, 4.2_

- [x] 2. 实现配置迁移逻辑
  - [x] 2.1 在 AppConfig 中添加迁移函数
    - 检测旧配置格式
    - 按 provider+apiBase 分组创建 Provider
    - 将旧 model 转换为新 Model
    - 将旧 systemPrompt 创建为 Agent
    - _Requirements: 4.5_

- [x] 3. 更新后端命令
  - [x] 3.1 更新 chat_stream 命令
    - 接收 agent_name 参数
    - 解析 modelRef 获取 provider 和 model
    - 组装 system prompt
    - _Requirements: 6.3, 6.4_

  - [x] 3.2 更新 generate_title 命令
    - 使用新的 Agent 架构
    - _Requirements: 6.3_

- [x] 4. Checkpoint - 后端编译通过
  - 确保 Rust 代码编译无错误

- [x] 5. 更新前端 Store
  - [x] 5.1 重构 configStore.ts
    - 新增 Provider CRUD 方法
    - 新增 Agent CRUD 方法
    - 新增 setDefaultAgent 方法
    - 移除旧的 model 相关方法
    - _Requirements: 1.6, 3.6_

- [x] 6. 重构设置界面
  - [x] 6.1 创建 ProviderConfigForm 组件
    - Provider 列表（带搜索、ON/OFF 开关）
    - Provider 表单（displayName, type, apiBase, apiKey）
    - 内嵌 Model 列表（可展开/折叠）
    - Test Connection 按钮
    - _Requirements: 5.2, 5.3, 5.4_

  - [x] 6.2 创建 AgentConfigForm 组件
    - Agent 列表（带搜索、默认标记）
    - Agent 表单（displayName, description, modelRef, systemPrompt, formatType）
    - Model 选择器（显示 provider/model 格式）
    - Set Default 按钮
    - _Requirements: 5.5, 5.6, 5.7_

  - [x] 6.3 更新 SettingsView 组件
    - 替换 Models 标签为 Providers
    - 替换 Presets 标签为 Agents
    - _Requirements: 5.1_

- [x] 7. 更新 Chat 界面
  - [x] 7.1 更新 Header 组件
    - 添加 Agent 选择器
    - 使用 defaultAgent 初始化
    - _Requirements: 6.1, 6.2_

  - [x] 7.2 更新 chatService.ts
    - chatStream 传递 agentName 参数
    - _Requirements: 6.3_

- [ ] 8. Checkpoint - 功能测试
  - 测试 Provider 增删改查
  - 测试 Agent 增删改查
  - 测试 Chat 使用 Agent
  - 测试配置迁移

- [x] 9. 清理旧代码
  - [x] 9.1 删除 ModelConfigForm 组件
  - [x] 9.2 删除 PresetManager 组件
  - [x] 9.3 更新组件导出

## Notes

- 迁移逻辑需要处理边界情况（空配置、无效引用等）
- UI 需要处理 modelRef 解析失败的情况
- 保持向后兼容，旧配置自动迁移
