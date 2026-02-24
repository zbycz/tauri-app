import React from "react";
import ReactDOM from "react-dom/client";
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';


ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <div style={{ position: 'absolute', top: 0, left: 0, padding: 10, zIndex: 1 }}>
      <h1>MapLibre GL JS Example</h1>
        <input/>
    </div>
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