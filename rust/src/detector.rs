use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct TargetLocation {
    pub label: String,
    pub extensions_dir: PathBuf,
    pub webview_index_js: PathBuf,
    pub version: String,
}

pub fn detect_targets() -> Vec<TargetLocation> {
    let mut targets = Vec::new();
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return targets,
    };

    let possible_roots = vec![
        home.join(".vscode/extensions"),
        home.join(".vscode-insiders/extensions"),
        home.join(".cursor/extensions"),
        home.join(".windsurf/extensions"),
    ];

    for root in possible_roots {
        if !root.exists() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("anthropic.claude-code-") {
                    let ext_dir = entry.path();
                    let webview_index = ext_dir.join("webview/index.js");
                    let version = name.trim_start_matches("anthropic.claude-code-").to_string();

                    let label = if root.to_string_lossy().contains("insiders") {
                        format!("VS Code Insiders (v{})", version)
                    } else if root.to_string_lossy().contains("cursor") {
                        format!("Cursor (v{})", version)
                    } else if root.to_string_lossy().contains("windsurf") {
                        format!("Windsurf (v{})", version)
                    } else {
                        format!("VS Code (v{})", version)
                    };

                    targets.push(TargetLocation {
                        label,
                        extensions_dir: ext_dir,
                        webview_index_js: webview_index,
                        version,
                    });
                }
            }
        }
    }

    targets
}
