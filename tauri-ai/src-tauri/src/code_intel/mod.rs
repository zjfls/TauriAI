//! 代码智能（Code Intelligence）
//!
//! 目标：
//! - 为 Workstudio 提供类似 VS Code 的代码导航能力（定义/引用/悬停/补全/诊断等）
//! - 后端负责管理 LSP 进程（stdio JSON-RPC），并向前端提供命令式 API
//! - AST 能力用于轻量解析/符号提取（作为 LSP 的补充或兜底）

pub mod lsp;
pub mod ast;
pub mod types;
pub mod index_db;
pub mod index_types;
pub mod index_manager;
