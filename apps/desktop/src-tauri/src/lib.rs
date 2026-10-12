//! Tessera desktop: a Tauri 2 window running the web app (`apps/web`), with workspaces stored as
//! folders (`tessera.db` + `assets/`), native menus, a tray icon, quick capture, deep links and
//! updates. The web side lives in `apps/desktop/src` (TypeScript) and talks to `commands.rs`.

mod cloud;
mod commands;
mod config;
mod db;
mod deeplink;
mod error;
mod lifecycle;
mod menu;
mod protocol;
mod secrets;
mod state;
mod updater;
mod validate;
mod windows;
mod workspace;

use state::{AppState, CAPTURE_WINDOW, MAIN_WINDOW};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent};

/// Queues deep links and tells the main window to take them (`links_take`), so a link that
/// arrives before the page is listening is not lost.
fn handle_links<R: Runtime>(app: &AppHandle<R>, links: Vec<deeplink::DeepLink>) {
    if links.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    if let Ok(mut pending) = state.pending_links.lock() {
        pending.extend(links);
    }
    windows::show_main(app);
    let _ = app.emit_to(MAIN_WINDOW, "desktop://deep-link", ());
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "app.quit" => lifecycle::quit(app, 0),
        "tray.show" => windows::show_main(app),
        "tray.capture" | "app.capture" => {
            if let Err(error) = windows::show_capture(app) {
                log::warn!("quick capture: {error}");
            }
        }
        _ => {
            // Everything else runs a command in the web app.
            if id.starts_with("tray.") {
                windows::show_main(app);
            }
            let _ = app.emit_to(MAIN_WINDOW, "desktop://menu", id.to_string());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Must be the first plugin: a second launch hands its arguments (deep links) to this one.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            windows::show_main(app);
            handle_links(app, deeplink::from_args(argv));
        }));
    }

    builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .max_file_size(2_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&[CAPTURE_WINDOW])
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(protocol::handle(&app, &request));
            });
        })
        .on_menu_event(|app, event| on_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| match (window.label(), event) {
            (MAIN_WINDOW, WindowEvent::CloseRequested { api, .. }) => {
                let app = window.app_handle();
                let close_to_tray = app
                    .state::<AppState>()
                    .prefs
                    .lock()
                    .map(|p| p.close_to_tray)
                    .unwrap_or(false);
                api.prevent_close();
                if close_to_tray {
                    let _ = window.hide();
                } else {
                    lifecycle::quit(app, 0);
                }
            }
            (CAPTURE_WINDOW, WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            // Quick capture behaves like a popover: clicking elsewhere puts it away (the draft
            // stays in the page for next time).
            (CAPTURE_WINDOW, WindowEvent::Focused(false)) => {
                let _ = window.hide();
            }
            _ => {}
        })
        .setup(|app| {
            let state = AppState::load(app.handle())?;
            let zoom = state.prefs.lock().map(|p| p.zoom).unwrap_or(1.0);
            app.manage(state);

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::ShortcutState;
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, _shortcut, event| {
                            if event.state() == ShortcutState::Pressed {
                                if let Err(error) = windows::show_capture(app) {
                                    log::warn!("quick capture: {error}");
                                }
                            }
                        })
                        .build(),
                )?;
                if let Err(error) = windows::apply_shortcut(app.handle()) {
                    log::warn!("quick capture shortcut: {error}");
                }
            }

            windows::create_tray(app.handle())?;

            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Installers register the scheme; development builds and AppImages register it
                // at runtime.
                #[cfg(any(windows, target_os = "linux"))]
                if cfg!(debug_assertions) || std::env::var_os("APPIMAGE").is_some() {
                    if let Err(error) = app.deep_link().register_all() {
                        log::warn!("could not register tessera:// links: {error}");
                    }
                }
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let links = event
                        .urls()
                        .iter()
                        .filter_map(|url| deeplink::parse(url.as_str()))
                        .collect();
                    handle_links(&handle, links);
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let links = urls
                        .iter()
                        .filter_map(|url| deeplink::parse(url.as_str()))
                        .collect();
                    handle_links(app.handle(), links);
                }
            }

            // The main window starts hidden so its saved size and position apply before it shows.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                use tauri_plugin_window_state::{StateFlags, WindowExt};
                let _ = window.restore_state(StateFlags::all() & !StateFlags::VISIBLE);
                if (zoom - 1.0).abs() > f64::EPSILON {
                    let _ = window.set_zoom(zoom);
                }
                window.show()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::app_quit,
            commands::flush_done,
            commands::open_external,
            commands::links_take,
            commands::menu_set,
            commands::window_set_title,
            commands::window_zoom,
            commands::window_toggle_fullscreen,
            commands::window_show_main,
            commands::prefs_get,
            commands::prefs_set,
            commands::updates_mark_checked,
            commands::capture_show,
            commands::capture_ready,
            commands::capture_hide,
            commands::registry_list,
            commands::registry_upsert,
            commands::registry_remove,
            commands::registry_touch,
            commands::folder_inspect,
            commands::folder_suggest,
            commands::folder_pick,
            commands::folder_reveal,
            commands::file_save,
            commands::window_print,
            commands::workspace_attach,
            commands::workspace_detach,
            commands::workspace_status,
            commands::workspace_set_name,
            commands::workspace_merge_conflict,
            commands::doc_load,
            commands::doc_store,
            commands::doc_compact,
            commands::doc_delete,
            commands::doc_list,
            commands::asset_put,
            commands::asset_get,
            commands::asset_info,
            commands::asset_list,
            commands::asset_delete,
            commands::mirror_begin,
            commands::mirror_write,
            commands::mirror_finish,
            commands::secret_get,
            commands::secret_set,
            commands::secret_delete,
            commands::secret_servers,
            commands::updater_check,
            commands::updater_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Tessera desktop app")
        .run(|app, event| match event {
            // Flush every window and close the databases before really exiting.
            RunEvent::ExitRequested { api, code, .. }
                if !app.state::<AppState>().exit.is_ready() =>
            {
                api.prevent_exit();
                lifecycle::quit(app, code.unwrap_or(0));
            }
            // macOS: clicking the Dock icon brings the hidden window back.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows,
                ..
            } if !has_visible_windows => windows::show_main(app),
            _ => {}
        });
}
