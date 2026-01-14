//! AI Client factory for creating provider-specific clients

use std::sync::Arc;

use super::traits::{AiClient, AiError};
use super::openai::{OpenAiClient, OpenAiCompatibleClient};
use super::anthropic::AnthropicClient;
use super::ollama::OllamaClient;

/// Provider types supported by the application
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Provider {
    OpenAi,
    OpenAiCompatible,
    Anthropic,
    Ollama,
}

impl From<&str> for Provider {
    fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "openai" => Provider::OpenAi,
            "openai_compatible" => Provider::OpenAiCompatible,
            "anthropic" => Provider::Anthropic,
            "ollama" => Provider::Ollama,
            _ => Provider::OpenAiCompatible, // Default to compatible for unknown providers
        }
    }
}

/// Get an AI client based on the provider type
///
/// # Arguments
/// * `provider` - The provider type string (e.g., "openai", "openai_compatible", "anthropic", "ollama")
///
/// # Returns
/// An Arc-wrapped AI client implementation for the specified provider
pub fn get_client(provider: &str) -> Result<Arc<dyn AiClient>, AiError> {
    let provider_type = Provider::from(provider);

    match provider_type {
        Provider::OpenAi => Ok(Arc::new(OpenAiClient::new())),
        Provider::OpenAiCompatible => Ok(Arc::new(OpenAiCompatibleClient::new())),
        Provider::Anthropic => Ok(Arc::new(AnthropicClient::new())),
        Provider::Ollama => Ok(Arc::new(OllamaClient::new())),
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
        assert_eq!(Provider::from("openai_compatible"), Provider::OpenAiCompatible);
        assert_eq!(Provider::from("anthropic"), Provider::Anthropic);
        assert_eq!(Provider::from("Anthropic"), Provider::Anthropic);
        assert_eq!(Provider::from("ollama"), Provider::Ollama);
        assert_eq!(Provider::from("Ollama"), Provider::Ollama);
        assert_eq!(Provider::from("unknown"), Provider::OpenAiCompatible);
    }

    #[test]
    fn test_get_client_openai() {
        let client = get_client("openai");
        assert!(client.is_ok());
    }

    #[test]
    fn test_get_client_openai_compatible() {
        let client = get_client("openai_compatible");
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
}
