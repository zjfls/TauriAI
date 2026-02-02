use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::{mpsc, Mutex};

/// ToolServices：工具运行时依赖/状态的集合。
///
/// 设计目的：
/// - handler 尽量保持“无状态”（便于共享与测试）
/// - 状态/资源（例如 PTY 会话、权限缓存、文件索引、webfetch 缓存…）统一挂在 services 上
#[derive(Default)]
pub struct ToolServices {
    pub pty: PtyService,
    pub web_search: WebSearchService,
}

impl std::fmt::Debug for ToolServices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 避免把内部句柄/通道打印出来（也避免要求所有字段都实现 Debug）
        f.debug_struct("ToolServices").finish()
    }
}

/// WebSearch service: rate limit / state across turns.
#[derive(Default)]
pub struct WebSearchService {
    last_call_ms: Mutex<Option<i64>>,
}

impl WebSearchService {
    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    pub async fn wait_for_interval(&self, min_interval_ms: u64) {
        let min_interval_ms = min_interval_ms.max(0);
        loop {
            let wait_ms = {
                let mut guard = self.last_call_ms.lock().await;
                let now = Self::now_ms();
                match *guard {
                    None => {
                        *guard = Some(now);
                        0
                    }
                    Some(prev) => {
                        let elapsed = (now - prev).max(0) as u64;
                        if elapsed >= min_interval_ms {
                            *guard = Some(now);
                            0
                        } else {
                            min_interval_ms - elapsed
                        }
                    }
                }
            };
            if wait_ms == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
        }
    }
}

/// PTY 会话服务：跨 turn 的交互式终端会话管理。
///
/// 说明：
/// - 当前实现支持按 conversation 复用（由 run_state 持有）。
/// - 这里只做会话存取/生命周期；具体的输出聚合/事件输出由 handler 负责。
#[derive(Default)]
pub struct PtyService {
    inner: Mutex<PtyServiceInner>,
}

#[derive(Default)]
struct PtyServiceInner {
    next_id: i32,
    sessions: HashMap<i32, PtySessionEntry>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PtySessionScope {
    Task,
    Conversation,
}

#[derive(Clone, Debug)]
pub struct PtySessionMeta {
    pub conversation_id: String,
    pub task_id: String,
    pub scope: PtySessionScope,
    pub command: Vec<String>,
    pub workdir: Option<PathBuf>,
    pub created_at_ms: i64,
    pub last_used_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionInfo {
    pub session_id: i32,
    pub conversation_id: String,
    pub task_id: String,
    pub scope: PtySessionScope,
    pub command: String,
    pub workdir: Option<String>,
    pub created_at_ms: i64,
    pub last_used_ms: i64,
    pub is_alive: bool,
}

struct PtySessionEntry {
    session: Arc<Mutex<PtySession>>,
    meta: PtySessionMeta,
}

pub struct PtySession {
    // 保持 PTY master 的生命周期与 session 一致。
    //
    // 重要：在 Windows 的 ConPTY 实现中，master/slave 内部持有 pseudo console 句柄；
    // 如果在 spawn 后立刻丢弃它们，可能导致 pseudo console 被释放，从而出现：
    // - reader 立刻 EOF（工具输出为空）
    // - try_wait 竞态（exit_code 可能丢失）
    //
    // 当前我们不需要调用 master 的方法，仅用于 keepalive。
    pub _master: Box<dyn portable_pty::MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send>,
    pub writer: Arc<tokio::sync::Mutex<Option<Box<dyn Write + Send>>>>,
    pub rx: Arc<tokio::sync::Mutex<mpsc::Receiver<Vec<u8>>>>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // best-effort：避免 run 结束后遗留后台子进程
        let _ = self.child.kill();
    }
}

impl PtyService {
    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    pub async fn create_session(
        &self,
        command: Vec<String>,
        workdir: Option<PathBuf>,
        conversation_id: &str,
        task_id: &str,
        scope: PtySessionScope,
    ) -> Result<i32, String> {
        if command.is_empty() {
            return Err("pty command 为空".to_string());
        }

        // 分配会话 id（0 作为“未分配/默认值”更安全，跳过）
        let session_id = {
            let mut inner = self.inner.lock().await;
            let id = if inner.next_id <= 0 { 1 } else { inner.next_id };
            inner.next_id = id.saturating_add(1);
            id
        };

        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty 失败: {e}"))?;

        let mut cmd = portable_pty::CommandBuilder::new(&command[0]);
        if command.len() > 1 {
            for arg in &command[1..] {
                cmd.arg(arg);
            }
        }
        if let Some(dir) = workdir.as_ref() {
            cmd.cwd(dir);
        }
        // Best-effort: hint to child processes that ANSI/truecolor is supported.
        // This improves colored output for many CLIs (git/ls/pretty loggers).
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("CLICOLOR", "1");
        cmd.env("CLICOLOR_FORCE", "1");
        cmd.env("FORCE_COLOR", "1");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn_command 失败: {e}"))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone pty reader 失败: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take pty writer 失败: {e}"))?;
        let master = pair.master;

        let (tx, rx) = mpsc::channel::<Vec<u8>>(256);

        // 读取线程：把 PTY 输出持续推到 channel
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let session = Arc::new(Mutex::new(PtySession {
            _master: master,
            child,
            writer: Arc::new(tokio::sync::Mutex::new(Some(writer))),
            rx: Arc::new(tokio::sync::Mutex::new(rx)),
        }));

        let now_ms = Self::now_ms();
        let meta = PtySessionMeta {
            conversation_id: conversation_id.to_string(),
            task_id: task_id.to_string(),
            scope,
            command: command.clone(),
            workdir: workdir.clone(),
            created_at_ms: now_ms,
            last_used_ms: now_ms,
        };

        let mut inner = self.inner.lock().await;
        inner.sessions.insert(
            session_id,
            PtySessionEntry {
                session,
                meta,
            },
        );
        Ok(session_id)
    }

    pub async fn get_session(&self, session_id: i32) -> Option<Arc<Mutex<PtySession>>> {
        let mut inner = self.inner.lock().await;
        let entry = inner.sessions.get_mut(&session_id)?;
        entry.meta.last_used_ms = Self::now_ms();
        Some(Arc::clone(&entry.session))
    }

    pub async fn get_session_meta(&self, session_id: i32) -> Option<PtySessionMeta> {
        let inner = self.inner.lock().await;
        inner.sessions.get(&session_id).map(|entry| entry.meta.clone())
    }

    pub async fn remove_session(&self, session_id: i32) -> Option<Arc<Mutex<PtySession>>> {
        let entry = {
            let mut inner = self.inner.lock().await;
            inner.sessions.remove(&session_id)
        };
        entry.map(|entry| entry.session)
    }

    pub async fn close_session(&self, session_id: i32) -> bool {
        let entry = {
            let mut inner = self.inner.lock().await;
            inner.sessions.remove(&session_id)
        };

        if let Some(entry) = entry {
            let mut guard = entry.session.lock().await;
            let _ = guard.child.kill();
            true
        } else {
            false
        }
    }

    pub async fn close_task_sessions(&self, conversation_id: &str, task_id: &str) -> usize {
        let entries = {
            let mut inner = self.inner.lock().await;
            let ids: Vec<i32> = inner
                .sessions
                .iter()
                .filter(|(_, entry)| {
                    entry.meta.scope == PtySessionScope::Task
                        && entry.meta.conversation_id == conversation_id
                        && entry.meta.task_id == task_id
                })
                .map(|(id, _)| *id)
                .collect();

            ids.into_iter()
                .filter_map(|id| inner.sessions.remove(&id))
                .collect::<Vec<_>>()
        };

        let count = entries.len();
        for entry in entries {
            let mut guard = entry.session.lock().await;
            let _ = guard.child.kill();
        }
        count
    }

    pub async fn close_conversation_sessions(&self, conversation_id: &str) -> usize {
        let entries = {
            let mut inner = self.inner.lock().await;
            let ids: Vec<i32> = inner
                .sessions
                .iter()
                .filter(|(_, entry)| {
                    entry.meta.scope == PtySessionScope::Conversation
                        && entry.meta.conversation_id == conversation_id
                })
                .map(|(id, _)| *id)
                .collect();

            ids.into_iter()
                .filter_map(|id| inner.sessions.remove(&id))
                .collect::<Vec<_>>()
        };

        let count = entries.len();
        for entry in entries {
            let mut guard = entry.session.lock().await;
            let _ = guard.child.kill();
        }
        count
    }

    pub async fn list_sessions(&self, conversation_id: &str) -> Vec<PtySessionInfo> {
        let entries = {
            let inner = self.inner.lock().await;
            inner
                .sessions
                .iter()
                .filter(|(_, entry)| entry.meta.conversation_id == conversation_id)
                .map(|(id, entry)| (*id, Arc::clone(&entry.session), entry.meta.clone()))
                .collect::<Vec<_>>()
        };

        let mut out = Vec::with_capacity(entries.len());
        for (session_id, session, meta) in entries {
            let is_alive = {
                let mut guard = session.lock().await;
                match guard.child.try_wait() {
                    Ok(Some(_)) => false,
                    Ok(None) => true,
                    Err(_) => true,
                }
            };

            out.push(PtySessionInfo {
                session_id,
                conversation_id: meta.conversation_id.clone(),
                task_id: meta.task_id.clone(),
                scope: meta.scope,
                command: meta.command.join(" "),
                workdir: meta.workdir.as_ref().map(|p| p.display().to_string()),
                created_at_ms: meta.created_at_ms,
                last_used_ms: meta.last_used_ms,
                is_alive,
            });
        }
        out
    }
}
