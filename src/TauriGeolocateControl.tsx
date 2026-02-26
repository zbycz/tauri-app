import { GeolocateControl } from 'maplibre-gl'; // nebo 'mapbox-gl'
import * as tauriGeolocation from '@tauri-apps/plugin-geolocation';

// Pomocná detekce, zda běžíme v Tauri
const isTauri = !!(window as any).__TAURI_INTERNALS__;

export class TauriGeolocateControl extends GeolocateControl {
    // @ts-ignore (Tauri vrací v1.watchPosition jiný typ ID)
    _geolocationWatchID: any = null;

    /**
     * Přepisujeme metodu trigger, která se volá při kliknutí na tlačítko
     */
    trigger(): boolean {
        if (!isTauri) {
            return super.trigger();
        }

        // Pokud už běží setup, nebo není mapa, nic neděláme
        if (!this._map) return false;

        this._setupUI();
        this._startTauriFlow().catch((err) => {
            this._onError(err as any);
        });

        return true;
    }

    private async _startTauriFlow() {
        try {
            // 1. Kontrola a vyžádání práv (specifické pro Tauri)
            let permissions = await tauriGeolocation.checkPermissions();

            if (permissions.location === 'prompt' || permissions.location === 'prompt-with-rationale') {
                permissions = await tauriGeolocation.requestPermissions(['location']);
            }

            if (permissions.location !== 'granted') {
                throw { code: 1, message: "User denied Geolocation" };
            }

            // 2. Pokud chceme jen jednorázovou polohu
            const pos = await tauriGeolocation.getCurrentPosition();
            const webPos = this._convertToWebPosition(pos);

            this._onSuccess(webPos);

            // 3. Pokud je zapnutý tracking (sledování polohy)
            if (this.options.trackUserLocation) {
                this._watchState = "WAITING_ACTIVE";

                // Vyčistíme případný starý watch
                this._clearWatch();

                this._geolocationWatchID = await tauriGeolocation.watchPosition(
                    {
                        enableHighAccuracy: this.options.positionOptions?.enableHighAccuracy ?? true,
                        timeout: this.options.positionOptions?.timeout ?? 10000,
                        maximumAge: this.options.positionOptions?.maximumAge ?? 0
                    },
                    (pos) => {
                        this._onSuccess(this._convertToWebPosition(pos));
                    }
                );
            }
        } catch (error) {
            this._onError(error as any);
        }
    }

    /**
     * Mapování Tauri souřadnic na standardní webové rozhraní GeolocationPosition
     */
    private _convertToWebPosition(tauriPos: any): GeolocationPosition {
        // Tauri v2 vrací souřadnice v objektu coords
        return {
            coords: {
                latitude: tauriPos.coords.latitude,
                longitude: tauriPos.coords.longitude,
                accuracy: tauriPos.coords.accuracy,
                altitude: tauriPos.coords.altitude,
                altitudeAccuracy: tauriPos.coords.altitudeAccuracy,
                heading: tauriPos.coords.heading,
                speed: tauriPos.coords.speed,
            },
            timestamp: tauriPos.timestamp || Date.now(),
        } as GeolocationPosition;
    }

    /**
     * Přepisujeme čištění watcheru
     */
    _clearWatch(): void {
        if (!isTauri) {
            return super._clearWatch();
        }

        if (this._geolocationWatchID !== null) {
            // Poznámka: v Tauri v2 se watch čistí pomocí příkazu,
            // v závislosti na verzi pluginu může být potřeba tauriGeolocation.clearWatch(id)
            // Pokud plugin clearWatch nemá, stačí přestat reagovat na callback.
            this._geolocationWatchID = null;
        }
        this._watchState = "OFF";
    }
}