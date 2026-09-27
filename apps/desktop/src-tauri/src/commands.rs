//! Every command the web side can call. Commands that touch the disk are `async` and do their
//! work on the blocking pool, so the UI thread never waits on SQLite or the file system. The
//! TypeScript mirror of this file is `apps/desktop/src/backend/tauri-backend.ts`, and the fake used
//! in tests is `apps/desktop/src/testing/fake-tauri.ts`: keep all three in step.

use crate::config::{clamp_zoom, Prefs, PrefsPatch, RegistryEntry, RegistryItem, ServerEntry};
use crate::db::{AssetRow, MergeReport};
use crate::deeplink::DeepLink;
use crate::error::{poisoned, Error, Result};
use crate::menu::{self, MenuSpec};
use crate::state::{AppState, OriginEvent, CAPTURE_WINDOW, MAIN_WINDOW};
use crate::updater::{self, UpdateInfo};
use crate::workspace::{self, FolderInfo, MirrorReport, WorkspaceStatus};
use crate::{lifecycle, secrets, validate, windows};
use base64::Engine;
use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, Webview};

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| Error::Internal(e.to_string()))?
}

fn header(request: &Request<'_>, name: &str) -> Result<String> {
    let value = request
        .headers()
        .get(name)
        .ok_or_else(|| Error::Invalid(format!("missing header {name}")))?
        .to_str()
        .map_err(|_| Error::Invalid(format!("header {name} is not ASCII")))?;
    Ok(percent_decode_str(value)
        .decode_utf8()
        .map_err(|_| Error::Invalid(format!("header {name} is not UTF-8")))?
        .into_owned())
}

fn optional_header(request: &Request<'_>, name: &str) -> Result<Option<String>> {
    if request.headers().contains_key(name) {
        header(request, name).map(|value| Some(value).filter(|v| !v.is_empty()))
    } else {
        Ok(None)
    }
}

/// The binary body of a request. Webviews that fall back to the JSON channel send an array of
/// byte values instead.
fn body(request: &Request<'_>) -> Result<Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .map(|value| value.as_u64().filter(|b| *b <= 255).map(|b| b as u8))
            .collect::<Option<Vec<u8>>>()
            .ok_or_else(|| Error::Invalid("the body is not a byte array".into())),
        _ => Err(Error::Invalid("expected a binary body".into())),
    }
}

fn state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

fn registry_changed(app: &AppHandle, origin: &str) {
    let _ = app.emit(
        "desktop://registry-changed",
        OriginEvent {
            origin: origin.to_string(),
        },
    );
}

// ---------------------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    window_label: String,
    os: &'static str,
    arch: &'static str,
    debug: bool,
    default_root: Option<String>,
    updates_configured: bool,
}

#[tauri::command]
pub async fn app_info(app: AppHandle, webview: Webview) -> Result<AppInfo> {
    let state = state(&app);
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        window_label: webview.label().to_string(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        debug: cfg!(debug_assertions),
        default_root: state
            .paths
            .default_root
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        updates_configured: updater::configured(&app),
    })
}

#[tauri::command]
pub async fn flush_done(app: AppHandle, webview: Webview) -> Result<()> {
    lifecycle::flush_done(&app, webview.label());
    Ok(())
}

#[tauri::command]
pub async fn app_quit(app: AppHandle) -> Result<()> {
    lifecycle::quit(&app, 0);
    Ok(())
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let parsed =
        url::Url::parse(&url).map_err(|_| Error::Invalid(format!("invalid URL {url:?}")))?;
    if !matches!(parsed.scheme(), "https" | "mailto") {
        return Err(Error::Invalid(
            "only https and mailto links open outside the app".into(),
        ));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| Error::Unavailable(e.to_string()))
}

#[tauri::command]
pub async fn links_take(app: AppHandle) -> Result<Vec<DeepLink>> {
    let state = state(&app);
    let mut pending = state.pending_links.lock().map_err(poisoned)?;
    Ok(std::mem::take(&mut *pending))
}

// ---------------------------------------------------------------------------------------------
// Windows, menus, preferences
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn menu_set(app: AppHandle, webview: Webview, spec: MenuSpec) -> Result<()> {
    if webview.label() != MAIN_WINDOW {
        return Err(Error::Invalid("only the main window sets the menus".into()));
    }
    menu::validate(&spec)?;
    // Menus must be created on the main thread on macOS.
    let (sender, receiver) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| -> Result<()> {
            let app_menu = menu::build(&handle, &spec.menu)?;
            handle.set_menu(app_menu)?;
            let tray_menu = menu::build(&handle, &spec.tray)?;
            if let Some(tray) = handle.tray_by_id(windows::TRAY_ID) {
                tray.set_menu(Some(tray_menu))?;
            }
            Ok(())
        })();
        let _ = sender.send(result);
    })?;
    blocking(move || {
        receiver
            .recv()
            .map_err(|e| Error::Internal(e.to_string()))?
    })
    .await
}

#[tauri::command]
pub async fn window_set_title(webview: Webview, title: String) -> Result<()> {
    let title: String = title
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect();
    webview.window().set_title(&title)?;
    Ok(())
}

/// `delta`: 1 zooms in, -1 zooms out, 0 resets. Returns the new zoom factor.
#[tauri::command]
pub async fn window_zoom(app: AppHandle, delta: i32) -> Result<f64> {
    let state = state(&app);
    let zoom = {
        let mut prefs = state.prefs.lock().map_err(poisoned)?;
        prefs.zoom = match delta.signum() {
            0 => 1.0,
            sign => clamp_zoom(prefs.zoom + 0.1 * f64::from(sign)),
        };
        prefs.save(&state.paths.prefs)?;
        prefs.zoom
    };
    for window in app.webview_windows().values() {
        let _ = window.set_zoom(zoom);
    }
    Ok(zoom)
}

#[tauri::command]
pub async fn window_toggle_fullscreen(webview: Webview) -> Result<()> {
    let window = webview.window();
    let fullscreen = window.is_fullscreen()?;
    window.set_fullscreen(!fullscreen)?;
    Ok(())
}

#[tauri::command]
pub async fn window_show_main(app: AppHandle) -> Result<()> {
    windows::show_main(&app);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefsView {
    #[serde(flatten)]
    prefs: Prefs,
    shortcut_error: Option<String>,
}

fn prefs_view(state: &AppState) -> Result<PrefsView> {
    Ok(PrefsView {
        prefs: state.prefs.lock().map_err(poisoned)?.clone(),
        shortcut_error: state.shortcut_error.lock().map_err(poisoned)?.clone(),
    })
}

#[tauri::command]
pub async fn prefs_get(app: AppHandle) -> Result<PrefsView> {
    prefs_view(&state(&app))
}

#[tauri::command]
pub async fn prefs_set(app: AppHandle, patch: PrefsPatch) -> Result<PrefsView> {
    let state = state(&app);
    let shortcut_changed = {
        let mut prefs = state.prefs.lock().map_err(poisoned)?;
        let before = (prefs.capture_enabled, prefs.capture_shortcut.clone());
        if let Some(value) = patch.close_to_tray {
            prefs.close_to_tray = value;
        }
        if let Some(value) = patch.capture_enabled {
            prefs.capture_enabled = value;
        }
        if let Some(value) = patch.capture_shortcut {
            let value = value.trim();
            if value.is_empty() || value.len() > 64 {
                return Err(Error::Invalid("invalid shortcut".into()));
            }
            prefs.capture_shortcut = value.to_string();
        }
        if let Some(value) = patch.check_updates {
            prefs.check_updates = value;
        }
        prefs.save(&state.paths.prefs)?;
        before != (prefs.capture_enabled, prefs.capture_shortcut.clone())
    };
    if shortcut_changed {
        windows::apply_shortcut(&app)?;
    }
    prefs_view(&state)
}

#[tauri::command]
pub async fn updates_mark_checked(app: AppHandle) -> Result<()> {
    let state = state(&app);
    let mut prefs = state.prefs.lock().map_err(poisoned)?;
    prefs.last_update_check = Some(crate::db::now_ms());
    prefs.save(&state.paths.prefs)
}

#[tauri::command]
pub async fn capture_show(app: AppHandle) -> Result<()> {
    windows::show_capture(&app)
}

#[tauri::command]
pub async fn capture_ready(app: AppHandle) -> Result<()> {
    windows::capture_ready(&app)
}

#[tauri::command]
pub async fn capture_hide(app: AppHandle) -> Result<()> {
    windows::hide_capture(&app)
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn registry_list(app: AppHandle) -> Result<Vec<RegistryItem>> {
    blocking(move || Ok(state(&app).registry.lock().map_err(poisoned)?.items())).await
}

#[tauri::command]
pub async fn registry_upsert(app: AppHandle, webview: Webview, entry: RegistryEntry) -> Result<()> {
    let origin = webview.label().to_string();
    let handle = app.clone();
    blocking(move || {
        state(&handle)
            .registry
            .lock()
            .map_err(poisoned)?
            .upsert(entry)
    })
    .await?;
    registry_changed(&app, &origin);
    Ok(())
}

#[tauri::command]
pub async fn registry_remove(app: AppHandle, webview: Webview, id: String) -> Result<()> {
    let origin = webview.label().to_string();
    let handle = app.clone();
    blocking(move || {
        state(&handle)
            .registry
            .lock()
            .map_err(poisoned)?
            .remove(&id)
    })
    .await?;
    registry_changed(&app, &origin);
    Ok(())
}

#[tauri::command]
pub async fn registry_touch(app: AppHandle, webview: Webview, id: String) -> Result<RegistryEntry> {
    let origin = webview.label().to_string();
    let handle = app.clone();
    let entry =
        blocking(move || state(&handle).registry.lock().map_err(poisoned)?.touch(&id)).await?;
    registry_changed(&app, &origin);
    Ok(entry)
}

// ---------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn folder_inspect(path: String) -> Result<FolderInfo> {
    blocking(move || workspace::inspect_folder(&path)).await
}

#[tauri::command]
pub async fn folder_suggest(parent: String, name: String) -> Result<String> {
    blocking(move || workspace::suggest_folder(&parent, &name)).await
}

#[tauri::command]
pub async fn folder_pick(
    app: AppHandle,
    title: String,
    default_path: Option<String>,
) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let title: String = title.chars().take(200).collect();
    blocking(move || {
        let mut dialog = app.dialog().file().set_title(title);
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            dialog = dialog.set_parent(&window);
        }
        if let Some(path) = default_path.filter(|p| std::path::Path::new(p).is_dir()) {
            dialog = dialog.set_directory(path);
        }
        match dialog.blocking_pick_folder() {
            Some(path) => {
                let path = path
                    .into_path()
                    .map_err(|e| Error::Invalid(e.to_string()))?;
                Ok(Some(path.to_string_lossy().into_owned()))
            }
            None => Ok(None),
        }
    })
    .await
}

/// Shows a folder in Finder, Explorer or the file manager. A workspace that was never written to
/// has no folder yet; it is created (empty) so the user sees where their workspace will live.
#[tauri::command]
pub async fn folder_reveal(app: AppHandle, path: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let folder = validate::absolute_folder(&path)?;
    let handle = app.clone();
    let folder = blocking(move || {
        if !folder.exists() {
            let registered = state(&handle)
                .registry
                .lock()
                .map_err(poisoned)?
                .items()
                .iter()
                .any(|item| std::path::Path::new(&item.entry.path) == folder);
            if !registered {
                return Err(Error::NotFound(format!(
                    "{} does not exist",
                    folder.display()
                )));
            }
            std::fs::create_dir_all(&folder)?;
        }
        Ok(folder)
    })
    .await?;
    app.opener()
        .reveal_item_in_dir(&folder)
        .map_err(|e| Error::Unavailable(e.to_string()))
}

// ---------------------------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn workspace_attach(
    app: AppHandle,
    workspace_id: String,
    path: String,
    name: String,
) -> Result<WorkspaceStatus> {
    blocking(move || {
        Ok(state(&app)
            .workspaces
            .attach(&workspace_id, &path, &name)?
            .1)
    })
    .await
}

#[tauri::command]
pub async fn workspace_detach(app: AppHandle, workspace_id: String) -> Result<()> {
    blocking(move || state(&app).workspaces.detach(&workspace_id)).await
}

#[tauri::command]
pub async fn workspace_status(app: AppHandle, workspace_id: String) -> Result<WorkspaceStatus> {
    blocking(move || state(&app).workspaces.get(&workspace_id)?.status()).await
}

#[tauri::command]
pub async fn workspace_set_name(app: AppHandle, workspace_id: String, name: String) -> Result<()> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(Error::Invalid(
            "workspace names must have 1 to 100 characters".into(),
        ));
    }
    blocking(move || state(&app).workspaces.get(&workspace_id)?.set_name(&name)).await
}

#[tauri::command]
pub async fn workspace_merge_conflict(
    app: AppHandle,
    workspace_id: String,
    file_name: String,
) -> Result<MergeReport> {
    blocking(move || {
        let state = state(&app);
        let ws = state.workspaces.get(&workspace_id)?;
        ws.merge_conflict(&file_name, |id| state.workspace_created(&app, id))
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------------------------

/// `[u64 maxSeq][u32 count]` then `count` times `[u32 length][bytes]`, little-endian.
fn encode_frame(max_seq: i64, updates: &[Vec<u8>]) -> Vec<u8> {
    let size = 12 + updates.iter().map(|u| 4 + u.len()).sum::<usize>();
    let mut frame = Vec::with_capacity(size);
    frame.extend_from_slice(&(max_seq.max(0) as u64).to_le_bytes());
    frame.extend_from_slice(&(updates.len() as u32).to_le_bytes());
    for update in updates {
        frame.extend_from_slice(&(update.len() as u32).to_le_bytes());
        frame.extend_from_slice(update);
    }
    frame
}

#[tauri::command]
pub async fn doc_load(app: AppHandle, workspace_id: String, doc_name: String) -> Result<Response> {
    validate::doc_name(&doc_name)?;
    let (max, updates) = blocking(move || {
        let ws = state(&app).workspaces.get(&workspace_id)?;
        Ok(ws.read(|db| db.load(&doc_name))?.unwrap_or((0, Vec::new())))
    })
    .await?;
    Ok(Response::new(encode_frame(max, &updates)))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocUpdateEvent {
    workspace_id: String,
    doc_name: String,
    /// Base64.
    update: String,
    origin: String,
}

#[tauri::command]
pub async fn doc_store(app: AppHandle, webview: Webview, request: Request<'_>) -> Result<()> {
    let workspace_id = header(&request, "x-tessera-workspace")?;
    let doc_name = header(&request, "x-tessera-doc")?;
    validate::doc_name(&doc_name)?;
    let bytes = std::sync::Arc::new(body(&request)?);
    let handle = app.clone();
    let (ws_id, doc, stored) = (workspace_id.clone(), doc_name.clone(), bytes.clone());
    blocking(move || {
        let state = state(&handle);
        let ws = state.workspaces.get(&ws_id)?;
        ws.write(
            |id| state.workspace_created(&handle, id),
            |db| db.store(&doc, &stored),
        )
    })
    .await?;
    // Other windows with the same doc open apply it (DocStore.watch).
    if app.webview_windows().len() > 1 {
        let event = DocUpdateEvent {
            workspace_id,
            doc_name,
            update: base64::engine::general_purpose::STANDARD.encode(bytes.as_slice()),
            origin: webview.label().to_string(),
        };
        let _ = app.emit("desktop://doc-update", event);
    }
    Ok(())
}

#[tauri::command]
pub async fn doc_compact(app: AppHandle, request: Request<'_>) -> Result<()> {
    let workspace_id = header(&request, "x-tessera-workspace")?;
    let doc_name = header(&request, "x-tessera-doc")?;
    validate::doc_name(&doc_name)?;
    let upto: i64 = header(&request, "x-tessera-upto")?
        .parse()
        .map_err(|_| Error::Invalid("invalid x-tessera-upto".into()))?;
    let bytes = body(&request)?;
    blocking(move || {
        let ws = state(&app).workspaces.get(&workspace_id)?;
        ws.read(|db| db.compact(&doc_name, upto, &bytes))?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn doc_delete(app: AppHandle, workspace_id: String, doc_name: String) -> Result<()> {
    validate::doc_name(&doc_name)?;
    blocking(move || {
        let ws = state(&app).workspaces.get(&workspace_id)?;
        ws.read(|db| db.delete_doc(&doc_name))?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn doc_list(app: AppHandle, workspace_id: String, prefix: String) -> Result<Vec<String>> {
    if prefix.len() > 200 {
        return Err(Error::Invalid("prefix too long".into()));
    }
    blocking(move || {
        let ws = state(&app).workspaces.get(&workspace_id)?;
        Ok(ws.read(|db| db.list_docs(&prefix))?.unwrap_or_default())
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------------------------

/// Largest attachment accepted (the IPC body is held in memory).
const MAX_ASSET_BYTES: usize = 512 * 1024 * 1024;

#[tauri::command]
pub async fn asset_put(app: AppHandle, request: Request<'_>) -> Result<AssetRow> {
    let workspace_id = header(&request, "x-tessera-workspace")?;
    let name = optional_header(&request, "x-tessera-name")?;
    let mime = optional_header(&request, "x-tessera-mime")?;
    let bytes = body(&request)?;
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(Error::Invalid(
            "files larger than 512 MB can't be attached".into(),
        ));
    }
    let handle = app.clone();
    blocking(move || {
        let state = state(&handle);
        let ws = state.workspaces.get(&workspace_id)?;
        ws.put_asset(&bytes, name, mime, |id| {
            state.workspace_created(&handle, id)
        })
    })
    .await
}

#[tauri::command]
pub async fn asset_get(app: AppHandle, workspace_id: String, asset_id: String) -> Result<Response> {
    let bytes = blocking(move || {
        let ws = state(&app).workspaces.get(&workspace_id)?;
        ws.asset_bytes(&asset_id)?
            .map(|(_, bytes)| bytes)
            .ok_or_else(|| Error::NotFound(format!("asset {asset_id} not found")))
    })
    .await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn asset_info(
    app: AppHandle,
    workspace_id: String,
    asset_id: String,
) -> Result<Option<AssetRow>> {
    blocking(move || {
        state(&app)
            .workspaces
            .get(&workspace_id)?
            .asset_info(&asset_id)
    })
    .await
}

#[tauri::command]
pub async fn asset_list(app: AppHandle, workspace_id: String) -> Result<Vec<AssetRow>> {
    blocking(move || state(&app).workspaces.get(&workspace_id)?.list_assets()).await
}

#[tauri::command]
pub async fn asset_delete(app: AppHandle, workspace_id: String, asset_id: String) -> Result<()> {
    blocking(move || {
        state(&app)
            .workspaces
            .get(&workspace_id)?
            .delete_asset(&asset_id)
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// Markdown mirror
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn mirror_begin(app: AppHandle, workspace_id: String) -> Result<()> {
    blocking(move || state(&app).workspaces.get(&workspace_id)?.mirror_begin()).await
}

#[tauri::command]
pub async fn mirror_write(app: AppHandle, request: Request<'_>) -> Result<bool> {
    let workspace_id = header(&request, "x-tessera-workspace")?;
    let path = header(&request, "x-tessera-path")?;
    let bytes = body(&request)?;
    blocking(move || {
        state(&app)
            .workspaces
            .get(&workspace_id)?
            .mirror_write(&path, &bytes)
    })
    .await
}

/// `keep`: files an incremental run left as they were (see `Workspace::mirror_finish`).
#[tauri::command]
pub async fn mirror_finish(
    app: AppHandle,
    workspace_id: String,
    keep: Option<Vec<String>>,
) -> Result<MirrorReport> {
    blocking(move || {
        state(&app)
            .workspaces
            .get(&workspace_id)?
            .mirror_finish(keep.as_deref().unwrap_or_default())
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn secret_get(server: String) -> Result<Option<String>> {
    blocking(move || secrets::get(&server)).await
}

#[tauri::command]
pub async fn secret_set(app: AppHandle, server: String, token: String) -> Result<()> {
    blocking(move || secrets::set(&state(&app), &server, &token)).await
}

#[tauri::command]
pub async fn secret_delete(app: AppHandle, server: String) -> Result<()> {
    blocking(move || secrets::delete(&state(&app), &server)).await
}

#[tauri::command]
pub async fn secret_servers(app: AppHandle) -> Result<Vec<ServerEntry>> {
    blocking(move || secrets::list(&state(&app))).await
}

// ---------------------------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<UpdateInfo> {
    updater::check(&app).await
}

#[tauri::command]
pub async fn updater_install(app: AppHandle, webview: Webview) -> Result<()> {
    if webview.label() == CAPTURE_WINDOW {
        return Err(Error::Invalid(
            "updates are installed from the main window".into(),
        ));
    }
    updater::install(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_updates() {
        let frame = encode_frame(7, &[vec![1, 2], vec![3]]);
        assert_eq!(&frame[0..8], &7u64.to_le_bytes());
        assert_eq!(&frame[8..12], &2u32.to_le_bytes());
        assert_eq!(&frame[12..16], &2u32.to_le_bytes());
        assert_eq!(&frame[16..18], &[1, 2]);
        assert_eq!(&frame[18..22], &1u32.to_le_bytes());
        assert_eq!(frame[22], 3);
        assert_eq!(encode_frame(0, &[]).len(), 12);
    }
}
