//! AI Client module for TauriAI
//!
//! This module provides the AI client infrastructure for communicating with
//! various AI providers (OpenAI, OpenAI-compatible, Anthropic, Ollama).

mod traits;
mod openai;
mod anthropic;
mod ollama;
mod factory;

pub use traits::*;
pub use openai::{OpenAiClient, OpenAiCompatibleClient};
pub use anthropic::AnthropicClient;
pub use ollama::OllamaClient;
pub use factory::{get_client, Provider};
