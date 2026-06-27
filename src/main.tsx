import React from "react";
import ReactDOM from "react-dom/client";
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
    checkPermissions,
    requestPermissions,
    getCurrentPosition,
} from '@tauri-apps/plugin-geolocation';
import {isTauri, invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import libertyStyle from "./liberty-style.json";


// Geolocation in tauri works only on iOS/Android
// General discussion: https://github.com/orgs/tauri-apps/discussions/6048#discussioncomment-11967854
// desktop+polyfill? issue: https://github.com/tauri-apps/plugins-workspace/issues/2074


const getPositionOrDenial = async () => {

    //-- NEFUNGUJE
    console.log("NEFUNGUJE CONSOLE !!! Tauri Geolocation plugin is available");

    if(isTauri()) {
        console.log({window});


        // this._geolocationWatchID = window.navigator.geolocation.watchPosition(
        //                     this._onSuccess, this._onError, positionOptions);
        //window.navigator.geolocation.getCurrentPosition(
        //                 this._onSuccess, this._onError, this.options.positionOptions);
        //window.navigator.geolocation.clearWatch(this._geolocationWatchID);


    }

    let permissions = await checkPermissions();
    if (
        permissions.location === 'prompt' ||
        permissions.location === 'prompt-with-rationale'
    ) {
        permissions = await requestPermissions(['location']);
    }

    if (permissions.location !== 'granted') {
        return "denied";
    }

    const res = await getCurrentPosition();
    const { coords: {latitude, longitude }} = res;
    return {latitude, longitude};

    // await watchPosition(
    //     { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    //     (pos) => {
    //       console.log(pos);
    //     }
    //   );
}




// --- Offline tile download ---------------------------------------------------

// Locations the user can pre-download (all with a 1 km radius).
type Loc = { name: string; lat: number; lon: number; radius: number };
const LOCATIONS: Loc[] = [
    { name: "Liboc", lat: 50.0917934, lon: 14.3218556, radius: 1000 },
    { name: "Staré Město", lat: 50.0880997, lon: 14.4219519, radius: 1000 },
    { name: "Roviště", lat: 49.6608700, lon: 14.2561431, radius: 1000 },
];

type ZoomPlan = { zoom: number; tiles: number; est_bytes: number };
type DownloadPlan = { per_zoom: ZoomPlan[]; total_tiles: number; total_est_bytes: number };
type Progress = { name: string; zoom: number; done: number; total: number; bytes: number; eta_seconds: number };
type Region = { name: string; lat: number; lon: number; radius_m: number };

const fmtMB = (bytes: number) => (bytes / 1_000_000).toFixed(2) + " MB";

// MapLibre asks for offline resources (tiles, glyphs, sprite) through this
// protocol; we answer from disk via the Tauri bridge (the `get_asset` command).
maplibregl.addProtocol("offline", async (params) => {
    const path = decodeURIComponent(params.url.replace(/^offline:\/\//, ""));
    const bytes = await invoke<ArrayBuffer>("get_asset", { path });
    if (params.type === "json") {
        return { data: JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) };
    }
    return { data: bytes };
});

// OpenFreeMap "liberty" style (bundled), rewired to read vector tiles from disk
// so no network is needed for the map geometry once tiles are downloaded.
function buildOfflineStyle(): any {
    const style = JSON.parse(JSON.stringify(libertyStyle));
    style.sources.openmaptiles = {
        type: "vector",
        tiles: ["offline://tiles/{z}/{x}/{y}.pbf"],
        minzoom: 0,
        maxzoom: 14,
    };
    // Read fonts and icons from disk too, so the style is fully offline.
    style.glyphs = "offline://glyphs/{fontstack}/{range}.pbf";
    style.sprite = "offline://sprite/ofm";
    // Drop the online natural-earth raster so the style is fully offline.
    delete style.sources.ne2_shaded;
    style.layers = style.layers.filter((l: any) => l.source !== "ne2_shaded");

    // Add hillshading DEM source (terrarium encoding) and hillshade layer.
    style.sources.hillshading = {
        type: "raster-dem",
        tiles: ["offline://hillshading/{z}/{x}/{y}.webp"],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 14,
        encoding: "terrarium",
    };
    // Insert the hillshade layer just above the background so terrain shading
    // shows through without obscuring labels or roads.
    const bgIdx = style.layers.findIndex((l: any) => l.type !== "background");
    const insertAt = bgIdx >= 0 ? bgIdx : 0;
    style.layers.splice(insertAt, 0, {
        id: "hillshading",
        type: "hillshade",
        source: "hillshading",
        paint: {
            "hillshade-exaggeration": 0.5,
        },
    });

    return style;
}

// Polygon approximating a circle of the given radius (metres).
function circlePolygon(lon: number, lat: number, radiusM: number, points = 64): number[][] {
    const dLat = radiusM / 111_320;
    const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
    const ring: number[][] = [];
    for (let i = 0; i <= points; i++) {
        const t = (2 * Math.PI * i) / points;
        ring.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
    }
    return ring;
}

// Draw a green circle for every downloaded region as "what's offline" signalling.
async function showRegions(map: maplibregl.Map) {
    const regions = await invoke<Region[]>("get_regions");
    const fc = {
        type: "FeatureCollection" as const,
        features: regions.map((r) => ({
            type: "Feature" as const,
            properties: { name: r.name },
            geometry: { type: "Polygon" as const, coordinates: [circlePolygon(r.lon, r.lat, r.radius_m)] },
        })),
    };
    const existing = map.getSource("regions") as maplibregl.GeoJSONSource | undefined;
    if (existing) {
        existing.setData(fc as any);
        return;
    }
    map.addSource("regions", { type: "geojson", data: fc as any });
    map.addLayer({ id: "regions-line", type: "line", source: "regions", paint: { "line-color": "#d50000", "line-width": 3 } });
}

const App = () => {
    const [location, setLocation] = React.useState("");
    const [plan, setPlan] = React.useState<DownloadPlan | null>(null);
    const [progress, setProgress] = React.useState<Progress | null>(null);
    const [status, setStatus] = React.useState("");
    const [error, setError] = React.useState("");
    const [busy, setBusy] = React.useState(false);

    React.useEffect(() => {
        const unP = listen<Progress>("download-progress", (e) => setProgress(e.payload));
        const unS = listen<string>("download-status", (e) => setStatus(e.payload));
        const unE = listen<string>("download-error", (e) => setError(e.payload));
        return () => { unP.then((f) => f()); unS.then((f) => f()); unE.then((f) => f()); };
    }, []);

    const onClick = async () => {
        const pos = await getPositionOrDenial();
        setLocation(JSON.stringify(pos));
    };

    const onDownload = async (loc: Loc) => {
        setBusy(true);
        setError("");
        setProgress(null);
        // 1. Show the plan: tiles per zoom + size estimate.
        const p = await invoke<DownloadPlan>("plan_download", { lat: loc.lat, lon: loc.lon, radiusM: loc.radius });
        setPlan(p);
        try {
            // 2. Download (progress arrives via events).
            await invoke("download_region", { name: loc.name, lat: loc.lat, lon: loc.lon, radiusM: loc.radius });
            // 3. Switch to the offline style and centre on the area.
            const style = buildOfflineStyle();
            map.once("style.load", () => { showRegions(map); });
            map.setStyle(style, { diff: false });
            map.flyTo({ center: [loc.lon, loc.lat], zoom: 13 });
        } catch {
            // error already surfaced via the download-error event
        } finally {
            setBusy(false);
        }
    };

    return <div id="panel">
        <h1>MapLibre GL JS Example</h1>

        <input/>
        <button onClick={onClick}>Get Location</button>
        <div>{location}</div>

        <h3>Offline mapy (OpenFreeMap)</h3>
        {LOCATIONS.map((loc) => (
            <button key={loc.name} disabled={busy} onClick={() => onDownload(loc)} style={{ display: "block", margin: "4px 0" }}>
                Stáhnout {loc.name} (+{loc.radius / 1000} km)
            </button>
        ))}

        {plan && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
                <b>Plán stahování:</b>
                <table style={{ borderCollapse: "collapse" }}>
                    <thead><tr><th style={{ textAlign: "left", paddingRight: 8 }}>zoom</th><th style={{ textAlign: "left", paddingRight: 8 }}>dlaždic</th><th style={{ textAlign: "left" }}>odhad</th></tr></thead>
                    <tbody>
                        {plan.per_zoom.map((z) => (
                            <tr key={z.zoom}><td>{z.zoom}</td><td>{z.tiles}</td><td>{fmtMB(z.est_bytes)}</td></tr>
                        ))}
                    </tbody>
                </table>
                <div>Celkem: {plan.total_tiles} dlaždic, odhad {fmtMB(plan.total_est_bytes)}</div>
            </div>
        )}

        {status && <div style={{ marginTop: 8, fontSize: 13 }}>{status}</div>}

        {progress && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
                <b>Stahuji…</b> {progress.done}/{progress.total} dlaždic (zoom {progress.zoom})<br/>
                staženo {fmtMB(progress.bytes)}, ETA {progress.eta_seconds}s
                <div style={{ height: 8, background: "#ccc", marginTop: 4 }}>
                    <div style={{ height: 8, width: `${(progress.done / progress.total) * 100}%`, background: "#2e7d32" }}/>
                </div>
            </div>
        )}

        {error && <div style={{ marginTop: 8, color: "#c62828", fontSize: 13 }}>{error}</div>}
    </div>;
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
      <App/>
  </React.StrictMode>,
);


const map = new maplibregl.Map({
    container: 'map', // container id
    style: 'https://demotiles.maplibre.org/style.json',
    center: [-74.5, 40], // starting position
    zoom: 2, // starting zoom
    rollEnabled: true // Enable mouse control of camera roll angle with `Ctrl` + right-click and drag
});

// Show any previously downloaded regions on first load.
map.on('load', () => { showRegions(map); });


// Add zoom and rotation controls to the map.
map.addControl(new maplibregl.NavigationControl({
    visualizePitch: true,
    visualizeRoll: true,
    showZoom: true,
    showCompass: true
}));

map.addControl(new maplibregl.GeolocateControl({
    positionOptions: {
        enableHighAccuracy: true
    },
    trackUserLocation: true
}));
