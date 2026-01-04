//! AI Client factory for creating provider-specific clients

use std::sync::Arc;

use super::traits::{AiClient, AiError};
use super::openai::OpenAiClient;
use super::anthropic::AnthropicClient;
use super::ollama::OllamaClient;

/// Provider types supported by the application
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Provider {
    OpenAi,
    Anthropic,
    Ollama,
    Custom,
}

impl From<&str> for Provider {
    fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "openai" => Provider::OpenAi,
            "anthropic" => Provider::Anthropic,
            "ollama" => Provider::Ollama,
            _ => Provider::Custom,
        }
    }
}

/// Get an AI client based on the provider type
///
/// # Arguments
/// * `provider` - The provider type string (e.g., "openai", "anthropic", "ollama")
///
/// # Returns
/// An Arc-wrapped AI client implementation for the specified provider
pub fn get_client(provider: &str) -> Result<Arc<dyn AiClient>, AiError> {
    let provider_type = Provider::from(provider);

    match provider_type {
        Provider::OpenAi => Ok(Arc::new(OpenAiClient::new())),
        Provider::Anthropic => Ok(Arc::new(AnthropicClient::new())),
        Provider::Ollama => Ok(Arc::new(OllamaClient::new())),
        Provider::Custom => {
            // Custom providers default to OpenAI-compatible API
            Ok(Arc::new(OpenAiClient::new()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_from_string() {
        assert_eq!(Provider::from("openai"), Provider::OpenAi);
        assert_eq!(Provider::from("OpenAI"), Provider::OpenAi);
        assert_eq!(Provider::from("OPENAI"), Provider::OpenAi);
        assert_eq!(Provider::from("anthropic"), Provider::Anthropic);
        assert_eq!(Provider::from("Anthropic"), Provider::Anthropic);
        assert_eq!(Provider::from("ollama"), Provider::Ollama);
        assert_eq!(Provider::from("Ollama"), Provider::Ollama);
        assert_eq!(Provider::from("custom"), Provider::Custom);
        assert_eq!(Provider::from("unknown"), Provider::Custom);
    }

    #[test]
    fn test_get_client_openai() {
        let client = get_client("openai");
        assert!(client.is_ok());
    }

    #[test]
    fn test_get_client_anthropic() {
        let client = get_client("anthropic");
        assert!(client.is_ok());
    }

    #[test]
    fn test_get_client_ollama() {
        let client = get_client("ollama");
        assert!(client.is_ok());
    }

    #[test]
    fn test_get_client_custom() {
        let client = get_client("custom");
        assert!(client.is_ok());
    }
}
