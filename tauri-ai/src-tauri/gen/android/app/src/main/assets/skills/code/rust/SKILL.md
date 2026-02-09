---
name: code-rust-best-practices
description: Rust 工程最佳实践：错误处理、并发、模块组织、序列化、测试与可维护性。
metadata:
  short-description: Rust 工程实践与代码风格建议
---

# Rust 工程最佳实践

## 错误处理
- 业务错误：自定义 error enum（thiserror）
- 边界层：把外部错误映射为可序列化错误

## 并发/异步
- I/O 用 tokio；避免在 async 中做阻塞操作
- 锁粒度尽量小；注意死锁与持锁 await

## 代码组织
- 模块边界清晰：commands / runtime / storage
- 类型与协议：单独文件维护（models/types）

## 测试
- 优先单元测试关键解析/权限逻辑
- 使用 tempfile 做文件系统隔离

