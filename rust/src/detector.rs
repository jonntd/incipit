use std::path::PathBuf;

const CLAUDE_CODE_EXTENSION_PREFIX: &str = "anthropic.claude-code-";

#[derive(Debug, Clone)]
pub struct TargetLocation {
    pub label: String,
    pub extensions_dir: PathBuf,
    pub webview_index_js: PathBuf,
    pub version: String,
    pub host_id: String,
}

struct HostDef {
    id: &'static str,
    label: &'static str,
    home_names: &'static [&'static str],
}

const HOSTS: &[HostDef] = &[
    HostDef { id: "vscode",           label: "VS Code",           home_names: &[".vscode"] },
    HostDef { id: "vscode-insiders",  label: "VS Code Insiders",  home_names: &[".vscode-insiders"] },
    HostDef { id: "vscodium",         label: "VSCodium",          home_names: &[".vscode-oss"] },
    HostDef { id: "cursor",           label: "Cursor",            home_names: &[".cursor"] },
    HostDef { id: "cursor-insiders",  label: "Cursor Insiders",   home_names: &[".cursor-insiders"] },
    HostDef { id: "windsurf",         label: "Windsurf",          home_names: &[".windsurf"] },
    HostDef { id: "antigravity",      label: "Antigravity",       home_names: &[".antigravity-ide", ".antigravity"] },
    HostDef { id: "trae",             label: "Trae",              home_names: &[".trae"] },
    HostDef { id: "trae-cn",          label: "Trae CN",           home_names: &[".trae-cn"] },
    HostDef { id: "kiro",             label: "Kiro",              home_names: &[".kiro"] },
];

fn parse_version(dir_name: &str) -> Vec<u32> {
    let stripped = dir_name.trim_start_matches(CLAUDE_CODE_EXTENSION_PREFIX);
    stripped
        .split('.')
        .filter_map(|s| s.parse::<u32>().ok())
        .collect()
}

fn scan_extensions_dir(extensions_dir: &std::path::Path) -> Vec<TargetLocation> {
    let mut results = Vec::new();
    let entries = match std::fs::read_dir(extensions_dir) {
        Ok(e) => e,
        Err(_) => return results,
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(CLAUDE_CODE_EXTENSION_PREFIX) {
            continue;
        }
        let ext_dir = entry.path();
        if !ext_dir.is_dir() {
            continue;
        }

        let webview_index = ext_dir.join("webview/index.js");
        let version = parse_version(&name);
        let version_str = if version.is_empty() {
            "unknown".to_string()
        } else {
            version.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(".")
        };

        // Determine host label from extensions dir path
        let path_str = extensions_dir.to_string_lossy();
        let host_label = if path_str.contains(".vscode-insiders") {
            "VS Code Insiders"
        } else if path_str.contains(".cursor-insiders") {
            "Cursor Insiders"
        } else if path_str.contains(".cursor") {
            "Cursor"
        } else if path_str.contains(".windsurf") {
            "Windsurf"
        } else if path_str.contains(".antigravity") {
            "Antigravity"
        } else if path_str.contains(".trae-cn") {
            "Trae CN"
        } else if path_str.contains(".trae") {
            "Trae"
        } else if path_str.contains(".kiro") {
            "Kiro"
        } else if path_str.contains(".vscode-oss") {
            "VSCodium"
        } else {
            "VS Code"
        };

        results.push(TargetLocation {
            label: format!("{} (v{})", host_label, version_str),
            extensions_dir: ext_dir,
            webview_index_js: webview_index,
            version: version_str,
            host_id: host_label.to_lowercase().replace(' ', "-"),
        });
    }

    results
}

pub fn detect_targets() -> Vec<TargetLocation> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };

    let mut all_targets = Vec::new();

    for host in HOSTS {
        for home_name in host.home_names {
            let extensions_dir = home.join(home_name).join("extensions");
            if !extensions_dir.exists() {
                continue;
            }
            let mut targets = scan_extensions_dir(&extensions_dir);
            // Update host_id to match the defined host
            for t in &mut targets {
                t.host_id = host.id.to_string();
            }
            all_targets.extend(targets);
        }
    }

    // Sort by version (highest first)
    all_targets.sort_by(|a, b| {
        let va = parse_version(&format!("anthropic.claude-code-{}", a.version));
        let vb = parse_version(&format!("anthropic.claude-code-{}", b.version));
        vb.cmp(&va)
    });

    all_targets
}
