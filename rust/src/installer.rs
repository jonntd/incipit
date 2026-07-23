use std::fs;
use std::path::{Path, PathBuf};
use crate::assets::{DataAssets, CompanionAssets};
use crate::config::Config;
use crate::detector::TargetLocation;

// Files to copy from embedded data/ to webview/
const ROOT_WEBVIEW_FILES: &[(&str, &str)] = &[
    ("claude_code_enhance.js", "enhance.js"),
    ("enhance_shared.js", "enhance_shared.js"),
    ("runtime_kernel.js", "runtime_kernel.js"),
    ("capability.js", "capability.js"),
    ("enhance_footer_badge.js", "enhance_footer_badge.js"),
    ("enhance_thinking.js", "enhance_thinking.js"),
    ("enhance_typography.js", "enhance_typography.js"),
    ("mermaid_render.js", "mermaid_render.js"),
    ("enhance_legacy.js", "enhance_legacy.js"),
    ("host_probe.js", "host_probe.js"),
    ("host-badge.cjs", "host-badge.cjs"),
    ("checkpoint_timeline.cjs", "checkpoint_timeline.cjs"),
    ("markdown_preprocess.js", "markdown_preprocess.js"),
    ("protocol_tags.js", "protocol_tags.js"),
    ("math_tokens.js", "math_tokens.js"),
    ("math_rewriter.js", "math_rewriter.js"),
    ("theme.css", "theme.css"),
    ("commit_message_bundle.js", "commit_message_bundle.js"),
    ("warm-white-override.css", "warm-white-override.css"),
];

const ASSET_TREES: &[&str] = &[
    "katex", "hljs", "effort-brain", "capability", "legacy", "mermaid", "ui",
];

// Generate the JS config preamble that gets injected at the top of enhance.js
fn build_enhance_preamble(config: &Config) -> String {
    let math = if config.features.math { "true" } else { "false" };
    let session = if config.features.session_usage { "true" } else { "false" };
    let overlay = if config.features.editor_selection_overlay { "true" } else { "false" };
    let palette = &config.theme.palette;
    let font_size = config.theme.body_font_size;
    let lang = &config.language;

    format!(
        "// incipit user config (generated at apply; do not edit)\n\
         globalThis.__incipitConfig = Object.freeze({{\
         math: {}, sessionUsage: {}, editorSelectionOverlay: {},\
         theme: {{ bodyFontSize: {}, palette: \"{}\" }},\
         language: \"{}\" }});\n\n",
        math, session, overlay, font_size, palette, lang
    )
}

// Generate the CSS :root overrides for theme customization
fn build_theme_override_block(config: &Config) -> String {
    let size = config.theme.body_font_size;
    let body_font = "'ReadingHei', 'IBM Plex Serif', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif";
    let code_font = "'Rec Mono Linear', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', Consolas, Monaco, 'Courier New', monospace";

    format!(
        "\n\n/* incipit user theme overrides (generated at apply; do not edit) */\n\
         :root {{\n\
         --incipit-body-size: {}px;\n\
         --incipit-body-font: {};\n\
         --incipit-code-font: {};\n\
         }}\n",
        size, body_font, code_font
    )
}

// Generate the webview/index.js config preamble
fn build_webview_preamble(config: &Config) -> String {
    let math = if config.features.math { "true" } else { "false" };
    let session = if config.features.session_usage { "true" } else { "false" };
    let overlay = if config.features.editor_selection_overlay { "true" } else { "false" };
    let palette = &config.theme.palette;
    let font_size = config.theme.body_font_size;
    let lang = &config.language;

    format!(
        "// incipit webview config (generated at apply; do not edit)\n\
         globalThis.__incipitConfig = Object.freeze({{\
         math: {}, sessionUsage: {}, editorSelectionOverlay: {},\
         theme: {{ bodyFontSize: {}, palette: \"{}\" }},\
         language: \"{}\" }});\n\n",
        math, session, overlay, font_size, palette, lang
    )
}

pub fn apply_patch(target: &TargetLocation) -> Result<(), String> {
    let config = Config::load();
    apply_patch_with_config(target, &config)
}

pub fn apply_patch_with_config(target: &TargetLocation, config: &Config) -> Result<(), String> {
    let webview_dir = target.webview_index_js.parent().ok_or("Invalid webview dir")?;
    let extension_dir = &target.extensions_dir;

    if !webview_dir.exists() {
        fs::create_dir_all(webview_dir).map_err(|e| e.to_string())?;
    }

    // 1. Create backup of official files
    let backup_dir = dirs::home_dir()
        .ok_or("No home dir")?
        .join(".incipit-backup")
        .join(&target.version);
    fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;

    let backup_webview = backup_dir.join("webview_index.js");
    if target.webview_index_js.exists() && !backup_webview.exists() {
        fs::copy(&target.webview_index_js, &backup_webview).map_err(|e| e.to_string())?;
    }

    // 2. Copy root webview files (with preamble injection for enhance.js and theme.css)
    for (src_name, dst_name) in ROOT_WEBVIEW_FILES {
        if let Some(content) = DataAssets::get(&format!("data/{}", src_name)) {
            let dst_path = webview_dir.join(dst_name);
            let mut data = content.data.to_vec();

            if *dst_name == "enhance.js" {
                // Inject config preamble at top
                let preamble = build_enhance_preamble(config);
                let mut new_data = preamble.into_bytes();
                new_data.extend_from_slice(&data);
                data = new_data;
            } else if *dst_name == "theme.css" {
                // Append theme overrides at bottom
                let overrides = build_theme_override_block(config);
                data.extend_from_slice(overrides.as_bytes());
            }

            fs::write(&dst_path, &data).map_err(|e| e.to_string())?;
        }
    }

    // 3. Patch webview/index.js — inject config preamble at top
    if target.webview_index_js.exists() {
        let original = fs::read_to_string(&target.webview_index_js)
            .map_err(|e| format!("Failed to read webview/index.js: {}", e))?;
        let preamble = build_webview_preamble(config);
        let patched = format!("{}{}", preamble, original);
        fs::write(&target.webview_index_js, &patched)
            .map_err(|e| format!("Failed to write patched webview/index.js: {}", e))?;
    }

    // 4. Sync asset trees (katex, hljs, mermaid, etc.)
    for tree_name in ASSET_TREES {
        let src_prefix = format!("data/{}/", tree_name);
        let dst_tree = webview_dir.join(tree_name);
        fs::create_dir_all(&dst_tree).ok();

        for file in DataAssets::iter() {
            let file_path = file.as_ref();
            if file_path.starts_with(&src_prefix) {
                let relative = &file_path[src_prefix.len()..];
                if let Some(content) = DataAssets::get(file_path) {
                    let dst_file = dst_tree.join(relative);
                    if let Some(parent) = dst_file.parent() {
                        fs::create_dir_all(parent).ok();
                    }
                    fs::write(dst_file, content.data).ok();
                }
            }
        }
    }

    // 5. Extract companion extensions
    let extensions_parent = extension_dir.parent().ok_or("Invalid extensions dir")?;
    for file in CompanionAssets::iter() {
        let file_path = file.as_ref();
        if let Some(content) = CompanionAssets::get(file_path) {
            let target_file_path = extensions_parent.join(file_path);
            if let Some(parent) = target_file_path.parent() {
                fs::create_dir_all(parent).ok();
            }
            fs::write(target_file_path, content.data).ok();
        }
    }

    // 6. Register companions in extensions.json
    register_companions(extension_dir)?;

    Ok(())
}

fn register_companions(extension_dir: &Path) -> Result<(), String> {
    let ext_json_path = extension_dir.join("extensions.json");
    let mut extensions: Vec<serde_json::Value> = if ext_json_path.exists() {
        let content = fs::read_to_string(&ext_json_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };

    let companion_dirs = vec![
        "incipit.claude-selection-reference",
        "incipit.claude-folder-reference",
    ];

    for id in &companion_dirs {
        let already = extensions.iter().any(|e| {
            e.get("identifier").and_then(|v| v.as_str()) == Some(id)
                || e.get("id").and_then(|v| v.as_str()) == Some(id)
        });
        if !already {
            extensions.push(serde_json::json!({
                "identifier": id,
                "version": "0.0.4",
                "location": extension_dir.parent()
                    .map(|p| p.join(id))
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                "relativeLocation": id,
            }));
        }
    }

    let json = serde_json::to_string_pretty(&extensions).map_err(|e| e.to_string())?;
    fs::write(&ext_json_path, &json).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn restore_official(target: &TargetLocation) -> Result<(), String> {
    let backup_dir = dirs::home_dir()
        .ok_or("No home dir")?
        .join(".incipit-backup")
        .join(&target.version);

    let backup_webview = backup_dir.join("webview_index.js");
    if backup_webview.exists() {
        fs::copy(&backup_webview, &target.webview_index_js)
            .map_err(|e| format!("Failed to restore webview/index.js: {}", e))?;
    }

    // Remove patched enhance.js and theme.css
    let webview_dir = target.webview_index_js.parent().ok_or("Invalid webview dir")?;
    let _ = fs::remove_file(webview_dir.join("enhance.js"));
    let _ = fs::remove_file(webview_dir.join("theme.css"));
    let _ = fs::remove_file(webview_dir.join("enhance_shared.js"));
    let _ = fs::remove_file(webview_dir.join("runtime_kernel.js"));

    // Remove injected asset trees
    for tree_name in ASSET_TREES {
        let _ = fs::remove_dir_all(webview_dir.join(tree_name));
    }

    Ok(())
}

// Target selection: if multiple targets exist, let user choose via index
pub fn choose_and_apply() -> Result<(), String> {
    let targets = crate::detector::detect_targets();
    if targets.is_empty() {
        return Err("No Claude Code installation detected.".to_string());
    }

    // If only one target, apply directly
    if targets.len() == 1 {
        return apply_patch(&targets[0]);
    }

    // Multiple targets — return error with list so UI can handle selection
    let list: Vec<String> = targets.iter().enumerate()
        .map(|(i, t)| format!("{}. {} -> {}", i + 1, t.label, t.extensions_dir.display()))
        .collect();
    Err(format!("Multiple targets found:\n{}", list.join("\n")))
}
