//======================================================
// Buscador Lugares Antamina 2026
// Archivo principal
// v4: en modo "keraunos" (keraunos.html) NO carga lugares.json
//     ni el buscador. Solo crea el mapa, pinta zonas2.json y
//     arranca estado-cliente para leer estado.json.
//======================================================

import { cargarLugares } from "./data.js";
import { crearBuscador, teclado } from "./search.js";
import { crearMapa } from "./map.js";
import { inicializarFirebase } from "./notifications.js";
import { escucharMensajesPush } from "./mensajes.js";
import { mostrarAlertaCompleta, cerrarAlertaTotal, mostrarAlertaLibre } from "./alertas.js";
import { iniciarEstadoCliente } from "./estado-cliente.js";

// Leer configuración (o defaults si no existe)
const CONFIG = window.__APP_CONFIG__ || {
    modo: "manual",
    zonasFile: "./zonas.json",
    origenFiltro: "manual",
    usarFirestore: true,
    usarEstadoJSON: false
};

console.log(`[app] modo: ${CONFIG.modo} | zonas: ${CONFIG.zonasFile} | filtro: ${CONFIG.origenFiltro}`);

//======================================================
// Referencias HTML
//======================================================

const input = document.getElementById("search");
const stats = document.getElementById("stats");
const results = document.getElementById("results");

//======================================================

let lugares = [];
let buscar = null;
let mapa = null;

//======================================================
// Inicio
//======================================================

async function iniciar() {

    try {

        // ==================================================
        // MODO KERAUNOS (keraunos.html)
        // - Sin buscador, sin lugares.json
        // - Solo mapa + zonas2.json + estado.json
        // ==================================================
        if (CONFIG.modo === "keraunos") {
            console.log("[app] modo keraunos: sin buscador ni lugares.json");

            // Ocultar el buscador y stats (por si acaso el HTML los tiene)
            if (input) input.closest(".search-box")?.style.setProperty("display", "none");
            if (results) results.style.setProperty("display", "none");
            if (stats) stats.style.setProperty("display", "none");

            mapa = crearMapa("map");

            // Pintar las 4 zonas de zonas2.json en verde
            try {
                const mod = await import("./map.js");
                if (mod && typeof mod.pintarZonasBaseVerde === "function") {
                    await mod.pintarZonasBaseVerde();
                }
            } catch (e) {
                console.warn("[app] No se pudieron pintar las zonas base:", e);
            }

            // Arrancar estado-cliente (lee estado.json cada 30 s)
            try {
                iniciarEstadoCliente({ modo: "index" });
            } catch (e) {
                console.warn("[app] estado-cliente no arrancó:", e);
            }

            // No hacer nada más. Sin buscador, sin Firestore, sin lugares.json.
            return;
        }

        // ==================================================
        // MODO MANUAL (index.html) — comportamiento original
        // ==================================================
        stats.textContent = "Cargando lugares...";

        lugares = await cargarLugares();

        buscar = crearBuscador(lugares);

        mapa = crearMapa("map");

        mapa.cargarGeoJSON(lugares);

        stats.textContent = `${lugares.length} lugares cargados`;

        // Firestore: solo si la config lo pide
        if (CONFIG.usarFirestore) {
            escucharMensajesPush();
            inicializarFirebase().catch(err => console.warn("Firebase:", err.message));
        }

        // estado.json: solo si la config lo pide (index no lo usa)
        if (CONFIG.usarEstadoJSON) {
            try {
                iniciarEstadoCliente({ modo: "index" });
            } catch (e) {
                console.warn("estado-cliente no arrancó:", e);
            }
        }

        // Pintar las zonas base (zonas.json, 3 zonas en modo manual)
        try {
            const mod = await import("./map.js");
            if (mod && typeof mod.pintarZonasBaseVerde === "function") {
                await mod.pintarZonasBaseVerde();
            }
        } catch (e) {
            console.warn("No se pudieron pintar las zonas base:", e);
        }

    } catch (error) {
        console.error(error);
        if (stats) stats.textContent = "Error cargando lugares.json";
    }
}

//======================================================
// Eventos (solo si existen los elementos — en keraunos.html no existen)
//======================================================

if (input) {
    input.addEventListener("input", buscarTexto);
    input.addEventListener("keydown", controlarTeclado);
}

//======================================================
// Buscar
//======================================================

function buscarTexto() {
    if (!buscar || !input) return;
    const texto = input.value.trim();
    cambiarColorFondo(texto);
    buscar(texto, results, mapa, stats);
}

//======================================================
// Teclado
//======================================================

function controlarTeclado(e) {
    if (!mapa) return;
    teclado(e, mapa);
}

//======================================================
// Fondo dinámico
//======================================================

function cambiarColorFondo(texto) {
    if (texto.length === 0) {
        document.body.style.backgroundColor = "#2c3e50";
        return;
    }
    const tono = (texto.length * 18) % 360;
    document.body.style.backgroundColor = `hsl(${tono},45%,30%)`;
}

//======================================================
// Botón "Consultar alerta meteorológica"
//======================================================

function configurarBotonConsulta() {
    const btn = document.getElementById("btn-test-alerta");
    if (!btn) return;
    btn.addEventListener("click", () => consultarEstadoAlerta());
}

async function consultarEstadoAlerta() {
    try {
        const { getFirestore, collection, query, orderBy, limit, getDocs } =
            await import("https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js");
        const { obtenerApp } = await import("./firebase-app.js");

        const db = getFirestore(obtenerApp());
        const ref = collection(db, "mensajes_push");
        const q = query(ref, orderBy("fecha", "desc"), limit(1));
        const snapshot = await getDocs(q);

        const DURACION_ALERTA_MS = 15 * 60 * 1000;

        if (!snapshot.empty) {
            const doc = snapshot.docs[0];
            const data = doc.data();
            const esAlerta = data.tipo === "alerta" ||
                (data.nivel && data.nivel !== "normal" && data.nivel !== "vigilancia");

            if (esAlerta) {
                const timestampInicio = data.timestampInicio || null;
                const fechaDoc = data.fecha?.toMillis?.() || null;
                let tiempoRef = timestampInicio || fechaDoc;

                if (tiempoRef) {
                    const transcurrido = Date.now() - tiempoRef;
                    if (transcurrido < DURACION_ALERTA_MS) {
                        mostrarAlertaCompleta({
                            nivel:           data.nivel || "roja",
                            titulo:          data.titulo || "⚡ ALERTA DE TORMENTA ELÉCTRICA",
                            mensaje:         data.cuerpo || "",
                            distrito:        data.distrito || "",
                            intensidad:      data.intensidad || "",
                            lat:             (typeof data.lat === "number") ? data.lat : null,
                            lng:             (typeof data.lng === "number") ? data.lng : null,
                            duracionMin:     data.duracionMin || 15,
                            timestampInicio: timestampInicio,
                            sectorOriginal:  data.sectorOriginal || null,
                            inicio:          data.inicio || null,
                            fin:             data.fin || null,
                            origen:          data.origen || null
                        });
                        return;
                    }
                } else {
                    mostrarAlertaCompleta({
                        nivel:           data.nivel || "roja",
                        titulo:          data.titulo || "⚡ ALERTA DE TORMENTA ELÉCTRICA",
                        mensaje:         data.cuerpo || "",
                        distrito:        data.distrito || "",
                        intensidad:      data.intensidad || "",
                        lat:             (typeof data.lat === "number") ? data.lat : null,
                        lng:             (typeof data.lng === "number") ? data.lng : null,
                        duracionMin:     data.duracionMin || 15,
                        timestampInicio: fechaDoc,
                        sectorOriginal:  data.sectorOriginal || null,
                        inicio:          data.inicio || null,
                        fin:             data.fin || null,
                        origen:          data.origen || null
                    });
                    return;
                }
            }
        }

        mostrarAlertaLibre();

    } catch (e) {
        console.warn("app.js: error consultando estado de alerta", e);
        mostrarAlertaLibre();
    }
}

configurarBotonConsulta();

//======================================================

iniciar();
