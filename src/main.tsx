import React from "react";
import ReactDOM from "react-dom/client";
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
    checkPermissions,
    requestPermissions,
    getCurrentPosition,
} from '@tauri-apps/plugin-geolocation';
import {isTauri} from "@tauri-apps/api/core";


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

map.addControl(new maplibregl.GeolocateControl({
    positionOptions: {
        enableHighAccuracy: true
    },
    trackUserLocation: true
}));
