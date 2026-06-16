use std::{env, fs};
use zed_extension_api::{self as zed, Result};

struct I18nLensExtension {
    did_find_server: bool,
}

/// The language server is published to npm and installed into the extension's
/// work directory at runtime, the same pattern the official Node-based
/// extensions use. Zed extensions must not ship the language server themselves.
const PACKAGE_NAME: &str = "i18n-lens-language-server";
const SERVER_PATH: &str = "node_modules/i18n-lens-language-server/server/index.js";

impl I18nLensExtension {
    fn server_exists(&self) -> bool {
        fs::metadata(SERVER_PATH).is_ok_and(|stat| stat.is_file())
    }

    fn server_script_path(&mut self, language_server_id: &zed::LanguageServerId) -> Result<String> {
        let server_exists = self.server_exists();
        if self.did_find_server && server_exists {
            return self.absolute_server_path();
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let latest = zed::npm_package_latest_version(PACKAGE_NAME)?;

        if !server_exists
            || zed::npm_package_installed_version(PACKAGE_NAME)?.as_deref() != Some(latest.as_str())
        {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            match zed::npm_install_package(PACKAGE_NAME, &latest) {
                Ok(()) => {
                    if !self.server_exists() {
                        return Err(format!(
                            "installed npm package '{PACKAGE_NAME}' is missing expected entry '{SERVER_PATH}'"
                        ));
                    }
                }
                // If the install fails but a previous version is already present,
                // keep using it rather than breaking the editor (e.g. offline).
                Err(error) => {
                    if !self.server_exists() {
                        return Err(error);
                    }
                }
            }
        }

        self.did_find_server = true;
        self.absolute_server_path()
    }

    fn absolute_server_path(&self) -> Result<String> {
        // The spawned Node process does not inherit the extension work directory
        // as its cwd, so pass an absolute path to the installed entry point.
        let absolute = env::current_dir()
            .map_err(|err| format!("failed to resolve extension work directory: {err}"))?
            .join(SERVER_PATH);
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
