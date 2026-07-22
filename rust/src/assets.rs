use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "data/"]
pub struct DataAssets;

#[derive(RustEmbed)]
#[folder = "companion/"]
pub struct CompanionAssets;
