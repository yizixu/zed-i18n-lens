use std::{env, fs};
use zed_extension_api::{self as zed, Result};

struct I18nLensExtension {
    did_find_server: bool,
}

/// Kept in sync with the crate version; also used to select the GitHub release
/// tag and to namespace the downloaded server so a new extension version always
/// fetches a fresh bundle.
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

impl I18nLensExtension {
    /// Resolves the bundled language server, downloading it into the extension's
    /// work directory on first use.
    ///
    /// A Zed extension cannot reference files committed to its own repository at
    /// runtime: the wasm guest only has access to its work directory (which maps
    /// to `current_dir`), while the repository files live in a separate
    /// `installed` directory whose path is not exposed. The supported pattern is
    /// therefore to fetch runtime assets into the work directory, exactly like
    /// the official Node-based extensions (Vue, Svelte, ...).
    fn server_script_path(&mut self, language_server_id: &zed::LanguageServerId) -> Result<String> {
        let file_name = format!("i18n-lens-server-{SERVER_VERSION}.cjs");
        let server_exists = fs::metadata(&file_name).is_ok_and(|stat| stat.is_file());

        if !(self.did_find_server && server_exists) && !server_exists {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );

            let url = format!(
                "https://github.com/yizixu/zed-i18n-lens/releases/download/v{SERVER_VERSION}/i18n-lens-server.cjs"
            );

            zed::download_file(&url, &file_name, zed::DownloadedFileType::Uncompressed)
                .map_err(|err| format!("failed to download i18n-lens language server: {err}"))?;

            if !fs::metadata(&file_name).is_ok_and(|stat| stat.is_file()) {
                return Err(format!(
                    "downloaded i18n-lens language server is missing expected file '{file_name}'"
                ));
            }
        }

        self.did_find_server = true;

        // The spawned Node process does not inherit the extension work directory
        // as its cwd, so the script must be passed as an absolute path.
        let absolute = env::current_dir()
            .map_err(|err| format!("failed to resolve extension work directory: {err}"))?
            .join(&file_name);
        Ok(absolute.to_string_lossy().into_owned())
    }
}

impl zed::Extension for I18nLensExtension {
    fn new() -> Self {
        Self {
            did_find_server: false,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let server_path = self.server_script_path(language_server_id)?;

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server_path, "--stdio".to_string()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(I18nLensExtension);
