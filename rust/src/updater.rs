use std::fs;
use std::process::Command;

const REPO: &str = "jonntd/incipit";
const CURRENT_VERSION: &str = "0.1.20";

fn get_platform_asset_name() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("incipit-macos-arm64"),
        ("macos", "x86_64") => Some("incipit-macos-x64"),
        ("windows", "x86_64") => Some("incipit-win-x64.exe"),
        ("linux", "x86_64") => Some("incipit-linux-x64"),
        _ => None,
    }
}

pub fn update_self() -> Result<(), String> {
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let asset_name = get_platform_asset_name().ok_or("Unsupported architecture")?;

    println!("Checking latest release from GitHub ({})...", REPO);

    let url = format!("https://github.com/{}/releases/latest/download/{}", REPO, asset_name);
    let temp_exe = current_exe.with_extension("tmp");

    println!("Downloading update from {} ...", url);

    let mut response = reqwest::blocking::get(&url).map_err(|e| format!("Failed to download: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Download failed with status {}", response.status()));
    }

    let mut out = fs::File::create(&temp_exe).map_err(|e| e.to_string())?;
    std::io::copy(&mut response, &mut out).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp_exe, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        fs::rename(&temp_exe, &current_exe).map_err(|e| e.to_string())?;

        println!("✅ Update completed! Restarting new version...");
        let _ = Command::new(&current_exe).args(std::env::args().skip(1)).spawn();
        std::process::exit(0);
    }

    #[cfg(windows)]
    {
        let bat_path = current_exe.with_extension("bat");
        let bat_content = format!(
            "@echo off\r\ntimeout /t 1 /nobreak > nul\r\nmove /y \"{}\" \"{}\"\r\nstart \"\" \"{}\"\r\ndel \"%~f0\"\r\n",
            temp_exe.display(),
            current_exe.display(),
            current_exe.display()
        );
        fs::write(&bat_path, bat_content).map_err(|e| e.to_string())?;
        Command::new("cmd.exe").args(["/c", bat_path.to_str().unwrap()]).spawn().map_err(|e| e.to_string())?;
        std::process::exit(0);
    }
}
