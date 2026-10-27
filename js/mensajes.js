// js/mensajes.js
//
// Sistema de mensajes en tiempo real usando Firebase Firestore.
// v5:
//   - Lee window.__APP_CONFIG__.usarFirestore (index: true, keraunos: false).
//   - Filtra por origen según APP_CONFIG.origenFiltro ("manual" | "scraper").
//   - index.html: solo procesa origen === "manual".
//   - keraunos.html: NO usa Firestore (usa estado.json).
// ============================================================

import {
    getFirestore, collection, addDoc, query, orderBy, limit,
    onSnapshot, serverTimestamp, doc
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";
import { obtenerApp } from "./firebase-app.js";
import { mostrarToast, reproducirSonido } from "./notifications.js";
import { mostrarAlertaCompleta, mostrarAlertaLibre, quitarAlerta, marcarArranqueListo } from "./alertas.js";

const NOMBRE_COLECCION = "mensajes_push";
const COLECCION_SISTEMA = "sistema";
const DOC_MODO = "estado_modo";
const DURACION_ALERTA_MS = 15 * 60 * 1000;
const LIMITE_DOCS = 50;

let db = null;
let yaEscuchando = false;
let primeraCarga = true;

const docsProcesados = new Set();

// Estado local del modo manual (leído de Firestore)
export const estadoModo = {
    modo: "automatico",
    zonasActivas: [],
    expiraEn: 0,
    cargado: false
};

function obtenerDB() {
    if (!db) db = getFirestore(obtenerApp());
    return db;
}

function obtenerConfig() {
    return window.__APP_CONFIG__ || {
        origenFiltro: "manual",
        usarFirestore: true
    };
}

function modoEstaActivo() {
    if (estadoModo.modo !== "manual") return false;
    if (estadoModo.expiraEn && estadoModo.expiraEn < Date.now()) return false;
    return true;
}

// ----------------------------------------------------------
// Filtro por origen
// ----------------------------------------------------------
// Devuelve true si el doc debe procesarse en esta página.
// - "manual": solo docs con origen === "manual".
// - "scraper": solo docs con origen !== "manual".
// ----------------------------------------------------------
function debeProcesar(data) {
    const cfg = obtenerConfig();
    const esAlerta = data.tipo === "alerta" ||
        (data.nivel && data.nivel !== "normal" && data.nivel !== "vigilancia");
    const esResuelta = data.tipo === "alerta-resuelta";
    const esNormal = !esAlerta && !esResuelta;

    // Los mensajes normales (no alerta) siempre se procesan
    if (esNormal) return true;

    if (cfg.origenFiltro === "manual") {
        return data.origen === "manual";
    }
    if (cfg.origenFiltro === "scraper") {
        return data.origen !== "manual";
    }
    return true;
}

// ----------------------------------------------------------
// Enviar mensaje
// ----------------------------------------------------------
export async function enviarMensajePush(titulo, cuerpo, datosAlerta = null) {
    const database = obtenerDB();
    const ref = collection(database, NOMBRE_COLECCION);
    const docData = { titulo, cuerpo, fecha: serverTimestamp() };

    if (datosAlerta) {
        if (datosAlerta.tipo !== "alerta-resuelta") {
            if (!datosAlerta.duracionMin || datosAlerta.duracionMin <= 0) {
                datosAlerta.duracionMin = 15;
            }
        }
        datosAlerta.timestampInicio = Date.now();
        Object.assign(docData, datosAlerta);
    }

    await addDoc(ref, docData);
}

// ----------------------------------------------------------
// Listener del flag de modo (manual / automatico)
// ----------------------------------------------------------
function escucharModo() {
    try {
        const database = obtenerDB();
        const ref = doc(database, COLECCION_SISTEMA, DOC_MODO);

        onSnapshot(ref, (snap) => {
            if (!snap.exists()) {
                estadoModo.modo = "automatico";
                estadoModo.zonasActivas = [];
                estadoModo.expiraEn = 0;
                estadoModo.cargado = true;
                return;
            }
            const data = snap.data() || {};
            estadoModo.modo = data.modo || "automatico";
            estadoModo.zonasActivas = Array.isArray(data.zonasActivas) ? data.zonasActivas : [];
            estadoModo.expiraEn = (data.expiraEn && typeof data.expiraEn.toMillis === "function")
                ? data.expiraEn.toMillis()
                : (data.expiraEn || 0);
            estadoModo.cargado = true;
            console.log("[mensajes] modo actualizado:", estadoModo.modo);
        }, (err) => {
            console.warn("[mensajes] error leyendo modo:", err);
            estadoModo.modo = "automatico";
            estadoModo.cargado = true;
        });
    } catch (e) {
        console.warn("[mensajes] no se pudo escuchar modo:", e);
    }
}

// ----------------------------------------------------------
// Escuchar mensajes
// ----------------------------------------------------------
export function escucharMensajesPush() {
    if (yaEscuchando) return;
    yaEscuchando = true;

    const cfg = obtenerConfig();

    // Si la config dice "no usar Firestore" (keraunos.html), salir temprano.
    if (!cfg.usarFirestore) {
        console.log("[mensajes] Firestore desactivado en esta página (keraunos.html)");
        marcarArranqueListo("firestore"); // liberar barrera
        return;
    }

    escucharModo();

    try {
        const database = obtenerDB();
        const ref = collection(database, NOMBRE_COLECCION);
        const q = query(ref, orderBy("fecha", "desc"), limit(LIMITE_DOCS));

        onSnapshot(q, (snapshot) => {
            if (primeraCarga) {
                primeraCarga = false;
                procesarPrimeraCarga(snapshot);
                marcarArranqueListo("firestore");
                return;
            }

            snapshot.docChanges().forEach((cambio) => {
                if (cambio.type !== "added") return;
                const docId = cambio.doc.id;
                if (docsProcesados.has(docId)) return;
                docsProcesados.add(docId);

                procesarDocumentoNuevo(cambio.doc.data());
            });
        }, (error) => {
            console.error("Error escuchando mensajes:", error);
            marcarArranqueListo("firestore");
            try { mostrarAlertaLibre(); } catch (e) {}
        });

    } catch (error) {
        console.error("No se pudo iniciar la escucha de mensajes:", error);
        marcarArranqueListo("firestore");
        try { mostrarAlertaLibre(); } catch (e) {}
    }
}

// ----------------------------------------------------------
// Primera carga
// ----------------------------------------------------------
function procesarPrimeraCarga(snapshot) {
    const docs = snapshot.docs.map(d => ({ id: d.id, data: d.data() })).reverse();
    const estadoPorZona = new Map();
    const mensajesNormales = [];
    const ahora = Date.now();

    for (const { data } of docs) {
        const esResuelta = data.tipo === "alerta-resuelta";
        const esAlerta = data.tipo === "alerta" ||
            (data.nivel && data.nivel !== "normal" && data.nivel !== "vigilancia");
        const esNormal = !esResuelta && !esAlerta;

        if (esResuelta) {
            if (!debeProcesar(data)) continue;
            const distrito = data.distrito || "";
            if (distrito) estadoPorZona.set(distrito, { tipo: "resuelta", data });
            continue;
        }

        if (esAlerta) {
            if (!debeProcesar(data)) continue;
            const distrito = data.distrito || "";
            if (!distrito) continue;

            const tsInicio = data.timestampInicio || (data.fecha?.toMillis?.() || 0);
            const duracionMin = data.duracionMin || 15;
            const duracionMs = duracionMin * 60 * 1000;

            if (tsInicio && (ahora - tsInicio) < duracionMs) {
                estadoPorZona.set(distrito, { tipo: "alerta", data, tsInicio, duracionMin });
            }
            continue;
        }

        if (esNormal) {
            const fecha = data.fecha?.toMillis?.() || 0;
            if (fecha && (ahora - fecha) < DURACION_ALERTA_MS) {
                mensajesNormales.push(data);
            }
        }
    }

    const zonasActivas = [];
    for (const [, entrada] of estadoPorZona.entries()) {
        if (entrada.tipo === "alerta") zonasActivas.push(entrada);
    }

    if (zonasActivas.length === 0) {
        if (mensajesNormales.length > 0) {
            setTimeout(() => {
                mensajesNormales.slice(0, 3).forEach(m => {
                    mostrarToast(m.titulo || "🔔 Notificación", m.cuerpo || "", "alerta", true);
                });
            }, 1500);
        }
        return;
    }

    for (const entrada of zonasActivas) {
        mostrarAlertaActiva(entrada.data, entrada.duracionMin, entrada.tsInicio);
    }
}

// ----------------------------------------------------------
// Nuevo documento
// ----------------------------------------------------------
function procesarDocumentoNuevo(data) {
    if (!debeProcesar(data)) return;

    const titulo = data.titulo || "🔔 Notificación";
    const cuerpo = data.cuerpo || "";

    const esResuelta = data.tipo === "alerta-resuelta";
    const esAlerta = data.tipo === "alerta" ||
        (data.nivel && data.nivel !== "normal" && data.nivel !== "vigilancia");

    if (esResuelta) {
        const distrito = data.distrito || "";
        if (distrito) quitarAlerta(distrito);
        else mostrarAlertaLibre();
        return;
    }

    if (esAlerta) {
        reproducirSonido();
        const duracionMin = data.duracionMin || 15;
        const tsInicio = (typeof data.timestampInicio === "number") ? data.timestampInicio : null;
        mostrarAlertaActiva(data, duracionMin, tsInicio);

        if ("Notification" in window && Notification.permission === "granted") {
            try {
                new Notification(titulo, {
                    body: cuerpo,
                    icon: "https://cdn-icons-png.flaticon.com/512/1827/1827301.png",
                    tag: "antamina-alerta-" + Date.now()
                });
            } catch (e) {}
        }
        return;
    }

    mostrarToast(titulo, cuerpo, "alerta", true);

    if ("Notification" in window && Notification.permission === "granted") {
        try {
            new Notification(titulo, {
                body: cuerpo,
                icon: "https://cdn-icons-png.flaticon.com/512/1827/1827301.png",
                tag: "antamina-mensaje-" + Date.now()
            });
        } catch (e) {}
    }
}

function mostrarAlertaActiva(data, duracionMin, timestampInicio) {
    mostrarAlertaCompleta({
        tipo:            "alerta",
        nivel:           data.nivel || "roja",
        titulo:          data.titulo || "⚡ ALERTA DE TORMENTA ELÉCTRICA",
        mensaje:         data.cuerpo || data.mensaje || "",
        distrito:        data.distrito || "",
        intensidad:      data.intensidad || "",
        lat:             (typeof data.lat === "number") ? data.lat : null,
        lng:             (typeof data.lng === "number") ? data.lng : null,
        duracionMin:     duracionMin,
        timestampInicio: timestampInicio,
        sectorOriginal:  data.sectorOriginal || null,
        inicio:          data.inicio || null,
        fin:             data.fin || null,
        origen:          data.origen || null
    });
}
