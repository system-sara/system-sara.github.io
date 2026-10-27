// js/alertas.js
// ============================================================
// Sistema de Alerta Meteorológica — v4.5
// ------------------------------------------------------------
// v4.5:
//   - En modo keraunos, se oculta el icono SVG del rayo central.
//   - En su lugar, se muestra solo el emoji circular del nivel.
//   - En modo manual (index.html) no cambia nada.
// ============================================================

import { reproducirSonidoAlerta, detenerSonidoAlerta } from "./notifications.js";

const VERDE_BASE = "#22c55e";
const ZONAS_OCULTAS_MANUAL = ["Zona 4 - Tajo"];
const APP_CONFIG = window.__APP_CONFIG__ || { origenFiltro: "manual", modo: "manual" };
const isKeraunos = APP_CONFIG.modo === "keraunos" || APP_CONFIG.origenFiltro === "scraper";

// Añadir clase al body si estamos en keraunos
if (isKeraunos && typeof document !== "undefined") {
    if (document.body) {
        document.body.classList.add("modo-keraunos");
    } else {
        document.addEventListener("DOMContentLoaded", () => document.body.classList.add("modo-keraunos"));
    }
}

function esZonaOcultaManual(nombreZona) {
    if (APP_CONFIG.origenFiltro !== "manual") return false;
    if (!nombreZona) return false;
    const n = String(nombreZona).toLowerCase();
    return ZONAS_OCULTAS_MANUAL.some(oc =>
        oc.toLowerCase() === n ||
        n.includes(oc.toLowerCase()) ||
        oc.toLowerCase().includes(n)
    );
}

export const NIVELES_ALERTA = {
    vigilancia: {
        nombre: "Vigilancia", color: VERDE_BASE, colorDark: "#15803d",
        glow: "rgba(34,197,94,0.6)", icono: "🟢", iconoBig: "🌩️",
        descripcion: "Actividad eléctrica lejana.",
        recomendacion: "Manténgase informado sobre el desarrollo del clima.",
        orden: 0
    },
    amarilla: {
        nombre: "Alerta amarilla", color: "#f1c40f", colorDark: "#c9a003",
        glow: "rgba(241,196,15,0.6)", icono: "🟡", iconoBig: "⚡",
        descripcion: "Posibles descargas eléctricas en la zona.",
        recomendacion: "Manténgase atento a la evolución de la actividad eléctrica.",
        orden: 1
    },
    naranja: {
        nombre: "Alerta naranja", color: "#e67e22", colorDark: "#b9530f",
        glow: "rgba(230,126,34,0.65)", icono: "🟠", iconoBig: "⚡",
        descripcion: "Actividad eléctrica cercana.",
        recomendacion: "Evite actividades al aire libre.",
        orden: 2
    },
    roja: {
        nombre: "Alerta roja", color: "#e74c3c", colorDark: "#c0392b",
        glow: "rgba(231,76,60,0.7)", icono: "🔴", iconoBig: "⚡",
        descripcion: "Actividad eléctrica muy cercana.",
        recomendacion: "Refúgiese inmediatamente.",
        orden: 3
    }
};

const MEDIDAS_SEGURIDAD = {
    vigilancia: [
        { icono: "📡", texto: "<strong>Monitoree</strong> los partes meteorológicos locales." },
        { icono: "📱", texto: "Mantenga su dispositivo <strong>cargado</strong> por si hay cortes." },
        { icono: "👀", texto: "Observe la evolución de las nubes en la zona." }
    ],
    amarilla: [
        { icono: "🏠", texto: "Identifique <strong>lugares seguros</strong> cercanos." },
        { icono: "🚫", texto: "Evite el uso de <strong>equipos eléctricos sensibles</strong>." },
        { icono: "⚡", texto: "Aléjese de <strong>estructuras metálicas</strong> elevadas." },
        { icono: "☂️", texto: "Tenga a mano <strong>paraguas e impermeables</strong>." }
    ],
    naranja: [
        { icono: "🏃", texto: "<strong>Suspenda</strong> toda actividad al aire libre." },
        { icono: "🏠", texto: "Busque <strong>refugio en edificaciones</strong> cerradas." },
        { icono: "🌳", texto: "Aléjese de <strong>árboles solitarios</strong> y postes." },
        { icono: "💧", texto: "Evite <strong>contacto con agua</strong> (no se bañe ni lave)." },
        { icono: "🔌", texto: "<strong>Desconecte</strong> equipos electrónicos sensibles." }
    ],
    roja: [
        { icono: "🏛️", texto: "<strong>Refúgiese de inmediato</strong> en un lugar cerrado." },
        { icono: "🚫", texto: "No toque <strong>metales ni agua</strong>." },
        { icono: "🪑", texto: "Adopte posición de <strong>cuclillas</strong>, pies juntos." },
        { icono: "📱", texto: "Mantenga el <strong>móvil cargado</strong>, evite llamadas con cable." },
        { icono: "🚗", texto: "Dentro de un <strong>vehículo</strong> es seguro (jaula de Faraday)." },
        { icono: "❤️", texto: "Si alguien es fulminado, llame a <strong>emergencias</strong>." }
    ]
};

const SVG_RAYO = `
<svg class="al-rayo-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="alRayoGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff7c2"/>
      <stop offset="50%" stop-color="#ffeb3b"/>
      <stop offset="100%" stop-color="#ffb300"/>
    </linearGradient>
  </defs>
  <polygon points="58,5 30,52 48,52 38,95 72,42 52,42 62,5" fill="url(#alRayoGrad)" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`;

const estado = {
    zonasActivas: new Map(),
    colaBanners: [],
    bannerActual: null,
    intervalMaestro: null,
    intervalTimestamp: null
};

const capasRayos = new Map();
let libreYaCerradoPorUsuario = false;
const DURACION_TIMER_MINUTOS = 15;
const MINUTOS_DEGRADACION = 1;

const arranque = {
    esperando: true,
    listos: new Set(),
    timeoutId: null,
    TIMEOUT_MS: 1500
};

// ------------------------------------------------------------
// BOTÓN DE ACTIVAR SONIDO (Autoplay fix)
// ------------------------------------------------------------
function inyectarBotonSonido() {
    if (document.getElementById("btn-unlock-sonido")) return;
    const btn = document.createElement("button");
    btn.id = "btn-unlock-sonido";
    btn.innerHTML = "🔊";
    btn.title = "Activar sonido de alertas";
    btn.style.cssText = `
        position: fixed; bottom: 20px; left: 20px; z-index: 30000;
        background: rgba(0,0,0,0.6); color: white; border: 2px solid white;
        border-radius: 50%; width: 44px; height: 44px; font-size: 20px;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 10px rgba(0,0,0,0.3);
    `;
    btn.addEventListener("click", () => {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            gain.gain.value = 0;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.1);
            if (audioCtx.state === "suspended") audioCtx.resume();
        } catch(e) {}
        btn.remove();
    });
    document.body.appendChild(btn);
}

export function marcarArranqueListo(fuente) {
    if (!arranque.esperando) return;
    arranque.listos.add(fuente);
    if (arranque.listos.has("firestore") && arranque.listos.has("estado-cliente")) {
        liberarArranque();
    }
}

function liberarArranque() {
    if (!arranque.esperando) return;
    arranque.esperando = false;
    if (arranque.timeoutId) {
        clearTimeout(arranque.timeoutId);
        arranque.timeoutId = null;
    }
    if (estado.zonasActivas.size === 0 && !libreYaCerradoPorUsuario) {
        mostrarAlertaLibre(true);
    }
}

arranque.timeoutId = setTimeout(() => {
    if (arranque.esperando) liberarArranque();
}, arranque.TIMEOUT_MS);

export function calcularNivelEfectivo(nivelOriginal, timestampInicio, duracionMin, origen = null) {
    const elapsedMin = (Date.now() - timestampInicio) / 60000;
    const D = duracionMin || DURACION_TIMER_MINUTOS;

    if (origen !== "manual") {
        if (elapsedMin < D) {
            return { nivel: nivelOriginal, restanteSeg: Math.max(0, Math.ceil((D - elapsedMin) * 60)) };
        }
        return { nivel: "libre", restanteSeg: 0 };
    }

    if (nivelOriginal === "roja") {
        if (elapsedMin < D)                 return { nivel: "roja",    restanteSeg: Math.max(0, Math.ceil((D - elapsedMin) * 60)) };
        if (elapsedMin < D + MINUTOS_DEGRADACION)     return { nivel: "naranja", restanteSeg: Math.max(0, Math.ceil((D + MINUTOS_DEGRADACION - elapsedMin) * 60)) };
        if (elapsedMin < D + 2 * MINUTOS_DEGRADACION) return { nivel: "amarilla",restanteSeg: Math.max(0, Math.ceil((D + 2 * MINUTOS_DEGRADACION - elapsedMin) * 60)) };
        return { nivel: "libre", restanteSeg: 0 };
    }
    if (nivelOriginal === "naranja") {
        if (elapsedMin < D)                 return { nivel: "naranja", restanteSeg: Math.max(0, Math.ceil((D - elapsedMin) * 60)) };
        if (elapsedMin < D + MINUTOS_DEGRADACION)     return { nivel: "amarilla",restanteSeg: Math.max(0, Math.ceil((D + MINUTOS_DEGRADACION - elapsedMin) * 60)) };
        return { nivel: "libre", restanteSeg: 0 };
    }
    if (elapsedMin < D)                     return { nivel: "amarilla", restanteSeg: Math.max(0, Math.ceil((D - elapsedMin) * 60)) };
    return { nivel: "libre", restanteSeg: 0 };
}

function asegurarEstructuraDOM() {
    if (document.getElementById("al-overlay")) return;

    const html = `
    <div id="al-overlay" role="alertdialog" aria-modal="true" aria-labelledby="al-titulo-texto">
        <div class="al-panel" id="al-panel">
            <div class="al-icono-wrap">
                <span class="al-radar r1"></span>
                <span class="al-radar r2"></span>
                <span class="al-radar r3"></span>
                <span class="al-icono" id="al-icono-big">⚡</span>
                ${isKeraunos ? "" : SVG_RAYO}
            </div>
            <div style="text-align:center;">
                <span class="al-nivel-badge" id="al-nivel-badge">EMERGENCIA</span>
            </div>
            <h2 class="al-titulo" id="al-titulo-texto">⚡ ALERTA DE TORMENTA ELÉCTRICA</h2>
            <p class="al-mensaje" id="al-mensaje-texto">Se detectó actividad eléctrica en la zona.</p>
            <p class="al-recomendacion" id="al-recomendacion-texto">Refúgiese inmediatamente.</p>
            <div class="al-contador-wrap" id="al-contador-wrap" style="display:none;">
                <div class="al-contador-label">⏰ Finaliza en</div>
                <div class="al-contador" id="al-contador">00:00:00</div>
            </div>
            <div class="al-botones">
                <button class="al-btn al-btn-primario" id="al-btn-mapa">📍 Ver mapa</button>
                <button class="al-btn al-btn-secundario" id="al-btn-seguridad">🛡️ Medidas de seguridad</button>
                <button class="al-btn al-btn-cerrar" id="al-btn-cerrar">Entendido</button>
            </div>
            <div class="al-cola-indicador" id="al-cola-indicador" style="display:none;"></div>
        </div>
    </div>

    <div id="al-barra-superior" role="alert">
        <span class="al-barra-icono" id="al-barra-icono">⚡</span>
        <span class="al-barra-texto">
            <span class="al-barra-nivel" id="al-barra-nivel">ALERTA ROJA</span><br>
            <span class="al-barra-desc" id="al-barra-desc">Tormenta eléctrica intensa</span>
        </span>
        <span class="al-barra-tiempo" id="al-barra-tiempo">Hace 2 minutos</span>
        <button class="al-barra-cerrar" id="al-barra-cerrar" aria-label="Cerrar barra">×</button>
    </div>

    <div id="al-tarjeta" role="alert">
        <button class="al-tarjeta-cerrar" id="al-tarjeta-cerrar" aria-label="Cerrar tarjeta">×</button>
        <div class="al-tarjeta-header">
            <span class="al-tarjeta-icono" id="al-tarjeta-icono">⚡</span>
            <div>
                <div class="al-tarjeta-sub" id="al-tarjeta-sub">ALERTA</div>
                <h3 class="al-tarjeta-titulo" id="al-tarjeta-titulo">Tormenta eléctrica</h3>
            </div>
        </div>
        <div class="al-tarjeta-cuerpo" id="al-tarjeta-cuerpo"></div>
        <button class="al-tarjeta-btn" id="al-tarjeta-btn">Ver</button>
    </div>

    <div id="al-modal-seguridad" role="dialog" aria-modal="true">
        <div class="al-modal-contenido">
            <h3 class="al-modal-titulo">🛡️ Medidas de seguridad</h3>
            <div class="al-modal-sub" id="al-modal-sub">NIVEL DE ALERTA</div>
            <div class="al-leyenda" id="al-leyenda"></div>
            <div id="al-medidas-lista"></div>
            <button class="al-modal-cerrar" id="al-modal-cerrar">Entendido</button>
        </div>
    </div>`;

    const cont = document.createElement("div");
    cont.innerHTML = html;
    while (cont.firstChild) document.body.appendChild(cont.firstChild);

    document.getElementById("al-btn-cerrar").addEventListener("click", () => cerrarBannerActual());
    document.getElementById("al-btn-mapa").addEventListener("click", () => verMapaAlerta());
    document.getElementById("al-btn-seguridad").addEventListener("click", () => mostrarModalSeguridad());
    document.getElementById("al-modal-cerrar").addEventListener("click", () => cerrarModalSeguridad());
    document.getElementById("al-modal-seguridad").addEventListener("click", (e) => {
        if (e.target.id === "al-modal-seguridad") cerrarModalSeguridad();
    });
    document.getElementById("al-barra-cerrar").addEventListener("click", (e) => {
        e.stopPropagation();
        ocultarBarraSuperior();
    });
    document.getElementById("al-barra-superior").addEventListener("click", () => abrirBannerDeNuevo());
    document.getElementById("al-tarjeta-cerrar").addEventListener("click", () => ocultarTarjeta());
    document.getElementById("al-tarjeta-btn").addEventListener("click", () => abrirBannerDeNuevo());

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            if (document.getElementById("al-modal-seguridad").classList.contains("al-visible")) {
                cerrarModalSeguridad();
            } else if (document.getElementById("al-overlay").classList.contains("al-visible")) {
                cerrarBannerActual();
            }
        }
    });
}

async function obtenerModuloMapa() {
    try { return await import("./map.js"); }
    catch (e) { console.warn("alertas.js: no se pudo importar map.js", e); return null; }
}

function iniciarIntervalMaestro() {
    if (estado.intervalMaestro !== null) return;
    estado.intervalMaestro = setInterval(tickMaestro, 1000);
}

function detenerIntervalMaestro() {
    if (estado.intervalMaestro !== null) {
        clearInterval(estado.intervalMaestro);
        estado.intervalMaestro = null;
    }
}

async function tickMaestro() {
    const aQuitar = [];
    for (const [distrito, zona] of estado.zonasActivas.entries()) {
        const ef = calcularNivelEfectivo(zona.nivelKey, zona.timestampInicio, zona.duracionMin, zona.origen);
        if (ef.nivel === "libre") { aQuitar.push(distrito); continue; }
        if (ef.nivel !== zona.nivelActual) {
            zona.nivelActual = ef.nivel;
            const mod = await obtenerModuloMapa();
            if (mod && typeof mod.pintarPoligonoZona === "function") {
                const nivel = NIVELES_ALERTA[ef.nivel];
                if (nivel) { try { await mod.pintarPoligonoZona(distrito, nivel.color, ef.nivel); } catch (e) {} }
            }
            if (estado.bannerActual === distrito) {
                const overlay = document.getElementById("al-overlay");
                const estabaVisible = overlay?.classList.contains("al-visible");
                pintarBannerDeZona(zona, { noReabrir: !estabaVisible });
            }
        }
    }
    for (const distrito of aQuitar) { try { await quitarAlerta(distrito); } catch (e) { console.error(e); } }
    if (estado.zonasActivas.size === 0) { detenerIntervalMaestro(); return; }
    if (estado.bannerActual) {
        const zona = estado.zonasActivas.get(estado.bannerActual);
        if (zona) {
            const ef = calcularNivelEfectivo(zona.nivelKey, zona.timestampInicio, zona.duracionMin, zona.origen);
            const el = document.getElementById("al-contador");
            if (el) {
                el.textContent = formatearTiempo(ef.restanteSeg);
                if (ef.restanteSeg <= 60) el.classList.add("al-critico");
                else el.classList.remove("al-critico");
            }
        }
    }
    actualizarBarraYTarjetaAgregadas();
}

function formatearTiempo(segundos) {
    if (segundos < 0) segundos = 0;
    const h = Math.floor(segundos / 3600);
    const m = Math.floor((segundos % 3600) / 60);
    const s = segundos % 60;
    return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
}

function tiempoRestanteZona(zona) {
    return calcularNivelEfectivo(zona.nivelKey, zona.timestampInicio, zona.duracionMin, zona.origen).restanteSeg;
}

export async function pintarZonasBaseSiProcede() {
    try {
        const mod = await import("./map.js");
        if (mod && typeof mod.pintarZonasBaseVerde === "function") {
            await mod.pintarZonasBaseVerde();
        }
    } catch (e) { console.warn("alertas.js: no se pudo pintar zonas base:", e); }
}

export async function mostrarAlertaCompleta(datos = {}) {
    try {
        const origen = datos.origen || null;
        const filtro = APP_CONFIG.origenFiltro;

        if (filtro === "manual" && origen !== "manual") return;
        if (filtro === "scraper" && origen === "manual") return;

        const distrito = datos.distrito || "";
        if (esZonaOcultaManual(distrito)) return;

        libreYaCerradoPorUsuario = false;
        asegurarEstructuraDOM();
        inyectarBotonSonido();

        const nivelKey = NIVELES_ALERTA[datos.nivel] ? datos.nivel : "roja";
        const distritoFinal = distrito || `Zona ${estado.zonasActivas.size + 1}`;
        const duracionMin = (datos.duracionMin && datos.duracionMin > 0) ? datos.duracionMin : DURACION_TIMER_MINUTOS;
        const tsInicio = (typeof datos.timestampInicio === "number" && datos.timestampInicio > 0) ? datos.timestampInicio : Date.now();
        
        const yaExistia = estado.zonasActivas.has(distritoFinal);
        const zonaAnterior = yaExistia ? estado.zonasActivas.get(distritoFinal) : null;
        const cambioNivel = !!(zonaAnterior && zonaAnterior.nivelKey !== nivelKey);
        const esScraperMode = filtro === "scraper";

        estado.zonasActivas.set(distritoFinal, {
            nivel: nivelKey,
            nivelKey,
            nivelActual: nivelKey,
            distrito: distritoFinal,
            lat: datos.lat ?? null,
            lng: datos.lng ?? null,
            duracionMin,
            timestampInicio: tsInicio,
            origen,
            sectorOriginal: datos.sectorOriginal || null,
            inicio: datos.inicio || null,
            fin: datos.fin || null,
            titulo: datos.titulo || `⚡ ALERTA ${nivelKey.toUpperCase()} — ${distritoFinal}`,
            mensaje: datos.mensaje || `Actividad eléctrica detectada en ${distritoFinal}.`
        });

        iniciarIntervalMaestro();

        if (distritoFinal) {
            const mod = await obtenerModuloMapa();
            if (mod && typeof mod.pintarPoligonoZona === "function") {
                const nivel = NIVELES_ALERTA[nivelKey];
                try { await mod.pintarPoligonoZona(distritoFinal, nivel.color, nivelKey); } catch (e) {}
            }
        }

        if (!yaExistia && datos.lat != null && datos.lng != null) {
            const mod = await obtenerModuloMapa();
            if (mod && typeof mod.iluminarDistrito === "function") {
                if (capasRayos.has(distritoFinal)) {
                    try { capasRayos.get(distritoFinal).detener(); } catch (e) {}
                    capasRayos.delete(distritoFinal);
                }
                const capa = await mod.iluminarDistrito(datos.lat, datos.lng, nivelKey);
                if (capa) capasRayos.set(distritoFinal, capa);
            }
        }

        if (!yaExistia) {
            estado.colaBanners.push(distritoFinal);
            estado.colaBanners.sort((a, b) => {
                const za = estado.zonasActivas.get(a);
                const zb = estado.zonasActivas.get(b);
                if (!za || !zb) return 0;
                return NIVELES_ALERTA[zb.nivelActual].orden - NIVELES_ALERTA[za.nivelActual].orden;
            });
        }

        const forzarReabrir = esScraperMode && cambioNivel;

        if (estado.bannerActual === null || forzarReabrir) {
            if (forzarReabrir) {
                estado.bannerActual = null;
                estado.colaBanners.unshift(distritoFinal);
            }
            mostrarSiguienteBanner();
        } else if (estado.bannerActual === distritoFinal) {
            const overlay = document.getElementById("al-overlay");
            const estabaVisible = overlay?.classList.contains("al-visible");
            pintarBannerDeZona(estado.zonasActivas.get(distritoFinal), {
                noReabrir: !estabaVisible
            });
            if (forzarReabrir) {
                overlay.classList.add("al-visible");
            }
        } else {
            actualizarIndicadorCola();
        }

        actualizarBarraYTarjetaAgregadas();

        const debeSonar = nivelKey !== "vigilancia" && (!yaExistia || (esScraperMode && cambioNivel));
        if (debeSonar) {
            try { reproducirSonidoAlerta(30); } catch (e) {}
        }
    } catch (e) {
        console.error("alertas.js: error al mostrar alerta", e);
    }
}

export async function quitarAlerta(distrito) {
    try {
        if (!distrito) return false;
        let distritoReal = null;
        for (const key of estado.zonasActivas.keys()) {
            if (key === distrito || key.includes(distrito) || distrito.includes(key)) {
                distritoReal = key;
                break;
            }
        }
        if (!distritoReal) return false;

        const origen = estado.zonasActivas.get(distritoReal)?.origen || null;
        const esOculta = APP_CONFIG.origenFiltro === "manual" && esZonaOcultaManual(distritoReal);

        if (!esOculta) {
            const mod = await obtenerModuloMapa();
            if (mod && typeof mod.pintarPoligonoZona === "function") {
                try { await mod.pintarPoligonoZona(distritoReal, VERDE_BASE, "vigilancia"); } catch (e) {}
            }
        } else {
            const mod = await obtenerModuloMapa();
            if (mod && typeof mod.quitarPoligonoZona === "function") {
                try { mod.quitarPoligonoZona(distritoReal); } catch (e) {}
            }
        }

        if (capasRayos.has(distritoReal)) {
            try { capasRayos.get(distritoReal).detener(); } catch (e) {}
            capasRayos.delete(distritoReal);
        }

        estado.zonasActivas.delete(distritoReal);
        estado.colaBanners = estado.colaBanners.filter(d => d !== distritoReal);

        if (estado.bannerActual === distritoReal) {
            estado.bannerActual = null;
            cerrarBanner();
            if (estado.colaBanners.length > 0) { mostrarSiguienteBanner(); }
        } else {
            actualizarIndicadorCola();
        }

        if (estado.zonasActivas.size === 0) {
            detenerIntervalMaestro();
            detenerSonidoAlerta();
            const esScraperMode = APP_CONFIG.origenFiltro === "scraper";
            mostrarAlertaLibre(esScraperMode);
        } else {
            actualizarBarraYTarjetaAgregadas();
        }
        return true;
    } catch (e) {
        console.error("alertas.js: error al quitar alerta", e);
        return false;
    }
}

function mostrarSiguienteBanner() {
    if (estado.colaBanners.length === 0) {
        estado.bannerActual = null;
        cerrarBanner();
        if (estado.zonasActivas.size === 0) mostrarAlertaLibre();
        return;
    }
    const distrito = estado.colaBanners.shift();
    const zona = estado.zonasActivas.get(distrito);
    if (!zona) { mostrarSiguienteBanner(); return; }
    estado.bannerActual = distrito;
    pintarBannerDeZona(zona);
    actualizarIndicadorCola();
}

function actualizarIndicadorCola() {
    const el = document.getElementById("al-cola-indicador");
    if (!el) return;
    const p = estado.colaBanners.length;
    if (p === 0) { el.style.display = "none"; el.textContent = ""; return; }
    el.style.display = "block";
    el.textContent = `+ ${p} zona${p > 1 ? "s" : ""} en alerta`;
}

function pintarBannerDeZona(zona, opts = {}) {
    const nivelKeyActual = zona.nivelActual || zona.nivelKey;
    const nivel = NIVELES_ALERTA[nivelKeyActual];
    if (!nivel) return;

    const overlayEl = document.getElementById("al-overlay");
    const panelEl = document.getElementById("al-panel");
    const modalEl = document.getElementById("al-modal-seguridad");

    overlayEl.classList.remove("al-libre");

    if (panelEl) {
        panelEl.style.background = `linear-gradient(160deg, ${nivel.color}, ${nivel.colorDark})`;
        panelEl.style.borderColor = nivel.color;
    }

    const vars = [
        ["--al-color", nivel.color],
        ["--al-color-dark", nivel.colorDark],
        ["--al-glow", nivel.glow]
    ];
    const aplicarVars = (el) => { if (!el) return; vars.forEach(([k, v]) => el.style.setProperty(k, v)); };
    aplicarVars(overlayEl);
    aplicarVars(panelEl);
    aplicarVars(modalEl);

    // AQUI SE DECIDE SI USAR EL RAYO (iconoBig) O EL CIRCULO (icono)
    const iconoAMostrar = isKeraunos ? nivel.icono : nivel.iconoBig;
    
    document.getElementById("al-icono-big").textContent = iconoAMostrar;
    document.getElementById("al-nivel-badge").textContent = nivel.nombre;
    document.getElementById("al-titulo-texto").textContent = zona.titulo;
    document.getElementById("al-mensaje-texto").textContent = zona.mensaje;
    document.getElementById("al-recomendacion-texto").textContent = nivel.recomendacion;

    panelEl.classList.remove("al-resplandor-activo", "al-sirena-activa");
    void panelEl.offsetWidth;

    if (!opts.noReabrir) overlayEl.classList.add("al-visible");
    panelEl.classList.add("al-sirena-activa");

    if (!opts.noReabrir) activarFlashFondo(); // MANTENEMOS EL FLASH DE FONDO

    const wrap = document.getElementById("al-contador-wrap");
    const el = document.getElementById("al-contador");
    if (wrap) wrap.style.display = "block";
    if (el) el.textContent = formatearTiempo(tiempoRestanteZona(zona));

    actualizarTimestampBarra(zona.timestampInicio);
    if (!opts.noReabrir) setTimeout(() => document.getElementById("al-btn-cerrar")?.focus(), 800);
}

function cerrarBannerActual() {
    cerrarBanner();
    estado.bannerActual = null;
    if (estado.colaBanners.length > 0) {
        setTimeout(() => mostrarSiguienteBanner(), 400);
    } else if (estado.zonasActivas.size > 0) {
        actualizarBarraYTarjetaAgregadas();
    } else {
        libreYaCerradoPorUsuario = true;
        mostrarBarraTarjetaLibre();
    }
}

function cerrarBanner() {
    const o = document.getElementById("al-overlay");
    o?.classList.remove("al-visible");
    o?.classList.remove("al-libre");
}

function abrirOverlayLibre() {
    try {
        asegurarEstructuraDOM();
        const nivel = NIVELES_ALERTA.vigilancia;
        const overlayEl = document.getElementById("al-overlay");
        const panelEl = document.getElementById("al-panel");
        const modalEl = document.getElementById("al-modal-seguridad");

        if (panelEl) {
            panelEl.style.background = "";
            panelEl.style.borderColor = "";
        }

        const vars = [
            ["--al-color", nivel.color],
            ["--al-color-dark", nivel.colorDark],
            ["--al-glow", nivel.glow]
        ];
        const aplicarVars = (el) => { if (!el) return; vars.forEach(([k, v]) => el.style.setProperty(k, v)); };
        aplicarVars(overlayEl);
        aplicarVars(panelEl);
        aplicarVars(modalEl);

        document.getElementById("al-icono-big").textContent = "✅";
        document.getElementById("al-nivel-badge").textContent = "VIGILANCIA";
        document.getElementById("al-nivel-badge").style.background = nivel.color;
        document.getElementById("al-titulo-texto").textContent = "🟢 LIBRE DE ALERTAS";
        document.getElementById("al-mensaje-texto").textContent =
            "No se han emitido alertas meteorológicas. El sistema se encuentra en vigilancia.";
        document.getElementById("al-recomendacion-texto").textContent =
            "Manténgase informado sobre el desarrollo del clima.";

        const wrap = document.getElementById("al-contador-wrap");
        if (wrap) wrap.style.display = "none";

        panelEl.classList.remove("al-resplandor-activo", "al-sirena-activa");
        void panelEl.offsetWidth;

        overlayEl.classList.add("al-visible", "al-libre");

        const cola = document.getElementById("al-cola-indicador");
        if (cola) cola.style.display = "none";
    } catch (e) { console.error("alertas.js: error al abrir overlay libre", e); }
}

function actualizarBarraYTarjetaAgregadas() {
    const barra = document.getElementById("al-barra-superior");
    const tarjeta = document.getElementById("al-tarjeta");
    if (!barra || !tarjeta) return;

    const zonas = Array.from(estado.zonasActivas.values());
    if (zonas.length === 0) return;

    let nivelMax = NIVELES_ALERTA.vigilancia;
    for (const z of zonas) {
        const n = NIVELES_ALERTA[z.nivelActual || z.nivelKey];
        if (n.orden > nivelMax.orden) nivelMax = n;
    }

    barra.classList.remove("al-modo-libre");
    tarjeta.classList.remove("al-modo-libre");

    if (barra) barra.style.background = `linear-gradient(160deg, rgba(20, 20, 25, 0.96), ${nivelMax.colorDark})`;
    if (tarjeta) {
        tarjeta.style.background = `linear-gradient(160deg, rgba(20, 20, 25, 0.96), ${nivelMax.colorDark})`;
        tarjeta.style.borderLeft = `4px solid ${nivelMax.color}`;
    }

    const vars = [
        ["--al-color", nivelMax.color],
        ["--al-color-dark", nivelMax.colorDark],
        ["--al-glow", nivelMax.glow]
    ];
    const aplicarVars = (el) => { if (!el) return; vars.forEach(([k, v]) => el.style.setProperty(k, v)); };
    aplicarVars(barra);
    aplicarVars(tarjeta);

    document.getElementById("al-barra-icono").textContent = nivelMax.iconoBig;

    if (zonas.length === 1) {
        const z = zonas[0];
        const n = NIVELES_ALERTA[z.nivelActual || z.nivelKey];
        document.getElementById("al-barra-nivel").textContent = (n.nombre + " " + n.icono).toUpperCase();
        document.getElementById("al-barra-desc").textContent = `${z.sectorOriginal || z.distrito} · ${z.distrito}`;
    } else {
        document.getElementById("al-barra-nivel").textContent = `${zonas.length} ZONAS EN ALERTA`;
        const resumen = zonas.slice()
            .sort((a, b) => NIVELES_ALERTA[b.nivelActual || b.nivelKey].orden - NIVELES_ALERTA[a.nivelActual || a.nivelKey].orden)
            .map(z => {
                const n = NIVELES_ALERTA[z.nivelActual || z.nivelKey];
                return `${n.icono} ${z.distrito}`;
            }).join(" · ");
        document.getElementById("al-barra-desc").textContent = resumen;
    }
    barra.classList.add("al-visible");

    document.getElementById("al-tarjeta-icono").textContent = nivelMax.iconoBig;

    if (zonas.length === 1) {
        const z = zonas[0];
        const n = NIVELES_ALERTA[z.nivelActual || z.nivelKey];
        document.getElementById("al-tarjeta-sub").textContent = ("ALERTA " + n.nombre).toUpperCase();
        document.getElementById("al-tarjeta-titulo").textContent = z.titulo;
        const cuerpo = [];
        if (z.sectorOriginal) cuerpo.push(`<strong>🏭 Sector:</strong> ${z.sectorOriginal}`);
        if (z.distrito)       cuerpo.push(`<strong>📍 Zona:</strong> ${z.distrito}`);
        cuerpo.push(`<strong>⚡ Nivel actual:</strong> ${n.nombre}`);
        cuerpo.push(`<strong>⏰ Restante:</strong> ${formatearTiempo(tiempoRestanteZona(z))}`);
        document.getElementById("al-tarjeta-cuerpo").innerHTML = cuerpo.join("<br>");
    } else {
        document.getElementById("al-tarjeta-sub").textContent = `${zonas.length} ZONAS EN ALERTA`;
        document.getElementById("al-tarjeta-titulo").textContent = "Alerta múltiple";
        const lineas = zonas.slice()
            .sort((a, b) => NIVELES_ALERTA[b.nivelActual || b.nivelKey].orden - NIVELES_ALERTA[a.nivelActual || a.nivelKey].orden)
            .map(z => {
                const n = NIVELES_ALERTA[z.nivelActual || z.nivelKey];
                const t = formatearTiempo(tiempoRestanteZona(z));
                return `${n.icono} <strong>${z.distrito}</strong> — ${n.nombre}<br>⏰ Restante: ${t}`;
            });
        document.getElementById("al-tarjeta-cuerpo").innerHTML = lineas.join("<br><br>");
    }
    tarjeta.classList.add("al-visible");
}

function actualizarTimestampBarra(timestampInicio) {
    const el = document.getElementById("al-barra-tiempo");
    if (!el) return;
    const actualizar = () => {
        if (!timestampInicio) return;
        const diff = Math.floor((Date.now() - timestampInicio) / 1000);
        let txt;
        if (diff < 60) txt = `Hace ${diff} seg`;
        else if (diff < 3600) txt = `Hace ${Math.floor(diff / 60)} min`;
        else txt = `Hace ${Math.floor(diff / 3600)} h`;
        el.textContent = txt;
    };
    actualizar();
    if (estado.intervalTimestamp) clearInterval(estado.intervalTimestamp);
    estado.intervalTimestamp = setInterval(actualizar, 15000);
}

export function mostrarBarraTarjetaLibre() {
    try {
        asegurarEstructuraDOM();
        const nivel = NIVELES_ALERTA.vigilancia;
        const vars = [
            ["--al-color", nivel.color],
            ["--al-color-dark", nivel.colorDark],
            ["--al-glow", nivel.glow]
        ];
        const aplicarVars = (el) => { if (!el) return; vars.forEach(([k, v]) => el.style.setProperty(k, v)); };

        const barra = document.getElementById("al-barra-superior");
        const tarjeta = document.getElementById("al-tarjeta");

        if (barra) { barra.style.background = ""; barra.style.borderColor = ""; }
        if (tarjeta) { tarjeta.style.background = ""; tarjeta.style.borderLeft = ""; }

        aplicarVars(barra);
        aplicarVars(tarjeta);

        barra?.classList.add("al-modo-libre");
        tarjeta?.classList.add("al-modo-libre");

        document.getElementById("al-barra-icono").textContent = "✅";
        document.getElementById("al-barra-nivel").textContent = "LIBRE DE ALERTAS";
        document.getElementById("al-barra-desc").textContent = "Sistema en vigilancia — sin alertas activas";
        document.getElementById("al-barra-tiempo").textContent = "Vigilancia";
        barra?.classList.add("al-visible");

        document.getElementById("al-tarjeta-icono").textContent = "✅";
        document.getElementById("al-tarjeta-sub").textContent = "VIGILANCIA";
        document.getElementById("al-tarjeta-titulo").textContent = "Libre de alertas";
        document.getElementById("al-tarjeta-cuerpo").innerHTML =
            "<strong>🟢 Estado:</strong> Sin alertas meteorológicas<br>" +
            "<strong>📍 Sistema:</strong> En vigilancia";
        tarjeta?.classList.add("al-visible");
    } catch (e) { console.error("alertas.js: error al mostrar barra/tarjeta libre", e); }
}

export function mostrarAlertaLibre(forzar = false) {
    try {
        if (!forzar && arranque.esperando) return;
        if (!forzar && libreYaCerradoPorUsuario) {
            asegurarEstructuraDOM();
            mostrarBarraTarjetaLibre();
            return;
        }
        if (forzar) libreYaCerradoPorUsuario = false;

        if (estado.zonasActivas.size > 0) return;

        asegurarEstructuraDOM();
        detenerIntervalMaestro();
        detenerSonidoAlerta();

        for (const [, capa] of capasRayos.entries()) { try { capa.detener(); } catch (e) {} }
        capasRayos.clear();

        obtenerModuloMapa().then(mod => {
            if (!mod) return;
            if (typeof mod.pintarZonasBaseVerde === "function") {
                mod.pintarZonasBaseVerde().catch(() => {});
            }
        }).catch(() => {});

        estado.zonasActivas.clear();
        estado.colaBanners = [];
        estado.bannerActual = null;

        abrirOverlayLibre();
        mostrarBarraTarjetaLibre();

        setTimeout(() => document.getElementById("al-btn-cerrar")?.focus(), 1000);
    } catch (e) { console.error("alertas.js: error al mostrar alerta libre", e); }
}

function verMapaAlerta() {
    try {
        const o = document.getElementById("al-overlay");
        o?.classList.remove("al-visible");
        o?.classList.remove("al-libre");
        setTimeout(() => {
            const mapEl = document.getElementById("map");
            if (mapEl) mapEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 150);
    } catch (e) {}
}

function abrirBannerDeNuevo() {
    if (estado.bannerActual) {
        const o = document.getElementById("al-overlay");
        if (o && !o.classList.contains("al-visible")) {
            o.classList.add("al-visible");
            o.classList.remove("al-libre");
            const p = document.getElementById("al-panel");
            if (p) { p.classList.remove("al-sirena-activa"); void p.offsetWidth; p.classList.add("al-sirena-activa"); }
        }
        return;
    }
    if (estado.colaBanners.length > 0) { mostrarSiguienteBanner(); return; }
    if (estado.zonasActivas.size > 0) {
        estado.colaBanners = Array.from(estado.zonasActivas.keys());
        estado.colaBanners.sort((a, b) => {
            const za = estado.zonasActivas.get(a);
            const zb = estado.zonasActivas.get(b);
            if (!za || !zb) return 0;
            return NIVELES_ALERTA[zb.nivelActual || zb.nivelKey].orden - NIVELES_ALERTA[za.nivelActual || za.nivelKey].orden;
        });
        mostrarSiguienteBanner();
        return;
    }
    abrirOverlayLibre();
}

function mostrarModalSeguridad() {
    try {
        let nivelKey = "roja";
        if (estado.bannerActual) {
            const z = estado.zonasActivas.get(estado.bannerActual);
            if (z) nivelKey = z.nivelActual || z.nivelKey;
        } else if (estado.zonasActivas.size > 0) {
            let max = NIVELES_ALERTA.vigilancia;
            for (const z of estado.zonasActivas.values()) {
                const n = NIVELES_ALERTA[z.nivelActual || z.nivelKey];
                if (n.orden > max.orden) max = n;
            }
            nivelKey = Object.keys(NIVELES_ALERTA).find(k => NIVELES_ALERTA[k] === max) || "roja";
        } else nivelKey = "vigilancia";

        const nivel = NIVELES_ALERTA[nivelKey];
        document.getElementById("al-modal-sub").textContent = ("NIVEL: " + nivel.nombre).toUpperCase();
        document.getElementById("al-modal-seguridad").style.setProperty("--al-color", nivel.color);

        const leyenda = document.getElementById("al-leyenda");
        leyenda.innerHTML = "";
        Object.entries(NIVELES_ALERTA).forEach(([k, n]) => {
            const item = document.createElement("div");
            item.className = "al-leyenda-item";
            item.innerHTML = `
                <span class="al-leyenda-punto" style="background:${n.color}"></span>
                <span class="al-leyenda-nombre">${n.icono} ${n.nombre}</span>
                <span class="al-leyenda-desc">— ${n.descripcion}</span>`;
            leyenda.appendChild(item);
        });

        const lista = document.getElementById("al-medidas-lista");
        lista.innerHTML = "";
        const medidas = MEDIDAS_SEGURIDAD[nivelKey] || MEDIDAS_SEGURIDAD.roja;
        medidas.forEach(m => {
            const d = document.createElement("div");
            d.className = "al-medida";
            d.innerHTML = `<span class="al-medida-icono">${m.icono}</span><span class="al-medida-texto">${m.texto}</span>`;
            lista.appendChild(d);
        });

        document.getElementById("al-modal-seguridad").classList.add("al-visible");
    } catch (e) { console.error("alertas.js: error modal seguridad", e); }
}

function cerrarModalSeguridad() { document.getElementById("al-modal-seguridad")?.classList.remove("al-visible"); }

function activarFlashFondo() {
    try {
        const body = document.body;
        body.classList.remove("al-flash-activo");
        void body.offsetWidth;
        body.classList.add("al-flash-activo");
        setTimeout(() => body.classList.remove("al-flash-activo"), 4600);
    } catch (e) {}
}

function ocultarBarraSuperior() {
    const b = document.getElementById("al-barra-superior");
    if (b?.classList.contains("al-modo-libre")) return;
    if (estado.zonasActivas.size > 0) return;
    b?.classList.remove("al-visible");
    if (estado.intervalTimestamp) { clearInterval(estado.intervalTimestamp); estado.intervalTimestamp = null; }
}

function ocultarTarjeta() {
    const t = document.getElementById("al-tarjeta");
    if (t?.classList.contains("al-modo-libre")) return;
    if (estado.zonasActivas.size > 0) return;
    t?.classList.remove("al-visible");
}

export function cerrarAlerta() { cerrarBannerActual(); }

export function cerrarAlertaTotal() {
    cerrarBanner();
    ocultarBarraSuperior();
    ocultarTarjeta();
    cerrarModalSeguridad();
    detenerIntervalMaestro();
    detenerSonidoAlerta();
    for (const [, capa] of capasRayos.entries()) { try { capa.detener(); } catch (e) {} }
    capasRayos.clear();
    estado.zonasActivas.clear();
    estado.colaBanners = [];
    estado.bannerActual = null;
    obtenerModuloMapa().then(mod => {
        if (mod && typeof mod.pintarZonasBaseVerde === "function") {
            mod.pintarZonasBaseVerde().catch(() => {});
        }
    }).catch(() => {});
}

export function hayAlertaActiva() { return estado.zonasActivas.size > 0; }
export function obtenerZonasActivas() { return Array.from(estado.zonasActivas.values()); }
