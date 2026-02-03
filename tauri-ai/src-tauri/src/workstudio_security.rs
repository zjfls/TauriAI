use std::path::PathBuf;

use crate::models::TrustedCommandConfig;

fn security_file_path(main_folder: &str) -> PathBuf {
    PathBuf::from(main_folder)
        .join(".tauriai")
        .join("security.json")
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkstudioSecurityFile {
    version: u32,
    #[serde(default)]
    writable_roots: Vec<String>,
    #[serde(default)]
    trusted_commands: Vec<TrustedCommandConfig>,
}

impl Default for WorkstudioSecurityFile {
    fn default() -> Self {
        Self {
            version: 1,
            writable_roots: Vec::new(),
            trusted_commands: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioSecurityConfig {
    #[serde(default)]
    pub writable_roots: Vec<String>,
    #[serde(default)]
    pub trusted_commands: Vec<TrustedCommandConfig>,
}

pub fn read_workstudio_security_config(main_folder: &str) -> Result<WorkstudioSecurityConfig, String> {
    let main_folder = main_folder.trim();
    if main_folder.is_empty() {
        // No main folder -> no project-scoped security config.
        return Ok(WorkstudioSecurityConfig::default());
    }
    let path = security_file_path(main_folder);
    if !path.exists() {
        return Ok(WorkstudioSecurityConfig::default());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read security.json failed: {e}"))?;
    let file: WorkstudioSecurityFile =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse security.json failed: {e}"))?;
    Ok(WorkstudioSecurityConfig {
        writable_roots: file.writable_roots,
        trusted_commands: file.trusted_commands,
    })
}

pub fn write_workstudio_security_config(
    main_folder: &str,
    config: &WorkstudioSecurityConfig,
) -> Result<(), String> {
    let main_folder = main_folder.trim();
    if main_folder.is_empty() {
        return Err("Workstudio 主目录为空，无法写入安全配置（.tauriai/security.json）".to_string());
    }
    let path = security_file_path(main_folder);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create .tauriai failed: {e}"))?;
    }
    let file = WorkstudioSecurityFile {
        version: 1,
        writable_roots: config.writable_roots.clone(),
        trusted_commands: config.trusted_commands.clone(),
    };
    let json = serde_json::to_vec_pretty(&file).map_err(|e| format!("serialize security.json failed: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("write security.json failed: {e}"))?;
    Ok(())
}
