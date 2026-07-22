use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    style::{self, Color, Stylize},
    terminal::{self, ClearType},
};
use std::io::{self, Write};

use crate::config::Config;
use crate::detector::detect_targets;
use crate::installer::{apply_patch, restore_official};
use crate::updater::update_self;

// ── Color palette (matches original frontispiece.js) ──
fn terra() -> Color { Color::Rgb { r: 217, g: 119, b: 87 } }
fn ivory() -> Color { Color::Rgb { r: 248, g: 248, b: 246 } }
fn grey()  -> Color { Color::Rgb { r: 152, g: 152, b: 152 } }

fn pad(s: &str, width: usize) -> String {
    let len = s.chars().count();
    if len >= width { s.to_string() } else { format!("{}{}", s, " ".repeat(width - len)) }
}

fn center(text: &str, width: usize) -> String {
    let len = text.chars().count();
    let p = if len >= width { 0 } else { (width - len) / 2 };
    format!("{}{}", " ".repeat(p), text)
}

fn rule(w: usize) -> String { "━".repeat(w) }

const MENU_ITEMS: &[(&str, &str)] = &[
    ("apply",     "应用界面补丁"),
    ("restore",   "恢复官方 Claude Code"),
    ("configure", "配置"),
    ("update",    "检查新版本 / 自动升级"),
    ("target",    "管理 Claude Code 目标位置"),
    ("language",  "CLI 界面语言"),
    ("connect",   "Connect us"),
    ("cleanup",   "清理旧版备份文件"),
    ("quit",      "退出"),
];

const MENU_ITEMS_EN: &[(&str, &str)] = &[
    ("apply",     "Apply interface patch"),
    ("restore",   "Restore official Claude Code"),
    ("configure", "Configure"),
    ("update",    "Check for updates (GitHub Releases)"),
    ("target",    "Manage Claude Code targets"),
    ("language",  "CLI language"),
    ("connect",   "Connect us"),
    ("cleanup",   "Clean legacy backup files"),
    ("quit",      "Quit"),
];

fn get_items(lang: &str) -> &[(&str, &str)] {
    match lang { "en" => MENU_ITEMS_EN, _ => MENU_ITEMS }
}

fn print_help(lang: &str) {
    if lang == "en" {
        println!("  incipit  A frontend rework of the official Claude Code VS Code extension\n");
        println!("  Usage:");
        println!("    incipit              Launch interactive menu");
        println!("    incipit apply        Apply interface patch");
        println!("    incipit restore      Restore official Claude Code");
        println!("    incipit update       Check for updates (GitHub Releases)");
        println!("    incipit list-targets List every known Claude Code target");
        println!("    incipit clean-backups Clean legacy backup files");
    } else {
        println!("  incipit  Claude Code VS Code 扩展前端重绘\n");
        println!("  用法:");
        println!("    incipit              启动交互式菜单");
        println!("    incipit apply        应用界面补丁");
        println!("    incipit restore      恢复官方 Claude Code");
        println!("    incipit update       检查新版本 / 自动升级");
        println!("    incipit list-targets 列出所有已知 Claude Code 目标");
        println!("    incipit clean-backups 清理旧版备份文件");
    }
}

// ── Main menu ──
fn draw_menu(stdout: &mut io::Stdout, items: &[(&str, &str)], sel: usize, lang: &str) -> io::Result<()> {
    execute!(stdout, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0))?;
    let w: usize = 60;
    let r = rule(w);
    let ind = "      ";

    execute!(stdout, style::PrintStyledContent(format!("{}\n\n", center(&r, w)).with(grey())))?;
    execute!(stdout, style::PrintStyledContent(format!("{}\n\n", center("I  ·  N  ·  C  ·  I  ·  P  ·  I  ·  T", w)).with(terra()).bold()))?;
    execute!(stdout, style::PrintStyledContent(format!("{}\n", center("A frontend rework of the official", w)).with(grey()).italic()))?;
    execute!(stdout, style::PrintStyledContent(format!("{}\n", center("Claude Code VS Code extension", w)).with(grey()).italic()))?;
    execute!(stdout, style::PrintStyledContent(format!("\n{}\n\n", center(&format!("version {}", env!("CARGO_PKG_VERSION")), w)).with(grey()).italic()))?;

    let targets = detect_targets();
    if let Some(t) = targets.first() {
        execute!(stdout, cursor::MoveTo(0, 8))?;
        execute!(stdout, style::PrintStyledContent(format!("{}{}{}\n", ind, pad("Target", 12), t.label).with(ivory())))?;
        execute!(stdout, cursor::MoveTo(0, 9))?;
        let ext_name = t.extensions_dir.file_name().unwrap_or_default().to_string_lossy();
        execute!(stdout, style::PrintStyledContent(format!("{}{}{}\n", ind, pad("Extension", 12), ext_name).with(ivory())))?;
    } else {
        execute!(stdout, cursor::MoveTo(0, 8))?;
        execute!(stdout, style::PrintStyledContent(format!("{}{}{}\n", ind, pad("Target", 12), "(no Claude Code detected)").with(grey()).italic()))?;
    }
    execute!(stdout, style::PrintStyledContent("\n".with(grey())))?;

    let mut row: u16 = 10;
    for (i, (_, label)) in items.iter().enumerate() {
        let mark = format!("{}.", i + 1);
        if i == sel {
            execute!(stdout, cursor::MoveTo(0, row))?;
            execute!(stdout, style::PrintStyledContent(
                format!("   {}  {}  {}\n", "›".with(terra()).bold(), pad(&mark, 4).with(terra()).bold(), label).with(ivory())
            ))?;
        } else {
            execute!(stdout, cursor::MoveTo(0, row))?;
            execute!(stdout, style::PrintStyledContent(
                format!("{}{}{}\n", ind, pad(&mark, 4).with(terra()), label).with(ivory())
            ))?;
        }
        row += 1;
    }

    execute!(stdout, style::PrintStyledContent(format!("\n{}\n", center(&r, w)).with(grey())))?;
    let hint = if lang == "en" { "↑↓ navigate  ·  Enter confirm  ·  q quit" } else { "↑↓ 导航  ·  回车 确认  ·  q 退出" };
    execute!(stdout, cursor::MoveTo(0, row + 2))?;
    execute!(stdout, style::PrintStyledContent(format!("{}\n", center(hint, w)).with(grey()).italic()))?;
    execute!(stdout, cursor::MoveTo(0, row + 3))?;
    execute!(stdout, style::PrintStyledContent(format!("{}{}", ind, "› ").with(terra()).bold()))?;
    execute!(stdout, style::PrintStyledContent("\n".with(grey())))?;
    stdout.flush()?;
    Ok(())
}

// ── Targets sub-menu ──
fn run_targets(lang: &str) {
    let mut stdout = io::stdout();
    let mut targets = detect_targets();
    let mut sel: usize = 0;
    terminal::enable_raw_mode().ok();
    execute!(stdout, cursor::Hide).ok();

    loop {
        execute!(stdout, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0)).ok();
        let w: usize = 60;
        let r = rule(w);
        let ind = "      ";
        let title = if lang == "en" { "Manage Claude Code Targets" } else { "管理 Claude Code 目标位置" };

        execute!(stdout, style::PrintStyledContent(format!("{}\n", center(&r, w)).with(grey()))).ok();
        execute!(stdout, style::PrintStyledContent(format!("{}\n{}\n", center(title, w).with(terra()).bold(), center(&r, w)).with(grey()))).ok();
        execute!(stdout, style::PrintStyledContent("\n".with(grey()))).ok();

        if targets.is_empty() {
            let msg = if lang == "en" { "No Claude Code installation detected." } else { "未检测到 Claude Code 安装。" };
            execute!(stdout, style::PrintStyledContent(format!("{}\n", center(msg, w)).with(grey()).italic())).ok();
        } else {
            for (i, t) in targets.iter().enumerate() {
                let mark = format!("{}.", i + 1);
                if i == sel {
                    execute!(stdout, style::PrintStyledContent(
                        format!("   {}  {}  {}\n", "›".with(terra()).bold(), pad(&mark, 4).with(terra()).bold(), t.label).with(ivory())
                    )).ok();
                } else {
                    execute!(stdout, style::PrintStyledContent(
                        format!("{}{}{}\n", ind, pad(&mark, 4).with(terra()), t.label).with(ivory())
                    )).ok();
                }
            }
        }

        execute!(stdout, style::PrintStyledContent(format!("\n{}\n", center(&r, w)).with(grey()))).ok();
        let hint = if lang == "en" { "[r] Rescan  ·  [q] Back" } else { "[r] 重新扫描  ·  [q] 返回" };
        execute!(stdout, style::PrintStyledContent(format!("{}\n", center(hint, w)).with(grey()).italic())).ok();
        stdout.flush().ok();

        if let Event::Key(key) = event::read().expect("read") {
            if key.kind != KeyEventKind::Press { continue; }
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => { if !targets.is_empty() { sel = if sel > 0 { sel - 1 } else { targets.len() - 1 }; } }
                KeyCode::Down | KeyCode::Char('j') => { if !targets.is_empty() { sel = if sel < targets.len() - 1 { sel + 1 } else { 0 }; } }
                KeyCode::Char('r') => { targets = detect_targets(); sel = 0; }
                KeyCode::Char('q') | KeyCode::Esc | KeyCode::Char('b') => { execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                _ => {}
            }
        }
    }
}

// ── Language picker ──
fn run_language(lang: &str) {
    let mut stdout = io::stdout();
    let options = vec!["中文", "English"];
    let mut sel: usize = if lang == "en" { 1 } else { 0 };
    terminal::enable_raw_mode().ok();
    execute!(stdout, cursor::Hide).ok();

    loop {
        execute!(stdout, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0)).ok();
        let w: usize = 60;
        let r = rule(w);
        let ind = "      ";

        execute!(stdout, style::PrintStyledContent(format!("{}\n", center(&r, w)).with(grey()))).ok();
        execute!(stdout, style::PrintStyledContent(format!("{}\n{}\n", center("CLI 界面语言 / Language", w).with(terra()).bold(), center(&r, w)).with(grey()))).ok();
        execute!(stdout, style::PrintStyledContent("\n".with(grey()))).ok();

        for (i, label) in options.iter().enumerate() {
            let mark = format!("{}.", i + 1);
            if i == sel {
                execute!(stdout, style::PrintStyledContent(
                    format!("   {}  {}  {}\n", "›".with(terra()).bold(), pad(&mark, 4).with(terra()).bold(), label).with(ivory())
                )).ok();
            } else {
                execute!(stdout, style::PrintStyledContent(
                    format!("{}{}{}\n", ind, pad(&mark, 4).with(terra()), label).with(ivory())
                )).ok();
            }
        }

        execute!(stdout, style::PrintStyledContent(format!("\n{}\n", center(&r, w)).with(grey()))).ok();
        let hint = if lang == "en" { "↑↓ move  ·  Enter select  ·  q back" } else { "↑↓ 移动  ·  回车 确认  ·  q 返回" };
        execute!(stdout, style::PrintStyledContent(format!("{}\n", center(hint, w)).with(grey()).italic())).ok();
        stdout.flush().ok();

        if let Event::Key(key) = event::read().expect("read") {
            if key.kind != KeyEventKind::Press { continue; }
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => { sel = if sel > 0 { sel - 1 } else { options.len() - 1 }; }
                KeyCode::Down | KeyCode::Char('j') => { sel = if sel < options.len() - 1 { sel + 1 } else { 0 }; }
                KeyCode::Enter => {
                    let new_lang = if sel == 0 { "zh" } else { "en" };
                    let mut config = Config::load();
                    config.language = new_lang.to_string();
                    let _ = config.save();
                    execute!(stdout, cursor::Show).ok();
                    terminal::disable_raw_mode().ok();
                    std::process::Command::new(std::env::current_exe().unwrap())
                        .arg("--lang").arg(new_lang).spawn().ok();
                    std::process::exit(0);
                }
                KeyCode::Char('q') | KeyCode::Esc | KeyCode::Char('b') => {
                    execute!(stdout, cursor::Show).ok();
                    terminal::disable_raw_mode().ok();
                    return;
                }
                _ => {}
            }
        }
    }
}

// ── Cleanup backups ──
fn run_cleanup(lang: &str) {
    let backup_dir = dirs::home_dir().map(|h| h.join(".incipit-backup"));
    let restore_dir = dirs::home_dir().map(|h| h.join(".incipit").join("official-restore-points-v1"));
    let mut total_bytes: u64 = 0;
    let mut total_files: u64 = 0;
    let mut total_dirs: u64 = 0;

    for dir in backup_dir.iter().chain(restore_dir.iter()) {
        if dir.exists() {
            for entry in std::fs::read_dir(dir).into_iter().flatten() {
                if let Ok(entry) = entry {
                    if let Some(m) = entry.metadata().ok() {
                        total_bytes += m.len();
                        if m.is_dir() { total_dirs += 1; } else { total_files += 1; }
                    }
                }
            }
        }
    }

    let size_str = if total_bytes > 1_048_576 { format!("{:.1} MB", total_bytes as f64 / 1_048_576.0) }
    else if total_bytes > 1024 { format!("{:.1} KB", total_bytes as f64 / 1024.0) }
    else { format!("{} B", total_bytes) };

    if lang == "en" {
        println!("\n  Clean Legacy Backups\n");
        if let Some(ref p) = backup_dir { println!("  Backup root: {}", p.display()); }
        println!("  Files: {}  Dirs: {}  Size: {}", total_files, total_dirs, size_str);
    } else {
        println!("\n  清理旧版备份文件\n");
        if let Some(ref p) = backup_dir { println!("  备份目录: {}", p.display()); }
        println!("  文件: {}  目录: {}  大小: {}", total_files, total_dirs, size_str);
    }

    if total_bytes == 0 {
        println!("{}", if lang == "en" { "\n  No legacy backups found." } else { "\n  未发现旧版备份文件。" });
    } else {
        let prompt = if lang == "en" { "\n  Delete all legacy backups? [y/N] " } else { "\n  确认删除所有旧版备份？[y/N] " };
        print!("{}", prompt);
        io::stdout().flush().ok();
        let mut input = String::new();
        io::stdin().read_line(&mut input).ok();
        if input.trim().eq_ignore_ascii_case("y") {
            for dir in backup_dir.iter().chain(restore_dir.iter()) {
                if dir.exists() { let _ = std::fs::remove_dir_all(dir); }
            }
            println!("{}", if lang == "en" { "  ✅ Legacy backups deleted." } else { "  ✅ 旧版备份已清理。" });
        } else {
            println!("{}", if lang == "en" { "  Cancelled." } else { "  已取消。" });
        }
    }
    println!("\n  Press Enter to return...");
    let mut buf = String::new();
    io::stdin().read_line(&mut buf).ok();
}

// ── Configure sub-menu ──
fn draw_configure(stdout: &mut io::Stdout, config: &Config, sel: usize, lang: &str) -> io::Result<()> {
    execute!(stdout, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0))?;
    let w: usize = 60;
    let r = rule(w);
    let ind = "      ";
    let title = if lang == "en" { "Configure" } else { "配置" };

    execute!(stdout, style::PrintStyledContent(format!("{}\n", center(&r, w)).with(grey())))?;
    execute!(stdout, style::PrintStyledContent(format!("{}\n{}\n", center(title, w).with(terra()).bold(), center(&r, w)).with(grey())))?;
    execute!(stdout, style::PrintStyledContent("\n".with(grey())))?;

    let on = if lang == "en" { "ON" } else { "开启" };
    let off = if lang == "en" { "OFF" } else { "关闭" };

    let rows: Vec<(String, String, bool)> = vec![
        ("math".into(), if lang == "en" { "Math rendering" } else { "数学公式渲染" }.into(), config.features.math),
        ("session".into(), if lang == "en" { "Session usage" } else { "会话用量统计" }.into(), config.features.session_usage),
        ("overlay".into(), if lang == "en" { "Editor overlay" } else { "编辑器浮层" }.into(), config.features.editor_selection_overlay),
        ("bodysize".into(), if lang == "en" { "Body font size" } else { "正文字号" }.into(), false),
        ("palette".into(), if lang == "en" { "Color palette" } else { "主题色" }.into(), false),
        ("reset".into(), if lang == "en" { "Reset to defaults" } else { "恢复默认设置" }.into(), false),
        ("back".into(), if lang == "en" { "Back" } else { "返回" }.into(), false),
    ];

    for (i, (_, label, val)) in rows.iter().enumerate() {
        let display = match i {
            0..=2 => format!("{} [{}]", label, if *val { on } else { off }),
            3 => format!("{}  {} px", label, config.theme.body_font_size),
            4 => {
                let pal = if config.theme.palette == "warm-white" {
                    if lang == "en" { "Warm White" } else { "暖白" }
                } else {
                    if lang == "en" { "Warm Black" } else { "暖黑" }
                };
                format!("{}  {}", label, pal)
            }
            _ => label.clone(),
        };
        let mark = format!("{}.", i + 1);
        if i == sel {
            execute!(stdout, cursor::MoveTo(0, (i + 4) as u16))?;
            execute!(stdout, style::PrintStyledContent(
                format!("   {}  {}  {}\n", "›".with(terra()).bold(), pad(&mark, 4).with(terra()).bold(), display).with(ivory())
            ))?;
        } else {
            execute!(stdout, cursor::MoveTo(0, (i + 4) as u16))?;
            execute!(stdout, style::PrintStyledContent(
                format!("{}{}{}\n", ind, pad(&mark, 4).with(terra()), display).with(ivory())
            ))?;
        }
    }

    execute!(stdout, cursor::MoveTo(0, (rows.len() + 5) as u16))?;
    execute!(stdout, style::PrintStyledContent(format!("{}\n", center(&r, w)).with(grey())))?;
    let hint = if lang == "en" { "↑↓ move  ·  Enter toggle  ·  r reset  ·  q back" } else { "↑↓ 移动  ·  回车 切换  ·  r 恢复默认  ·  q 返回" };
    execute!(stdout, style::PrintStyledContent(format!("{}\n", center(hint, w)).with(grey()).italic()))?;
    stdout.flush()?;
    Ok(())
}

pub fn run_configure(lang: &str) {
    let mut stdout = io::stdout();
    let mut config = Config::load();
    let mut sel: usize = 0;
    terminal::enable_raw_mode().expect("Failed to enable raw mode");
    execute!(stdout, cursor::Hide).ok();
    draw_configure(&mut stdout, &config, sel, lang).ok();

    loop {
        if let Event::Key(key) = event::read().expect("read") {
            if key.kind != KeyEventKind::Press { continue; }
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => { sel = if sel > 0 { sel - 1 } else { 6 }; draw_configure(&mut stdout, &config, sel, lang).ok(); }
                KeyCode::Down | KeyCode::Char('j') => { sel = if sel < 6 { sel + 1 } else { 0 }; draw_configure(&mut stdout, &config, sel, lang).ok(); }
                KeyCode::Char('q') | KeyCode::Char('b') | KeyCode::Esc => { execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                KeyCode::Enter | KeyCode::Char(' ') => {
                    match sel {
                        0 => config.features.math = !config.features.math,
                        1 => config.features.session_usage = !config.features.session_usage,
                        2 => config.features.editor_selection_overlay = !config.features.editor_selection_overlay,
                        3 => config.theme.body_font_size = match config.theme.body_font_size { 12 => 13, 13 => 14, 14 => 15, 15 => 16, _ => 12 },
                        4 => config.theme.palette = if config.theme.palette == "warm-black" { "warm-white".into() } else { "warm-black".into() },
                        5 => config = Config::default(),
                        6 => { let _ = config.save(); execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                        _ => {}
                    }
                    let _ = config.save();
                    draw_configure(&mut stdout, &config, sel, lang).ok();
                }
                KeyCode::Char('r') => { config = Config::default(); let _ = config.save(); draw_configure(&mut stdout, &config, sel, lang).ok(); }
                _ => {}
            }
        }
    }
}

// ── Main interactive menu ──
pub fn run_interactive(lang: &str) {
    if !terminal::window_size().is_ok() {
        print_help(lang);
        return;
    }

    let mut stdout = io::stdout();
    let items = get_items(lang);
    let mut sel: usize = 0;

    terminal::enable_raw_mode().expect("Failed to enable raw mode");
    execute!(stdout, cursor::Hide).ok();
    draw_menu(&mut stdout, items, sel, lang).ok();

    loop {
        if let Event::Key(key) = event::read().expect("read") {
            if key.kind != KeyEventKind::Press { continue; }
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => { sel = if sel > 0 { sel - 1 } else { items.len() - 1 }; draw_menu(&mut stdout, items, sel, lang).ok(); }
                KeyCode::Down | KeyCode::Char('j') => { sel = if sel < items.len() - 1 { sel + 1 } else { 0 }; draw_menu(&mut stdout, items, sel, lang).ok(); }
                KeyCode::Enter => {
                    let action = items[sel].0;
                    match action {
                        "quit" => { execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                        "apply" => {
                            execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            let targets = detect_targets();
                            if targets.is_empty() { eprintln!("\n  ⚠  No Claude Code installation detected.\n"); }
                            else {
                                eprintln!("\n  ⏳ Applying patch to {}...", targets[0].label);
                                match apply_patch(&targets[0]) { Ok(()) => eprintln!("  ✅ Patch applied successfully!\n"), Err(e) => eprintln!("  ❌ Error: {}\n", e) }
                            }
                            eprintln!("  Press Enter to return...");
                            let mut buf = String::new(); io::stdin().read_line(&mut buf).ok();
                            terminal::enable_raw_mode().ok(); execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, sel, lang).ok();
                        }
                        "restore" => {
                            execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            let targets = detect_targets();
                            if targets.is_empty() { eprintln!("\n  ⚠  No Claude Code installation detected.\n"); }
                            else {
                                eprintln!("\n  ⏳ Restoring {}...", targets[0].label);
                                match restore_official(&targets[0]) { Ok(()) => eprintln!("  ✅ Official files restored!\n"), Err(e) => eprintln!("  ❌ Error: {}\n", e) }
                            }
                            eprintln!("  Press Enter to return...");
                            let mut buf = String::new(); io::stdin().read_line(&mut buf).ok();
                            terminal::enable_raw_mode().ok(); execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, sel, lang).ok();
                        }
                        "update" => {
                            execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            eprintln!("\n  ⏳ Checking for updates...");
                            match update_self() { Ok(()) => {} Err(e) => { eprintln!("  ❌ Update failed: {}\n", e); eprintln!("  Press Enter to return..."); let mut buf = String::new(); io::stdin().read_line(&mut buf).ok(); } }
                            terminal::enable_raw_mode().ok(); execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, sel, lang).ok();
                        }
                        "configure" => {
                            execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            run_configure(lang);
                            terminal::enable_raw_mode().ok(); execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, sel, lang).ok();
                        }
                        "target" => {
                            execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            run_targets(lang);
                            terminal::enable_raw_mode().ok(); execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, sel, lang).ok();
                        }
                        "language" => {
                            execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            run_language(lang);
                            terminal::enable_raw_mode().ok(); execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, sel, lang).ok();
                        }
                        "connect" => {
                            execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            println!("\n  GitHub: https://github.com/jonntd/incipit");
                            println!("  Issues: https://github.com/jonntd/incipit/issues\n");
                            println!("  Press Enter to return...");
                            let mut buf = String::new(); io::stdin().read_line(&mut buf).ok();
                            terminal::enable_raw_mode().ok(); execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, sel, lang).ok();
                        }
                        "cleanup" => {
                            execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            run_cleanup(lang);
                            terminal::enable_raw_mode().ok(); execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, sel, lang).ok();
                        }
                        _ => {}
                    }
                }
                KeyCode::Char('q') => { execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                KeyCode::Char(c) => {
                    if let Some(digit) = c.to_digit(10) {
                        let idx = digit as usize;
                        if idx >= 1 && idx <= items.len() {
                            let action = items[idx - 1].0;
                            if action == "quit" { execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                            execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            match action {
                                "apply" => { let targets = detect_targets(); if targets.is_empty() { eprintln!("\n  ⚠  No Claude Code installation detected.\n"); } else { eprintln!("\n  ⏳ Applying patch..."); match apply_patch(&targets[0]) { Ok(()) => eprintln!("  ✅ Done!\n"), Err(e) => eprintln!("  ❌ Error: {}\n", e) } } }
                                "restore" => { let targets = detect_targets(); if targets.is_empty() { eprintln!("\n  ⚠  No Claude Code installation detected.\n"); } else { eprintln!("\n  ⏳ Restoring..."); match restore_official(&targets[0]) { Ok(()) => eprintln!("  ✅ Done!\n"), Err(e) => eprintln!("  ❌ Error: {}\n", e) } } }
                                "update" => { eprintln!("\n  ⏳ Checking for updates..."); if let Err(e) = update_self() { eprintln!("  ❌ Failed: {}\n", e); } }
                                "target" => run_targets(lang),
                                "connect" => { println!("\n  GitHub: https://github.com/jonntd/incipit\n  Issues: https://github.com/jonntd/incipit/issues\n"); }
                                "cleanup" => run_cleanup(lang),
                                "language" => run_language(lang),
                                _ => {}
                            }
                            return;
                        }
                    }
                }
                _ => {}
            }
        }
    }
}
