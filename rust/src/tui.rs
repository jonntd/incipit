use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEventKind},
    execute, queue,
    style::{self, Color, Stylize},
    terminal::{self, ClearType},
};
use std::io::{self, Write};

use crate::config::Config;
use crate::detector::detect_targets;
use crate::installer::{apply_patch, restore_official};
use crate::updater::update_self;

fn terra() -> Color { Color::Rgb { r: 217, g: 119, b: 87 } }
fn ivory() -> Color { Color::Rgb { r: 248, g: 248, b: 246 } }
fn grey()  -> Color { Color::Rgb { r: 152, g: 152, b: 152 } }

fn tw() -> usize { terminal::size().map(|(w, _)| w as usize).unwrap_or(80).min(100).max(60) }
fn pad(s: &str, w: usize) -> String { let l = s.chars().count(); if l >= w { s.to_string() } else { format!("{}{}", " ".repeat((w - l) / 2), s) } }
fn ci() -> String { format!("   {}  ", "›".with(terra()).bold()) }

const MI: &[(&str, &str)] = &[
    ("apply",     "应用界面补丁"), ("restore",   "恢复官方 Claude Code"),
    ("configure", "配置"),         ("update",    "检查新版本 / 自动升级"),
    ("target",    "管理 Claude Code 目标位置"), ("language",  "CLI 界面语言"),
    ("connect",   "Connect us"),   ("cleanup",   "清理旧版备份文件"),
    ("quit",      "退出"),
];
const MI_EN: &[(&str, &str)] = &[
    ("apply",     "Apply interface patch"), ("restore",   "Restore official Claude Code"),
    ("configure", "Configure"),             ("update",    "Check for updates (GitHub Releases)"),
    ("target",    "Manage Claude Code targets"), ("language",  "CLI language"),
    ("connect",   "Connect us"),            ("cleanup",   "Clean legacy backup files"),
    ("quit",      "Quit"),
];
fn its(lang: &str) -> &[(&str, &str)] { match lang { "en" => MI_EN, _ => MI } }

// ── All output through queue! then single flush ──
macro_rules! q { ($s:expr, $($t:tt)*) => { queue!($s, $($t)*).ok(); } }

fn hdr(s: &mut io::Stdout, title: &str, w: usize) {
    let r = "━".repeat(w);
    q!(s, style::PrintStyledContent(pad(&r, w).with(grey())), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent("\n\n".with(grey())), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent(pad("I  ·  N  ·  C  ·  I  ·  P  ·  I  ·  T", w).with(terra()).bold()), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent("\n\n".with(grey())), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent(pad("A frontend rework of the official", w).with(grey()).italic()), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent(pad("Claude Code VS Code extension", w).with(grey()).italic()), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent("\n\n".with(grey())), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent(pad(&format!("version {}", env!("CARGO_PKG_VERSION")), w).with(grey()).italic()), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent("\n\n".with(grey())), cursor::MoveToColumn(0));
    if !title.is_empty() {
        q!(s, style::PrintStyledContent(pad(title, w).with(grey())), cursor::MoveToColumn(0));
        q!(s, style::PrintStyledContent("\n\n".with(grey())), cursor::MoveToColumn(0));
    }
}

fn ftr(s: &mut io::Stdout, hint: &str, w: usize) {
    let r = "━".repeat(w);
    q!(s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent(pad(&r, w).with(grey())), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent(pad(hint, w).with(grey()).italic()), cursor::MoveToColumn(0));
    q!(s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
}

// ── Main menu ──
fn draw_main(s: &mut io::Stdout, items: &[(&str, &str)], sel: usize, lang: &str) {
    let _ = execute!(s, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0));
    let w = tw();
    let i = "      ";

    hdr(s, "", w);

    let tgts = detect_targets();
    if let Some(t) = tgts.first() {
        q!(s, cursor::MoveToColumn(0));
        q!(s, style::PrintStyledContent(i.to_string().with(grey())));
        q!(s, style::PrintStyledContent("Target     ".with(grey())));
        q!(s, style::PrintStyledContent(t.label.clone().with(ivory())));
        q!(s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
        let en = t.extensions_dir.file_name().unwrap_or_default().to_string_lossy();
        q!(s, cursor::MoveToColumn(0));
        q!(s, style::PrintStyledContent(i.to_string().with(grey())));
        q!(s, style::PrintStyledContent("Extension  ".with(grey())));
        q!(s, style::PrintStyledContent(en.to_string().with(grey())));
        q!(s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
    } else {
        q!(s, cursor::MoveToColumn(0));
        q!(s, style::PrintStyledContent(i.to_string().with(grey())));
        q!(s, style::PrintStyledContent("Target     ".with(grey())));
        q!(s, style::PrintStyledContent("(no Claude Code detected)\n".with(grey()).italic()), cursor::MoveToColumn(0));
    }
    q!(s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));

    for (idx, (_, label)) in items.iter().enumerate() {
        let mark = format!("{}.", idx + 1);
        q!(s, cursor::MoveToColumn(0));
        if idx == sel {
            q!(s, style::PrintStyledContent("   ".with(grey())));
            q!(s, style::PrintStyledContent("›".with(terra()).bold()));
            q!(s, style::PrintStyledContent("  ".with(grey())));
        } else {
            q!(s, style::PrintStyledContent(i.to_string().with(grey())));
        }
        q!(s, style::PrintStyledContent(format!("{:<4}", mark).with(terra())));
        q!(s, style::PrintStyledContent(label.to_string().with(ivory())));
        q!(s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
    }

    let hint = if lang == "en" { "↑↓ navigate  ·  Enter confirm  ·  q quit" } else { "↑↓ 导航  ·  回车 确认  ·  q 退出" };
    ftr(s, hint, w);
    s.flush().ok();
}

// ── Configure ──
fn draw_cfg(s: &mut io::Stdout, c: &Config, sel: usize, lang: &str) {
    let _ = execute!(s, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0));
    let w = tw();
    let i = "      ";

    hdr(s, if lang == "en" { "Configure" } else { "配置" }, w);

    let on = if lang == "en" { "ON" } else { "开启" };
    let off = if lang == "en" { "OFF" } else { "关闭" };

    let rows: Vec<(bool, &str, &str, String)> = vec![
        (true,  "1.", if lang == "en" { "Math rendering" } else { "数学公式渲染" }, if c.features.math { on.into() } else { off.into() }),
        (true,  "2.", if lang == "en" { "Session usage" } else { "会话用量统计" }, if c.features.session_usage { on.into() } else { off.into() }),
        (true,  "3.", if lang == "en" { "Editor overlay" } else { "编辑器浮层" }, if c.features.editor_selection_overlay { on.into() } else { off.into() }),
        (false, "4.", if lang == "en" { "Body font size" } else { "正文字号" }, format!("{} px", c.theme.body_font_size)),
        (false, "5.", if lang == "en" { "Color palette" } else { "主题色" }, if c.theme.palette == "warm-white" { if lang == "en" { "Warm White" } else { "暖白" }.into() } else { if lang == "en" { "Warm Black" } else { "暖黑" }.into() }),
        (false, "", "", "".into()),
        (false, "", "", "".into()),
        (false, "r.", if lang == "en" { "Reset to defaults" } else { "恢复默认设置" }, "".into()),
        (false, "b.", if lang == "en" { "Back" } else { "返回" }, "".into()),
    ];

    for (idx, (is_toggle, mark, label, val)) in rows.iter().enumerate() {
        if mark.is_empty() { continue; }
        q!(s, cursor::MoveToColumn(0));
        if idx == sel {
            q!(s, style::PrintStyledContent("   ".with(grey())));
            q!(s, style::PrintStyledContent("›".with(terra()).bold()));
            q!(s, style::PrintStyledContent("  ".with(grey())));
        } else {
            q!(s, style::PrintStyledContent(i.to_string().with(grey())));
        }
        q!(s, style::PrintStyledContent(format!("{:<4}", mark).with(terra())));
        if *is_toggle {
            let g = if (idx == 0 && c.features.math) || (idx == 1 && c.features.session_usage) || (idx == 2 && c.features.editor_selection_overlay) { "✓" } else { "✗" };
            let gc = if g == "✓" { terra() } else { grey() };
            q!(s, style::PrintStyledContent(format!("{:<4}", g).with(gc)));
            q!(s, style::PrintStyledContent(label.to_string().with(ivory())));
        } else {
            q!(s, style::PrintStyledContent(format!("{:<22}", label).with(ivory())));
            q!(s, style::PrintStyledContent(val.clone().with(ivory())));
        }
        q!(s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
    }

    let hint = if lang == "en" { "↑↓ move  ·  Enter toggle  ·  r reset  ·  b back" } else { "↑↓ 移动  ·  回车 切换  ·  r 恢复默认  ·  b 返回" };
    ftr(s, hint, w);
    s.flush().ok();
}

pub fn run_configure(lang: &str) {
    let mut s = io::stdout();
    let mut c = Config::load();
    let mut sel: usize = 0;
    terminal::enable_raw_mode().expect("raw mode");
    draw_cfg(&mut s, &c, sel, lang);
    loop {
        if let Event::Key(k) = event::read().expect("read") {
            if k.kind != KeyEventKind::Press { continue; }
            match k.code {
                KeyCode::Up | KeyCode::Char('k') => { sel = if sel > 0 { sel - 1 } else { 8 }; draw_cfg(&mut s, &c, sel, lang); }
                KeyCode::Down | KeyCode::Char('j') => { sel = if sel < 8 { sel + 1 } else { 0 }; draw_cfg(&mut s, &c, sel, lang); }
                KeyCode::Char('q') | KeyCode::Char('b') | KeyCode::Esc => { execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                KeyCode::Enter | KeyCode::Char(' ') => {
                    match sel {
                        0 => c.features.math = !c.features.math,
                        1 => c.features.session_usage = !c.features.session_usage,
                        2 => c.features.editor_selection_overlay = !c.features.editor_selection_overlay,
                        3 => c.theme.body_font_size = match c.theme.body_font_size { 12 => 13, 13 => 14, 14 => 15, 15 => 16, _ => 12 },
                        4 => c.theme.palette = if c.theme.palette == "warm-black" { "warm-white".into() } else { "warm-black".into() },
                        7 => c = Config::default(),
                        8 => { let _ = c.save(); execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                        _ => {}
                    }
                    let _ = c.save();
                    draw_cfg(&mut s, &c, sel, lang);
                }
                KeyCode::Char('r') => { c = Config::default(); let _ = c.save(); draw_cfg(&mut s, &c, sel, lang); }
                _ => {}
            }
        }
    }
}

// ── Targets ──
fn run_tgt(lang: &str) {
    let mut s = io::stdout();
    let mut tgts = detect_targets();
    let mut sel: usize = 0;
    let acts: Vec<(&str, &str)> = vec![
        ("a.", if lang == "en" { "Add target" } else { "添加目标" }),
        ("s.", if lang == "en" { "Deep scan" } else { "深度扫描" }),
        ("d.", if lang == "en" { "Remove target" } else { "删除目标" }),
        ("b.", if lang == "en" { "Back" } else { "返回" }),
    ];
    terminal::enable_raw_mode().ok();

    loop {
        let _ = execute!(&mut s, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0));
        let w = tw();
        let i = "      ";

        hdr(&mut s, if lang == "en" { "Manage Targets" } else { "管理目标位置" }, w);

        let sub = if lang == "en" { "Detected targets:" } else { "已检测到的目标：" };
        q!(&mut s, cursor::MoveToColumn(0));
        q!(&mut s, style::PrintStyledContent(format!("{}{}", i, sub).with(grey())));
        q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
        q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));

        if tgts.is_empty() {
            let m = if lang == "en" { "No Claude Code installation detected." } else { "未检测到 Claude Code 安装。" };
            q!(&mut s, cursor::MoveToColumn(0));
            q!(&mut s, style::PrintStyledContent(format!("{}{}", i, m).with(grey()).italic()));
            q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
        } else {
            for t in &tgts {
                let en = t.extensions_dir.file_name().unwrap_or_default().to_string_lossy();
                q!(&mut s, cursor::MoveToColumn(0));
                q!(&mut s, style::PrintStyledContent(format!("{}{}", i, t.label).with(ivory())));
                q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
                q!(&mut s, cursor::MoveToColumn(0));
                q!(&mut s, style::PrintStyledContent(format!("        {}", en).with(grey()).italic()));
                q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
            }
        }

        let sep = "─".repeat(w.saturating_sub(8));
        q!(&mut s, cursor::MoveToColumn(0));
        q!(&mut s, style::PrintStyledContent(format!("{}{}", i, sep).with(grey())));
        q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
        q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));

        for (idx, (mark, label)) in acts.iter().enumerate() {
            q!(&mut s, cursor::MoveToColumn(0));
            if idx == sel {
                q!(&mut s, style::PrintStyledContent("   ".with(grey())));
                q!(&mut s, style::PrintStyledContent("›".with(terra()).bold()));
                q!(&mut s, style::PrintStyledContent("  ".with(grey())));
            } else {
                q!(&mut s, style::PrintStyledContent(i.to_string().with(grey())));
            }
            q!(&mut s, style::PrintStyledContent(format!("{:<4}", mark).with(terra())));
            q!(&mut s, style::PrintStyledContent(label.to_string().with(ivory())));
            q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
        }

        let hint = if lang == "en" { "↑↓ navigate  ·  Enter select  ·  b back" } else { "↑↓ 导航  ·  回车 确认  ·  b 返回" };
        ftr(&mut s, hint, w);
        s.flush().ok();

        if let Event::Key(k) = event::read().expect("read") {
            if k.kind != KeyEventKind::Press { continue; }
            match k.code {
                KeyCode::Up | KeyCode::Char('k') => { sel = if sel > 0 { sel - 1 } else { acts.len() - 1 }; }
                KeyCode::Down | KeyCode::Char('j') => { sel = if sel < acts.len() - 1 { sel + 1 } else { 0 }; }
                KeyCode::Enter => { match sel { 1 => tgts = detect_targets(), 3 => { execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; } _ => {} } }
                KeyCode::Char('q') | KeyCode::Esc | KeyCode::Char('b') => { execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                _ => {}
            }
        }
    }
}

// ── Language ──
fn run_lang(lang: &str) {
    let mut s = io::stdout();
    let opts = vec!["中文", "English"];
    let mut sel: usize = if lang == "en" { 1 } else { 0 };
    terminal::enable_raw_mode().ok();

    loop {
        let _ = execute!(&mut s, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0));
        let w = tw();
        let i = "      ";

        hdr(&mut s, if lang == "en" { "CLI Language" } else { "CLI 界面语言" }, w);
        q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));

        for (idx, label) in opts.iter().enumerate() {
            let mark = format!("{}.", idx + 1);
            q!(&mut s, cursor::MoveToColumn(0));
            if idx == sel {
                q!(&mut s, style::PrintStyledContent("   ".with(grey())));
                q!(&mut s, style::PrintStyledContent("›".with(terra()).bold()));
                q!(&mut s, style::PrintStyledContent("  ".with(grey())));
            } else {
                q!(&mut s, style::PrintStyledContent(i.to_string().with(grey())));
            }
            q!(&mut s, style::PrintStyledContent(format!("{:<4}", mark).with(terra())));
            q!(&mut s, style::PrintStyledContent(label.to_string().with(ivory())));
            q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
        }

        let hint = if lang == "en" { "↑↓ move  ·  Enter select  ·  b back" } else { "↑↓ 移动  ·  回车 确认  ·  b 返回" };
        ftr(&mut s, hint, w);
        s.flush().ok();

        if let Event::Key(k) = event::read().expect("read") {
            if k.kind != KeyEventKind::Press { continue; }
            match k.code {
                KeyCode::Up | KeyCode::Char('k') => { sel = if sel > 0 { sel - 1 } else { opts.len() - 1 }; }
                KeyCode::Down | KeyCode::Char('j') => { sel = if sel < opts.len() - 1 { sel + 1 } else { 0 }; }
                KeyCode::Enter => {
                    let nl = if sel == 0 { "zh" } else { "en" };
                    let mut cf = Config::load(); cf.language = nl.to_string(); let _ = cf.save();
                    execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                    std::process::Command::new(std::env::current_exe().unwrap()).arg("--lang").arg(nl).spawn().ok();
                    std::process::exit(0);
                }
                KeyCode::Char('q') | KeyCode::Esc | KeyCode::Char('b') => { execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                _ => {}
            }
        }
    }
}

// ── Cleanup ──
fn run_clean(lang: &str) {
    let bd = dirs::home_dir().map(|h| h.join(".incipit-backup"));
    let rd = dirs::home_dir().map(|h| h.join(".incipit").join("official-restore-points-v1"));
    let (mut tb, mut tf, mut td) = (0u64, 0u64, 0u64);
    for d in bd.iter().chain(rd.iter()) {
        if d.exists() { for e in std::fs::read_dir(d).into_iter().flatten() { if let Ok(e) = e { if let Some(m) = e.metadata().ok() { tb += m.len(); if m.is_dir() { td += 1 } else { tf += 1 } } } } }
    }
    let ss = if tb > 1_048_576 { format!("{:.1} MB", tb as f64 / 1_048_576.0) } else if tb > 1024 { format!("{:.1} KB", tb as f64 / 1024.0) } else { format!("{} B", tb) };
    if lang == "en" {
        println!("\n  Clean Legacy Backups\n");
        if let Some(ref p) = bd { println!("  Backup root: {}", p.display()); }
        println!("  Files: {}  Dirs: {}  Size: {}", tf, td, ss);
    } else {
        println!("\n  清理旧版备份文件\n");
        if let Some(ref p) = bd { println!("  备份目录: {}", p.display()); }
        println!("  文件: {}  目录: {}  大小: {}", tf, td, ss);
    }
    if tb == 0 {
        println!("{}", if lang == "en" { "\n  No legacy backups found." } else { "\n  未发现旧版备份文件。" });
    } else {
        print!("{}", if lang == "en" { "\n  Delete all? [y/N] " } else { "\n  确认删除？[y/N] " });
        io::stdout().flush().ok();
        let mut input = String::new(); io::stdin().read_line(&mut input).ok();
        if input.trim().eq_ignore_ascii_case("y") {
            for d in bd.iter().chain(rd.iter()) { if d.exists() { let _ = std::fs::remove_dir_all(d); } }
            println!("{}", if lang == "en" { "  ✅ Done." } else { "  ✅ 已清理。" });
        } else { println!("{}", if lang == "en" { "  Cancelled." } else { "  已取消。" }); }
    }
    println!("\n  Press Enter to return...");
    let mut buf = String::new(); io::stdin().read_line(&mut buf).ok();
}

// ── Target picker ──
fn pick_target(lang: &str) -> Option<crate::detector::TargetLocation> {
    let tgts = detect_targets();
    if tgts.is_empty() { return None; }
    if tgts.len() == 1 { return Some(tgts[0].clone()); }

    let mut s = io::stdout();
    let mut sel: usize = 0;
    terminal::enable_raw_mode().ok();

    loop {
        let _ = execute!(&mut s, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0));
        let w = tw();
        let i = "      ";

        hdr(&mut s, if lang == "en" { "Select Target" } else { "选择目标" }, w);
        let sub = if lang == "en" { "Multiple Claude Code installations found:" } else { "检测到多个 Claude Code 安装：" };
        q!(&mut s, cursor::MoveToColumn(0));
        q!(&mut s, style::PrintStyledContent(format!("{}{}", i, sub).with(grey())));
        q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
        q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));

        for (idx, t) in tgts.iter().enumerate() {
            q!(&mut s, cursor::MoveToColumn(0));
            if idx == sel {
                q!(&mut s, style::PrintStyledContent("   ".with(grey())));
                q!(&mut s, style::PrintStyledContent("›".with(terra()).bold()));
                q!(&mut s, style::PrintStyledContent("  ".with(grey())));
            } else {
                q!(&mut s, style::PrintStyledContent(i.to_string().with(grey())));
            }
            q!(&mut s, style::PrintStyledContent(format!("{:<4}", format!("{}.", idx + 1)).with(terra())));
            q!(&mut s, style::PrintStyledContent(t.label.clone().with(ivory())));
            q!(&mut s, style::PrintStyledContent("\n".with(grey())), cursor::MoveToColumn(0));
        }

        let hint = if lang == "en" { "↑↓ navigate  ·  Enter select  ·  b cancel" } else { "↑↓ 导航  ·  回车 确认  ·  b 取消" };
        ftr(&mut s, hint, w);
        s.flush().ok();

        if let Event::Key(k) = event::read().expect("read") {
            if k.kind != KeyEventKind::Press { continue; }
            match k.code {
                KeyCode::Up | KeyCode::Char('k') => { sel = if sel > 0 { sel - 1 } else { tgts.len() - 1 }; }
                KeyCode::Down | KeyCode::Char('j') => { sel = if sel < tgts.len() - 1 { sel + 1 } else { 0 }; }
                KeyCode::Enter => {
                    execute!(&mut s, cursor::Show).ok();
                    terminal::disable_raw_mode().ok();
                    return Some(tgts[sel].clone());
                }
                KeyCode::Char('q') | KeyCode::Esc | KeyCode::Char('b') => {
                    execute!(&mut s, cursor::Show).ok();
                    terminal::disable_raw_mode().ok();
                    return None;
                }
                _ => {}
            }
        }
    }
}

// ── Main ──
pub fn run_interactive(lang: &str) {
    if !terminal::window_size().is_ok() {
        if lang == "en" {
            println!("  incipit  A frontend rework of the official Claude Code VS Code extension\n");
            println!("  Usage:\n    incipit              Launch interactive menu\n    incipit apply        Apply interface patch");
            println!("    incipit restore      Restore official Claude Code\n    incipit update       Check for updates");
            println!("    incipit list-targets List targets\n    incipit clean-backups Clean backups");
        } else {
            println!("  incipit  Claude Code VS Code 扩展前端重绘\n");
            println!("  用法:\n    incipit              启动交互式菜单\n    incipit apply        应用界面补丁");
            println!("    incipit restore      恢复官方 Claude Code\n    incipit update       检查新版本 / 自动升级");
            println!("    incipit list-targets 列出所有已知目标\n    incipit clean-backups 清理旧版备份文件");
        }
        return;
    }
    let mut s = io::stdout();
    let items = its(lang);
    let mut sel: usize = 0;
    terminal::enable_raw_mode().expect("raw mode");
    execute!(&mut s, cursor::Hide).ok();
    draw_main(&mut s, items, sel, lang);

    loop {
        if let Event::Key(k) = event::read().expect("read") {
            if k.kind != KeyEventKind::Press { continue; }
            match k.code {
                KeyCode::Up | KeyCode::Char('k') => { sel = if sel > 0 { sel - 1 } else { items.len() - 1 }; draw_main(&mut s, items, sel, lang); }
                KeyCode::Down | KeyCode::Char('j') => { sel = if sel < items.len() - 1 { sel + 1 } else { 0 }; draw_main(&mut s, items, sel, lang); }
                KeyCode::Enter => {
                    let a = items[sel].0;
                    match a {
                        "quit" => { execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                        "apply" => {
                            execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            let tg = detect_targets();
                            if tg.is_empty() { eprintln!("\n  ⚠  No Claude Code detected.\n"); }
                            else if let Some(target) = pick_target(lang) {
                                eprintln!("\n  ⏳ Applying to {}...", target.label);
                                match apply_patch(&target) { Ok(()) => eprintln!("  ✅ Done!\n"), Err(e) => eprintln!("  ❌ {}\n", e) }
                            }
                            eprintln!("  Press Enter..."); let mut b = String::new(); io::stdin().read_line(&mut b).ok();
                            terminal::enable_raw_mode().ok(); execute!(&mut s, cursor::Hide).ok(); draw_main(&mut s, items, sel, lang);
                        }
                        "restore" => {
                            execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            let tg = detect_targets();
                            if tg.is_empty() { eprintln!("\n  ⚠  No Claude Code detected.\n"); }
                            else { eprintln!("\n  ⏳ Restoring {}...", tg[0].label); match restore_official(&tg[0]) { Ok(()) => eprintln!("  ✅ Done!\n"), Err(e) => eprintln!("  ❌ {}\n", e) } }
                            eprintln!("  Press Enter..."); let mut b = String::new(); io::stdin().read_line(&mut b).ok();
                            terminal::enable_raw_mode().ok(); execute!(&mut s, cursor::Hide).ok(); draw_main(&mut s, items, sel, lang);
                        }
                        "update" => {
                            execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            eprintln!("\n  ⏳ Checking...");
                            match update_self() { Ok(()) => {} Err(e) => { eprintln!("  ❌ {}\n", e); eprintln!("  Press Enter..."); let mut b = String::new(); io::stdin().read_line(&mut b).ok(); } }
                            terminal::enable_raw_mode().ok(); execute!(&mut s, cursor::Hide).ok(); draw_main(&mut s, items, sel, lang);
                        }
                        "configure" => {
                            execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok(); run_configure(lang);
                            terminal::enable_raw_mode().ok(); execute!(&mut s, cursor::Hide).ok(); draw_main(&mut s, items, sel, lang);
                        }
                        "target" => {
                            execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok(); run_tgt(lang);
                            terminal::enable_raw_mode().ok(); execute!(&mut s, cursor::Hide).ok(); draw_main(&mut s, items, sel, lang);
                        }
                        "language" => {
                            execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok(); run_lang(lang);
                            terminal::enable_raw_mode().ok(); execute!(&mut s, cursor::Hide).ok(); draw_main(&mut s, items, sel, lang);
                        }
                        "connect" => {
                            execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            println!("\n  GitHub: https://github.com/jonntd/incipit\n  Issues: https://github.com/jonntd/incipit/issues\n");
                            println!("  Press Enter..."); let mut b = String::new(); io::stdin().read_line(&mut b).ok();
                            terminal::enable_raw_mode().ok(); execute!(&mut s, cursor::Hide).ok(); draw_main(&mut s, items, sel, lang);
                        }
                        "cleanup" => {
                            execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok(); run_clean(lang);
                            terminal::enable_raw_mode().ok(); execute!(&mut s, cursor::Hide).ok(); draw_main(&mut s, items, sel, lang);
                        }
                        _ => {}
                    }
                }
                KeyCode::Char('q') => { execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                KeyCode::Char(c) => {
                    if let Some(d) = c.to_digit(10) {
                        let idx = d as usize;
                        if idx >= 1 && idx <= items.len() {
                            let a = items[idx - 1].0;
                            if a == "quit" { execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok(); return; }
                            execute!(&mut s, cursor::Show).ok(); terminal::disable_raw_mode().ok();
                            match a {
                                "apply" => { let tg = detect_targets(); if tg.is_empty() { eprintln!("\n  ⚠  No Claude Code detected.\n"); } else if let Some(target) = pick_target(lang) { eprintln!("\n  ⏳ Applying to {}...", target.label); match apply_patch(&target) { Ok(()) => eprintln!("  ✅ Done!\n"), Err(e) => eprintln!("  ❌ {}\n", e) } } }
                                "restore" => { let tg = detect_targets(); if tg.is_empty() { eprintln!("\n  ⚠  No Claude Code detected.\n"); } else { eprintln!("\n  ⏳ Restoring..."); match restore_official(&tg[0]) { Ok(()) => eprintln!("  ✅ Done!\n"), Err(e) => eprintln!("  ❌ {}\n", e) } } }
                                "update" => { eprintln!("\n  ⏳ Checking..."); if let Err(e) = update_self() { eprintln!("  ❌ {}\n", e); } }
                                "target" => run_tgt(lang),
                                "cleanup" => run_clean(lang),
                                "language" => run_lang(lang),
                                "connect" => { println!("\n  GitHub: https://github.com/jonntd/incipit\n  Issues: https://github.com/jonntd/incipit/issues\n"); }
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
