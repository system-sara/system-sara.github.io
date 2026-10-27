// js/notifications.js
//
// Sistema de notificaciones: popups/toasts visuales, sonido, y
// habilitación silenciosa de Firebase Cloud Messaging (para
// notificaciones nativas en segundo plano).
//
// IMPORTANTE: El envío REAL de mensajes a todos los navegadores se hace
// mediante Firestore en tiempo real (ver js/mensajes.js), no aquí.
// Este archivo solo se encarga de: mostrar popups, sonido, y pedir
// permiso de notificaciones nativas (silenciosamente, sin toasts de
// "activado" que confundan al usuario).

import {
    getMessaging,
    getToken
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-messaging.js";

import { obtenerApp } from "./firebase-app.js";
import { vapidKey } from "./firebase-config.js";

// ======================================================
// Estado interno
// ======================================================
let messaging = null;
let currentToken = null;
let audioCtx = null;
let audioDesbloqueado = false;

// ======================================================
// Desbloqueo de audio (política de autoplay de los navegadores)
// ======================================================
// Los navegadores bloquean el AudioContext hasta que el usuario
// interactúa con la página (clic, tecla, toque). Para evitar el warning
// "The AudioContext was not allowed to start...", creamos/reanudamos el
// contexto en el PRIMER gesto del usuario, silenciosamente.
function desbloquearAudioContext() {
    if (audioDesbloqueado) return;

    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC && !audioCtx) {
            audioCtx = new AC();
        }
        if (audioCtx && audioCtx.state === "suspended") {
            audioCtx.resume();
        }
        audioDesbloqueado = true;
    } catch (e) {
        // Silencioso
    }
}

["click", "keydown", "touchstart"].forEach((evento) => {
    document.addEventListener(evento, desbloquearAudioContext, { once: true, passive: true });
});

// ======================================================
// Sonido (Web Audio API + archivo WAV de respaldo)
// ======================================================

/**
 * Reproduce el sonido de notificación.
 * Usa Web Audio API (oscilador) como método principal para máxima
 * compatibilidad, y carga el archivo sounds/notificacion.wav como
 * alternativa si el navegador lo permite.
 */
export function reproducirSonido() {
    try {
        // Asegurar que el contexto esté desbloqueado (por si se llama
        // antes de cualquier gesto del usuario, no lanzará warnings).
        if (!audioCtx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) audioCtx = new AC();
        }

        if (audioCtx) {
            if (audioCtx.state === "suspended") {
                // Intentar reanudar; si el navegador lo bloquea, se
                // ignora silenciosamente (no rompe la app).
                audioCtx.resume().catch(() => {});
            }

            // Doble beep ascendente: 880Hz -> 1175Hz
            const ahora = audioCtx.currentTime;

            const osc1 = audioCtx.createOscillator();
            const gain1 = audioCtx.createGain();
            osc1.type = "sine";
            osc1.frequency.value = 880;
            gain1.gain.setValueAtTime(0, ahora);
            gain1.gain.linearRampToValueAtTime(0.3, ahora + 0.01);
            gain1.gain.linearRampToValueAtTime(0, ahora + 0.22);
            osc1.connect(gain1);
            gain1.connect(audioCtx.destination);
            osc1.start(ahora);
            osc1.stop(ahora + 0.25);

            const osc2 = audioCtx.createOscillator();
            const gain2 = audioCtx.createGain();
            osc2.type = "sine";
            osc2.frequency.value = 1175;
            gain2.gain.setValueAtTime(0, ahora + 0.27);
            gain2.gain.linearRampToValueAtTime(0.3, ahora + 0.28);
            gain2.gain.linearRampToValueAtTime(0, ahora + 0.55);
            osc2.connect(gain2);
            gain2.connect(audioCtx.destination);
            osc2.start(ahora + 0.27);
            osc2.stop(ahora + 0.6);
        }

        // Método 2 (respaldo): intentar reproducir el archivo WAV
        try {
            const audio = new Audio("./sounds/notificacion.wav");
            audio.volume = 0.4;
            audio.play().catch(() => {
                // Silencioso: el método Web Audio ya sonó
            });
        } catch (e) {
            // Silencioso
        }
    } catch (e) {
        // Silencioso: el sonido es un extra, no debe romper la app
    }
}

// ======================================================
// Sonido de alerta en LOOP (30 segundos por defecto)
// ======================================================
// Reproduce el sonido de notificación repetidamente durante
// los segundos indicados. Se usa para las alertas meteorológicas
// (amarillo, naranja, rojo) según los nuevos requerimientos.
let intervalSonidoAlerta = null;

/**
 * Reproduce el sonido de alerta en bucle durante `duracionSeg` segundos.
 * Por defecto 30 segundos. Detiene automáticamente al terminar.
 * @param {number} duracionSeg - duración total del loop en segundos
 */
export function reproducirSonidoAlerta(duracionSeg = 30) {
    // Detener cualquier loop previo
    detenerSonidoAlerta();

    // Reproducir inmediatamente la primera vez
    reproducirSonido();

    // Repetir cada 2 segundos (el beep dura ~0.6s, hay 1.4s de silencio)
    intervalSonidoAlerta = setInterval(() => {
        reproducirSonido();
    }, 2000);

    // Detener automáticamente después de duracionSeg
    setTimeout(() => {
        detenerSonidoAlerta();
    }, duracionSeg * 1000);
}

/**
 * Detiene el loop de sonido de alerta inmediatamente.
 */
export function detenerSonidoAlerta() {
    if (intervalSonidoAlerta) {
        clearInterval(intervalSonidoAlerta);
        intervalSonidoAlerta = null;
    }
}

// ======================================================
// Popups / Toasts visuales
// ======================================================

/**
 * Muestra un toast (popup) en pantalla.
 * @param {string} titulo  - Título en negrita
 * @param {string} mensaje - Texto del cuerpo
 * @param {string} tipo    - "info" | "exito" | "alerta"
 * @param {boolean} conSonido - si true, reproduce sonido
 */
export function mostrarToast(titulo, mensaje, tipo = "info", conSonido = false) {
    if (conSonido) reproducirSonido();

    let contenedor = document.getElementById("toast-container");
    if (!contenedor) {
        contenedor = document.createElement("div");
        contenedor.id = "toast-container";
        document.body.appendChild(contenedor);
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${tipo}`;

    const iconos = {
        info: "ℹ️",
        exito: "✅",
        alerta: "🔔"
    };

    toast.innerHTML = `
        <div class="toast-icono">${iconos[tipo] || "ℹ️"}</div>
        <div class="toast-cuerpo">
            <div class="toast-titulo">${titulo}</div>
            <div class="toast-mensaje">${mensaje}</div>
        </div>
        <div class="toast-cerrar">&times;</div>
    `;

    contenedor.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add("toast-visible");
    });

    toast.querySelector(".toast-cerrar").addEventListener("click", () => {
        cerrarToast(toast);
    });

    const timeoutId = setTimeout(() => cerrarToast(toast), 5000);
    toast.dataset.timeout = timeoutId;
}

function cerrarToast(toast) {
    if (!toast || !toast.parentNode) return;
    clearTimeout(Number(toast.dataset.timeout));
    toast.classList.remove("toast-visible");
    toast.classList.add("toast-saliendo");
    setTimeout(() => toast.remove(), 300);
}

// ======================================================
// Firebase Cloud Messaging — habilitación SILENCIOSA
// ======================================================
// Esta parte solo pide permiso de notificaciones nativas y registra
// el Service Worker + token FCM para uso futuro (push en segundo plano).
// NO muestra toasts de estado: el usuario solo debe ver el popup con
// el mensaje REAL cuando el admin lo envíe (ver js/mensajes.js).

async function registrarServiceWorker() {
    try {
        if (!("serviceWorker" in navigator)) return null;

        const registration = await navigator.serviceWorker.register(
            "./firebase-messaging-sw.js",
            { scope: "./" }
        );
        console.log("Service Worker registrado:", registration.scope);
        return registration;
    } catch (error) {
        console.warn("Service Worker no disponible (no crítico):", error.message);
        return null;
    }
}

/**
 * Inicializa Firebase Messaging de forma silenciosa:
 * - Pide permiso de notificaciones (si aún no se decidió).
 * - Registra el Service Worker.
 * - Obtiene el token FCM (solo para consola / uso interno futuro).
 * No muestra ningún toast de estado al usuario.
 * @returns {Promise<string|null>} token FCM o null
 */
export async function inicializarFirebase() {
    try {
        const app = obtenerApp();
        messaging = getMessaging(app);

        // Solo pedir permiso si el usuario aún no decidió (evita
        // molestar si ya lo bloqueó o ya lo concedió antes).
        if (!("Notification" in window)) return null;

        if (Notification.permission === "default") {
            const permiso = await Notification.requestPermission();
            if (permiso !== "granted") {
                console.info("Permiso de notificaciones no concedido:", permiso);
                return null;
            }
        }

        if (Notification.permission !== "granted") {
            return null;
        }

        const swRegistration = await registrarServiceWorker();
        if (!swRegistration) return null;

        try {
            currentToken = await getToken(messaging, {
                vapidKey: vapidKey,
                serviceWorkerRegistration: swRegistration
            });
            if (currentToken) {
                console.log("Token FCM (uso interno):", currentToken);
            }
        } catch (e) {
            console.warn("No se obtuvo token FCM (no crítico):", e.message);
        }

        return currentToken;

    } catch (error) {
        console.warn("Firebase Messaging no disponible (no crítico):", error.message);
        return null;
    }
}

/**
 * Devuelve el token FCM actual (si ya se obtuvo).
 */
export function obtenerToken() {
    return currentToken;
}
