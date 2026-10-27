// js/admin.js
//
// Panel de Alertas — Antamina
// ============================================================
// v7 (2026-10):
//   - Modo manual vs automático (flag en sistema/estado_modo).
//   - Alertas manuales llevan origen: "manual" y degradan.
//   - Zona 4 - Tajo oculta (reactivable con flag).
//   - Alertas Activas muestran nivel EFECTIVO (degradado).
//   - Recalcula modo cada 15s. Vuelve a automático al expirar
//     la última zona manual o al liberar todas.
// ============================================================

import { inicializarFirebase, mostrarToast } from "./notifications.js";
import { enviarMensajePush, escucharMensajesPush } from "./mensajes.js";
import { iniciarSesion, cerrarSesion, observarSesion, traducirErrorAuth } from "./auth.js";
import { NIVELES_ALERTA, calcularNivelEfectivo } from "./alertas.js";
import { iniciarEstadoCliente } from "./estado-cliente.js";
import { getFirestore, collection, query, orderBy, limit, onSnapshot,
         doc, setDoc, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";
import { obtenerApp } from "./firebase-app.js";

// ======================================================
// ZONAS OFICIALES
// ======================================================
const ZONAS = [
    { distrito: "Zona 1 - Campamentos",   sectorOriginal: "Campamento Yanacancha", lat: -9.5822364, lng: -77.0223100, short: "1", oculta: false },
    { distrito: "Zona 2 - Oficinas Mina", sectorOriginal: "Oficinas Mina",         lat: -9.5718388, lng: -77.0447182, short: "2", oculta: false },
    { distrito: "Zona 3 - Tucush",        sectorOriginal: "Tucush",                lat: -9.5263487, lng: -77.0485794, short: "3", oculta: false },
    // ⚠️ Zona 4 oculta del panel manual. Para reactivarla:
    //     cambiar `oculta: true` → `oculta: false`.
    { distrito: "Zona 4 - Tajo",          sectorOriginal: "Tajo",                  lat: -9.5416465, lng: -77.0707659, short: "4", oculta: true  }
];

const NIVELES_VALIDOS = ["amarilla", "naranja", "roja"];

// ======================================================
// Modo manual (flag Firestore)
// ======================================================
const COLECCION_SISTEMA = "sistema";
const DOC_MODO = "estado_modo";
const TIMEOUT_MODO_MS = 8 * 60 * 60 * 1000;   // 8 horas

// ======================================================
// Referencias DOM
// ======================================================
const loginContainer = document.getElementById("login-container");
const panelContainer = document.getElementById("panel-container");
const formLogin = document.getElementById("form-login");
const inputEmail = document.getElementById("login-email");
const inputPassword = document.getElementById("login-password");
const btnLogin = document.getElementById("btn-login");
const loginStatus = document.getElementById("login-status");
const btnLogout = document.getElementById("btn-logout");

const paAASection = document.getElementById("pa-aa-section");
const paAACount = document.getElementById("pa-aa-count");
const paAALista = document.getElementById("pa-aa-lista");
const paBtnLiberarTodas = document.getElementById("pa-btn-liberar-todas");

const paNaLista = document.getElementById("pa-na-lista");
const paResumen = document.getElementById("pa-resumen");
const paBtnEnviar = document.getElementById("pa-btn-enviar");

const paMiToggle = document.getElementById("pa-mi-toggle");
const paMiCampos = document.getElementById("pa-mi-campos");
const inputTitulo = document.getElementById("titulo");
const inputCuerpo = document.getElementById("cuerpo");
const charCounter = document.getElementById("char-counter");

const statusBar = document.getElementById("status-bar");

const modalConfirm = document.getElementById("modal-confirm");
const modalBox = document.getElementById("modal-box");
const modalIcon = document.getElementById("modal-icon");
const modalTitulo = document.getElementById("modal-titulo");
const modalMensaje = document.getElementById("modal-mensaje");
const btnModalAceptar = document.getElementById("modal-btn-aceptar");
const btnModalCancelar = document.getElementById("modal-btn-cancelar");

// ======================================================
// Estado
// ======================================================
const estado = {
    config: {},
    ultimaZonaTocada: null,
    alertasActivas: new Map(),
    intervalContadores: null,
    intervalModo: null,
    _ultimoRecalculoModo: 0,
    panelListo: false
};

ZONAS.forEach(z => {
    estado.config[z.distrito] = {
        activa: false,
        nivel: "amarilla",
        duracionMin: 15
    };
});

// ======================================================
// Modal genérico
// ======================================================
let modalCallback = null;

function abrirModal({ icon = "❓", titulo, mensajeHtml, textoAceptar = "✅ Aceptar", claseBox = "", claseBtnAceptar = "" }, callback) {
    modalIcon.textContent = icon;
    modalTitulo.textContent = titulo;
    modalMensaje.innerHTML = mensajeHtml || "";
    btnModalAceptar.innerHTML = textoAceptar;
    btnModalAceptar.className = "btn btn-enviar " + claseBtnAceptar;
    modalBox.className = "modal-box " + claseBox;
    modalCallback = callback;
    modalConfirm.classList.add("modal-visible");
}

function cerrarModal() {
    modalConfirm.classList.remove("modal-visible");
    modalCallback = null;
}

btnModalAceptar.addEventListener("click", () => {
    const cb = modalCallback;
    cerrarModal();
    if (cb) cb(true);
});
btnModalCancelar.addEventListener("click", cerrarModal);
modalConfirm.addEventListener("click", (e) => {
    if (e.target === modalConfirm) cerrarModal();
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalConfirm.classList.contains("modal-visible")) cerrarModal();
});

// ======================================================
// Auth
// ======================================================
let panelYaInicializado = false;

observarSesion((user) => {
    if (user) {
        loginContainer.style.display = "none";
        panelContainer.style.display = "";
        if (!panelYaInicializado) {
            panelYaInicializado = true;
            initPanel();
        }
    } else {
        loginContainer.style.display = "";
        panelContainer.style.display = "none";
    }
});

formLogin.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = inputEmail.value.trim();
    const password = inputPassword.value;
    if (!email || !password) return;

    btnLogin.disabled = true;
    btnLogin.innerHTML = '<span class="spinner"></span> Ingresando...';
    loginStatus.textContent = "";
    loginStatus.className = "status-bar";

    try {
        await iniciarSesion(email, password);
        inputPassword.value = "";
    } catch (error) {
        console.error("Auth error:", error);
        loginStatus.textContent = traducirErrorAuth(error.code);
        loginStatus.className = "status-bar error";
    } finally {
        btnLogin.disabled = false;
        btnLogin.innerHTML = "🔓 Ingresar";
    }
});

btnLogout.addEventListener("click", async () => {
    try {
        await cerrarSesion();
        mostrarEstado("Sesión cerrada.", "");
    } catch (e) {
        console.error("Error cerrando sesión:", e);
    }
});

// ======================================================
// Init panel
// ======================================================
async function initPanel() {
    try {
        await inicializarFirebase();
        escucharMensajesPush();

        renderSectores();
        engancharEventos();

        mostrarEstado("Panel listo. Configura las alertas y envía.", "");

        //try { iniciarEstadoCliente({ modo: "admin" }); }
        //catch (e) { console.warn("estado-cliente (admin):", e); }
        console.log("[admin] scraper NO se reenvía a Firestore (vive en keraunos.html)");

        escucharAlertasActivas();

        if (estado.intervalContadores) clearInterval(estado.intervalContadores);
        estado.intervalContadores = setInterval(actualizarContadores, 1000);

        if (estado.intervalModo) clearInterval(estado.intervalModo);
        estado.intervalModo = setInterval(actualizarBadgeModo, 2000);

        estado.panelListo = true;
    } catch (error) {
        console.error("Error iniciando panel:", error);
        mostrarEstado("Panel listo (sin Firebase).", "");
    }
}

// ======================================================
// Render de las tarjetas de sector
// ======================================================
function renderSectores() {
    paNaLista.innerHTML = "";

    ZONAS.forEach(z => {
        if (z.oculta) return;

        const cfg = estado.config[z.distrito];
        const card = document.createElement("div");
        card.className = "pa-na-card";
        card.dataset.distrito = z.distrito;

        card.innerHTML = `
            <div class="pa-na-row1">
                <button type="button" class="pa-na-check" data-distrito="${escapeAttr(z.distrito)}"></button>
                <div class="pa-na-nombre">${escapeHtml(z.distrito)}</div>
                <div class="pa-na-shortcut">${z.short}</div>
            </div>
            <div class="pa-na-row2">
                <div class="pa-pill-group">
                    <button type="button" class="pa-pill pa-pill-amarilla" data-distrito="${escapeAttr(z.distrito)}" data-nivel="amarilla">🟡 Amarilla</button>
                    <button type="button" class="pa-pill pa-pill-naranja"  data-distrito="${escapeAttr(z.distrito)}" data-nivel="naranja">🟠 Naranja</button>
                    <button type="button" class="pa-pill pa-pill-roja"     data-distrito="${escapeAttr(z.distrito)}" data-nivel="roja">🔴 Roja</button>
                </div>
                <div class="pa-duracion-wrap pa-disabled" data-distrito="${escapeAttr(z.distrito)}">
                    <input type="number" min="1" max="1440" value="${cfg.duracionMin}" data-distrito="${escapeAttr(z.distrito)}">
                    <span>min</span>
                </div>
            </div>
        `;

        paNaLista.appendChild(card);
    });

    aplicarEstadoVisual();
}

// ======================================================
// Enganchar eventos
// ======================================================
function engancharEventos() {
    paNaLista.addEventListener("click", (e) => {
        const checkBtn = e.target.closest(".pa-na-check");
        if (checkBtn) { toggleZona(checkBtn.dataset.distrito); return; }
        const pill = e.target.closest(".pa-pill");
        if (pill) { seleccionarNivel(pill.dataset.distrito, pill.dataset.nivel); return; }
    });

    paNaLista.addEventListener("input", (e) => {
        if (e.target.matches(".pa-duracion-wrap input")) {
            const distrito = e.target.dataset.distrito;
            let v = parseInt(e.target.value, 10);
            if (isNaN(v) || v < 1) v = 1;
            if (v > 1440) v = 1440;
            estado.config[distrito].duracionMin = v;
            marcarUltimaTocada(distrito);
            actualizarResumen();
        }
    });

    paBtnEnviar.addEventListener("click", onClickEnviar);
    paBtnLiberarTodas.addEventListener("click", onClickLiberarTodas);

    paMiToggle.addEventListener("click", () => {
        const visible = paMiCampos.style.display !== "none";
        if (visible) {
            paMiCampos.style.display = "none";
            paMiToggle.textContent = "▸ 💬 Mensaje informativo (opcional)";
        } else {
            paMiCampos.style.display = "block";
            paMiToggle.textContent = "▾ 💬 Mensaje informativo (opcional)";
        }
    });

    inputCuerpo.addEventListener("input", () => {
        const len = inputCuerpo.value.length;
        charCounter.textContent = `${len} / 500`;
        charCounter.classList.remove("warn", "danger");
        if (len > 400) charCounter.classList.add("warn");
        if (len > 475) charCounter.classList.add("danger");
    });

    document.addEventListener("keydown", onKeyDown);
}

// ======================================================
// Toggle / nivel
// ======================================================
function toggleZona(distrito) {
    const cfg = estado.config[distrito];
    if (!cfg) return;
    const zona = ZONAS.find(z => z.distrito === distrito);
    if (zona && zona.oculta) return;

    cfg.activa = !cfg.activa;
    marcarUltimaTocada(distrito);
    aplicarEstadoVisual();
    actualizarResumen();
}

function seleccionarNivel(distrito, nivel) {
    if (!NIVELES_VALIDOS.includes(nivel)) return;
    const cfg = estado.config[distrito];
    if (!cfg) return;
    const zona = ZONAS.find(z => z.distrito === distrito);
    if (zona && zona.oculta) return;

    cfg.nivel = nivel;
    if (!cfg.activa) cfg.activa = true;
    marcarUltimaTocada(distrito);
    aplicarEstadoVisual();
    actualizarResumen();
}

function marcarUltimaTocada(distrito) {
    estado.ultimaZonaTocada = distrito;
    document.querySelectorAll(".pa-na-card").forEach(el => {
        el.classList.toggle("pa-ultima-tocada", el.dataset.distrito === distrito);
    });
}

// ======================================================
// Aplicar estado visual
// ======================================================
function aplicarEstadoVisual() {
    ZONAS.forEach(z => {
        if (z.oculta) return;
        const cfg = estado.config[z.distrito];
        const card = document.querySelector(`.pa-na-card[data-distrito="${cssEscape(z.distrito)}"]`);
        if (!card) return;

        const check = card.querySelector(".pa-na-check");
        const dWrap = card.querySelector(".pa-duracion-wrap");
        const inputDur = card.querySelector(".pa-duracion-wrap input");

        if (cfg.activa) check.classList.add("pa-on");
        else check.classList.remove("pa-on");

        card.classList.remove("pa-activa-amarilla", "pa-activa-naranja", "pa-activa-roja");
        if (cfg.activa) card.classList.add(`pa-activa-${cfg.nivel}`);

        card.querySelectorAll(".pa-pill").forEach(p => {
            p.classList.remove("pa-sel-amarilla", "pa-sel-naranja", "pa-sel-roja");
            if (cfg.activa && p.dataset.nivel === cfg.nivel) {
                p.classList.add(`pa-sel-${cfg.nivel}`);
            }
        });

        if (cfg.activa) dWrap.classList.remove("pa-disabled");
        else dWrap.classList.add("pa-disabled");

        if (inputDur && inputDur.value !== String(cfg.duracionMin)) {
            inputDur.value = String(cfg.duracionMin);
        }
    });
}

// ======================================================
// Resumen
// ======================================================
function actualizarResumen() {
    const activas = zonasSeleccionadas();

    if (activas.length === 0) {
        paResumen.classList.remove("pa-visible");
        paResumen.innerHTML = "";
        paBtnEnviar.disabled = true;
        paBtnEnviar.innerHTML = "📤 ENVIAR ALERTAS";
        return;
    }

    const items = activas.map(a => {
        const n = NIVELES_ALERTA[a.nivel] || NIVELES_ALERTA.roja;
        return `<div>${n.icono} <strong>${escapeHtml(a.distrito)}</strong> · ${n.nombre} · ${a.duracionMin} min</div>`;
    });

    paResumen.innerHTML =
        `<strong>📋 ${activas.length} zona${activas.length > 1 ? "s" : ""} seleccionada${activas.length > 1 ? "s" : ""}:</strong>` +
        items.join("");

    paResumen.classList.add("pa-visible");
    paBtnEnviar.disabled = false;
    paBtnEnviar.innerHTML = `📤 ENVIAR ${activas.length} ALERTA${activas.length > 1 ? "S" : ""}`;
}

function zonasSeleccionadas() {
    const out = [];
    for (const z of ZONAS) {
        if (z.oculta) continue;
        const cfg = estado.config[z.distrito];
        if (cfg.activa) {
            out.push({
                distrito: z.distrito,
                sectorOriginal: z.sectorOriginal,
                lat: z.lat,
                lng: z.lng,
                nivel: cfg.nivel,
                duracionMin: cfg.duracionMin
            });
        }
    }
    return out;
}

// ======================================================
// Click Enviar
// ======================================================
function onClickEnviar() {
    const activas = zonasSeleccionadas();

    if (activas.length === 0) {
        mostrarToast("⚠️ Nada que enviar", "Selecciona al menos una zona.", "alerta", true);
        return;
    }

    const items = activas.map(a => {
        const n = NIVELES_ALERTA[a.nivel] || NIVELES_ALERTA.roja;
        return `${n.icono} <strong>${escapeHtml(a.distrito)}</strong> · ${n.nombre} · ${a.duracionMin} min`;
    }).join("<br>");

    abrirModal({
        icon: "⚡",
        titulo: "CONFIRMAR ENVÍO",
        mensajeHtml: `<div style="margin-bottom:8px;">Se enviarán <strong>${activas.length}</strong> alerta${activas.length > 1 ? "s" : ""}:</div>${items}<div style="margin-top:12px;opacity:0.75;">¿Estás seguro?</div>`,
        textoAceptar: "✅ ENVIAR"
    }, (aceptar) => {
        if (aceptar) enviarAlertas(activas);
    });
}

// ======================================================
// Enviar alertas
// ======================================================
async function enviarAlertas(activas) {
    paBtnEnviar.disabled = true;
    paBtnEnviar.innerHTML = "⏳ Enviando...";
    mostrarEstado("Enviando alertas...", "");

    let ok = 0, err = 0;
    const incluirMensaje = paMiCampos.style.display !== "none";
    const tituloMsg = inputTitulo.value.trim();
    const cuerpoMsg = inputCuerpo.value.trim();

    try {
        for (const a of activas) {
            try {
                const nivelInfo = NIVELES_ALERTA[a.nivel] || NIVELES_ALERTA.roja;
                const datosAlerta = {
                    tipo: "alerta",
                    nivel: a.nivel,
                    distrito: a.distrito,
                    lat: a.lat,
                    lng: a.lng,
                    duracionMin: a.duracionMin,
                    timestampInicio: Date.now(),
                    sectorOriginal: a.sectorOriginal,
                    origen: "manual"
                };

                await enviarMensajePush(
                    `⚡ ALERTA ${a.nivel.toUpperCase()} — ${a.distrito}`,
                    `Actividad eléctrica detectada en ${a.distrito}. Nivel ${nivelInfo.nombre}. Duración: ${a.duracionMin} min.`,
                    datosAlerta
                );
                ok++;
            } catch (e) {
                console.error("Error enviando alerta:", a.distrito, e);
                err++;
            }
        }

        // Activar modo manual si se envió al menos 1 alerta
        if (ok > 0) {
            const zonasEnviadas = activas.map(a => a.distrito);
            await escribirModoManual(zonasEnviadas);
        }

        let okMsg = false;
        if (incluirMensaje) {
            if (!tituloMsg || !cuerpoMsg) {
                mostrarToast("⚠️ Mensaje vacío", "Completa título y cuerpo del mensaje informativo, o colápsalo.", "alerta", true);
            } else {
                try {
                    await enviarMensajePush(tituloMsg, cuerpoMsg, null);
                    okMsg = true;
                } catch (e) {
                    console.error("Error mensaje informativo:", e);
                }
            }
        }

        const partes = [];
        if (ok) partes.push(`✅ ${ok} alerta${ok > 1 ? "s" : ""}`);
        if (err) partes.push(`⚠️ ${err} fallo${err > 1 ? "s" : ""}`);
        if (okMsg) partes.push("✅ mensaje");

        const exito = err === 0;
        mostrarToast(exito ? "✅ Enviado" : "⚠️ Envío parcial", partes.join(" · "), exito ? "exito" : "alerta", true);
        mostrarEstado(partes.join(" · "), exito ? "success" : "error");

        if (ok > 0 || okMsg) limpiarFormulario();
    } catch (e) {
        console.error("Error general:", e);
        mostrarToast("❌ Error", "Revisa la consola (F12).", "alerta", true);
        mostrarEstado("✗ " + e.message, "error");
    } finally {
        actualizarResumen();
    }
}

// ======================================================
// Limpiar formulario
// ======================================================
function limpiarFormulario() {
    ZONAS.forEach(z => {
        estado.config[z.distrito] = {
            activa: false,
            nivel: "amarilla",
            duracionMin: 15
        };
    });
    estado.ultimaZonaTocada = null;
    document.querySelectorAll(".pa-ultima-tocada").forEach(el => el.classList.remove("pa-ultima-tocada"));

    inputTitulo.value = "";
    inputCuerpo.value = "";
    charCounter.textContent = "0 / 500";
    charCounter.classList.remove("warn", "danger");
    paMiCampos.style.display = "none";
    paMiToggle.textContent = "▸ 💬 Mensaje informativo (opcional)";

    aplicarEstadoVisual();
    actualizarResumen();
}

// ======================================================
// Listener Firestore
// ======================================================
function escucharAlertasActivas() {
    try {
        const db = getFirestore(obtenerApp());
        const ref = collection(db, "mensajes_push");
        const q = query(ref, orderBy("fecha", "desc"), limit(50));

        onSnapshot(q, (snap) => {
            const docs = snap.docs.map(d => ({ id: d.id, data: d.data() }));
            const estadoPorDistrito = new Map();

            for (const { id, data } of docs) {
                const tipo = data.tipo;
                if (tipo !== "alerta" && tipo !== "alerta-resuelta") continue;
                const distrito = data.distrito;
                if (!distrito) continue;
                if (estadoPorDistrito.has(distrito)) continue;

                if (tipo === "alerta-resuelta") {
                    estadoPorDistrito.set(distrito, { resuelta: true });
                } else if (tipo === "alerta") {
                    const tsIni = (typeof data.timestampInicio === "number")
                        ? data.timestampInicio
                        : (data.fecha?.toMillis?.() || 0);
                    const dur = (data.duracionMin && data.duracionMin > 0) ? data.duracionMin : 15;
                    const finMs = tsIni + dur * 60 * 1000;
                    if (finMs > Date.now()) {
                        estadoPorDistrito.set(distrito, {
                            resuelta: false,
                            nivel: data.nivel || "roja",
                            timestampInicio: tsIni,
                            duracionMin: dur,
                            docId: id,
                            origen: data.origen || null
                        });
                    } else {
                        estadoPorDistrito.set(distrito, { resuelta: true });
                    }
                }
            }

            estado.alertasActivas.clear();
            for (const [distrito, info] of estadoPorDistrito.entries()) {
                if (!info.resuelta) {
                    estado.alertasActivas.set(distrito, info);
                }
            }

            renderAlertasActivas();
        }, (err) => {
            console.warn("listener alertas activas:", err);
        });
    } catch (e) {
        console.warn("No se pudo iniciar listener de alertas:", e);
    }
}

// ======================================================
// Render "Alertas activas"
// ======================================================
function renderAlertasActivas() {
    const count = estado.alertasActivas.size;

    if (count === 0) {
        paAASection.style.display = "none";
        return;
    }

    paAASection.style.display = "";
    paAACount.textContent = `(${count})`;
    paAALista.innerHTML = "";

    const items = [];
    for (const [distrito, info] of estado.alertasActivas.entries()) {
        const ef = calcularNivelEfectivo(info.nivel, info.timestampInicio, info.duracionMin, info.origen);
        if (ef.nivel === "libre") continue;
        items.push({ distrito, info, ef });
    }

    if (items.length === 0) {
        paAASection.style.display = "none";
        return;
    }

    paAACount.textContent = `(${items.length})`;

    items.sort((a, b) =>
        (NIVELES_ALERTA[b.ef.nivel]?.orden || 0) - (NIVELES_ALERTA[a.ef.nivel]?.orden || 0)
    );

    for (const { distrito, info, ef } of items) {
        const n = NIVELES_ALERTA[ef.nivel] || NIVELES_ALERTA.roja;
        const item = document.createElement("div");
        item.className = `pa-aa-item pa-nivel-${ef.nivel}`;
        item.dataset.distrito = distrito;
        item.innerHTML = `
            <div class="pa-aa-icono">${n.icono}</div>
            <div class="pa-aa-info">
                <div class="pa-aa-nombre">${escapeHtml(distrito)}</div>
                <div class="pa-aa-meta">
                    <span>${n.nombre}</span>
                    <span>·</span>
                    <span class="pa-aa-restante" data-distrito="${escapeAttr(distrito)}">--:--:--</span>
                </div>
            </div>
            <button type="button" class="pa-aa-btn-liberar" data-distrito="${escapeAttr(distrito)}">
                🛑 LIBERAR
            </button>
        `;
        paAALista.appendChild(item);
    }

    paAALista.querySelectorAll(".pa-aa-btn-liberar").forEach(btn => {
        btn.addEventListener("click", () => onClickLiberarZona(btn.dataset.distrito));
    });

    paBtnLiberarTodas.style.display = items.length >= 1 ? "" : "none";
    actualizarContadores();
}

// ======================================================
// Contadores en vivo
// ======================================================
function actualizarContadores() {
    for (const [distrito, info] of estado.alertasActivas.entries()) {
        const el = paAALista.querySelector(`.pa-aa-restante[data-distrito="${cssEscape(distrito)}"]`);
        if (!el) continue;

        const ef = calcularNivelEfectivo(info.nivel, info.timestampInicio, info.duracionMin, info.origen);

        if (ef.nivel === "libre") {
            estado.alertasActivas.delete(distrito);
            el.closest(".pa-aa-item")?.remove();
            continue;
        }

        const itemEl = el.closest(".pa-aa-item");
        if (itemEl && !itemEl.classList.contains(`pa-nivel-${ef.nivel}`)) {
            renderAlertasActivas();
            return;
        }

        const restante = ef.restanteSeg;
        const h = Math.floor(restante / 3600);
        const m = Math.floor((restante % 3600) / 60);
        const s = restante % 60;
        el.textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

        if (restante <= 60) el.classList.add("pa-critico");
        else el.classList.remove("pa-critico");
    }

    if (estado.alertasActivas.size === 0) {
        paAASection.style.display = "none";
    }

    // Recalcular modo cada 15 s
    if (!estado._ultimoRecalculoModo || (Date.now() - estado._ultimoRecalculoModo) > 15000) {
        estado._ultimoRecalculoModo = Date.now();
        recalcularModo().catch(e => console.warn("recalcularModo:", e));
    }
}

// ======================================================
// Liberar
// ======================================================
function onClickLiberarZona(distrito) {
    const info = estado.alertasActivas.get(distrito);
    if (!info) return;

    const ef = calcularNivelEfectivo(info.nivel, info.timestampInicio, info.duracionMin, info.origen);
    const n = NIVELES_ALERTA[ef.nivel] || NIVELES_ALERTA.roja;
    const mm = Math.floor(ef.restanteSeg / 60);
    const ss = ef.restanteSeg % 60;

    abrirModal({
        icon: "🛑",
        titulo: "LIBERAR ZONA",
        mensajeHtml:
            `<div>Vas a liberar la alerta de:</div>` +
            `<div style="margin:10px 0;font-size:15px;"><strong>${escapeHtml(distrito)}</strong></div>` +
            `<div>${n.icono} ${n.nombre} · Restante ${String(mm).padStart(2,"0")}:${String(ss).padStart(2,"0")}</div>` +
            `<div style="margin-top:12px;opacity:0.75;">La zona quedará libre en todos los dispositivos.</div>`,
        textoAceptar: "🛑 LIBERAR",
        claseBtnAceptar: "pa-btn-peligro"
    }, async (aceptar) => {
        if (!aceptar) return;
        await liberarZona(distrito);
    });
}

async function liberarZona(distrito) {
    try {
        await enviarMensajePush(
            `✅ Alerta finalizada — ${distrito}`,
            `La alerta meteorológica en ${distrito} ha finalizado.`,
            { tipo: "alerta-resuelta", distrito }
        );
        mostrarToast("🛑 Liberada", `${distrito} liberada.`, "info", true);
        mostrarEstado(`✓ ${distrito} liberada.`, "success");
        setTimeout(() => recalcularModo().catch(() => {}), 1000);
    } catch (e) {
        console.error("Error liberando zona:", e);
        mostrarToast("❌ Error", "No se pudo liberar la zona.", "alerta", true);
    }
}

function onClickLiberarTodas() {
    const zonas = Array.from(estado.alertasActivas.keys());
    if (zonas.length === 0) return;

    const listaHtml = zonas.map(d => `<div>🛑 <strong>${escapeHtml(d)}</strong></div>`).join("");

    abrirModal({
        icon: "⚠️",
        titulo: "⚠️ LIBERAR TODAS LAS ALERTAS ⚠️",
        mensajeHtml:
            `<div>Vas a liberar <strong>${zonas.length}</strong> zona${zonas.length > 1 ? "s" : ""}:</div>` +
            `<div style="margin:10px 0;">${listaHtml}</div>` +
            `<div style="margin-top:10px;color:#ff8c7a;font-weight:700;">Esta acción es inmediata y afecta a TODOS los dispositivos.</div>` +
            `<div style="margin-top:8px;opacity:0.75;">¿Estás completamente seguro?</div>`,
        textoAceptar: "🛑 SÍ, LIBERAR TODAS",
        claseBox: "pa-modal-peligro",
        claseBtnAceptar: "pa-btn-peligro"
    }, async (aceptar) => {
        if (!aceptar) return;
        await liberarTodas(zonas);
    });
}

async function liberarTodas(zonas) {
    let ok = 0, err = 0;
    for (const distrito of zonas) {
        try {
            await enviarMensajePush(
                `✅ Alerta finalizada — ${distrito}`,
                `La alerta meteorológica en ${distrito} ha finalizado.`,
                { tipo: "alerta-resuelta", distrito }
            );
            ok++;
        } catch (e) {
            console.error("Error liberando:", distrito, e);
            err++;
        }
    }

    if (ok > 0) {
        await escribirModoAutomatico();
    }

    const msg = err === 0
        ? `🛑 ${ok} zona${ok > 1 ? "s" : ""} liberada${ok > 1 ? "s" : ""}`
        : `⚠️ ${ok} ok · ${err} fallo${err > 1 ? "s" : ""}`;
    mostrarToast("Liberación", msg, err === 0 ? "info" : "alerta", true);
    mostrarEstado(msg, err === 0 ? "success" : "error");
}

// ======================================================
// Modo manual / automático
// ======================================================
async function escribirModoManual(zonasActivas) {
    try {
        const db = getFirestore(obtenerApp());
        const ref = doc(db, COLECCION_SISTEMA, DOC_MODO);
        await setDoc(ref, {
            modo: "manual",
            zonasActivas: zonasActivas || [],
            actualizado: serverTimestamp(),
            expiraEn: new Date(Date.now() + TIMEOUT_MODO_MS)
        }, { merge: true });
        console.log("[admin] modo manual activado:", zonasActivas);
    } catch (e) {
        console.error("[admin] error escribiendo modo manual:", e);
    }
}

async function escribirModoAutomatico() {
    try {
        const db = getFirestore(obtenerApp());
        const ref = doc(db, COLECCION_SISTEMA, DOC_MODO);
        await setDoc(ref, {
            modo: "automatico",
            zonasActivas: [],
            actualizado: serverTimestamp(),
            expiraEn: null
        }, { merge: true });
        console.log("[admin] modo automatico activado");
    } catch (e) {
        console.error("[admin] error escribiendo modo automatico:", e);
    }
}

async function recalcularModo() {
    const zonasManualesActivas = [];
    for (const [distrito, info] of estado.alertasActivas.entries()) {
        if (info.origen === "manual") {
            const ef = calcularNivelEfectivo(info.nivel, info.timestampInicio, info.duracionMin, info.origen);
            if (ef.nivel !== "libre") zonasManualesActivas.push(distrito);
        }
    }

    if (zonasManualesActivas.length === 0) {
        await escribirModoAutomatico();
    } else {
        await escribirModoManual(zonasManualesActivas);
    }
}

// ======================================================
// Badge del modo (si existe en admin.html)
// ======================================================
let _ultimoModoMostrado = null;
function actualizarBadgeModo() {
    const el = document.getElementById("pa-badge-modo");
    if (!el) return;

    // Leer el estado del módulo mensajes.js
    import("./mensajes.js").then(mod => {
        const em = mod.estadoModo;
        if (!em) return;
        const texto = em.modo === "manual" ? "🖐️ MODO MANUAL" : "🤖 MODO AUTOMÁTICO";
        if (texto === _ultimoModoMostrado) return;
        _ultimoModoMostrado = texto;
        el.textContent = texto;
        el.style.background = em.modo === "manual" ? "#e67e22" : "#2ecc71";
    }).catch(() => {});
}

// ======================================================
// Atajos de teclado
// ======================================================
function onKeyDown(e) {
    const t = e.target;
    const esInput = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;

    if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        if (!paBtnEnviar.disabled) paBtnEnviar.click();
        return;
    }

    if (e.ctrlKey && e.shiftKey && (e.key === "L" || e.key === "l")) {
        e.preventDefault();
        if (estado.alertasActivas.size > 0) onClickLiberarTodas();
        return;
    }

    if (esInput) return;
    if (modalConfirm.classList.contains("modal-visible")) return;

    if (["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        const zona = ZONAS.find(z => z.short === e.key);
        if (zona && !zona.oculta) toggleZona(zona.distrito);
        return;
    }

    if (e.shiftKey && !e.ctrlKey && !e.altKey) {
        const k = e.key.toUpperCase();
        if (k === "A" || k === "N" || k === "R") {
            if (!estado.ultimaZonaTocada) {
                mostrarToast("⚠️ Sin zona", "Primero selecciona una zona con 1, 2 o 3.", "alerta", false);
                return;
            }
            const zona = ZONAS.find(z => z.distrito === estado.ultimaZonaTocada);
            if (zona && zona.oculta) return;

            const nivel = k === "A" ? "amarilla" : k === "N" ? "naranja" : "roja";
            e.preventDefault();
            seleccionarNivel(estado.ultimaZonaTocada, nivel);
            return;
        }
    }
}

// ======================================================
// Utilidades
// ======================================================
function mostrarEstado(texto, tipo) {
    statusBar.textContent = texto;
    statusBar.className = "status-bar" + (tipo ? " " + tipo : "");
}

function escapeHtml(txt) {
    return String(txt || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function escapeAttr(txt) {
    return String(txt || "").replace(/"/g, "&quot;");
}
function cssEscape(txt) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(txt);
    return String(txt || "").replace(/([^\w-])/g, "\\$1");
}
