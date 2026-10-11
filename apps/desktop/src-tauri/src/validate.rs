//! Validation of everything that crosses the IPC boundary. The webview is trusted code, but a
//! compromised page (or a bug) must never reach files outside a workspace folder.

use crate::error::{Error, Result};
use std::path::{Component, Path, PathBuf};

fn matches(value: &str, max: usize, extra: &[char]) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || extra.contains(&c))
}

/// Workspace and page IDs: `ID_PATTERN` in `@tessera/core` (`[A-Za-z0-9_-]{1,64}`).
pub fn id(value: &str) -> Result<&str> {
    if matches(value, 64, &[]) {
        Ok(value)
    } else {
        Err(Error::Invalid(format!("invalid ID {value:?}")))
    }
}

/// Asset IDs: `ASSET_ID_PATTERN` in `@tessera/core` (`[A-Za-z0-9_-]{1,128}`).
pub fn asset_id(value: &str) -> Result<&str> {
    if matches(value, 128, &[]) {
        Ok(value)
    } else {
        Err(Error::Invalid(format!("invalid asset ID {value:?}")))
    }
}

/// Doc names (`ws:<id>`, `page:<id>`, `db:<id>`, and whatever other features store). They only
/// ever reach SQL as bound parameters, never paths.
pub fn doc_name(value: &str) -> Result<&str> {
    if matches(value, 200, &[':', '.', '/']) {
        Ok(value)
    } else {
        Err(Error::Invalid(format!("invalid doc name {value:?}")))
    }
}

/// A folder chosen by the user: absolute, no `..`.
pub fn absolute_folder(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if value.is_empty() || value.contains('\0') || !path.is_absolute() {
        return Err(Error::Invalid(format!(
            "not an absolute folder path: {value:?}"
        )));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(Error::Invalid(format!(
            "folder paths may not contain '..': {value:?}"
        )));
    }
    Ok(path)
}

/// The file name a save dialog suggests: separators, reserved and control characters become `-`,
/// runs of whitespace one space, trailing dots and spaces go, at most 200 characters. It is only a
/// suggestion (the user picks the real path), so it is cleaned rather than refused.
pub fn suggested_file_name(value: &str) -> String {
    let replaced: String = value
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let limited: String = collapsed.chars().take(200).collect();
    let trimmed = limited.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        "export".to_string()
    } else {
        trimmed.to_string()
    }
}

/// The extension of a file name (`zip` for `Notes.zip`), when it has a short, plain one.
pub fn extension(name: &str) -> Option<&str> {
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty()
        && !ext.is_empty()
        && ext.len() <= 10
        && ext.chars().all(|c| c.is_ascii_alphanumeric()))
    .then_some(ext)
}

/// Joins a relative, `/`-separated path (from an exporter) under `root`, refusing anything that
/// could escape it: `..`, absolute paths, drive letters, NUL, empty segments and reserved names.
pub fn relative_under(root: &Path, relative: &str) -> Result<PathBuf> {
    let invalid = || Error::Invalid(format!("unsafe relative path {relative:?}"));
    if relative.is_empty() || relative.len() > 1024 || relative.contains('\0') {
        return Err(invalid());
    }
    let unified = relative.replace('\\', "/");
    if unified.starts_with('/') || unified.chars().nth(1) == Some(':') {
        return Err(invalid());
    }
    let mut path = root.to_path_buf();
    for segment in unified.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains(':') {
            return Err(invalid());
        }
        let trimmed = segment.trim_end_matches(['.', ' ']);
        if trimmed.is_empty() {
            return Err(invalid());
        }
        path.push(segment);
    }
    // Belt and braces: the joined path must still be under root.
    if !path.starts_with(root) {
        return Err(invalid());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_and_rejects_ids() {
        assert!(id("V1StGXR8_Z5jdHi6B-myT").is_ok());
        assert!(id("").is_err());
        assert!(id("a/b").is_err());
        assert!(id(&"x".repeat(65)).is_err());
        assert!(asset_id(&"a".repeat(64)).is_ok());
        assert!(asset_id("../etc").is_err());
    }

    #[test]
    fn accepts_doc_names() {
        assert!(doc_name("page:V1StGXR8_Z5jdHi6B-myT").is_ok());
        assert!(doc_name("ws:abc").is_ok());
        assert!(doc_name("page abc").is_err());
        assert!(doc_name("").is_err());
    }

    #[test]
    fn relative_paths_stay_under_root() {
        let root = PathBuf::from(if cfg!(windows) {
            r"C:\ws\markdown"
        } else {
            "/ws/markdown"
        });
        assert!(relative_under(&root, "Notes/Apollo.md").is_ok());
        assert!(relative_under(&root, "a\\b.md").is_ok());
        for bad in [
            "../x.md",
            "a/../../x",
            "/etc/passwd",
            "C:/x",
            "a//b",
            "a/./b",
            "",
            "a/b:c",
            "...",
        ] {
            assert!(
                relative_under(&root, bad).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn cleans_suggested_file_names() {
        assert_eq!(suggested_file_name("Launch plan.md"), "Launch plan.md");
        assert_eq!(suggested_file_name("a/b\\c:d*?.zip"), "a-b-c-d--.zip");
        assert_eq!(suggested_file_name("  two   spaces  .md"), "two spaces .md");
        assert_eq!(suggested_file_name("dots..."), "dots");
        assert_eq!(suggested_file_name("line\nbreak"), "line-break");
        assert_eq!(suggested_file_name(""), "export");
        assert_eq!(suggested_file_name(". ."), "export");
        assert_eq!(suggested_file_name(&"é".repeat(300)).chars().count(), 200);
    }

    #[test]
    fn reads_extensions() {
        assert_eq!(extension("Library.zip"), Some("zip"));
        assert_eq!(extension("a.b.html"), Some("html"));
        assert_eq!(extension("README"), None);
        assert_eq!(extension(".hidden"), None);
        assert_eq!(extension("odd.ex t"), None);
    }

    #[test]
    fn folders_must_be_absolute() {
        assert!(absolute_folder("relative/path").is_err());
        let abs = if cfg!(windows) {
            r"C:\Users\me\Tessera"
        } else {
            "/home/me/Tessera"
        };
        assert!(absolute_folder(abs).is_ok());
        let dotted = if cfg!(windows) {
            r"C:\Users\..\x"
        } else {
            "/home/../x"
        };
        assert!(absolute_folder(dotted).is_err());
    }
}
