use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{mpsc, Mutex};

/// ToolServices：工具运行时依赖/状态的集合。
///
/// 设计目的：
/// - handler 尽量保持“无状态”（便于共享与测试）
/// - 状态/资源（例如 PTY 会话、权限缓存、文件索引、webfetch 缓存…）统一挂在 services 上
#[derive(Default)]
pub struct ToolServices {
    pub pty: PtyService,
}

impl std::fmt::Debug for ToolServices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 避免把内部句柄/通道打印出来（也避免要求所有字段都实现 Debug）
        f.debug_struct("ToolServices").finish()
    }
}

/// PTY 会话服务：跨 turn 的交互式终端会话管理。
///
/// 说明：
/// - 当前实现面向“单 run 内可复用”；未来可以提升为“按 conversation 复用”。
/// - 这里只做会话存取/生命周期；具体的输出聚合/事件输出由 handler 负责。
#[derive(Default)]
pub struct PtyService {
    inner: Mutex<PtyServiceInner>,
}

#[derive(Default)]
struct PtyServiceInner {
    next_id: i32,
    sessions: HashMap<i32, Arc<Mutex<PtySession>>>,
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
    pub writer: Option<Box<dyn Write + Send>>,
    pub rx: mpsc::Receiver<Vec<u8>>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // best-effort：避免 run 结束后遗留后台子进程
        let _ = self.child.kill();
    }
}

impl PtyService {
    pub async fn create_session(
        &self,
        command: Vec<String>,
        workdir: Option<PathBuf>,
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
            writer: Some(writer),
            rx,
        }));

        let mut inner = self.inner.lock().await;
        inner.sessions.insert(session_id, session);
        Ok(session_id)
    }

    pub async fn get_session(&self, session_id: i32) -> Option<Arc<Mutex<PtySession>>> {
        let inner = self.inner.lock().await;
        inner.sessions.get(&session_id).cloned()
    }

    pub async fn remove_session(&self, session_id: i32) -> Option<Arc<Mutex<PtySession>>> {
        let mut inner = self.inner.lock().await;
        inner.sessions.remove(&session_id)
    }
}
