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

// ── Color palette (matches original frontispiece.js exactly) ──
fn terra() -> Color { Color::Rgb { r: 217, g: 119, b: 87 } }
fn ivory() -> Color { Color::Rgb { r: 248, g: 248, b: 246 } }
fn grey()  -> Color { Color::Rgb { r: 152, g: 152, b: 152 } }

const MARK_COL: usize = 5;
const CHECK_COL: usize = 4;
const LABEL_COL: usize = 22;

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

fn cursor_indent() -> String { format!("   {}  ", "›".with(terra()).bold()) }

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

// ── Render helpers ──
fn render_header(stdout: &mut io::Stdout, title: &str, w: usize) -> io::Result<()> {
    let r = rule(w);
    execute!(stdout, style::PrintStyledContent(format!("{}\n\n", center(&r, w)).with(grey())))?;
    execute!(stdout, style::PrintStyledContent(format!("{}\n\n", center("I  ·  N  ·  C  ·  I  ·  P  ·  I  ·  T", w)).with(terra()).bold()))?;
    execute!(stdout, style::PrintStyledContent(format!("{}\n", center("A frontend rework of the official", w)).with(grey()).italic()))?;
    execute!(stdout, style::PrintStyledContent(format!("{}\n", center("Claude Code VS Code extension", w)).with(grey()).italic()))?;
    execute!(stdout, style::PrintStyledContent(format!("\n{}\n\n", center(&format!("version {}", env!("CARGO_PKG_VERSION")), w)).with(grey()).italic()))?;
    execute!(stdout, style::PrintStyledContent(format!("{}\n", center(title, w)).with(grey())))?;
    execute!(stdout, style::PrintStyledContent("\n\n".with(grey())))?;
    Ok(())
}

fn render_footer(stdout: &mut io::Stdout, hint: &str, w: usize) -> io::Result<()> {
    let r = rule(w);
    execute!(stdout, style::PrintStyledContent(format!("\n{}\n", center(&r, w)).with(grey())))?;
    execute!(stdout, style::PrintStyledContent(format!("{}\n", center(hint, w)).with(grey()).italic()))?;
    Ok(())
}

// ── Main menu ──
fn draw_menu(stdout: &mut io::Stdout, items: &[(&str, &str)], sel: usize, lang: &str) -> io::Result<()> {
    execute!(stdout, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0))?;
    let w: usize = 60;
    let ind = "      ";

    render_header(stdout, "", w)?;

    // Ledger
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

    // Menu items
    let mut row: u16 = 10;
    for (i, (_, label)) in items.iter().enumerate() {
        let mark = format!("{}.", i + 1);
        let lead = if i == sel { cursor_indent() } else { ind.to_string() };
        execute!(stdout, cursor::MoveTo(0, row))?;
        execute!(stdout, style::PrintStyledContent(
            format!("{}{}{}\n", lead, pad(&mark, MARK_COL).with(terra()), label).with(ivory())
        ))?;
        row += 1;
    }

    let hint = if lang == "en" { "↑↓ navigate  ·  Enter confirm  ·  q quit" } else { "↑↓ 导航  ·  回车 确认  ·  q 退出" };
    render_footer(stdout, hint, w)?;
    stdout.flush()?;
    Ok(())
}

// ── Configure sub-menu (matches original with ✓/✗ toggles) ──
fn draw_configure(stdout: &mut io::Stdout, config: &Config, sel: usize, lang: &str) -> io::Result<()> {
    execute!(stdout, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0))?;
    let w: usize = 60;
    let ind = "      ";

    render_header(stdout, if lang == "en" { "Configure" } else { "配置" }, w)?;

    let on = if lang == "en" { "ON" } else { "开启" };
    let off = if lang == "en" { "OFF" } else { "关闭" };

    // Row data: (mark, value_display, is_toggle)
    struct Row { mark: &'static str, label: &'static str, value: String, is_toggle: bool }
    let rows: Vec<Row> = vec![
        Row { mark: "1.", label: if lang == "en" { "Math rendering" } else { "数学公式渲染" }, value: if config.features.math { on.into() } else { off.into() }, is_toggle: true },
        Row { mark: "2.", label: if lang == "en" { "Session usage" } else { "会话用量统计" }, value: if config.features.session_usage { on.into() } else { off.into() }, is_toggle: true },
        Row { mark: "3.", label: if lang == "en" { "Editor overlay" } else { "编辑器浮层" }, value: if config.features.editor_selection_overlay { on.into() } else { off.into() }, is_toggle: true },
        Row { mark: "4.", label: if lang == "en" { "Body font size" } else { "正文字号" }, value: format!("{} px", config.theme.body_font_size), is_toggle: false },
        Row { mark: "5.", label: if lang == "en" { "Color palette" } else { "主题色" }, value: if config.theme.palette == "warm-white" {
            if lang == "en" { "Warm White" } else { "暖白" }.into()
        } else {
            if lang == "en" { "Warm Black" } else { "暖黑" }.into()
        }, is_toggle: false },
        Row { mark: "6.", label: "", value: "".into(), is_toggle: false }, // placeholder for bodyFont
        Row { mark: "7.", label: "", value: "".into(), is_toggle: false }, // placeholder for codeFont
        Row { mark: "r.", label: if lang == "en" { "Reset to defaults" } else { "恢复默认设置" }, value: "".into(), is_toggle: false },
        Row { mark: "b.", label: if lang == "en" { "Back" } else { "返回" }, value: "".into(), is_toggle: false },
    ];

    let mut row_num: u16 = 10;
    for (i, r) in rows.iter().enumerate() {
        let lead = if i == sel { cursor_indent() } else { ind.to_string() };

        if i < 3 {
            // Toggle items: ✓/✗ + label
            let glyph = if (i == 0 && config.features.math)
                || (i == 1 && config.features.session_usage)
                || (i == 2 && config.features.editor_selection_overlay) { "✓" } else { "✗" };
            let glyph_color = if glyph == "✓" { terra() } else { grey() };

            execute!(stdout, cursor::MoveTo(0, row_num))?;
            execute!(stdout, style::PrintStyledContent(
                format!("{}{}{}{}\n", lead,
                    pad(r.mark, MARK_COL).with(terra()),
                    pad(glyph, CHECK_COL).with(glyph_color),
                    r.label).with(ivory())
            ))?;
        } else if i < 7 {
            // Knob items: label + value
            execute!(stdout, cursor::MoveTo(0, row_num))?;
            let knob_line = format!("{}{}{}{}", lead,
                pad(r.mark, MARK_COL).with(terra()),
                " ".repeat(CHECK_COL),
                pad(r.label, LABEL_COL).with(ivory()));
            execute!(stdout, style::PrintStyledContent(
                format!("{}{}\n", knob_line, r.value).with(ivory())
            ))?;
        } else {
            // Plain items: r. / b.
            execute!(stdout, cursor::MoveTo(0, row_num))?;
            execute!(stdout, style::PrintStyledContent(
                format!("{}{}{}\n", lead,
                    pad(r.mark, MARK_COL).with(terra()),
                    r.label).with(ivory())
            ))?;
        }
        row_num += 1;
    }

    let hint = if lang == "en" { "↑↓ move  ·  Enter toggle  ·  r reset  ·  b back" } else { "↑↓ 移动  ·  回车 切换  ·  r 恢复默认  ·  b 返回" };
    render_footer(stdout, hint, w)?;
    stdout.flush()?;
    Ok(())
}

pub fn run_configure(lang: &str) {
    let mut stdout = io::stdout();
    let mut config = Config::load();
    let mut sel: usize = 0;
    let item_count = 9; // 3 toggles + 3 knobs + reset + back + 1 bodyFont placeholder
    terminal::enable_raw_mode().expect("Failed to enable raw mode");
    execute!(stdout, cursor::Hide).ok();
    draw_configure(&mut stdout, &config, sel, lang).ok();

    loop {
        if let Event::Key(key) = event::read().expect("read") {
            if key.kind != KeyEventKind::Press { continue; }
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => { sel = if sel > 0 { sel - 1 } else { item_count - 1 }; draw_configure(&mut stdout, &config, sel, lang).ok(); }
                KeyCode::Down | KeyCode::Char('j') => { sel = if sel < item_count - 1 { sel + 1 } else { 0 }; draw_configure(&mut stdout, &config, sel, lang).ok(); }
                KeyCode::Char('q') | KeyCode::Char('b') | KeyCode::Esc => { execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                KeyCode::Enter | KeyCode::Char(' ') => {
                    match sel {
                        0 => config.features.math = !config.features.math,
                        1 => config.features.session_usage = !config.features.session_usage,
                        2 => config.features.editor_selection_overlay = !config.features.editor_selection_overlay,
                        3 => config.theme.body_font_size = match config.theme.body_font_size { 12 => 13, 13 => 14, 14 => 15, 15 => 16, _ => 12 },
                        4 => config.theme.palette = if config.theme.palette == "warm-black" { "warm-white".into() } else { "warm-black".into() },
                        7 => { config = Config::default(); }
                        8 => { let _ = config.save(); execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
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

// ── Targets sub-menu (browse mode with actions) ──
fn run_targets(lang: &str) {
    let mut stdout = io::stdout();
    let mut targets = detect_targets();
    let mut sel: usize = 0; // index into actions
    let actions: Vec<(&str, &str)> = vec![
        ("a.", if lang == "en" { "Add target" } else { "添加目标" }),
        ("s.", if lang == "en" { "Deep scan" } else { "深度扫描" }),
        ("d.", if lang == "en" { "Remove target" } else { "删除目标" }),
        ("b.", if lang == "en" { "Back" } else { "返回" }),
    ];

    terminal::enable_raw_mode().ok();
    execute!(stdout, cursor::Hide).ok();

    loop {
        execute!(stdout, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0)).ok();
        let w: usize = 60;
        let ind = "      ";

        render_header(&mut stdout, if lang == "en" { "Manage Targets" } else { "管理目标位置" }, w).ok();

        // Target list
        let sub_heading = if lang == "en" { "Detected targets:" } else { "已检测到的目标：" };
        execute!(stdout, style::PrintStyledContent(format!("{}{}\n", ind, sub_heading).with(grey()))).ok();
        execute!(stdout, style::PrintStyledContent("\n".with(grey()))).ok();

        let mut row: u16 = 12;
        if targets.is_empty() {
            let msg = if lang == "en" { "No Claude Code installation detected." } else { "未检测到 Claude Code 安装。" };
            let hint_msg = if lang == "en" { "Install Claude Code first, then run scan." } else { "请先安装 Claude Code，然后运行扫描。" };
            execute!(stdout, style::PrintStyledContent(format!("{}{}\n", ind, msg).with(grey()).italic())).ok();
            execute!(stdout, style::PrintStyledContent(format!("{}{}\n", ind, hint_msg).with(grey()).italic())).ok();
        } else {
            for t in &targets {
                let ext_name = t.extensions_dir.file_name().unwrap_or_default().to_string_lossy();
                execute!(stdout, cursor::MoveTo(0, row)).ok();
                execute!(stdout, style::PrintStyledContent(format!("{}{}\n", ind, t.label).with(ivory()))).ok();
                execute!(stdout, style::PrintStyledContent(format!("        {}\n", ext_name).with(grey()).italic())).ok();
                row += 2;
            }
        }

        // Separator
        execute!(stdout, style::PrintStyledContent("\n".with(grey()))).ok();
        execute!(stdout, style::PrintStyledContent(
            format!("{}{}\n", ind, "─".repeat(w - ind.len() - 2)).with(grey())
        )).ok();
        execute!(stdout, style::PrintStyledContent("\n".with(grey()))).ok();

        // Action rows
        for (i, (mark, label)) in actions.iter().enumerate() {
            let lead = if i == sel { cursor_indent() } else { ind.to_string() };
            execute!(stdout, style::PrintStyledContent(
                format!("{}{}{}\n", lead, pad(mark, MARK_COL).with(terra()), label).with(ivory())
            )).ok();
        }

        let hint = if lang == "en" { "↑↓ navigate  ·  Enter select  ·  b back" } else { "↑↓ 导航  ·  回车 确认  ·  b 返回" };
        render_footer(&mut stdout, hint, w).ok();
        stdout.flush().ok();

        if let Event::Key(key) = event::read().expect("read") {
            if key.kind != KeyEventKind::Press { continue; }
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => { sel = if sel > 0 { sel - 1 } else { actions.len() - 1 }; }
                KeyCode::Down | KeyCode::Char('j') => { sel = if sel < actions.len() - 1 { sel + 1 } else { 0 }; }
                KeyCode::Enter => {
                    match sel {
                        0 => { /* add target - TODO */ }
                        1 => { targets = detect_targets(); } // rescan
                        2 => { /* remove - TODO */ }
                        3 => { execute!(stdout, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                        _ => {}
                    }
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
        let ind = "      ";

        render_header(&mut stdout, if lang == "en" { "CLI Language" } else { "CLI 界面语言" }, w).ok();
        execute!(stdout, style::PrintStyledContent("\n".with(grey()))).ok();

        for (i, label) in options.iter().enumerate() {
            let mark = format!("{}.", i + 1);
            let lead = if i == sel { cursor_indent() } else { ind.to_string() };
            execute!(stdout, style::PrintStyledContent(
                format!("{}{}{}\n", lead, pad(&mark, MARK_COL).with(terra()), label).with(ivory())
            )).ok();
        }

        let hint = if lang == "en" { "↑↓ move  ·  Enter select  ·  b back" } else { "↑↓ 移动  ·  回车 确认  ·  b 返回" };
        render_footer(&mut stdout, hint, w).ok();
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
