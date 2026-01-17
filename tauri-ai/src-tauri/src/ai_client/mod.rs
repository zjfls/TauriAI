//! AI Client module for TauriAI
//!
//! This module provides the AI client infrastructure for communicating with
//! various AI providers (OpenAI, OpenAI-compatible, OpenAI Responses, Anthropic, Ollama).

mod anthropic;
mod factory;
mod ollama;
mod openai;
mod openai_responses;
mod traits;

pub use anthropic::AnthropicClient;
pub use factory::{get_client, Provider};
pub use ollama::OllamaClient;
pub use openai::{OpenAiClient, OpenAiCompatibleClient};
pub use openai_responses::OpenAiResponsesClient;
pub use traits::*;
