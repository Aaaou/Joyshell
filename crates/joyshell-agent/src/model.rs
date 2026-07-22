use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ModelProviderKind {
    OpenAiCompatible,
    AnthropicCompatible,
    OllamaCompatible,
    VllmCompatible,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelProviderConfig {
    pub kind: ModelProviderKind,
    pub base_url: String,
    pub api_key_ref: Option<String>,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub proxy: Option<String>,
}

impl Default for ModelProviderConfig {
    fn default() -> Self {
        Self {
            kind: ModelProviderKind::OpenAiCompatible,
            base_url: "https://api.openai.com/v1".to_string(),
            api_key_ref: None,
            model: "gpt-4.1-mini".to_string(),
            temperature: 0.2,
            max_tokens: 4096,
            proxy: None,
        }
    }
}
