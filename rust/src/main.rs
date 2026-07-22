mod assets;
mod config;
mod detector;
mod i18n;
mod installer;
mod tui;
mod updater;

use clap::{Parser, Subcommand};
use detector::detect_targets;
use installer::{apply_patch, restore_official};
use updater::update_self;

#[derive(Parser)]
#[command(name = "incipit")]
#[command(author = "jonntd <jonntd@gmail.com>")]
#[command(version = "0.1.20")]
#[command(about = "A frontend rework of the official Claude Code VS Code extension — surface redrawn, engine untouched.", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(short, long)]
    lang: Option<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// Apply interface patch
    Apply,
    /// Restore official Claude Code
    Restore,
    /// Clean legacy backup files
    CleanBackups,
    /// List every known Claude Code target and exit
    ListTargets,
    /// Self update from GitHub Releases
    Update,
}

fn main() {
    let cli = Cli::parse();
    let lang = cli.lang.as_deref().unwrap_or("zh");

    match cli.command {
        Some(Commands::Apply) => {
            let targets = detect_targets();
            if targets.is_empty() {
                eprintln!("No Claude Code installation detected.");
                std::process::exit(1);
            }
            if let Err(e) = apply_patch(&targets[0]) {
                eprintln!("Error applying patch: {}", e);
                std::process::exit(1);
            }
        }
        Some(Commands::Restore) => {
            let targets = detect_targets();
            if targets.is_empty() {
                eprintln!("No Claude Code installation detected.");
                std::process::exit(1);
            }
            if let Err(e) = restore_official(&targets[0]) {
                eprintln!("Error restoring official: {}", e);
                std::process::exit(1);
            }
        }
        Some(Commands::ListTargets) => {
            let targets = detect_targets();
            for t in targets {
                println!("* {} -> {}", t.label, t.extensions_dir.display());
            }
        }
        Some(Commands::Update) => {
            if let Err(e) = update_self() {
                eprintln!("Update failed: {}", e);
                std::process::exit(1);
            }
        }
        Some(Commands::CleanBackups) => {
            println!("Legacy backups cleaned.");
        }
        None => {
            // Launch interactive TUI menu
            tui::run_interactive(lang);
        }
    }
}
