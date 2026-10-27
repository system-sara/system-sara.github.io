// js/panico-admin.js
// ============================================================
// Listener de solicitudes de pánico en admin.html
// v2: usa la colección privada `panico_solicitudes`.
// ============================================================

import { getFirestore, collection, query, orderBy, limit, onSnapshot,
         doc, updateDoc, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";
import { obtenerApp } from "./firebase-app.js";
import { mostrarToast } from "./notifications.js";

const COLECCION = "panico_solicitudes";

let contenedor = null;

function asegurarContenedor() {
    if (document.getElementById("panico-admin-contenedor")) {
        contenedor = document.getElementById("panico-admin-contenedor");
        return contenedor;
    }
    contenedor = document.createElement("div");
    contenedor.id = "panico-admin-contenedor";
    document.body.appendChild(contenedor);
    return contenedor;
}

function crearTarjeta(docId, data) {
    const id = `panico-card-${docId}`;
    if (document.getElementById(id)) return;

    const card = document.createElement("div");
    card.id = id;
    card.className = "panico-card";

    let fechaTexto = "Hora desconocida";
    if (data.fechaMs) {
        fechaTexto = new Date(data.fechaMs).toLocaleString("es-PE");
    } else if (data.fecha?.toMillis) {
        fechaTexto = new Date(data.fecha.toMillis()).toLocaleString("es-PE");
    }

    const mapsUrl = (data.lat != null && data.lng != null)
        ? `https://www.google.com/maps?q=${data.lat},${data.lng}`
        : null;

    card.innerHTML = `
        <div class="panico-card-header">
            <span class="panico-card-icono">🆘</span>
            <div>
                <div class="panico-card-sub">SOLICITUD DE AYUDA</div>
                <div class="panico-card-hora">${fechaTexto}</div>
            </div>
            <button class="panico-card-cerrar" aria-label="Cerrar">×</button>
        </div>
        <div class="panico-card-body">
            <p><strong>🪪 DNI:</strong> ${escapeHtml(data.dni || "(no indicado)")}</p>
            <p><strong>📱 Teléfono:</strong> ${escapeHtml(data.telefono || "(no indicado)")}</p>
            <p><strong>📝 Descripción:</strong> ${escapeHtml(data.descripcion || "(sin descripción)")}</p>
            ${data.lat != null ? `
                <p><strong>📍 Ubicación:</strong> ${data.lat.toFixed(6)}, ${data.lng.toFixed(6)}</p>
            ` : ""}
        </div>
        <div class="panico-card-acciones">
            ${mapsUrl ? `<a href="${mapsUrl}" target="_blank" class="panico-card-btn-mapa">📍 Ver en mapa</a>` : ""}
            <button class="panico-card-btn-atender">✓ Marcar como atendido</button>
        </div>
    `;

    card.querySelector(".panico-card-cerrar").addEventListener("click", () => {
        card.remove();
    });

    card.querySelector(".panico-card-btn-atender").addEventListener("click", async () => {
        try {
            const db = getFirestore(obtenerApp());
            await updateDoc(doc(db, COLECCION, docId), {
                atendido: true,
                atendidoEn: serverTimestamp()
            });
            mostrarToast("✅ Atendido", "La solicitud fue marcada como atendida.", "exito", false);
            card.remove();
        } catch (e) {
            console.error("panico-admin: error marcando atendido", e);
            mostrarToast("⚠️ Error", "No se pudo marcar como atendido.", "alerta", true);
        }
    });

    asegurarContenedor().appendChild(card);
}

function escapeHtml(txt) {
    return String(txt)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function iniciarListener() {
    try {
        const db = getFirestore(obtenerApp());
        const ref = collection(db, COLECCION);
        // Traer los últimos 30, más recientes primero.
        const q = query(ref, orderBy("fechaMs", "desc"), limit(30));

        onSnapshot(q, (snapshot) => {
            snapshot.docs.forEach((d) => {
                const data = d.data();
                if (data.atendido === true) {
                    const el = document.getElementById(`panico-card-${d.id}`);
                    if (el) el.remove();
                    return;
                }
                crearTarjeta(d.id, data);
            });
        }, (error) => {
            console.warn("panico-admin: error listener", error);
        });

        console.log("🆘 panico-admin: escuchando panico_solicitudes");
    } catch (e) {
        console.warn("panico-admin: no se pudo iniciar", e);
    }
}

function init() {
    asegurarContenedor();
    iniciarListener();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
