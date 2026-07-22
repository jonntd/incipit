use std::fs;
use crate::assets::{DataAssets, CompanionAssets};
use crate::detector::TargetLocation;

pub fn apply_patch(target: &TargetLocation) -> Result<(), String> {
    let webview_dir = target.webview_index_js.parent().ok_or("Invalid webview dir")?;
    if !webview_dir.exists() {
        fs::create_dir_all(webview_dir).map_err(|e| e.to_string())?;
    }

    // 1. Create backup of official index.js if needed
    let backup_dir = dirs::home_dir().ok_or("No home dir")?.join(".incipit-backup").join(&target.version);
    fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
    let backup_index = backup_dir.join("index.js");

    if target.webview_index_js.exists() && !backup_index.exists() {
        fs::copy(&target.webview_index_js, &backup_index).map_err(|e| e.to_string())?;
    }

    // 2. Extract DataAssets into webview/
    for file in DataAssets::iter() {
        let file_path = file.as_ref();
        if let Some(content) = DataAssets::get(file_path) {
            let target_file_path = webview_dir.join(file_path);
            if let Some(parent) = target_file_path.parent() {
                fs::create_dir_all(parent).ok();
            }
            fs::write(target_file_path, content.data).map_err(|e| e.to_string())?;
        }
    }

    // 3. Extract Companions into extensions dir parent
    let extensions_parent = target.extensions_dir.parent().ok_or("Invalid extensions dir")?;
    for file in CompanionAssets::iter() {
        let file_path = file.as_ref();
        if let Some(content) = CompanionAssets::get(file_path) {
            let target_file_path = extensions_parent.join(file_path);
            if let Some(parent) = target_file_path.parent() {
                fs::create_dir_all(parent).ok();
            }
            fs::write(target_file_path, content.data).map_err(|e| e.to_string())?;
        }
    }

    println!("✅ Successfully applied Incipit patch to {}", target.label);
    Ok(())
}

pub fn restore_official(target: &TargetLocation) -> Result<(), String> {
    let backup_index = dirs::home_dir()
        .ok_or("No home dir")?
        .join(".incipit-backup")
        .join(&target.version)
        .join("index.js");

    if !backup_index.exists() {
        return Err("No official restore point found for this target.".to_string());
    }

    fs::copy(&backup_index, &target.webview_index_js).map_err(|e| e.to_string())?;
    println!("✅ Restored official files for {}", target.label);
    Ok(())
}
