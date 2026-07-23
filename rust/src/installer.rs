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

const CDN_HOST: &str = "https://cdnjs.cloudflare.com";

// Patch CSP directives in extension.js to allow cdnjs resources
fn patch_csp_directives(content: &str) -> String {
    let mut result = content.to_string();

    let directives = vec![
        ("style-src", vec![CDN_HOST]),
        ("script-src", vec![CDN_HOST]),
        ("font-src", vec![CDN_HOST, "data:"]),
    ];

    for (directive, required_tokens) in &directives {
        for token in required_tokens {
            if !result.contains(token) {
                let pattern = format!(r"{}(\s+[^;]*?)(;)", regex::escape(directive));
                if let Ok(re) = regex::Regex::new(&pattern) {
                    if let Some(caps) = re.captures(&result) {
                        let full_match = caps.get(0).unwrap().as_str();
                        let existing_tokens = caps.get(1).unwrap().as_str();
                        if !existing_tokens.contains(token) {
                            let replacement = format!("{} {}{};", directive, existing_tokens.trim(), token);
                            result = result.replacen(full_match, &replacement, 1);
                        }
                    }
                }
            }
        }
    }

    result
}

// Patch extension.js with all critical modifications
fn patch_extension_js(content: &str) -> String {
    let mut result = content.to_string();

    // 1. Remove legacy enhance script tag
    let enhance_tag_re = regex::Regex::new(
        r#"<script nonce="\$\{[^}]+\}" src="\$\{[^}]*enhance\.js[^}]*\}"(?: type="module")?><\/script>"#
    ).unwrap();
    result = enhance_tag_re.replace_all(&result, "").to_string();

    // 2. Remove legacy module-load diagnostic probe
    let modload_re = regex::Regex::new(
        r"try\{require\('fs'\)\.appendFileSync\([^)]*MODULE LOADED[^)]*\)\}catch\(e\)\{\};"
    ).unwrap();
    result = modload_re.replace_all(&result, "").to_string();

    // 3. Patch message guard — add __incipit filter
    let msg_guard_re = regex::Regex::new(
        r"\.webview\.onDidReceiveMessage\(\(([A-Za-z_$][\w$]*)\)=>\{(?!if\(\1&&\1\.__incipit===true\)return;)"
    ).unwrap();
    if msg_guard_re.is_match(&result) {
        result = msg_guard_re.replace_all(&result, |caps: &regex::Captures| {
            let var = &caps[1];
            format!(".webview.onDidReceiveMessage(({})=>{{if({}&&{}.__incipit===true)return;", var, var, var)
        }).to_string();
    }

    result
}

// Patch webview/index.js with config preamble and legacy cleanup
fn patch_webview_index(content: &str, config: &Config) -> String {
    let mut result = content.to_string();

    // 1. Strip any existing incipit preamble
    if let Ok(re) = regex::Regex::new(r"^// incipit webview config \(generated at apply; do not edit\)\r?\n[\s\S]*?\r?\n\r?\n") {
        result = re.replace(&result, "").to_string();
    }

    // 2. Strip install manifest
    if let Ok(re) = regex::Regex::new(r"globalThis\.__incipitInstallManifest = Object\.freeze\([\s\S]*?\);\r?\n") {
        result = re.replace_all(&result, "").to_string();
    }

    // 3. Strip legacy acquireVsCodeApi wrapper
    if let Ok(re) = regex::Regex::new(r"\(function\(\)\{if\(window\.__cceApiWrap\)[\s\S]*?\}\)\(\);\n") {
        result = re.replace(&result, "").to_string();
    }

    // 4. Patch Monaco diff theme
    if let Ok(re) = regex::Regex::new(r#"theme:"vs-dark""#) {
        let theme_expr = "(globalThis.__incipitConfig&&globalThis.__incipitConfig.theme&&globalThis.__incipitConfig.theme.palette===\"warm-white\"?\"vs\":\"vs-dark\")";
        result = re.replace_all(&result, format!("theme:{}", theme_expr).as_str()).to_string();
    }

    // 5. Patch Monaco font size
    if let Ok(re) = regex::Regex::new(r#"fontSize:12"#) {
        result = re.replace_all(&result, "fontSize:13").to_string();
    }

    // 6. Patch lineNumbers
    if let Ok(re) = regex::Regex::new(r#"lineNumbers:"off""#) {
        result = re.replace_all(&result, "lineNumbers:\"on\"").to_string();
    }

    // 7. Patch lineDecorationsWidth
    if let Ok(re) = regex::Regex::new(r#"lineDecorationsWidth:\d+"#) {
        result = re.replace_all(&result, "lineDecorationsWidth:0").to_string();
    }

    // 8. Inject config preamble at top
    let preamble = build_webview_preamble(config);
    format!("{}{}", preamble, result)
}

// Check if CSP already has the required tokens
fn csp_has_tokens(content: &str, directive: &str, required: &[&str]) -> bool {
    let pattern = format!("{}\\s+[^;]*", regex::escape(directive));
    if let Ok(re) = regex::Regex::new(&pattern) {
        if let Some(m) = re.find(content) {
            let directive_text = m.as_str();
            return required.iter().all(|t| directive_text.contains(t));
        }
    }
    false
}

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

    // 3. Patch webview/index.js — inject config preamble, strip legacy, etc.
    if target.webview_index_js.exists() {
        let original = fs::read_to_string(&target.webview_index_js)
            .map_err(|e| format!("Failed to read webview/index.js: {}", e))?;
        let patched = patch_webview_index(&original, config);
        fs::write(&target.webview_index_js, &patched)
            .map_err(|e| format!("Failed to write patched webview/index.js: {}", e))?;
    }

    // 4. Patch extension.js — CSP + legacy cleanup + message guard
    let extension_js = extension_dir.join("extension.js");
    if extension_js.exists() {
        let original = fs::read_to_string(&extension_js)
            .map_err(|e| format!("Failed to read extension.js: {}", e))?;

        // Backup original extension.js
        let backup_ext = backup_dir.join("extension.js");
        if !backup_ext.exists() {
            fs::copy(&extension_js, &backup_ext).ok();
        }

        let mut patched = patch_extension_js(&original);

        // Apply CSP patching if needed
        if !csp_has_tokens(&patched, "style-src", &[CDN_HOST, "data:"])
            || !csp_has_tokens(&patched, "script-src", &[CDN_HOST])
            || !csp_has_tokens(&patched, "font-src", &[CDN_HOST, "data:"])
        {
            patched = patch_csp_directives(&patched);
        }

        fs::write(&extension_js, &patched)
            .map_err(|e| format!("Failed to write patched extension.js: {}", e))?;
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

    // 6. Patch extension's package.json — add commit-message command and prune legacy entries
    patch_package_json(extension_dir)?;

    // 7. Register companions in extensions.json
    register_companions(extension_dir)?;

    Ok(())
}

fn patch_package_json(extension_dir: &Path) -> Result<(), String> {
    let pkg_path = extension_dir.join("package.json");
    if !pkg_path.exists() { return Ok(()); }

    let content = fs::read_to_string(&pkg_path).map_err(|e| e.to_string())?;
    let mut pkg: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let mut modified = false;

    // 1. Remove legacy hunkwise entries
    if let Some(arr) = pkg.get_mut("enabledApiProposals").and_then(|v| v.as_array_mut()) {
        let before = arr.len();
        arr.retain(|v| v.as_str() != Some("editorInsets"));
        if arr.len() != before { modified = true; }
        if arr.is_empty() { pkg.as_object_mut().unwrap().remove("enabledApiProposals"); }
    }

    // 2. Add commit-message command from embedded package.json
    if let Some(cm_data) = DataAssets::get("data/commit_message_package.json") {
        if let Ok(cm_pkg) = serde_json::from_slice::<serde_json::Value>(&cm_data.data) {
            if let Some(cm_contributes) = cm_pkg.get("contributes") {
                if let Some(pkg_obj) = pkg.as_object_mut() {
                    if !pkg_obj.contains_key("contributes") {
                        pkg_obj.insert("contributes".into(), serde_json::json!({}));
                    }
                    let contributes = pkg_obj.get_mut("contributes").unwrap().as_object_mut().unwrap();

                    // Merge commands
                    if let Some(cm_commands) = cm_contributes.get("commands").and_then(|v| v.as_array()) {
                        if !contributes.contains_key("commands") {
                            contributes.insert("commands".into(), serde_json::json!([]));
                        }
                        let commands = contributes.get_mut("commands").unwrap().as_array_mut().unwrap();
                        for cmd in cm_commands {
                            let id = cmd.get("command").and_then(|v| v.as_str());
                            if !commands.iter().any(|c| c.get("command").and_then(|v| v.as_str()) == id) {
                                commands.push(cmd.clone());
                                modified = true;
                            }
                        }
                    }

                    // Merge menus
                    if let Some(cm_menus) = cm_contributes.get("menus").and_then(|v| v.as_object()) {
                        if !contributes.contains_key("menus") {
                            contributes.insert("menus".into(), serde_json::json!({}));
                        }
                        let menus = contributes.get_mut("menus").unwrap().as_object_mut().unwrap();
                        for (key, items) in cm_menus {
                            if !menus.contains_key(key) {
                                menus.insert(key.clone(), serde_json::json!([]));
                            }
                            let arr = menus.get_mut(key).unwrap().as_array_mut().unwrap();
                            if let Some(items_arr) = items.as_array() {
                                for item in items_arr {
                                    let cmd = item.get("command").and_then(|v| v.as_str());
                                    if !arr.iter().any(|c| c.get("command").and_then(|v| v.as_str()) == cmd) {
                                        arr.push(item.clone());
                                        modified = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // 3. Copy icon
            if let Some(icon_data) = DataAssets::get("data/commit_message_icon.svg") {
                let icon_dir = extension_dir.join("resources");
                fs::create_dir_all(&icon_dir).ok();
                fs::write(icon_dir.join("commit_message_icon.svg"), icon_data.data).ok();
            }
        }
    }

    // 4. Ensure activationEvents includes commit-message command
    if let Some(pkg_obj) = pkg.as_object_mut() {
        if !pkg_obj.contains_key("activationEvents") {
            pkg_obj.insert("activationEvents".into(), serde_json::json!([]));
        }
        let events = pkg_obj.get_mut("activationEvents").unwrap().as_array_mut().unwrap();
        let commit_cmd = "onCommand:incipit.generateCommitMessage";
        if !events.iter().any(|e| e.as_str() == Some(commit_cmd)) {
            events.push(serde_json::json!(commit_cmd));
            modified = true;
        }
    }

    if modified {
        let new_content = serde_json::to_string_pretty(&pkg).map_err(|e| e.to_string())?;
        fs::write(&pkg_path, &new_content).map_err(|e| e.to_string())?;
    }

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

    let webview_dir = target.webview_index_js.parent().ok_or("Invalid webview dir")?;

    // 1. Restore webview/index.js
    let backup_webview = backup_dir.join("webview_index.js");
    if backup_webview.exists() {
        fs::copy(&backup_webview, &target.webview_index_js)
            .map_err(|e| format!("Failed to restore webview/index.js: {}", e))?;
    }

    // 2. Restore extension.js
    let backup_ext = backup_dir.join("extension.js");
    let extension_js = target.extensions_dir.join("extension.js");
    if backup_ext.exists() {
        fs::copy(&backup_ext, &extension_js)
            .map_err(|e| format!("Failed to restore extension.js: {}", e))?;
    }

    // 3. Remove all patched webview files
    let patched_files = [
        "enhance.js", "theme.css", "enhance_shared.js", "runtime_kernel.js",
        "capability.js", "enhance_footer_badge.js", "enhance_thinking.js",
        "enhance_typography.js", "mermaid_render.js", "enhance_legacy.js",
        "host_probe.js", "host-badge.cjs", "checkpoint_timeline.cjs",
        "markdown_preprocess.js", "protocol_tags.js", "math_tokens.js",
        "math_rewriter.js", "commit_message_bundle.js", "warm-white-override.css",
    ];
    for file in &patched_files {
        let _ = fs::remove_file(webview_dir.join(file));
    }

    // 4. Remove injected asset trees
    for tree_name in ASSET_TREES {
        let _ = fs::remove_dir_all(webview_dir.join(tree_name));
    }

    // 5. Remove patched resources (commit message icon)
    let _ = fs::remove_dir_all(target.extensions_dir.join("resources"));

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
