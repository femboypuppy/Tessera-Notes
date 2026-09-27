//! Open workspaces: one SQLite connection per workspace folder, shared by every window that
//! attached it (the main window and the quick-capture window), reference counted.
//!
//! A workspace's folder and database are created on the first write, never on open. So a
//! workspace that nobody edits leaves nothing on disk, and "Open folder…" during onboarding can
//! replace the empty workspace the shell created first without leaving an empty folder behind.

use crate::cloud::{self, CloudInfo};
use crate::db::{now_ms, AssetRow, JournalMode, Manifest, WorkspaceDb, ASSETS_DIR, DB_FILE};
use crate::error::{poisoned, Error, Result};
use crate::validate;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const MIRROR_DIR: &str = "markdown";
const MIRROR_MANIFEST: &str = ".tessera-mirror.json";
/// Where merged conflicted copies are moved (never deleted).
pub const MERGED_DIR: &str = ".tessera/merged";

pub struct OpenWorkspace {
    pub id: String,
    pub path: PathBuf,
    pub journal: JournalMode,
    name: Mutex<String>,
    db: Mutex<Option<WorkspaceDb>>,
    mirror: Mutex<Option<BTreeSet<String>>>,
}

/// Returned by `workspace_attach` and `workspace_status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub id: String,
    pub path: String,
    /// Whether `tessera.db` exists yet.
    pub exists: bool,
    pub journal: JournalMode,
    pub cloud: Option<CloudInfo>,
    /// Conflicted copies of `tessera.db` next to it.
    pub conflicts: Vec<String>,
    pub manifest: Option<Manifest>,
}

impl OpenWorkspace {
    /// Runs `f` with the database, or returns `None` when it doesn't exist yet.
    pub fn read<T>(&self, f: impl FnOnce(&WorkspaceDb) -> Result<T>) -> Result<Option<T>> {
        let guard = self.db.lock().map_err(poisoned)?;
        match guard.as_ref() {
            Some(db) => f(db).map(Some),
            None => Ok(None),
        }
    }

    /// Runs `f` with the database, creating the folder and the database first if needed.
    /// `on_create` runs once, after creation (the registry records it).
    pub fn write<T>(
        &self,
        on_create: impl FnOnce(&str),
        f: impl FnOnce(&WorkspaceDb) -> Result<T>,
    ) -> Result<T> {
        let mut guard = self.db.lock().map_err(poisoned)?;
        if guard.is_none() {
            let name = self.name.lock().map_err(poisoned)?.clone();
            let db = WorkspaceDb::create(&self.path, self.journal, &self.id, &name)?;
            *guard = Some(db);
            on_create(&self.id);
        }
        match guard.as_ref() {
            Some(db) => f(db),
            None => Err(Error::Internal("the workspace database is not open".into())),
        }
    }

    pub fn exists(&self) -> bool {
        self.db.lock().map(|db| db.is_some()).unwrap_or(false)
    }

    pub fn set_name(&self, name: &str) -> Result<()> {
        *self.name.lock().map_err(poisoned)? = name.to_string();
        self.read(|db| db.meta_set("name", Some(name)))?;
        Ok(())
    }

    pub fn status(&self) -> Result<WorkspaceStatus> {
        let manifest = self.read(|db| db.manifest())?;
        Ok(WorkspaceStatus {
            id: self.id.clone(),
            path: self.path.to_string_lossy().into_owned(),
            exists: manifest.is_some(),
            journal: self.journal,
            cloud: cloud::detect_here(&self.path, home().as_deref()),
            conflicts: cloud::conflicted_copies(&self.path, DB_FILE),
            manifest,
        })
    }

    /// Checkpoints and closes the database (app exit). Waits for any command using it.
    pub fn close(&self) {
        if let Ok(mut guard) = self.db.lock() {
            if let Some(db) = guard.as_ref() {
                if let Err(error) = db.checkpoint() {
                    log::warn!("checkpoint of {} failed: {error}", self.path.display());
                }
            }
            *guard = None;
        }
    }

    // --- Assets -------------------------------------------------------------------------------

    fn assets_dir(&self) -> PathBuf {
        self.path.join(ASSETS_DIR)
    }

    /// Stores a file by content hash (the same bytes twice give one asset).
    pub fn put_asset(
        &self,
        bytes: &[u8],
        name: Option<String>,
        mime: Option<String>,
        on_create: impl FnOnce(&str),
    ) -> Result<AssetRow> {
        let asset_id = hex(&Sha256::digest(bytes));
        let mime = mime
            .filter(|m| is_mime(m))
            .unwrap_or_else(|| "application/octet-stream".into());
        let name = name
            .map(|n| n.chars().take(255).collect::<String>())
            .filter(|n| !n.trim().is_empty());
        self.write(on_create, |db| {
            if let Some(existing) = db.asset(&asset_id)? {
                let file = self.assets_dir().join(&existing.file);
                if !file.is_file() {
                    crate::config::write_atomic(&file, bytes)?;
                }
                return Ok(existing);
            }
            let extension = extension_for(name.as_deref(), &mime);
            let file = match extension {
                Some(ext) => format!("{asset_id}.{ext}"),
                None => asset_id.clone(),
            };
            crate::config::write_atomic(&self.assets_dir().join(&file), bytes)?;
            let row = AssetRow {
                asset_id: asset_id.clone(),
                name: name.clone(),
                mime_type: mime.clone(),
                size: bytes.len() as i64,
                file,
                created_at: now_ms(),
            };
            db.insert_asset(&row)?;
            Ok(row)
        })
    }

    pub fn asset_info(&self, asset_id: &str) -> Result<Option<AssetRow>> {
        validate::asset_id(asset_id)?;
        Ok(self.read(|db| db.asset(asset_id))?.flatten())
    }

    pub fn asset_bytes(&self, asset_id: &str) -> Result<Option<(AssetRow, Vec<u8>)>> {
        let Some(row) = self.asset_info(asset_id)? else {
            return Ok(None);
        };
        let file = validate::relative_under(&self.assets_dir(), &row.file)?;
        match std::fs::read(file) {
            Ok(bytes) => Ok(Some((row, bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn list_assets(&self) -> Result<Vec<AssetRow>> {
        Ok(self.read(|db| db.assets())?.unwrap_or_default())
    }

    pub fn delete_asset(&self, asset_id: &str) -> Result<()> {
        validate::asset_id(asset_id)?;
        if let Some(row) = self.read(|db| db.delete_asset(asset_id))?.flatten() {
            let file = validate::relative_under(&self.assets_dir(), &row.file)?;
            match std::fs::remove_file(file) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.into())
                }
                _ => {}
            }
        }
        Ok(())
    }

    // --- Markdown mirror -------------------------------------------------------------------------

    fn mirror_root(&self) -> PathBuf {
        self.path.join(MIRROR_DIR)
    }

    pub fn mirror_begin(&self) -> Result<()> {
        if !self.exists() {
            return Err(Error::Unavailable("the workspace has no folder yet".into()));
        }
        std::fs::create_dir_all(self.mirror_root())?;
        *self.mirror.lock().map_err(poisoned)? = Some(BTreeSet::new());
        Ok(())
    }

    /// Writes one file of the mirror, skipping files whose content didn't change (so sync clients
    /// and file watchers only see real changes). Returns whether the file changed.
    pub fn mirror_write(&self, relative: &str, bytes: &[u8]) -> Result<bool> {
        let mut run = self.mirror.lock().map_err(poisoned)?;
        let written = run
            .as_mut()
            .ok_or_else(|| Error::Invalid("no mirror run in progress".into()))?;
        let target = validate::relative_under(&self.mirror_root(), relative)?;
        let key = relative.replace('\\', "/");
        if key == MIRROR_MANIFEST {
            return Err(Error::Invalid("reserved file name".into()));
        }
        written.insert(key);
        if std::fs::read(&target)
            .map(|current| current == bytes)
            .unwrap_or(false)
        {
            return Ok(false);
        }
        crate::config::write_atomic(&target, bytes)?;
        Ok(true)
    }

    /// Ends a mirror run: deletes the files the previous run wrote and this one didn't write or
    /// `keep` (pages that were renamed, moved or deleted). `keep` names the files an incremental
    /// run left as they were; only files an earlier run wrote count. Files the mirror never wrote
    /// are never touched.
    pub fn mirror_finish(&self, keep: &[String]) -> Result<MirrorReport> {
        let mut written = self
            .mirror
            .lock()
            .map_err(poisoned)?
            .take()
            .ok_or_else(|| Error::Invalid("no mirror run in progress".into()))?;
        let root = self.mirror_root();
        let manifest_path = root.join(MIRROR_MANIFEST);
        let previous: MirrorManifest = std::fs::read(&manifest_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        for file in keep {
            let key = file.replace('\\', "/");
            if previous.files.contains(&key) {
                written.insert(key);
            }
        }
        let mut removed = 0;
        for stale in previous
            .files
            .iter()
            .filter(|file| !written.contains(*file))
        {
            let Ok(path) = validate::relative_under(&root, stale) else {
                continue;
            };
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    removed += 1;
                    prune_empty_dirs(&root, path.parent());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => log::warn!("could not remove stale mirror file {stale}: {error}"),
            }
        }
        let manifest = MirrorManifest {
            files: written.iter().cloned().collect(),
            written_at: now_ms(),
        };
        crate::config::write_atomic(&manifest_path, &serde_json::to_vec_pretty(&manifest)?)?;
        Ok(MirrorReport {
            files: written.len(),
            removed,
        })
    }

    /// Merges a conflicted copy (`tessera 2.db`, …) into the database, then moves the copy to
    /// `.tessera/merged/` so it's out of the way but never deleted.
    pub fn merge_conflict(
        &self,
        file_name: &str,
        on_create: impl FnOnce(&str),
    ) -> Result<crate::db::MergeReport> {
        if !cloud::is_conflicted_copy(file_name, DB_FILE) {
            return Err(Error::Invalid(format!(
                "{file_name} is not a conflicted copy of {DB_FILE}"
            )));
        }
        let source = validate::relative_under(&self.path, file_name)?;
        if !source.is_file() {
            return Err(Error::NotFound(format!("{file_name} no longer exists")));
        }
        let report = self.write(on_create, |db| {
            db.checkpoint()?;
            db.merge_from(&source)
        })?;
        let merged_dir = self.path.join(MERGED_DIR);
        std::fs::create_dir_all(&merged_dir)?;
        let target = merged_dir.join(format!("{}-{file_name}", now_ms()));
        std::fs::rename(&source, &target)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            let side = self.path.join(format!("{file_name}{suffix}"));
            if side.exists() {
                let _ = std::fs::rename(
                    &side,
                    merged_dir.join(format!("{}-{file_name}{suffix}", now_ms())),
                );
            }
        }
        Ok(report)
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MirrorManifest {
    files: Vec<String>,
    #[serde(default)]
    written_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MirrorReport {
    pub files: usize,
    pub removed: usize,
}

fn prune_empty_dirs(root: &Path, mut dir: Option<&Path>) {
    while let Some(current) = dir {
        if current == root || !current.starts_with(root) {
            break;
        }
        if std::fs::remove_dir(current).is_err() {
            break;
        }
        dir = current.parent();
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_mime(value: &str) -> bool {
    value.len() <= 127
        && value.split_once('/').is_some_and(|(kind, sub)| {
            !kind.is_empty()
                && !sub.is_empty()
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "/+-.;=_ ".contains(c))
        })
}

/// A safe, short file extension from the original name, or from the MIME type.
fn extension_for(name: Option<&str>, mime: &str) -> Option<String> {
    let from_name = name
        .and_then(|n| n.rsplit_once('.'))
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| {
            !ext.is_empty() && ext.len() <= 10 && ext.chars().all(|c| c.is_ascii_alphanumeric())
        });
    from_name.or_else(|| {
        let ext = match mime.split(';').next().unwrap_or("").trim() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/svg+xml" => "svg",
            "image/avif" => "avif",
            "application/pdf" => "pdf",
            "text/plain" => "txt",
            "text/markdown" => "md",
            "video/mp4" => "mp4",
            "audio/mpeg" => "mp3",
            _ => return None,
        };
        Some(ext.to_string())
    })
}

pub fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

// ---------------------------------------------------------------------------------------------
// The set of open workspaces
// ---------------------------------------------------------------------------------------------

struct Slot {
    workspace: Arc<OpenWorkspace>,
    refs: usize,
}

#[derive(Default)]
pub struct Workspaces {
    slots: Mutex<HashMap<String, Slot>>,
}

impl Workspaces {
    /// Opens (or re-uses) the workspace `id` in `path`. The database is opened if it exists and
    /// must belong to `id`; otherwise it will be created on the first write.
    pub fn attach(
        &self,
        id: &str,
        path: &str,
        name: &str,
    ) -> Result<(Arc<OpenWorkspace>, WorkspaceStatus)> {
        validate::id(id)?;
        let folder = validate::absolute_folder(path)?;
        let mut slots = self.slots.lock().map_err(poisoned)?;
        if let Some(slot) = slots.get_mut(id) {
            if slot.workspace.path != folder {
                return Err(Error::Conflict(format!(
                    "workspace {id} is already open from {}",
                    slot.workspace.path.display()
                )));
            }
            slot.refs += 1;
            let workspace = slot.workspace.clone();
            drop(slots);
            let status = workspace.status()?;
            return Ok((workspace, status));
        }
        let cloud = cloud::detect_here(&folder, home().as_deref());
        let journal = if cloud.is_some() {
            JournalMode::Delete
        } else {
            JournalMode::Wal
        };
        let db = if folder.join(DB_FILE).is_file() {
            Some(WorkspaceDb::open(&folder, journal, Some(id))?)
        } else {
            None
        };
        let workspace = Arc::new(OpenWorkspace {
            id: id.to_string(),
            path: folder,
            journal,
            name: Mutex::new(name.to_string()),
            db: Mutex::new(db),
            mirror: Mutex::new(None),
        });
        slots.insert(
            id.to_string(),
            Slot {
                workspace: workspace.clone(),
                refs: 1,
            },
        );
        drop(slots);
        let status = workspace.status()?;
        Ok((workspace, status))
    }

    /// Releases one attachment; the connection closes with the last one.
    pub fn detach(&self, id: &str) -> Result<()> {
        let mut slots = self.slots.lock().map_err(poisoned)?;
        let Some(slot) = slots.get_mut(id) else {
            return Ok(());
        };
        slot.refs = slot.refs.saturating_sub(1);
        if slot.refs == 0 {
            if let Some(slot) = slots.remove(id) {
                drop(slots);
                slot.workspace.close();
            }
        }
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Arc<OpenWorkspace>> {
        self.slots
            .lock()
            .map_err(poisoned)?
            .get(id)
            .map(|slot| slot.workspace.clone())
            .ok_or_else(|| Error::NotFound(format!("workspace {id} is not open")))
    }

    /// Closes every workspace (app exit).
    pub fn close_all(&self) {
        let workspaces: Vec<_> = match self.slots.lock() {
            Ok(mut slots) => slots.drain().map(|(_, slot)| slot.workspace).collect(),
            Err(_) => return,
        };
        for workspace in workspaces {
            workspace.close();
        }
    }
}

/// What a folder holds, for the "Open folder…" flow.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub path: String,
    pub name: String,
    pub exists: bool,
    /// The workspace in the folder, if it holds one.
    pub workspace: Option<Manifest>,
    /// Number of entries in the folder (0 for an empty or missing folder).
    pub entries: usize,
    pub cloud: Option<CloudInfo>,
    pub conflicts: Vec<String>,
}

pub fn inspect_folder(path: &str) -> Result<FolderInfo> {
    let folder = validate::absolute_folder(path)?;
    let exists = folder.is_dir();
    let workspace = if exists {
        WorkspaceDb::read_manifest(&folder)?
    } else {
        None
    };
    let entries = if exists {
        std::fs::read_dir(&folder)?.filter_map(|e| e.ok()).count()
    } else {
        0
    };
    Ok(FolderInfo {
        name: folder
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: folder.to_string_lossy().into_owned(),
        exists,
        workspace,
        entries,
        cloud: cloud::detect_here(&folder, home().as_deref()),
        conflicts: if exists {
            cloud::conflicted_copies(&folder, DB_FILE)
        } else {
            Vec::new()
        },
    })
}

/// `parent/name`, or `parent/name 2`, `parent/name 3`… when that already exists.
pub fn suggest_folder(parent: &str, name: &str) -> Result<String> {
    let parent = validate::absolute_folder(parent)?;
    let base = sanitize_folder_name(name);
    for n in 1..1000 {
        let candidate = if n == 1 {
            base.clone()
        } else {
            format!("{base} {n}")
        };
        let path = parent.join(&candidate);
        if !path.exists() {
            return Ok(path.to_string_lossy().into_owned());
        }
    }
    Err(Error::Conflict("could not find a free folder name".into()))
}

/// Same rules as `sanitizeFileName` in `@tessera/core`.
pub fn sanitize_folder_name(name: &str) -> String {
    const RESERVED: [&str; 22] = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
        "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed
        .trim_end_matches(['.', ' '])
        .chars()
        .take(120)
        .collect::<String>();
    let trimmed = trimmed.trim().to_string();
    if trimmed.is_empty() {
        return "Workspace".into();
    }
    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_lowercase();
    if RESERVED.contains(&stem.as_str()) {
        format!("{trimmed}_")
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attach(workspaces: &Workspaces, id: &str, path: &Path) -> Arc<OpenWorkspace> {
        workspaces
            .attach(id, &path.to_string_lossy(), "Apollo")
            .unwrap()
            .0
    }

    #[test]
    fn creates_the_folder_on_first_write_only() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Apollo");
        let workspaces = Workspaces::default();
        let (ws, status) = workspaces
            .attach("ws1", &folder.to_string_lossy(), "Apollo")
            .unwrap();
        assert!(!status.exists);
        assert!(!folder.exists());
        assert_eq!(ws.read(|db| db.load("page:a")).unwrap(), None);
        let mut created = Vec::new();
        ws.write(
            |id| created.push(id.to_string()),
            |db| db.store("page:a", &[1]),
        )
        .unwrap();
        ws.write(
            |id| created.push(id.to_string()),
            |db| db.store("page:a", &[2]),
        )
        .unwrap();
        assert_eq!(created, vec!["ws1"]);
        assert!(folder.join(DB_FILE).is_file());
        assert_eq!(ws.status().unwrap().manifest.unwrap().name, "Apollo");
    }

    #[test]
    fn attachments_are_reference_counted() {
        let dir = tempfile::tempdir().unwrap();
        let workspaces = Workspaces::default();
        let a = attach(&workspaces, "ws1", dir.path());
        let b = attach(&workspaces, "ws1", dir.path());
        assert!(Arc::ptr_eq(&a, &b));
        workspaces.detach("ws1").unwrap();
        assert!(workspaces.get("ws1").is_ok());
        workspaces.detach("ws1").unwrap();
        assert!(workspaces.get("ws1").is_err());
        let other = dir.path().join("elsewhere");
        attach(&workspaces, "ws1", dir.path());
        assert!(workspaces
            .attach("ws1", &other.to_string_lossy(), "x")
            .is_err());
    }

    #[test]
    fn refuses_a_folder_of_another_workspace() {
        let dir = tempfile::tempdir().unwrap();
        drop(WorkspaceDb::create(dir.path(), JournalMode::Wal, "ws1", "A").unwrap());
        let workspaces = Workspaces::default();
        let err = workspaces
            .attach("ws2", &dir.path().to_string_lossy(), "B")
            .err()
            .unwrap();
        assert_eq!(err.code(), "conflict");
    }

    #[test]
    fn assets_are_content_addressed_files() {
        let dir = tempfile::tempdir().unwrap();
        let workspaces = Workspaces::default();
        let ws = attach(&workspaces, "ws1", dir.path());
        let row = ws
            .put_asset(
                b"png bytes",
                Some("Moon.PNG".into()),
                Some("image/png".into()),
                |_| {},
            )
            .unwrap();
        assert_eq!(row.asset_id.len(), 64);
        assert_eq!(row.file, format!("{}.png", row.asset_id));
        let again = ws
            .put_asset(b"png bytes", Some("copy.png".into()), None, |_| {})
            .unwrap();
        assert_eq!(again.asset_id, row.asset_id);
        assert_eq!(ws.list_assets().unwrap().len(), 1);
        let (info, bytes) = ws.asset_bytes(&row.asset_id).unwrap().unwrap();
        assert_eq!(bytes, b"png bytes");
        assert_eq!(info.name.as_deref(), Some("Moon.PNG"));
        let unknown = ws
            .put_asset(b"x", None, Some("bogus".into()), |_| {})
            .unwrap();
        assert_eq!(unknown.mime_type, "application/octet-stream");
        assert_eq!(unknown.file, unknown.asset_id);
        ws.delete_asset(&row.asset_id).unwrap();
        assert!(ws.asset_bytes(&row.asset_id).unwrap().is_none());
        assert!(!dir.path().join(ASSETS_DIR).join(&row.file).exists());
        assert!(ws.asset_info("../x").is_err());
    }

    #[test]
    fn mirror_writes_changes_and_removes_stale_files_it_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let workspaces = Workspaces::default();
        let ws = attach(&workspaces, "ws1", dir.path());
        assert!(ws.mirror_begin().is_err(), "no folder yet");
        ws.write(|_| {}, |db| db.store("ws:ws1", &[1])).unwrap();
        let root = dir.path().join(MIRROR_DIR);
        ws.mirror_begin().unwrap();
        assert!(ws.mirror_write("Apollo.md", b"# Apollo").unwrap());
        assert!(ws.mirror_write("Apollo/Mission.md", b"go").unwrap());
        assert_eq!(
            ws.mirror_finish(&[]).unwrap(),
            MirrorReport {
                files: 2,
                removed: 0
            }
        );
        std::fs::write(root.join("mine.txt"), b"user file").unwrap();

        ws.mirror_begin().unwrap();
        assert!(
            !ws.mirror_write("Apollo.md", b"# Apollo").unwrap(),
            "unchanged"
        );
        assert!(ws.mirror_write("../escape.md", b"x").is_err());
        assert_eq!(
            ws.mirror_finish(&[]).unwrap(),
            MirrorReport {
                files: 1,
                removed: 1
            }
        );
        assert!(!root.join("Apollo").exists(), "empty folders are pruned");
        assert!(
            root.join("mine.txt").exists(),
            "files the mirror didn't write stay"
        );
        assert!(ws.mirror_write("x.md", b"x").is_err(), "no run in progress");
    }

    #[test]
    fn mirror_keeps_the_files_an_incremental_run_left_as_they_were() {
        let dir = tempfile::tempdir().unwrap();
        let workspaces = Workspaces::default();
        let ws = attach(&workspaces, "ws1", dir.path());
        ws.write(|_| {}, |db| db.store("ws:ws1", &[1])).unwrap();
        let root = dir.path().join(MIRROR_DIR);
        ws.mirror_begin().unwrap();
        ws.mirror_write("Apollo.md", b"# Apollo").unwrap();
        ws.mirror_write("Gemini.md", b"# Gemini").unwrap();
        ws.mirror_finish(&[]).unwrap();
        std::fs::write(root.join("mine.md"), b"user file").unwrap();

        // Only Gemini changed: Apollo stays. A file the mirror never wrote can't be kept.
        ws.mirror_begin().unwrap();
        ws.mirror_write("Gemini.md", b"# Gemini 2").unwrap();
        let keep = ["Apollo.md".to_string(), "mine.md".to_string()];
        assert_eq!(
            ws.mirror_finish(&keep).unwrap(),
            MirrorReport {
                files: 2,
                removed: 0
            }
        );
        assert!(root.join("Apollo.md").exists());

        // Apollo's page was deleted: the next run leaves it out, and the user's file stays.
        ws.mirror_begin().unwrap();
        ws.mirror_write("Gemini.md", b"# Gemini 2").unwrap();
        assert_eq!(
            ws.mirror_finish(&["mine.md".to_string()]).unwrap(),
            MirrorReport {
                files: 1,
                removed: 1
            }
        );
        assert!(!root.join("Apollo.md").exists());
        assert!(root.join("mine.md").exists());
    }

    #[test]
    fn merges_and_moves_conflicted_copies() {
        let dir = tempfile::tempdir().unwrap();
        let workspaces = Workspaces::default();
        let ws = attach(&workspaces, "ws1", dir.path());
        ws.write(|_| {}, |db| db.store("page:a", &[1])).unwrap();
        ws.read(|db| db.checkpoint()).unwrap();
        std::fs::copy(dir.path().join(DB_FILE), dir.path().join("tessera 2.db")).unwrap();
        assert_eq!(ws.status().unwrap().conflicts, vec!["tessera 2.db"]);
        let report = ws.merge_conflict("tessera 2.db", |_| {}).unwrap();
        assert_eq!(report.updates, 1);
        assert!(ws.status().unwrap().conflicts.is_empty());
        let names = |path: &Path| -> Vec<String> {
            std::fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        };
        // The copy (and any side files SQLite made for it) moved out of the way, not deleted.
        assert!(!names(dir.path())
            .iter()
            .any(|name| name.starts_with("tessera 2.db")));
        assert!(names(&dir.path().join(MERGED_DIR))
            .iter()
            .any(|name| name.ends_with("-tessera 2.db")));
        assert!(ws.merge_conflict("notes.db", |_| {}).is_err());
    }

    #[test]
    fn inspects_and_suggests_folders() {
        let dir = tempfile::tempdir().unwrap();
        let info = inspect_folder(&dir.path().join("nope").to_string_lossy()).unwrap();
        assert!(!info.exists && info.workspace.is_none());
        drop(
            WorkspaceDb::create(
                &dir.path().join("Apollo"),
                JournalMode::Wal,
                "ws1",
                "Apollo",
            )
            .unwrap(),
        );
        let info = inspect_folder(&dir.path().join("Apollo").to_string_lossy()).unwrap();
        assert_eq!(info.workspace.unwrap().id, "ws1");
        assert_eq!(info.name, "Apollo");
        let parent = dir.path().to_string_lossy();
        assert!(suggest_folder(&parent, "Apollo")
            .unwrap()
            .ends_with("Apollo 2"));
        assert!(suggest_folder(&parent, "New: idea?")
            .unwrap()
            .ends_with("New- idea-"));
    }

    #[test]
    fn sanitizes_folder_names() {
        assert_eq!(sanitize_folder_name("  "), "Workspace");
        assert_eq!(sanitize_folder_name("CON"), "CON_");
        assert_eq!(sanitize_folder_name("Notes..."), "Notes");
        assert_eq!(sanitize_folder_name("a/b\\c"), "a-b-c");
    }

    #[test]
    fn recognizes_mime_types_and_extensions() {
        assert!(is_mime("image/png"));
        assert!(is_mime("text/plain; charset=utf-8"));
        assert!(!is_mime("png"));
        assert!(!is_mime("image/<script>"));
        assert_eq!(
            extension_for(Some("a.tar.GZ"), "x/y").as_deref(),
            Some("gz")
        );
        assert_eq!(
            extension_for(Some("noext"), "image/jpeg").as_deref(),
            Some("jpg")
        );
        assert_eq!(extension_for(Some("evil.p/ng"), "x/y"), None);
    }
}
