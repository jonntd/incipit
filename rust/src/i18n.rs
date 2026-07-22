pub enum Locale {
    En,
    Zh,
}

pub struct I18n {
    locale: Locale,
}

impl I18n {
    pub fn new(lang: Option<&str>) -> Self {
        let locale = match lang {
            Some("zh") => Locale::Zh,
            Some("en") => Locale::En,
            _ => Locale::Zh,
        };
        Self { locale }
    }

    pub fn t(&self, key: &str) -> String {
        let s = match self.locale {
            Locale::Zh => match key {
                "help.usage_heading" => "用法",
                "help.cmd_default" => "交互式扉页菜单(默认)",
                "help.cmd_apply" => "直接应用界面补丁，不进菜单",
                "help.cmd_restore" => "恢复为官方 Claude Code 文件",
                "help.cmd_clean_backups" => "删除旧版 incipit 备份文件",
                "help.cmd_list_targets" => "列出所有已知 Claude Code 目标后退出",
                "help.cmd_update" => "检查并从 GitHub Releases 自动升级",
                "help.cmd_version" => "显示 CLI 版本",
                "help.cmd_help" => "显示本帮助",
                "menu.apply" => "应用界面补丁",
                "menu.restore" => "恢复官方 Claude Code",
                "menu.configure" => "配置",
                "menu.update" => "检查新版本 / 自动升级",
                "menu.target" => "管理 Claude Code 目标位置",
                "menu.cli_language" => "CLI 界面语言",
                "menu.connect_us" => "Connect us",
                "menu.cleanup_backups" => "清理旧版备份文件",
                "menu.quit" => "退出",
                "hint.main" => "↑↓ 移动 · 回车 确认 · q 退出",
                _ => key,
            },
            Locale::En => match key {
                "help.usage_heading" => "Usage",
                "help.cmd_default" => "open the interactive frontispiece menu (default)",
                "help.cmd_apply" => "apply the interface patch without entering the menu",
                "help.cmd_restore" => "restore the official Claude Code files",
                "help.cmd_clean_backups" => "delete legacy incipit backup files",
                "help.cmd_list_targets" => "list every known Claude Code target and exit",
                "help.cmd_update" => "check and perform self update from GitHub Releases",
                "help.cmd_version" => "print the CLI version",
                "help.cmd_help" => "show this help",
                "menu.apply" => "Apply interface patch",
                "menu.restore" => "Restore official Claude Code",
                "menu.configure" => "Configure",
                "menu.update" => "Check for updates (GitHub Releases)",
                "menu.target" => "Manage Claude Code targets",
                "menu.cli_language" => "CLI language",
                "menu.connect_us" => "Connect us",
                "menu.cleanup_backups" => "Clean legacy backup files",
                "menu.quit" => "Quit",
                "hint.main" => "↑↓ move · Enter select · q quit",
                _ => key,
            },
        };
        s.to_string()
    }
}
