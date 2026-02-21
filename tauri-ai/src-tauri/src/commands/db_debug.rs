//! DB debug / observability commands.
//!
//! Purpose:
//! - Provide quick visibility into the global DB mutex contention state.
//! - Used by frontend GlobalErrorModal to enrich "DB lock 超时" errors.

use crate::storage::async_db::DbLockSnapshot;

/// Get current DB lock holder snapshot (best-effort).
///
/// Note:
/// - This does NOT touch SQLite and does not acquire the async DB mutex.
/// - It only reads the in-process lock holder tracking state.
#[tauri::command]
pub fn get_db_lock_snapshot() -> Option<DbLockSnapshot> {
    crate::storage::async_db::get_db_lock_snapshot()
}

