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

fn get_menu_items(lang: &str) -> &[(&str, &str)] {
    match lang {
        "en" => MENU_ITEMS_EN,
        _ => MENU_ITEMS,
    }
}

fn draw_menu(
    stdout: &mut io::Stdout,
    items: &[(&str, &str)],
    selected: usize,
    lang: &str,
) -> io::Result<()> {
    execute!(stdout, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0))?;

    let title = if lang == "en" {
        "  incipit  A frontend rework of the official Claude Code VS Code extension\n"
    } else {
        "  incipit  Claude Code VS Code 扩展前端重绘\n"
    };
    execute!(stdout, style::PrintStyledContent(title.with(Color::Cyan)))?;
    execute!(stdout, style::PrintStyledContent(
        "  ─────────────────────────────────────────────────\n".with(Color::DarkGrey)
    ))?;

    for (i, (_, label)) in items.iter().enumerate() {
        let is_quit = items[i].0 == "quit";
        let display_mark = if is_quit { "q.".to_string() } else { format!("{}.", i + 1) };

        if i == selected {
            // Selected item: white text on dark blue background
            execute!(stdout, cursor::MoveTo(0, (i + 3) as u16))?;
            execute!(stdout, style::PrintStyledContent(
                format!("  {}  ▸ {}", display_mark, label).with(Color::White).on(Color::DarkBlue)
            ))?;
        } else {
            // Normal item: grey text
            execute!(stdout, cursor::MoveTo(0, (i + 3) as u16))?;
            execute!(stdout, style::PrintStyledContent(
                format!("  {}    {}", display_mark, label).with(Color::Grey)
            ))?;
        }
    }

    execute!(stdout, cursor::MoveTo(0, (items.len() + 3) as u16))?;
    execute!(stdout, style::PrintStyledContent(
        "\n  ─────────────────────────────────────────────────\n".with(Color::DarkGrey)
    ))?;

    let hint = if lang == "en" {
        "  ↑↓ move · Enter select · q quit\n"
    } else {
        "  ↑↓ 移动 · 回车 确认 · q 退出\n"
    };
    execute!(stdout, style::PrintStyledContent(hint.with(Color::DarkGrey)))?;

    stdout.flush()?;
    Ok(())
}

fn show_targets() {
    let targets = detect_targets();
    if targets.is_empty() {
        println!("  No Claude Code installation detected.");
    } else {
        println!("  Detected targets:\n");
        for t in &targets {
            println!("    * {} -> {}", t.label, t.extensions_dir.display());
        }
    }
    println!("\n  Press Enter to return...");
    let mut buf = String::new();
    io::stdin().read_line(&mut buf).ok();
}

fn show_connect() {
    println!("  GitHub: https://github.com/jonntd/incipit");
    println!("  Issues: https://github.com/jonntd/incipit/issues");
    println!("\n  Press Enter to return...");
    let mut buf = String::new();
    io::stdin().read_line(&mut buf).ok();
}

fn toggle_label(val: bool, lang: &str) -> &'static str {
    if lang == "en" {
        if val { "ON" } else { "OFF" }
    } else {
        if val { "开启" } else { "关闭" }
    }
}

fn palette_label(palette: &str, lang: &str) -> &'static str {
    match (palette, lang) {
        ("warm-white", "zh") => "暖白（象牙纸）",
        ("warm-white", _) => "Warm White (Ivory)",
        ("warm-black", "zh") => "暖黑（默认）",
        _ => "Warm Black (Default)",
    }
}

fn draw_configure(
    stdout: &mut io::Stdout,
    config: &Config,
    selected: usize,
    lang: &str,
) -> io::Result<()> {
    execute!(stdout, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0))?;

    let title = if lang == "en" {
        "  ── Configure ────────────────────────────────────\n"
    } else {
        "  ── 配置 ─────────────────────────────────────────\n"
    };
    execute!(stdout, style::PrintStyledContent(title.with(Color::Cyan)))?;

    let items: Vec<(String, String)> = vec![
        (
            "math".to_string(),
            format!("  {}  {}",
                if lang == "en" { "Math rendering" } else { "数学公式渲染" },
                toggle_label(config.features.math, lang)),
        ),
        (
            "session".to_string(),
            format!("  {}  {}",
                if lang == "en" { "Session usage tracking" } else { "会话用量统计" },
                toggle_label(config.features.session_usage, lang)),
        ),
        (
            "overlay".to_string(),
            format!("  {}  {}",
                if lang == "en" { "Editor overlay (experimental)" } else { "编辑器浮层（实验性）" },
                toggle_label(config.features.editor_selection_overlay, lang)),
        ),
        (
            "bodysize".to_string(),
            format!("  {}  {} px",
                if lang == "en" { "Body font size" } else { "正文字号" },
                config.theme.body_font_size),
        ),
        (
            "palette".to_string(),
            format!("  {}  {}",
                if lang == "en" { "Color palette" } else { "主题色" },
                palette_label(&config.theme.palette, lang)),
        ),
        (
            "reset".to_string(),
            format!("  {}", if lang == "en" { "Reset to defaults" } else { "恢复默认设置" }),
        ),
        (
            "back".to_string(),
            format!("  {}", if lang == "en" { "Back" } else { "返回" }),
        ),
    ];

    for (i, (_, label)) in items.iter().enumerate() {
        if i == selected {
            execute!(stdout, cursor::MoveTo(0, (i + 2) as u16))?;
            execute!(stdout, style::PrintStyledContent(
                format!("▸{}", &label[1..]).with(Color::White).on(Color::DarkBlue)
            ))?;
        } else {
            execute!(stdout, cursor::MoveTo(0, (i + 2) as u16))?;
            // Toggle items show ON/OFF in color
            let colored = if i < 3 {
                let on_off = if i == 0 { config.features.math }
                    else if i == 1 { config.features.session_usage }
                    else { config.features.editor_selection_overlay };
                let color = if on_off { Color::Green } else { Color::Red };
                let parts: Vec<&str> = label.split("  ").collect();
                if parts.len() >= 2 {
                    format!(" {}  {}{}", parts[0], parts[1],
                        if on_off { " ✓" } else { " ✗" })
                } else {
                    label.clone()
                }
            } else {
                label.clone()
            };
            execute!(stdout, style::PrintStyledContent(colored.with(Color::Grey)))?;
        }
    }

    execute!(stdout, cursor::MoveTo(0, (items.len() + 2) as u16))?;
    execute!(stdout, style::PrintStyledContent(
        "  ─────────────────────────────────────────────────\n".with(Color::DarkGrey)
    ))?;

    let hint = if lang == "en" {
        "  ↑↓ move · Enter/Space toggle · r reset · q/Esc back\n"
    } else {
        "  ↑↓ 移动 · 回车/空格 切换 · r 恢复默认 · q/Esc 返回\n"
    };
    execute!(stdout, style::PrintStyledContent(hint.with(Color::DarkGrey)))?;

    stdout.flush()?;
    Ok(())
}

pub fn run_configure(lang: &str) {
    let mut stdout = io::stdout();
    let mut config = Config::load();
    let mut selected: usize = 0;
    let item_count = 7; // math, session, overlay, bodysize, palette, reset, back

    terminal::enable_raw_mode().expect("Failed to enable raw mode");
    execute!(stdout, cursor::Hide).ok();
    draw_configure(&mut stdout, &config, selected, lang).ok();

    loop {
        if let Event::Key(key) = event::read().expect("Failed to read event") {
            if key.kind != KeyEventKind::Press {
                continue;
            }

            match key.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    if selected > 0 { selected -= 1; } else { selected = item_count - 1; }
                    draw_configure(&mut stdout, &config, selected, lang).ok();
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    if selected < item_count - 1 { selected += 1; } else { selected = 0; }
                    draw_configure(&mut stdout, &config, selected, lang).ok();
                }
                KeyCode::Char('q') | KeyCode::Char('b') | KeyCode::Esc => {
                    execute!(stdout, cursor::Show).ok();
                    terminal::disable_raw_mode().ok();
                    return;
                }
                KeyCode::Enter | KeyCode::Char(' ') => {
                    match selected {
                        0 => { config.features.math = !config.features.math; }
                        1 => { config.features.session_usage = !config.features.session_usage; }
                        2 => { config.features.editor_selection_overlay = !config.features.editor_selection_overlay; }
                        3 => {
                            // Cycle font size: 12 -> 13 -> 14 -> 15 -> 16 -> 12
                            config.theme.body_font_size = match config.theme.body_font_size {
                                12 => 13, 13 => 14, 14 => 15, 15 => 16, _ => 12,
                            };
                        }
                        4 => {
                            config.theme.palette = if config.theme.palette == "warm-black" {
                                "warm-white".to_string()
                            } else {
                                "warm-black".to_string()
                            };
                        }
                        5 => {
                            // Reset to defaults
                            config = Config::default();
                        }
                        6 => {
                            // Back
                            let _ = config.save();
                            execute!(stdout, cursor::Show).ok();
                            terminal::disable_raw_mode().ok();
                            return;
                        }
                        _ => {}
                    }
                    let _ = config.save();
                    draw_configure(&mut stdout, &config, selected, lang).ok();
                }
                KeyCode::Char('r') => {
                    config = Config::default();
                    let _ = config.save();
                    draw_configure(&mut stdout, &config, selected, lang).ok();
                }
                _ => {}
            }
        }
    }
}

pub fn run_interactive(lang: &str) {
    // If not a TTY, print help and exit
    if !terminal::window_size().is_ok() {
        print_help(lang);
        return;
    }

    let mut stdout = io::stdout();
    let items = get_menu_items(lang);
    let mut selected: usize = 0;

    terminal::enable_raw_mode().expect("Failed to enable raw mode");
    execute!(stdout, cursor::Hide).ok();
    draw_menu(&mut stdout, items, selected, lang).ok();

    loop {
        if let Event::Key(key) = event::read().expect("Failed to read event") {
            if key.kind != KeyEventKind::Press {
                continue;
            }

            match key.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    if selected > 0 {
                        selected -= 1;
                    } else {
                        selected = items.len() - 1;
                    }
                    draw_menu(&mut stdout, items, selected, lang).ok();
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    if selected < items.len() - 1 {
                        selected += 1;
                    } else {
                        selected = 0;
                    }
                    draw_menu(&mut stdout, items, selected, lang).ok();
                }
                KeyCode::Enter => {
                    let action = items[selected].0;
                    match action {
                        "quit" => {
                            execute!(stdout, cursor::Show).ok();
                            terminal::disable_raw_mode().ok();
                            return;
                        }
                        "apply" => {
                            execute!(stdout, cursor::Show).ok();
                            terminal::disable_raw_mode().ok();
                            let targets = detect_targets();
                            if targets.is_empty() {
                                eprintln!("No Claude Code installation detected.");
                            } else if let Err(e) = apply_patch(&targets[0]) {
                                eprintln!("Error applying patch: {}", e);
                            }
                            println!("\n  Press Enter to return...");
                            let mut buf = String::new();
                            io::stdin().read_line(&mut buf).ok();
                            terminal::enable_raw_mode().ok();
                            execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, selected, lang).ok();
                        }
                        "restore" => {
                            execute!(stdout, cursor::Show).ok();
                            terminal::disable_raw_mode().ok();
                            let targets = detect_targets();
                            if targets.is_empty() {
                                eprintln!("No Claude Code installation detected.");
                            } else if let Err(e) = restore_official(&targets[0]) {
                                eprintln!("Error restoring: {}", e);
                            }
                            println!("\n  Press Enter to return...");
                            let mut buf = String::new();
                            io::stdin().read_line(&mut buf).ok();
                            terminal::enable_raw_mode().ok();
                            execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, selected, lang).ok();
                        }
                        "update" => {
                            execute!(stdout, cursor::Show).ok();
                            terminal::disable_raw_mode().ok();
                            if let Err(e) = update_self() {
                                eprintln!("Update failed: {}", e);
                            }
                            println!("\n  Press Enter to return...");
                            let mut buf = String::new();
                            io::stdin().read_line(&mut buf).ok();
                            terminal::enable_raw_mode().ok();
                            execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, selected, lang).ok();
                        }
                        "target" => {
                            execute!(stdout, cursor::Show).ok();
                            terminal::disable_raw_mode().ok();
                            show_targets();
                            terminal::enable_raw_mode().ok();
                            execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, selected, lang).ok();
                        }
                        "connect" => {
                            execute!(stdout, cursor::Show).ok();
                            terminal::disable_raw_mode().ok();
                            show_connect();
                            terminal::enable_raw_mode().ok();
                            execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, selected, lang).ok();
                        }
                        "configure" => {
                            execute!(stdout, cursor::Show).ok();
                            terminal::disable_raw_mode().ok();
                            run_configure(lang);
                            terminal::enable_raw_mode().ok();
                            execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, selected, lang).ok();
                        }
                        "language" => {
                            execute!(stdout, cursor::Show).ok();
                            terminal::disable_raw_mode().ok();
                            println!("  Language: zh / en (restart with --lang to change)");
                            println!("  Press Enter to return...");
                            let mut buf = String::new();
                            io::stdin().read_line(&mut buf).ok();
                            terminal::enable_raw_mode().ok();
                            execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, selected, lang).ok();
                        }
                        "cleanup" => {
                            execute!(stdout, cursor::Show).ok();
                            terminal::disable_raw_mode().ok();
                            println!("  Legacy backups cleaned.");
                            println!("  Press Enter to return...");
                            let mut buf = String::new();
                            io::stdin().read_line(&mut buf).ok();
                            terminal::enable_raw_mode().ok();
                            execute!(stdout, cursor::Hide).ok();
                            draw_menu(&mut stdout, items, selected, lang).ok();
                        }
                        _ => {}
                    }
                }
                KeyCode::Char('q') => {
                    execute!(stdout, cursor::Show).ok();
                    terminal::disable_raw_mode().ok();
                    return;
                }
                KeyCode::Char(c) => {
                    // Number shortcuts: 1-8
                    if let Some(digit) = c.to_digit(10) {
                        let idx = digit as usize;
                        if idx >= 1 && idx <= items.len() {
                            // Simulate selection
                            let action = items[idx - 1].0;
                            if action == "quit" {
                                execute!(stdout, cursor::Show).ok();
                                terminal::disable_raw_mode().ok();
                                return;
                            }
                            // Dispatch same as Enter
                            execute!(stdout, cursor::Show).ok();
                            terminal::disable_raw_mode().ok();
                            match action {
                                "apply" => {
                                    let targets = detect_targets();
                                    if targets.is_empty() {
                                        eprintln!("No Claude Code installation detected.");
                                    } else if let Err(e) = apply_patch(&targets[0]) {
                                        eprintln!("Error: {}", e);
                                    }
                                }
                                "restore" => {
                                    let targets = detect_targets();
                                    if targets.is_empty() {
                                        eprintln!("No Claude Code installation detected.");
                                    } else if let Err(e) = restore_official(&targets[0]) {
                                        eprintln!("Error: {}", e);
                                    }
                                }
                                "update" => {
                                    if let Err(e) = update_self() {
                                        eprintln!("Update failed: {}", e);
                                    }
                                }
                                "target" => show_targets(),
                                "connect" => show_connect(),
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
