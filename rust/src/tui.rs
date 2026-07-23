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

fn tw() -> usize { terminal::size().map(|(w, _)| w as usize).unwrap_or(80).min(100).max(60) }

fn center(text: &str, width: usize) -> String {
    let len = text.chars().count();
    let p = if len >= width { 0 } else { (width - len) / 2 };
    format!("{}{}", " ".repeat(p), text)
}

fn rule_line(w: usize) -> String { "━".repeat(w) }
fn cursor_ind() -> String { format!("   {}  ", "›".with(terra()).bold()) }

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
fn items(lang: &str) -> &[(&str, &str)] { match lang { "en" => MI_EN, _ => MI } }

fn help(lang: &str) {
    if lang == "en" {
        println!("  incipit  A frontend rework of the official Claude Code VS Code extension\n");
        println!("  Usage:\n    incipit              Launch interactive menu");
        println!("    incipit apply        Apply interface patch\n    incipit restore      Restore official Claude Code");
        println!("    incipit update       Check for updates\n    incipit list-targets List every known Claude Code target");
        println!("    incipit clean-backups Clean legacy backup files");
    } else {
        println!("  incipit  Claude Code VS Code 扩展前端重绘\n");
        println!("  用法:\n    incipit              启动交互式菜单");
        println!("    incipit apply        应用界面补丁\n    incipit restore      恢复官方 Claude Code");
        println!("    incipit update       检查新版本 / 自动升级\n    incipit list-targets 列出所有已知 Claude Code 目标");
        println!("    incipit clean-backups 清理旧版备份文件");
    }
}

// ── Sequential render helpers ──
fn hdr(s: &mut io::Stdout, title: &str, w: usize) {
    let r = rule_line(w);
    let _ = execute!(s, style::PrintStyledContent(format!("{}\n\n", center(&r, w)).with(grey())));
    let _ = execute!(s, style::PrintStyledContent(format!("{}\n\n", center("I  ·  N  ·  C  ·  I  ·  P  ·  I  ·  T", w)).with(terra()).bold()));
    let _ = execute!(s, style::PrintStyledContent(format!("{}\n", center("A frontend rework of the official", w)).with(grey()).italic()));
    let _ = execute!(s, style::PrintStyledContent(format!("{}\n", center("Claude Code VS Code extension", w)).with(grey()).italic()));
    let _ = execute!(s, style::PrintStyledContent(format!("\n{}\n\n", center(&format!("version {}", env!("CARGO_PKG_VERSION")), w)).with(grey()).italic()));
    if !title.is_empty() { let _ = execute!(s, style::PrintStyledContent(format!("{}\n", center(title, w)).with(grey()))); }
    let _ = execute!(s, style::PrintStyledContent("\n\n".with(grey())));
}

fn ftr(s: &mut io::Stdout, hint: &str, w: usize) {
    let r = rule_line(w);
    let _ = execute!(s, style::PrintStyledContent(format!("\n{}\n", center(&r, w)).with(grey())));
    let _ = execute!(s, style::PrintStyledContent(format!("{}\n", center(hint, w)).with(grey()).italic()));
}

// ── Main menu ──
fn draw(s: &mut io::Stdout, its: &[(&str, &str)], sel: usize, lang: &str) {
    let _ = execute!(s, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0));
    let w = tw(); let ind = "      ";
    hdr(s, "", w);
    let tgts = detect_targets();
    if let Some(t) = tgts.first() {
        let _ = execute!(s, style::PrintStyledContent(format!("{}{}{}\n", ind, pad("Target", 12), t.label).with(ivory())));
        let en = t.extensions_dir.file_name().unwrap_or_default().to_string_lossy();
        let _ = execute!(s, style::PrintStyledContent(format!("{}{}{}\n", ind, pad("Extension", 12), en).with(ivory())));
    } else {
        let _ = execute!(s, style::PrintStyledContent(format!("{}{}{}\n", ind, pad("Target", 12), "(no Claude Code detected)").with(grey()).italic()));
    }
    let _ = execute!(s, style::PrintStyledContent("\n".with(grey())));
    for (i, (_, l)) in its.iter().enumerate() {
        let m = format!("{}.", i + 1);
        let lead = if i == sel { cursor_ind() } else { ind.to_string() };
        let _ = execute!(s, style::PrintStyledContent(format!("{}{}{}\n", lead, pad(&m, MARK_COL).with(terra()), l).with(ivory())));
    }
    let h = if lang == "en" { "↑↓ navigate  ·  Enter confirm  ·  q quit" } else { "↑↓ 导航  ·  回车 确认  ·  q 退出" };
    ftr(s, h, w);
    let _ = s.flush();
}

// ── Configure ──
fn draw_cfg(s: &mut io::Stdout, c: &Config, sel: usize, lang: &str) {
    let _ = execute!(s, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0));
    let w = tw(); let ind = "      ";
    hdr(s, if lang == "en" { "Configure" } else { "配置" }, w);
    let on = if lang == "en" { "ON" } else { "开启" };
    let off = if lang == "en" { "OFF" } else { "关闭" };
    let lbl = |i: usize| -> (&'static str, &'static str) {
        match i { 0 => ("1.", if lang == "en" { "Math rendering" } else { "数学公式渲染" }),
            1 => ("2.", if lang == "en" { "Session usage" } else { "会话用量统计" }),
            2 => ("3.", if lang == "en" { "Editor overlay" } else { "编辑器浮层" }),
            3 => ("4.", if lang == "en" { "Body font size" } else { "正文字号" }),
            4 => ("5.", if lang == "en" { "Color palette" } else { "主题色" }),
            7 => ("r.", if lang == "en" { "Reset to defaults" } else { "恢复默认设置" }),
            8 => ("b.", if lang == "en" { "Back" } else { "返回" }),
            _ => ("", "")
        }
    };
    for i in 0..9 {
        let (m, l) = lbl(i);
        if m.is_empty() { continue; }
        let lead = if i == sel { cursor_ind() } else { ind.to_string() };
        if i < 3 {
            let g = if (i == 0 && c.features.math) || (i == 1 && c.features.session_usage) || (i == 2 && c.features.editor_selection_overlay) { "✓" } else { "✗" };
            let gc = if g == "✓" { terra() } else { grey() };
            let _ = execute!(s, style::PrintStyledContent(format!("{}{}{}{}\n", lead, pad(m, MARK_COL).with(terra()), pad(g, CHECK_COL).with(gc), l).with(ivory())));
        } else if i < 7 {
            let v = match i { 3 => format!("{} px", c.theme.body_font_size),
                4 => if c.theme.palette == "warm-white" { if lang == "en" { "Warm White" } else { "暖白" }.to_string() } else { if lang == "en" { "Warm Black" } else { "暖黑" }.to_string() },
                _ => "".to_string() };
            let _ = execute!(s, style::PrintStyledContent(format!("{}{}", lead, pad(m, MARK_COL)).with(terra())));
            let _ = execute!(s, style::PrintStyledContent(format!("{}{}", " ".repeat(CHECK_COL), pad(l, LABEL_COL)).with(ivory())));
            let _ = execute!(s, style::PrintStyledContent(format!("{}\n", v).with(ivory())));
        } else {
            let _ = execute!(s, style::PrintStyledContent(format!("{}{}{}\n", lead, pad(m, MARK_COL).with(terra()), l).with(ivory())));
        }
    }
    let h = if lang == "en" { "↑↓ move  ·  Enter toggle  ·  r reset  ·  b back" } else { "↑↓ 移动  ·  回车 切换  ·  r 恢复默认  ·  b 返回" };
    ftr(s, h, w);
    let _ = s.flush();
}

pub fn run_configure(lang: &str) {
    let mut s = io::stdout();
    let mut c = Config::load();
    let mut sel: usize = 0;
    terminal::enable_raw_mode().expect("raw mode");
    let _ = execute!(s, cursor::Hide);
    draw_cfg(&mut s, &c, sel, lang);
    loop {
        if let Event::Key(k) = event::read().expect("read") {
            if k.kind != KeyEventKind::Press { continue; }
            match k.code {
                KeyCode::Up | KeyCode::Char('k') => { sel = if sel > 0 { sel-1 } else { 8 }; draw_cfg(&mut s, &c, sel, lang); }
                KeyCode::Down | KeyCode::Char('j') => { sel = if sel < 8 { sel+1 } else { 0 }; draw_cfg(&mut s, &c, sel, lang); }
                KeyCode::Char('q')|KeyCode::Char('b')|KeyCode::Esc => { let _=execute!(s,cursor::Show); terminal::disable_raw_mode().ok(); return; }
                KeyCode::Enter|KeyCode::Char(' ') => {
                    match sel { 0=>c.features.math=!c.features.math, 1=>c.features.session_usage=!c.features.session_usage,
                        2=>c.features.editor_selection_overlay=!c.features.editor_selection_overlay,
                        3=>c.theme.body_font_size=match c.theme.body_font_size{12=>13,13=>14,14=>15,15=>16,_=>12},
                        4=>c.theme.palette=if c.theme.palette=="warm-black"{"warm-white".into()}else{"warm-black".into()},
                        7=>c=Config::default(),
                        8=>{let _=c.save();let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();return;}
                        _=>{} }
                    let _=c.save(); draw_cfg(&mut s, &c, sel, lang);
                }
                KeyCode::Char('r')=>{c=Config::default();let _=c.save();draw_cfg(&mut s,&c,sel,lang);}
                _=>{}
            }
        }
    }
}

// ── Targets ──
fn run_tgt(lang: &str) {
    let mut s = io::stdout();
    let mut tgts = detect_targets();
    let mut sel: usize = 0;
    let acts: Vec<(&str,&str)> = vec![("a.",if lang=="en"{"Add target"}else{"添加目标"}),("s.",if lang=="en"{"Deep scan"}else{"深度扫描"}),
        ("d.",if lang=="en"{"Remove target"}else{"删除目标"}),("b.",if lang=="en"{"Back"}else{"返回"})];
    terminal::enable_raw_mode().ok(); let _=execute!(s,cursor::Hide);
    loop {
        let _=execute!(s,terminal::Clear(ClearType::All),cursor::MoveTo(0,0));
        let w=tw(); let ind="      ";
        hdr(&mut s,if lang=="en"{"Manage Targets"}else{"管理目标位置"},w);
        let sub=if lang=="en"{"Detected targets:"}else{"已检测到的目标："};
        let _=execute!(s,style::PrintStyledContent(format!("{}{}\n",ind,sub).with(grey())));
        let _=execute!(s,style::PrintStyledContent("\n".with(grey())));
        if tgts.is_empty() {
            let m=if lang=="en"{"No Claude Code installation detected."}else{"未检测到 Claude Code 安装。"};
            let _=execute!(s,style::PrintStyledContent(format!("{}{}\n",ind,m).with(grey()).italic()));
        } else {
            for t in &tgts {
                let en=t.extensions_dir.file_name().unwrap_or_default().to_string_lossy();
                let _=execute!(s,style::PrintStyledContent(format!("{}{}\n",ind,t.label).with(ivory())));
                let _=execute!(s,style::PrintStyledContent(format!("        {}\n",en).with(grey()).italic()));
            }
        }
        let _=execute!(s,style::PrintStyledContent(format!("{}{}\n",ind,"─".repeat(w.saturating_sub(ind.len()+2))).with(grey())));
        let _=execute!(s,style::PrintStyledContent("\n".with(grey())));
        for (i,(m,l)) in acts.iter().enumerate() {
            let lead=if i==sel{cursor_ind()}else{ind.to_string()};
            let _=execute!(s,style::PrintStyledContent(format!("{}{}{}\n",lead,pad(m,MARK_COL).with(terra()),l).with(ivory())));
        }
        let h=if lang=="en"{"↑↓ navigate  ·  Enter select  ·  b back"}else{"↑↓ 导航  ·  回车 确认  ·  b 返回"};
        ftr(&mut s,h,w); let _=s.flush();
        if let Event::Key(k)=event::read().expect("read") {
            if k.kind!=KeyEventKind::Press{continue;}
            match k.code {
                KeyCode::Up|KeyCode::Char('k')=>{sel=if sel>0{sel-1}else{acts.len()-1};}
                KeyCode::Down|KeyCode::Char('j')=>{sel=if sel<acts.len()-1{sel+1}else{0};}
                KeyCode::Enter=>{match sel{1=>tgts=detect_targets(),3=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();return;}_=>{}}}
                KeyCode::Char('q')|KeyCode::Esc|KeyCode::Char('b')=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();return;}
                _=>{}
            }
        }
    }
}

// ── Language ──
fn run_lang(lang: &str) {
    let mut s = io::stdout();
    let opts=vec!["中文","English"];
    let mut sel:usize=if lang=="en"{1}else{0};
    terminal::enable_raw_mode().ok(); let _=execute!(s,cursor::Hide);
    loop {
        let _=execute!(s,terminal::Clear(ClearType::All),cursor::MoveTo(0,0));
        let w=tw(); let ind="      ";
        hdr(&mut s,if lang=="en"{"CLI Language"}else{"CLI 界面语言"},w);
        let _=execute!(s,style::PrintStyledContent("\n".with(grey())));
        for (i,l) in opts.iter().enumerate() {
            let m=format!("{}.",i+1);
            let lead=if i==sel{cursor_ind()}else{ind.to_string()};
            let _=execute!(s,style::PrintStyledContent(format!("{}{}{}\n",lead,pad(&m,MARK_COL).with(terra()),l).with(ivory())));
        }
        let h=if lang=="en"{"↑↓ move  ·  Enter select  ·  b back"}else{"↑↓ 移动  ·  回车 确认  ·  b 返回"};
        ftr(&mut s,h,w); let _=s.flush();
        if let Event::Key(k)=event::read().expect("read") {
            if k.kind!=KeyEventKind::Press{continue;}
            match k.code {
                KeyCode::Up|KeyCode::Char('k')=>{sel=if sel>0{sel-1}else{opts.len()-1};}
                KeyCode::Down|KeyCode::Char('j')=>{sel=if sel<opts.len()-1{sel+1}else{0};}
                KeyCode::Enter=>{let nl=if sel==0{"zh"}else{"en"};let mut cf=Config::load();cf.language=nl.to_string();let _=cf.save();
                    let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();
                    std::process::Command::new(std::env::current_exe().unwrap()).arg("--lang").arg(nl).spawn().ok();std::process::exit(0);}
                KeyCode::Char('q')|KeyCode::Esc|KeyCode::Char('b')=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();return;}
                _=>{}
            }
        }
    }
}

// ── Cleanup ──
fn run_clean(lang: &str) {
    let bd=dirs::home_dir().map(|h|h.join(".incipit-backup"));
    let rd=dirs::home_dir().map(|h|h.join(".incipit").join("official-restore-points-v1"));
    let (mut tb,mut tf,mut td)=(0u64,0u64,0u64);
    for d in bd.iter().chain(rd.iter()) { if d.exists(){for e in std::fs::read_dir(d).into_iter().flatten(){if let Ok(e)=e{if let Some(m)=e.metadata().ok(){tb+=m.len();if m.is_dir(){td+=1}else{tf+=1};}}}}}
    let ss=if tb>1_048_576{format!("{:.1} MB",tb as f64/1_048_576.0)}else if tb>1024{format!("{:.1} KB",tb as f64/1024.0)}else{format!("{} B",tb)};
    if lang=="en"{
        println!("\n  Clean Legacy Backups\n");if let Some(ref p)=bd{println!("  Backup root: {}",p.display());}
        println!("  Files: {}  Dirs: {}  Size: {}",tf,td,ss);
    } else {
        println!("\n  清理旧版备份文件\n");if let Some(ref p)=bd{println!("  备份目录: {}",p.display());}
        println!("  文件: {}  目录: {}  大小: {}",tf,td,ss);
    }
    if tb==0{println!("{}",if lang=="en"{"\n  No legacy backups found."}else{"\n  未发现旧版备份文件。"});
    }else{
        print!("{}",if lang=="en"{"\n  Delete all legacy backups? [y/N] "}else{"\n  确认删除所有旧版备份？[y/N] "});
        io::stdout().flush().ok();let mut input=String::new();io::stdin().read_line(&mut input).ok();
        if input.trim().eq_ignore_ascii_case("y"){for d in bd.iter().chain(rd.iter()){if d.exists(){let _=std::fs::remove_dir_all(d);}}
            println!("{}",if lang=="en"{"  ✅ Done."}else{"  ✅ 已清理。"});
        }else{println!("{}",if lang=="en"{"  Cancelled."}else{"  已取消。"});}
    }
    println!("\n  Press Enter to return...");let mut buf=String::new();io::stdin().read_line(&mut buf).ok();
}

// ── Main ──
pub fn run_interactive(lang: &str) {
    if !terminal::window_size().is_ok(){help(lang);return;}
    let mut s=io::stdout(); let its=items(lang); let mut sel:usize=0;
    terminal::enable_raw_mode().expect("raw mode");
    let _=execute!(s,cursor::Hide); draw(&mut s,its,sel,lang);
    loop {
        if let Event::Key(k)=event::read().expect("read"){
            if k.kind!=KeyEventKind::Press{continue;}
            match k.code {
                KeyCode::Up|KeyCode::Char('k')=>{sel=if sel>0{sel-1}else{its.len()-1};draw(&mut s,its,sel,lang);}
                KeyCode::Down|KeyCode::Char('j')=>{sel=if sel<its.len()-1{sel+1}else{0};draw(&mut s,its,sel,lang);}
                KeyCode::Enter=>{
                    let a=its[sel].0;
                    match a{
                    "quit"=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();return;}
                    "apply"=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();
                        let tg=detect_targets();if tg.is_empty(){eprintln!("\n  ⚠  No Claude Code detected.\n");}
                        else{eprintln!("\n  ⏳ Applying to {}...",tg[0].label);match apply_patch(&tg[0]){Ok(())=>eprintln!("  ✅ Done!\n"),Err(e)=>eprintln!("  ❌ {}\n",e)}}
                        eprintln!("  Press Enter...");let mut b=String::new();io::stdin().read_line(&mut b).ok();
                        terminal::enable_raw_mode().ok();let _=execute!(s,cursor::Hide);draw(&mut s,its,sel,lang);}
                    "restore"=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();
                        let tg=detect_targets();if tg.is_empty(){eprintln!("\n  ⚠  No Claude Code detected.\n");}
                        else{eprintln!("\n  ⏳ Restoring {}...",tg[0].label);match restore_official(&tg[0]){Ok(())=>eprintln!("  ✅ Done!\n"),Err(e)=>eprintln!("  ❌ {}\n",e)}}
                        eprintln!("  Press Enter...");let mut b=String::new();io::stdin().read_line(&mut b).ok();
                        terminal::enable_raw_mode().ok();let _=execute!(s,cursor::Hide);draw(&mut s,its,sel,lang);}
                    "update"=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();
                        eprintln!("\n  ⏳ Checking...");match update_self(){Ok(())=>{}Err(e)=>{eprintln!("  ❌ {}\n",e);eprintln!("  Press Enter...");let mut b=String::new();io::stdin().read_line(&mut b).ok();}}
                        terminal::enable_raw_mode().ok();let _=execute!(s,cursor::Hide);draw(&mut s,its,sel,lang);}
                    "configure"=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();run_configure(lang);
                        terminal::enable_raw_mode().ok();let _=execute!(s,cursor::Hide);draw(&mut s,its,sel,lang);}
                    "target"=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();run_tgt(lang);
                        terminal::enable_raw_mode().ok();let _=execute!(s,cursor::Hide);draw(&mut s,its,sel,lang);}
                    "language"=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();run_lang(lang);
                        terminal::enable_raw_mode().ok();let _=execute!(s,cursor::Hide);draw(&mut s,its,sel,lang);}
                    "connect"=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();
                        println!("\n  GitHub: https://github.com/jonntd/incipit\n  Issues: https://github.com/jonntd/incipit/issues\n");
                        println!("  Press Enter...");let mut b=String::new();io::stdin().read_line(&mut b).ok();
                        terminal::enable_raw_mode().ok();let _=execute!(s,cursor::Hide);draw(&mut s,its,sel,lang);}
                    "cleanup"=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();run_clean(lang);
                        terminal::enable_raw_mode().ok();let _=execute!(s,cursor::Hide);draw(&mut s,its,sel,lang);}
                    _=>{}}
                }
                KeyCode::Char('q')=>{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();return;}
                KeyCode::Char(c)=>{
                    if let Some(d)=c.to_digit(10){let idx=d as usize;
                    if idx>=1&&idx<=its.len(){let a=its[idx-1].0;
                    if a=="quit"{let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();return;}
                    let _=execute!(s,cursor::Show);terminal::disable_raw_mode().ok();
                    match a{
                        "apply"=>{let tg=detect_targets();if tg.is_empty(){eprintln!("\n  ⚠  No Claude Code detected.\n");}
                            else{eprintln!("\n  ⏳ Applying...");match apply_patch(&tg[0]){Ok(())=>eprintln!("  ✅ Done!\n"),Err(e)=>eprintln!("  ❌ {}\n",e)}}}
                        "restore"=>{let tg=detect_targets();if tg.is_empty(){eprintln!("\n  ⚠  No Claude Code detected.\n");}
                            else{eprintln!("\n  ⏳ Restoring...");match restore_official(&tg[0]){Ok(())=>eprintln!("  ✅ Done!\n"),Err(e)=>eprintln!("  ❌ {}\n",e)}}}
                        "update"=>{eprintln!("\n  ⏳ Checking...");if let Err(e)=update_self(){eprintln!("  ❌ {}\n",e);}}
                        "target"=>run_tgt(lang),"cleanup"=>run_clean(lang),"language"=>run_lang(lang),
                        "connect"=>{println!("\n  GitHub: https://github.com/jonntd/incipit\n  Issues: https://github.com/jonntd/incipit/issues\n");}
                        _=>{}}
                    return;}}
                }
                _=>{}
            }
        }
    }
}
