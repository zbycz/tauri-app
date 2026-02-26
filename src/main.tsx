import React from "react";
import ReactDOM from "react-dom/client";
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {TauriGeolocateControl} from "./TauriGeolocateControl.tsx";
import {
    checkPermissions,
    requestPermissions,
    getCurrentPosition,
} from '@tauri-apps/plugin-geolocation';


const getPositionOrDenial = async () => {
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

    const { coords: {latitude, longitude }} = await getCurrentPosition();
    return {latitude, longitude};
}


const App = () => {
    const [location, setLocation] = React.useState("");

    const onClick = async () => {
        const pos = await getPositionOrDenial();
        setLocation(JSON.stringify(pos));
    }

    return <div id="panel">
        <h1>MapLibre GL JS Example</h1>

        <input/>
        <button onClick={onClick}>Get Location</button>
        <div style={{height: "1500px", width: "100%"}}>
            {location}

        </div>
        x<br/>
        y<br/>
        z
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


// Add zoom and rotation controls to the map.
map.addControl(new maplibregl.NavigationControl({
    visualizePitch: true,
    visualizeRoll: true,
    showZoom: true,
    showCompass: true
}));

map.addControl(new TauriGeolocateControl({
    positionOptions: {
        enableHighAccuracy: true
    },
    trackUserLocation: true
}));
