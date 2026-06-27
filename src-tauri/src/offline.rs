// Offline OpenFreeMap vector-tile download + serving.
//
// Tiles are fetched from OpenFreeMap's planet endpoint by the Rust backend and
// stored on disk under <app_data_dir>/tiles/{z}/{x}/{y}.pbf. The frontend asks
// for them through the `get_tile` command (the Tauri bridge), which keeps tile
// delivery local and fast.

use std::f64::consts::PI;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const TILE_URL_BASE: &str = "https://tiles.openfreemap.org/planet/20260621_080001_pt";
const MIN_ZOOM: u32 = 0;
const MAX_ZOOM: u32 = 14;
// Rough average compressed size of an OpenMapTiles vector tile. Only used for
// the up-front size estimate; the real total is reported as bytes arrive.
const AVG_TILE_BYTES: u64 = 60_000;

#[derive(Serialize, Clone)]
pub struct ZoomPlan {
    zoom: u32,
    tiles: usize,
    est_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct DownloadPlan {
    per_zoom: Vec<ZoomPlan>,
    total_tiles: usize,
    total_est_bytes: u64,
}

#[derive(Serialize, Clone)]
struct Progress {
    name: String,
    zoom: u32,
    done: usize,
    total: usize,
    bytes: u64,
    eta_seconds: u64,
}

#[derive(Serialize, serde::Deserialize, Clone)]
pub struct Region {
    name: String,
    lat: f64,
    lon: f64,
    radius_m: f64,
}

// --- slippy-map tile math ---------------------------------------------------

fn lon_to_x(lon: f64, z: u32) -> f64 {
    (lon + 180.0) / 360.0 * (1u64 << z) as f64
}
fn lat_to_y(lat: f64, z: u32) -> f64 {
    let r = lat.to_radians();
    (1.0 - (r.tan() + 1.0 / r.cos()).ln() / PI) / 2.0 * (1u64 << z) as f64
}
fn x_to_lon(x: f64, z: u32) -> f64 {
    x / (1u64 << z) as f64 * 360.0 - 180.0
}
fn y_to_lat(y: f64, z: u32) -> f64 {
    let n = PI - 2.0 * PI * y / (1u64 << z) as f64;
    n.sinh().atan().to_degrees()
}

// Approximate distance (metres) between two lon/lat points (equirectangular —
// fine at the 1 km scale we work with).
fn dist_m(lon1: f64, lat1: f64, lon2: f64, lat2: f64) -> f64 {
    let mean_lat = ((lat1 + lat2) / 2.0).to_radians();
    let dx = (lon2 - lon1) * mean_lat.cos() * 111_320.0;
    let dy = (lat2 - lat1) * 111_320.0;
    (dx * dx + dy * dy).sqrt()
}

// All tiles whose bounding box intersects the circle, for every zoom level.
fn tiles_for_region(lat: f64, lon: f64, radius_m: f64) -> Vec<(u32, u32, u32)> {
    let d_lat = radius_m / 111_320.0;
    let d_lon = radius_m / (111_320.0 * lat.to_radians().cos());
    let (west, east) = (lon - d_lon, lon + d_lon);
    let (south, north) = (lat - d_lat, lat + d_lat);

    let mut out = Vec::new();
    for z in MIN_ZOOM..=MAX_ZOOM {
        let max_idx = (1u64 << z) as i64 - 1;
        let x0 = lon_to_x(west, z).floor() as i64;
        let x1 = lon_to_x(east, z).floor() as i64;
        let y0 = lat_to_y(north, z).floor() as i64;
        let y1 = lat_to_y(south, z).floor() as i64;
        for x in x0..=x1 {
            for y in y0..=y1 {
                if x < 0 || y < 0 || x > max_idx || y > max_idx {
                    continue;
                }
                // Nearest point of the tile bbox to the circle centre.
                let tw = x_to_lon(x as f64, z);
                let te = x_to_lon(x as f64 + 1.0, z);
                let tn = y_to_lat(y as f64, z);
                let ts = y_to_lat(y as f64 + 1.0, z);
                let clon = lon.clamp(tw, te);
                let clat = lat.clamp(ts, tn);
                if dist_m(lon, lat, clon, clat) <= radius_m {
                    out.push((z, x as u32, y as u32));
                }
            }
        }
    }
    out
}

// --- paths ------------------------------------------------------------------

fn tiles_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("no app data dir")
        .join("tiles")
}

fn regions_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("no app data dir")
        .join("regions.json")
}

fn read_regions(app: &AppHandle) -> Vec<Region> {
    std::fs::read_to_string(regions_file(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

// --- commands ---------------------------------------------------------------

#[tauri::command]
pub fn plan_download(lat: f64, lon: f64, radius_m: f64) -> DownloadPlan {
    let tiles = tiles_for_region(lat, lon, radius_m);
    let mut per_zoom: Vec<ZoomPlan> = Vec::new();
    for z in MIN_ZOOM..=MAX_ZOOM {
        let count = tiles.iter().filter(|(tz, _, _)| *tz == z).count();
        if count > 0 {
            per_zoom.push(ZoomPlan {
                zoom: z,
                tiles: count,
                est_bytes: count as u64 * AVG_TILE_BYTES,
            });
        }
    }
    let total_tiles = tiles.len();
    DownloadPlan {
        total_tiles,
        total_est_bytes: total_tiles as u64 * AVG_TILE_BYTES,
        per_zoom,
    }
}

#[tauri::command]
pub async fn download_region(
    app: AppHandle,
    name: String,
    lat: f64,
    lon: f64,
    radius_m: f64,
) -> Result<(), String> {
    let tiles = tiles_for_region(lat, lon, radius_m);
    let total = tiles.len();
    let dir = tiles_dir(&app);

    let client = reqwest::Client::builder()
        .user_agent("tauri-app-offline-tiles/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let start = std::time::Instant::now();
    let mut bytes: u64 = 0;

    for (i, (z, x, y)) in tiles.iter().enumerate() {
        let url = format!("{TILE_URL_BASE}/{z}/{x}/{y}.pbf");
        let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
        let status = resp.status();

        if status.as_u16() == 429 {
            let _ = app.emit(
                "download-error",
                "OpenFreeMap vrátil 429 (příliš mnoho požadavků). Stahování zastaveno.",
            );
            return Err("rate_limited".into());
        }

        if status.is_success() && status.as_u16() != 204 {
            let body = resp.bytes().await.map_err(|e| e.to_string())?;
            bytes += body.len() as u64;
            let tile_dir = dir.join(z.to_string()).join(x.to_string());
            std::fs::create_dir_all(&tile_dir).map_err(|e| e.to_string())?;
            std::fs::write(tile_dir.join(format!("{y}.pbf")), &body)
                .map_err(|e| e.to_string())?;
        }
        // 204 / 404 => no data at this tile, nothing to store.

        let done = i + 1;
        let elapsed = start.elapsed().as_secs_f64();
        let eta = if done > 0 {
            (elapsed / done as f64 * (total - done) as f64) as u64
        } else {
            0
        };
        let _ = app.emit(
            "download-progress",
            Progress {
                name: name.clone(),
                zoom: *z,
                done,
                total,
                bytes,
                eta_seconds: eta,
            },
        );
    }

    // Persist the region so the map can show what is downloaded.
    let mut regions = read_regions(&app);
    regions.retain(|r| r.name != name);
    regions.push(Region {
        name: name.clone(),
        lat,
        lon,
        radius_m,
    });
    std::fs::create_dir_all(regions_file(&app).parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(
        regions_file(&app),
        serde_json::to_string(&regions).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let _ = app.emit("download-done", &name);
    Ok(())
}

#[tauri::command]
pub fn get_tile(app: AppHandle, z: u32, x: u32, y: u32) -> tauri::ipc::Response {
    let path = tiles_dir(&app)
        .join(z.to_string())
        .join(x.to_string())
        .join(format!("{y}.pbf"));
    let bytes = std::fs::read(path).unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

#[tauri::command]
pub fn get_regions(app: AppHandle) -> Vec<Region> {
    read_regions(&app)
}
