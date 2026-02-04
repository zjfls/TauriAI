/// 文本/编码工具。
///
/// 背景：在 Windows 上，子进程 stdout/stderr 可能不是 UTF-8（常见为系统代码页，例如 GBK/CP936）。
/// 若直接 `from_utf8_lossy` 会出现大量 “�” 乱码。这里做一个更稳妥的解码：
/// 1) 优先按 UTF-8 严格解析；
/// 2) Windows 下回退到 Console/OEM/ACP 代码页；
/// 3) 最后再用 `from_utf8_lossy` 兜底。
pub fn decode_process_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }

    #[cfg(windows)]
    {
        if let Some(text) = decode_windows_codepage(bytes) {
            return text;
        }
    }

    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(windows)]
fn decode_windows_codepage(bytes: &[u8]) -> Option<String> {
    // Minimal WinAPI binding to avoid adding a heavy dependency.
    #[link(name = "kernel32")]
    extern "system" {
        fn GetACP() -> u32;
        fn GetOEMCP() -> u32;
        fn GetConsoleOutputCP() -> u32;
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            multi_byte_str: *const u8,
            cb_multi_byte: i32,
            wide_char_str: *mut u16,
            cch_wide_char: i32,
        ) -> i32;
    }

    const CP_UTF8: u32 = 65001;

    unsafe fn decode_with_cp(bytes: &[u8], cp: u32) -> Option<String> {
        if cp == 0 {
            return None;
        }
        // 我们已尝试 UTF-8，这里避免重复（同时减少错误解码的概率）。
        if cp == CP_UTF8 {
            return None;
        }

        let needed = MultiByteToWideChar(
            cp,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        );
        if needed <= 0 {
            return None;
        }
        let mut wide = vec![0u16; needed as usize];
        let written = MultiByteToWideChar(
            cp,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            wide.as_mut_ptr(),
            needed,
        );
        if written <= 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&wide[..written as usize]))
    }

    // 优先使用 Console 输出代码页（如有），其次 OEMCP（更贴近控制台应用），最后 ACP（系统 ANSI）。
    let cps = unsafe { [GetConsoleOutputCP(), GetOEMCP(), GetACP()] };
    for cp in cps {
        if let Some(text) = unsafe { decode_with_cp(bytes, cp) } {
            return Some(text);
        }
    }
    None
}

