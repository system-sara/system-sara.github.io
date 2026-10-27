// js/map.js
// ============================================================
//  Mapa Leaflet — Antamina
//  v15:
//   - fitBounds con invalidateSize + setTimeout
//   - relleno más transparente para contraste
//   - puntos centrales con etiquetas permanentes (nombre corto)
// ============================================================

let map;
let geoLayer;
let markerSeleccionado = null;

const MAPTILER_KEY = "j4zAW83dNrfEbSRUvYN0";
const MAP_STYLE    = "hybrid-v4";

let markerUbicacion  = null;
let circleAccuracy   = null;
let watchId          = null;
let iconoTu          = null;

const APP_CONFIG = window.__APP_CONFIG__ || {
    modo: "manual",
    zonasFile: "./zonas.json"
};

const ZONAS_OCULTAS_MANUAL = ["Zona 4 - Tajo"];

function esZonaOcultaManual(nombreZona) {
    if (APP_CONFIG.modo !== "manual") return false;
    if (!nombreZona) return false;
    const n = String(nombreZona).toLowerCase();
    return ZONAS_OCULTAS_MANUAL.some(oc =>
        oc.toLowerCase() === n ||
        n.includes(oc.toLowerCase()) ||
        oc.toLowerCase().includes(n)
    );
}

const VERDE_BASE = "#22c55e";

const COLORES_NIVEL = {
    vigilancia: VERDE_BASE,
    amarilla:   "#f1c40f",
    naranja:    "#e67e22",
    roja:       "#e74c3c",
    precaucion: "#f1c40f",
    alerta:     "#e67e22",
    emergencia: "#e74c3c"
};

function colorDeNivel(nivelKey) {
    return COLORES_NIVEL[nivelKey] || COLORES_NIVEL.roja;
}

const poligonosActivos = new Map();
let zonasData = null;
let _estiloGlowInyectado = false;

// ======================================================
// Carga de zonas
// ======================================================
async function cargarZonas() {
    if (zonasData) return zonasData;
    try {
        const resp = await fetch(APP_CONFIG.zonasFile);
        zonasData = await resp.json();
        console.log(`[map] zonas cargadas desde ${APP_CONFIG.zonasFile}:`, zonasData.zonas?.length || 0);
        return zonasData;
    } catch (e) {
        console.warn(`map.js: no se pudo cargar ${APP_CONFIG.zonasFile}`, e);
        return null;
    }
}

// ======================================================
// Glow pulsante
// ======================================================
function inyectarEstiloGlow() {
    if (_estiloGlowInyectado) return;
    _estiloGlowInyectado = true;

    const style = document.createElement("style");
    style.id = "al-zona-glow-style";
    style.textContent = `
        @keyframes al-zona-glow-pulso {
            0%   { filter: drop-shadow(0 0 3px  currentColor) drop-shadow(0 0 6px  currentColor); }
            50%  { filter: drop-shadow(0 0 12px currentColor) drop-shadow(0 0 22px currentColor); }
            100% { filter: drop-shadow(0 0 3px  currentColor) drop-shadow(0 0 6px  currentColor); }
        }
        .al-zona-glow {
            animation: al-zona-glow-pulso 1.6s ease-in-out infinite;
        }
        .al-zona-sin-glow {
            filter: none;
        }

        /* Etiqueta permanente para los puntos de zona */
        .leaflet-tooltip.label-punto-mapa {
            background: transparent !important;
            border: none !important;
            box-shadow: none !important;
            color: #1a73e8 !important;
            font-size: 8px !important;
            font-weight: 800 !important;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            text-shadow: 
                -1px -1px 0 #fff,  
                 1px -1px 0 #fff,
                -1px  1px 0 #fff,
                 1px  1px 0 #fff;
            padding: 0 !important;
            white-space: nowrap;
            pointer-events: none;
        }
        .leaflet-tooltip.label-punto-mapa::before {
            display: none;
        }
    `;
    document.head.appendChild(style);
}

function aplicarGlowPulsante(poligono, nivelKey) {
    try {
        const el = poligono.getElement();
        if (!el) return;
        const color = colorDeNivel(nivelKey);
        el.classList.remove("al-zona-sin-glow");
        el.classList.add("al-zona-glow");
        el.style.color = color;
    } catch (e) {
        console.warn("map.js: error aplicando glow:", e);
    }
}

function quitarGlow(poligono) {
    try {
        const el = poligono.getElement();
        if (!el) return;
        el.classList.remove("al-zona-glow");
        el.classList.add("al-zona-sin-glow");
        el.style.color = "";
    } catch (e) {}
}

// ======================================================
// ILUMINAR DISTRITO
// ======================================================
export function iluminarDistrito(lat, lng, nivelKey = "roja") {
    if (!map) return null;

    const color = colorDeNivel(nivelKey);

    const nucleo = L.circleMarker([lat, lng], {
        radius: 10, color: "#fff", weight: 2,
        fillColor: color, fillOpacity: 0.95
    }).addTo(map);

    const rayoIcon = L.divIcon({
        className: "al-mapa-rayo",
        html: `<svg class="al-mapa-rayo-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                 <polygon points="58,5 30,52 48,52 38,95 72,42 52,42 62,5"
                          fill="#ffeb3b" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
               </svg>`,
        iconSize: [50, 50], iconAnchor: [25, 25]
    });
    const rayoMarker = L.marker([lat, lng], {
        icon: rayoIcon, zIndexOffset: 2000
    }).addTo(map);

    const pulsoIcon = L.divIcon({
        className: "",
        html: `<div style="width:40px;height:40px;border-radius:50%;
                 border:3px solid ${color};position:relative;
                 animation:al-radar-pulso 2s ease-out infinite;"></div>`,
        iconSize: [40, 40], iconAnchor: [20, 20]
    });
    const pulsoMarker = L.marker([lat, lng], { icon: pulsoIcon, zIndexOffset: 1900 }).addTo(map);

    nucleo.bindPopup(
        `<b>⚡ Zona de alerta</b><br>` +
        `Actividad eléctrica detectada<br>` +
        `Lat: ${lat.toFixed(5)}<br>Lng: ${lng.toFixed(5)}`
    );

    let pulsoVisible = true;
    const intervalParpadeo = setInterval(() => {
        pulsoVisible = !pulsoVisible;
        const elementoPulso = pulsoMarker.getElement();
        if (elementoPulso) elementoPulso.style.opacity = pulsoVisible ? "1" : "0.35";
        if (nucleo) nucleo.setStyle({ fillOpacity: pulsoVisible ? 0.95 : 0.55 });
    }, 700);

    map.flyTo([lat, lng], 12, { duration: 1.4 });

    return {
        map, nucleo, rayoMarker, pulsoMarker, intervalParpadeo,
        detener() {
            clearInterval(intervalParpadeo);
            try { map.removeLayer(nucleo); } catch(e){}
            try { map.removeLayer(rayoMarker); } catch(e){}
            try { map.removeLayer(pulsoMarker); } catch(e){}
        }
    };
}

// ======================================================
// ILUMINAR ZONA DESDE GEOJSON
// ======================================================
export async function iluminarDistritoZona(nombreZona, nivelKey = "roja") {
    if (!map) return null;

    const color = colorDeNivel(nivelKey);
    let puntoEncontrado = null;

    const zonaLower = (nombreZona || "").toLowerCase();
    const partes = nombreZona.split("-");
    const nombreBusqueda = partes.length > 1
        ? partes.slice(1).join("-").trim().toLowerCase()
        : zonaLower;

    if (geoLayer) {
        geoLayer.eachLayer(layer => {
            if (puntoEncontrado) return;
            const f = layer.feature;
            if (!f) return;
            if (f.geometry && f.geometry.type === "Point") {
                const nombre = (f.properties?.Name || "").toLowerCase();
                if (nombre.includes(nombreBusqueda) || nombreBusqueda.includes(nombre)) {
                    const coords = f.geometry.coordinates;
                    puntoEncontrado = {
                        lat: coords[1], lng: coords[0],
                        nombre: f.properties?.Name || nombreZona,
                        layer: layer
                    };
                }
            }
        });
    }

    if (!puntoEncontrado) {
        try {
            const data = await cargarZonas();
            if (data && data.zonas) {
                const zona = data.zonas.find(z =>
                    z.nombre === nombreZona ||
                    z.nombre.includes(nombreZona) ||
                    nombreZona.includes(z.nombreCorto)
                );
                if (zona) {
                    puntoEncontrado = {
                        lat: zona.lat, lng: zona.lng,
                        nombre: zona.nombre, layer: null
                    };
                }
            }
        } catch (e) {}
    }

    if (!puntoEncontrado) {
        console.warn("map.js: no se encontró punto para la zona:", nombreZona);
        return null;
    }

    const lat = puntoEncontrado.lat;
    const lng = puntoEncontrado.lng;

    const circulo = L.circle([lat, lng], {
        radius: 1800, color, weight: 3, opacity: 0.9,
        fillColor: color, fillOpacity: 0.2, dashArray: "6 6"
    }).addTo(map);

    const circuloMedio = L.circle([lat, lng], {
        radius: 900, color, weight: 2, opacity: 0.7,
        fillColor: color, fillOpacity: 0.15
    }).addTo(map);

    const nucleo = L.circleMarker([lat, lng], {
        radius: 10, color: "#fff", weight: 2,
        fillColor: color, fillOpacity: 0.95
    }).addTo(map);

    const rayoIcon = L.divIcon({
        className: "al-mapa-rayo",
        html: `<svg class="al-mapa-rayo-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                 <polygon points="58,5 30,52 48,52 38,95 72,42 52,42 62,5"
                          fill="#ffeb3b" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
               </svg>`,
        iconSize: [50, 50], iconAnchor: [25, 25]
    });
    const rayoMarker = L.marker([lat, lng], {
        icon: rayoIcon, zIndexOffset: 2000
    }).addTo(map);

    const pulsoIcon = L.divIcon({
        className: "",
        html: `<div style="width:40px;height:40px;border-radius:50%;
                 border:3px solid ${color};position:relative;
                 animation:al-radar-pulso 2s ease-out infinite;"></div>`,
        iconSize: [40, 40], iconAnchor: [20, 20]
    });
    const pulsoMarker = L.marker([lat, lng], { icon: pulsoIcon, zIndexOffset: 1900 }).addTo(map);

    circulo.bindPopup(
        `<b>⚡ Zona de alerta</b><br>` +
        `Actividad eléctrica detectada<br>` +
        `<b>${puntoEncontrado.nombre}</b><br>` +
        `Lat: ${lat.toFixed(5)}<br>Lng: ${lng.toFixed(5)}`
    );

    let parpadeoOn = true;
    const intervalParpadeo = setInterval(() => {
        parpadeoOn = !parpadeoOn;
        circulo.setStyle({ fillOpacity: parpadeoOn ? 0.35 : 0.12, opacity: parpadeoOn ? 0.9 : 0.4 });
        circuloMedio.setStyle({ fillOpacity: parpadeoOn ? 0.25 : 0.08, opacity: parpadeoOn ? 0.7 : 0.3 });
    }, 700);

    map.flyTo([lat, lng], 12, { duration: 1.4 });

    return {
        map, circulo, circuloMedio, nucleo, rayoMarker, pulsoMarker,
        puntoEncontrado, intervalParpadeo,
        detener() {
            clearInterval(intervalParpadeo);
            try { map.removeLayer(circulo); } catch(e){}
            try { map.removeLayer(circuloMedio); } catch(e){}
            try { map.removeLayer(nucleo); } catch(e){}
            try { map.removeLayer(rayoMarker); } catch(e){}
            try { map.removeLayer(pulsoMarker); } catch(e){}
        }
    };
}

// ======================================================
// CREAR MAPA
// ======================================================
export function crearMapa(idDiv) {

    map = L.map(idDiv, { zoomControl: false });
    L.control.zoom({ position: "bottomright" }).addTo(map);

    iconoTu = L.divIcon({
        className: "",
        html: '<div style="position:relative;text-align:center;">' +
                '<div class="marker-tu"></div>' +
                '<div class="etiqueta-tu">Tú</div>' +
              '</div>',
        iconSize: [22, 22], iconAnchor: [11, 11]
    });

    L.tileLayer(
        `https://api.maptiler.com/maps/${MAP_STYLE}/{z}/{x}/{y}.jpg?key=${MAPTILER_KEY}`,
        {
            tileSize: 512, zoomOffset: -1, minZoom: 1,
            attribution:
                '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> ' +
                '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>',
            crossOrigin: true
        }
    ).addTo(map);

    map.setView([-9.50, -77.00], 9);

    engancharBotonUbicacion();
    inyectarEstiloGlow();

    return { cargarGeoJSON, irA, limpiarSeleccion, filtrarLugares };
}

// ======================================================
// ENGANCHE BOTÓN UBICACIÓN
// ======================================================
function engancharBotonUbicacion() {
    const btnUbicacion = document.getElementById("btn-ubicacion");
    if (!btnUbicacion) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", engancharBotonUbicacion);
        } else {
            setTimeout(engancharBotonUbicacion, 150);
        }
        return;
    }
    if (btnUbicacion.dataset.listener === "1") return;

    btnUbicacion.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation(); mostrarMiUbicacion();
    });
    btnUbicacion.addEventListener("touchend", (e) => {
        e.preventDefault(); e.stopPropagation(); mostrarMiUbicacion();
    }, { passive: false });

    btnUbicacion.dataset.listener = "1";
}

// ======================================================
// MOSTRAR MI UBICACIÓN
// ======================================================
function mostrarMiUbicacion() {
    const btn = document.getElementById("btn-ubicacion");
    if (!navigator.geolocation) { alert("Tu navegador no soporta geolocalización."); return; }
    if (btn) btn.classList.add("buscar");

    const options = { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 };

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            if (btn) btn.classList.remove("buscar");
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            const accuracy = pos.coords.accuracy;

            if (markerUbicacion) map.removeLayer(markerUbicacion);
            if (circleAccuracy) map.removeLayer(circleAccuracy);

            circleAccuracy = L.circle([lat, lng], {
                radius: accuracy, color: "#00c853", weight: 1.5,
                opacity: 0.4, fillColor: "#00c853", fillOpacity: 0.12
            }).addTo(map);

            markerUbicacion = L.marker([lat, lng], {
                icon: iconoTu, zIndexOffset: 1000
            }).addTo(map);

            markerUbicacion.bindPopup(
                `<b>📍 Tu ubicación</b><br>` +
                `Lat: ${lat.toFixed(6)}<br>` +
                `Lng: ${lng.toFixed(6)}<br>` +
                `Precisión: ±${Math.round(accuracy)} m`
            ).openPopup();

            let zoomLevel = 16;
            if (accuracy > 100) zoomLevel = 14;
            if (accuracy > 500) zoomLevel = 12;

            map.flyTo([lat, lng], zoomLevel, { duration: 1.2 });

            if (watchId !== null) navigator.geolocation.clearWatch(watchId);
            watchId = navigator.geolocation.watchPosition(
                (pos2) => {
                    if (markerUbicacion) {
                        markerUbicacion.setLatLng([pos2.coords.latitude, pos2.coords.longitude]);
                    }
                    if (circleAccuracy) {
                        circleAccuracy.setLatLng([pos2.coords.latitude, pos2.coords.longitude]);
                        circleAccuracy.setRadius(pos2.coords.accuracy);
                    }
                },
                () => {},
                { enableHighAccuracy: true, maximumAge: 5000 }
            );
        },
        (error) => {
            if (btn) btn.classList.remove("buscar");
            let mensaje = "No se pudo obtener tu ubicación.\n\n";
            switch (error.code) {
                case error.PERMISSION_DENIED:    mensaje += "⛔ Permiso denegado."; break;
                case error.POSITION_UNAVAILABLE: mensaje += "📡 Posición no disponible."; break;
                case error.TIMEOUT:              mensaje += "⏱️ Tiempo agotado."; break;
                default:                         mensaje += "Error: " + error.message;
            }
            alert(mensaje);
        },
        options
    );
}

// ======================================================
// CARGAR GEOJSON
// ======================================================
function cargarGeoJSON(lugares) {
    if (geoLayer) {
        try { geoLayer.remove(); } catch (e) {}
        geoLayer = null;
    }

    if (!Array.isArray(lugares) || lugares.length === 0) {
        console.warn("map.js: cargarGeoJSON recibió 0 lugares");
        return;
    }

    const geojson = {
        type: "FeatureCollection",
        features: lugares
            .map(l => l.feature)
            .filter(f => f && f.geometry)
    };

    if (geojson.features.length === 0) return;

    try {
        geoLayer = L.geoJSON(geojson, {
            pointToLayer(feature, latlng) {
                return L.circleMarker(latlng, {
                    radius: 7, fillColor: "#4285f4", color: "#ffffff",
                    weight: 2, opacity: 1, fillOpacity: 0.9
                });
            },
            onEachFeature(feature, layer) {
                const nombre = feature.properties?.Name || "Sin nombre";
                layer.bindPopup(`<b>${nombre}</b><br>${feature.geometry.type}`);
            }
        }).addTo(map);

        const bounds = geoLayer.getBounds();
        if (bounds && bounds.isValid()) {
            map.fitBounds(bounds, { padding: [30, 30] });
        }

    } catch (err) {
        console.error("map.js: error creando geoLayer:", err);
    }
}

// ======================================================
// FILTRAR LUGARES
// ======================================================
export function filtrarLugares(predicado) {
    if (!geoLayer || typeof predicado !== "function") return 0;
    let visibles = 0;
    geoLayer.eachLayer(layer => {
        const f = layer.feature;
        if (!f) return;
        const props = f.properties || {};
        const mostrar = predicado(props);
        if (mostrar) {
            if (!map.hasLayer(layer)) layer.addTo(map);
            visibles++;
        } else {
            if (map.hasLayer(layer)) map.removeLayer(layer);
        }
    });
    return visibles;
}

function limpiarSeleccion() {
    if (markerSeleccionado) {
        markerSeleccionado.setStyle({ fillColor: "#4285f4", radius: 7 });
    }
}

function irA(lugar) {
    limpiarSeleccion();
    map.flyTo([lugar.lat, lugar.lng], 18, { duration: 1.2 });
    map.once("moveend", () => {
        const desplazamientoY = Math.round(map.getSize().y * 0.10);
        map.panBy([0, desplazamientoY], { animate: true, duration: 0.5 });
    });
    if (!geoLayer) return;
    geoLayer.eachLayer(layer => {
        const f = layer.feature;
        if (f === lugar.feature) {
            markerSeleccionado = layer;
            if (layer.setStyle) layer.setStyle({ radius: 11, fillColor: "#ff4444" });
            layer.openPopup();
        }
    });
}

// ======================================================
// PINTAR POLÍGONO DE ZONA
// ======================================================
export async function pintarPoligonoZona(nombreZona, color = VERDE_BASE, nivelKey = null) {
    if (!map) return null;

    if (!nivelKey) {
        if (color === VERDE_BASE || color === "#2ECC71" || color === "#2ecc71") nivelKey = "vigilancia";
        else if (color === "#FFD400" || color === "#f1c40f") nivelKey = "amarilla";
        else if (color === "#FF8C00" || color === "#e67e22") nivelKey = "naranja";
        else if (color === "#FA5858" || color === "#e74c3c") nivelKey = "roja";
        else nivelKey = "vigilancia";
    }

    quitarPoligonoZona(nombreZona);

    const data = await cargarZonas();
    if (!data || !data.zonas) return null;

    const zona = data.zonas.find(z =>
        z.nombre === nombreZona ||
        z.nombreCorto === nombreZona ||
        z.nombre.includes(nombreZona) ||
        nombreZona.includes(z.nombreCorto)
    );

    if (!zona) {
        console.warn("map.js: zona no encontrada:", nombreZona);
        return null;
    }

    const latlngs = zona.poligono.map(coord => [coord[1], coord[0]]);

    const tieneAlerta = nivelKey !== "vigilancia";
    const colorFinal = tieneAlerta ? colorDeNivel(nivelKey) : VERDE_BASE;
    // CONTRASTE: relleno más transparente
    const fillOp = tieneAlerta ? 0.25 : 0.10;

    const poligono = L.polygon(latlngs, {
        color: colorFinal,
        weight: 3,
        opacity: 1.0,
        fillColor: colorFinal,
        fillOpacity: fillOp,
        dashArray: null
    }).addTo(map);

    // NUEVO: dibujar el punto central con su nombre corto SIEMPRE visible
    let marcadorCentro = null;
    if (zona.lat && zona.lng) {
        marcadorCentro = L.circleMarker([zona.lat, zona.lng], {
            radius: 8,
            color: "#ffffff",
            weight: 2,
            fillColor: colorFinal,
            fillOpacity: 0.95
        }).addTo(map);

        // Etiqueta permanente (nombre corto) SIEMPRE visible en azul y 8px
        marcadorCentro.bindTooltip(zona.nombreCorto || zona.nombre, {
            permanent: true,
            direction: "right",
            offset: [10, 0],
            className: "label-punto-mapa"
        });

        marcadorCentro.bindPopup(
            `<b>📍 ${zona.nombre}</b><br>` +
            (tieneAlerta ? `Zona bajo alerta meteorológica` : `Zona sin alerta`)
        );
    }

    poligono.bindPopup(
        `<b>⚡ ${zona.nombre}</b><br>` +
        (tieneAlerta ? `Zona bajo alerta meteorológica` : `Zona sin alerta`)
    );

    if (tieneAlerta) {
        setTimeout(() => aplicarGlowPulsante(poligono, nivelKey), 50);
    } else {
        setTimeout(() => quitarGlow(poligono), 50);
    }

    poligonosActivos.set(zona.nombre, {
        poligono,
        marcadorCentro,
        color: colorFinal,
        nivel: nivelKey,
        zona
    });

    return {
        zona,
        poligono,
        marcadorCentro,
        detener() { quitarPoligonoZona(zona.nombre); }
    };
}

// ======================================================
// QUITAR POLÍGONO
// ======================================================
export function quitarPoligonoZona(nombreZona) {
    if (!map) return false;

    for (const [key, entry] of poligonosActivos.entries()) {
        if (key === nombreZona ||
            key.includes(nombreZona) ||
            nombreZona.includes(key)) {
            try { map.removeLayer(entry.poligono); } catch (e) {}
            // Quitar también el marcador central si existía
            if (entry.marcadorCentro) {
                try { map.removeLayer(entry.marcadorCentro); } catch (e) {}
            }
            poligonosActivos.delete(key);
            return true;
        }
    }
    return false;
}

// ======================================================
// LIMPIAR POLÍGONOS
// ======================================================
export function limpiarPoligonosZona() {
    if (!map) return;
    for (const [, entry] of poligonosActivos.entries()) {
        try { map.removeLayer(entry.poligono); } catch (e) {}
        if (entry.marcadorCentro) {
            try { map.removeLayer(entry.marcadorCentro); } catch (e) {}
        }
    }
    poligonosActivos.clear();
}

export function obtenerPoligonosActivos() {
    return Array.from(poligonosActivos.keys());
}

export function esZonaOcultaExport(nombreZona) {
    return esZonaOcultaManual(nombreZona);
}

// ======================================================
// PINTAR ZONAS BASE VERDE (con fitBounds + invalidateSize)
// ======================================================
export async function pintarZonasBaseVerde() {
    if (!map) return;

    const data = await cargarZonas();
    if (!data || !data.zonas) {
        console.warn(`map.js: no se pudo cargar ${APP_CONFIG.zonasFile} para pintar zonas base`);
        return;
    }

    let pintadas = 0;
    for (const zona of data.zonas) {
        if (esZonaOcultaManual(zona.nombre)) continue;
        try {
            await pintarPoligonoZona(zona.nombre, VERDE_BASE, "vigilancia");
            pintadas++;
        } catch (e) {
            console.warn("map.js: error pintando zona base:", zona.nombre, e);
        }
    }

    // FIX: encuadrar las zonas pintadas con retardo para asegurar que el DOM esté listo.
    if (pintadas > 0) {
        setTimeout(() => {
            try {
                map.invalidateSize(); // Fuerza a Leaflet a recalcular el tamaño del div

                const todasLasCoords = [];
                for (const [, entry] of poligonosActivos.entries()) {
                    if (entry.poligono && typeof entry.poligono.getLatLngs === "function") {
                        const latlngs = entry.poligono.getLatLngs();
                        const flat = (arr) => {
                            for (const item of arr) {
                                if (Array.isArray(item)) flat(item);
                                else todasLasCoords.push(item);
                            }
                        };
                        flat(latlngs);
                    }
                }
                if (todasLasCoords.length > 0) {
                    const bounds = L.latLngBounds(todasLasCoords);
                    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
                    console.log(`[map] fitBounds ok a ${todasLasCoords.length} puntos de las ${pintadas} zonas`);
                }
            } catch (e) {
                console.warn("map.js: error en fitBounds de zonas:", e);
            }
        }, 350);
    }

    console.log(`[map] (${APP_CONFIG.modo}) ${pintadas} zonas pintadas en verde #22c55e`);
}
