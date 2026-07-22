use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Features {
    #[serde(default = "default_true")]
    pub math: bool,
    #[serde(default = "default_true")]
    pub session_usage: bool,
    #[serde(default)]
    pub editor_selection_overlay: bool,
}

fn default_true() -> bool { true }

impl Default for Features {
    fn default() -> Self {
        Self {
            math: true,
            session_usage: true,
            editor_selection_overlay: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    #[serde(default = "default_body_font_size")]
    pub body_font_size: u32,
    #[serde(default)]
    pub palette: String,
}

fn default_body_font_size() -> u32 { 13 }

impl Default for Theme {
    fn default() -> Self {
        Self {
            body_font_size: 13,
            palette: "warm-black".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_lang")]
    pub language: String,
    #[serde(default)]
    pub features: Features,
    #[serde(default)]
    pub theme: Theme,
}

fn default_lang() -> String { "zh".to_string() }

impl Default for Config {
    fn default() -> Self {
        Self {
            language: default_lang(),
            features: Features {
                math: true,
                session_usage: true,
                editor_selection_overlay: false,
            },
            theme: Theme {
                body_font_size: 13,
                palette: "warm-black".to_string(),
            },
        }
    }
}

impl Config {
    pub fn config_path() -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join(".incipit").join("config.json"))
    }

    pub fn load() -> Self {
        let path = match Self::config_path() {
            Some(p) => p,
            None => return Self::default(),
        };
        match fs::read_to_string(&path) {
            Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path().ok_or("Cannot determine home directory")?;
        let dir = path.parent().ok_or("Invalid config path")?;
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;

        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, &json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        Ok(())
    }
}
