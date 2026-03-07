#[cfg(any(target_os = "android", target_os = "ios"))]
fn main() {
    eprintln!("tauri-ai-cli is unavailable on mobile targets");
    std::process::exit(1);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tokio::main]
async fn main() {
    if let Err(error) = tauri_ai_lib::cli::run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
