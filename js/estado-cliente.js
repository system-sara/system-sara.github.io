// js/estado-cliente.js
// ============================================================
// Puente estado.json ↔ sistema de alertas (v10)
// ============================================================

import { mostrarAlertaCompleta, mostrarAlertaLibre, quitarAlerta, marcarArranqueListo } from "./alertas.js";

const ESTADO_URL    = "./estado.json";
const APP_CONFIG    = window.__APP_CONFIG__ || { modo: "index" };
const INTERVALO_MS  = APP_CONFIG.modo === "keraunos" ? 10_000 : 30_000;
const STORAGE_KEY   = "keraunos_estado_cliente_v2";
const MAX_HISTORIAL = 200;

const cliente = {
    modo: null,
    intervaloId: null,
    historial: {},
    zonasVistas: new Set(),
    cargado: false
};

let primeraCarga = true;

function cargarHistorial() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { historial: {}, zonas: [] };
        const parsed = JSON.parse(raw);
        return {
            historial: parsed.historial || {},
            zonas: parsed.zonas || []
        };
    } catch { return { historial: {}, zonas: [] }; }
}

function guardarHistorial(historial, zonas) {
    try {
        const claves = Object.keys(historial);
        if (claves.length > MAX_HISTORIAL) {
            const recortadas = claves.slice(-MAX_HISTORIAL);
            const nuevo = {};
            recortadas.forEach(k => nuevo[k] = historial[k]);
            historial = nuevo;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            historial,
            zonas: Array.from(zonas)
        }));
    } catch {}
}

// MIGRACIÓN: Reemplaza "Botadero Este" por "Oficinas Mina" en el historial viejo
function migrarHistorial() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        if (!raw.includes("Botadero Este")) return;

        const parsed = JSON.parse(raw);
        let cambio = false;

        // Migrar llaves y valores del historial
        const nuevoHistorial = {};
        for (const [clave, valor] of Object.entries(parsed.historial || {})) {
            const nuevaClave = clave.replace(/Botadero Este/g, "Oficinas Mina");
            const nuevoValor = { ...valor };
            if (nuevoValor.distrito && nuevoValor.distrito.includes("Botadero Este")) {
                nuevoValor.distrito = nuevoValor.distrito.replace(/Botadero Este/g, "Oficinas Mina");
                cambio = true;
            }
            nuevoHistorial[nuevaClave] = nuevoValor;
        }

        // Migrar zonas vistas
        const nuevasZonas = (parsed.zonas || []).map(z => z.replace(/Botadero Este/g, "Oficinas Mina"));

        if (cambio) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                historial: nuevoHistorial,
                zonas: nuevasZonas
            }));
            console.log("[estado-cliente] Migración de Botadero Este → Oficinas Mina completada.");
        }
    } catch (e) {
        console.warn("Error migrando historial:", e);
    }
}

function claveAlerta(a) {
    return `${a.distrito}::${a.timestampInicio}`;
}

async function leerEstado() {
    // Forzar limpieza de caché (headers + cache: no-store)
    const url = `${ESTADO_URL}?t=${Date.now()}`;
    const res = await fetch(url, {
        cache: "no-store",
        headers: {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
        }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
}

async function ciclo() {
    let data;
    try {
        data = await leerEstado();
    } catch (e) {
        console.warn("estado-cliente: no se pudo leer estado.json:", e.message);
        if (primeraCarga) {
            primeraCarga = false;
            marcarArranqueListo("estado-cliente");
        }
        return;
    }

    const alertas = Array.isArray(data.alertas) ? data.alertas : [];
    const { historial, zonas } = cargarHistorial();
    const zonasVistas = new Set(zonas);
    const distritosActuales = new Set();

    // FASE 1 — Procesar alertas del scraper
    for (const a of alertas) {
        if (a.nivel !== "amarilla" && a.nivel !== "naranja" && a.nivel !== "roja") continue;
        if (!a.distrito) continue;

        const origenAlerta = a.origen || "keraunos";
        if (origenAlerta === "manual") continue;

        distritosActuales.add(a.distrito);

        const clave = claveAlerta(a);
        const anterior = historial[clave];
        const cambioNivel = anterior && anterior.nivel !== a.nivel;
        const cambioTimestamp = anterior && anterior.timestampInicio !== a.timestampInicio;
        const cambioDuracion = anterior && anterior.duracionMin !== a.duracionMin;
        const esNueva = primeraCarga || !anterior || cambioNivel || cambioTimestamp || cambioDuracion;

        if (esNueva) {
            historial[clave] = {
                nivel: a.nivel,
                timestampInicio: a.timestampInicio,
                duracionMin: a.duracionMin,
                distrito: a.distrito
            };
            zonasVistas.add(a.distrito);

            try {
                await mostrarAlertaCompleta({
                    tipo:            "alerta",
                    nivel:           a.nivel,
                    titulo:          a.titulo,
                    mensaje:         a.mensaje,
                    distrito:        a.distrito,
                    lat:             a.lat,
                    lng:             a.lng,
                    duracionMin:     a.duracionMin,
                    timestampInicio: a.timestampInicio,
                    sectorOriginal:  a.sectorOriginal,
                    inicio:          a.inicio,
                    fin:             a.fin,
                    origen:          "scraper"
                });
            } catch (e) {
                console.error("estado-cliente: error mostrando alerta:", e);
            }
        }
    }

    // FASE 2 — Alertas resueltas
    const distritosResueltos = [];
    for (const d of zonasVistas) {
        if (!distritosActuales.has(d)) distritosResueltos.push(d);
    }

    for (const distrito of distritosResueltos) {
        zonasVistas.delete(distrito);
        try { await quitarAlerta(distrito); }
        catch (e) { console.error("estado-cliente: error quitando:", e); }
    }

    // FASE 3 — Si no hay zonas activas, mostrar libre (solo la primera vez)
    if (distritosActuales.size === 0 && zonasVistas.size === 0 && !cliente.cargado) {
        try { await mostrarAlertaLibre(); } catch {}
        cliente.cargado = true;
    }

    if (primeraCarga) {
        primeraCarga = false;
        marcarArranqueListo("estado-cliente");
    }

    guardarHistorial(historial, zonasVistas);
}

export function iniciarEstadoCliente(opciones = {}) {
    if (cliente.intervaloId !== null) return;

    const cfg = window.__APP_CONFIG__ || { usarEstadoJSON: true };

    if (!cfg.usarEstadoJSON) {
        console.log("[estado-cliente] desactivado en esta página (usarEstadoJSON=false)");
        marcarArranqueListo("estado-cliente");
        return;
    }

    cliente.modo = opciones.modo || "index";
    console.log(`estado-cliente: iniciado en modo "${cliente.modo}" (${INTERVALO_MS / 1000}s)`);

    migrarHistorial(); // <-- Ejecuta la migración de "Botadero Este" a "Oficinas Mina"

    primeraCarga = true;
    ciclo();
    cliente.intervaloId = setInterval(ciclo, INTERVALO_MS);

    // FORZAR ACTUALIZACIÓN AL VOLVER A LA PESTAÑA
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            console.log("[estado-cliente] Pestaña visible: forzando sincronización inmediata.");
            ciclo();
            
            // Forzar redibujado del mapa si es necesario
            import("./map.js").then(mod => {
                if (mod && typeof mod.invalidateSize === "function") mod.invalidateSize();
            }).catch(() => {});
        }
    });
}

export function detenerEstadoCliente() {
    if (cliente.intervaloId !== null) {
        clearInterval(cliente.intervaloId);
        cliente.intervaloId = null;
    }
}

export function resetearHistorial() {
    try {
        localStorage.removeItem(STORAGE_KEY);
        cliente.historial = {};
        cliente.zonasVistas = new Set();
        cliente.cargado = false;
        primeraCarga = true;
        console.log("estado-cliente: historial reseteado");
    } catch {}
}
