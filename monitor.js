// ============================================================
//  Monitor Keraunos — Scraper (v9)
//  ------------------------------------------------------------
//  Responsabilidad ÚNICA:
//    1. Scrapear Keraunos cada INTERVALO ms.
//    2. Extraer {nombre, nivel, inicio, fin} por cada tarjeta.
//    3. Escribir estado.json con `sectores[]` + `alertas[]`.
//    4. git push a GitHub Pages.
//
//  FIX v9 (sobre v8) — HORAS DE INICIO/FIN:
//    - FIX ZONA HORARIA (el bug de las "horas erróneas"):
//        Antes:  Date.parse("2026-10-05 13:23:17".replace(" ","T"))
//                -> se interpretaba en la zona horaria DEL SERVIDOR.
//        Como Keraunos publica en hora de Perú (UTC-5), en un server
//        UTC el timestamp salía 5 h desfasado (y con él el contador
//        "Restante" y la barra "Hace X" del frontend).
//        Ahora:  parseFechaKeraunos() construye el instante UTC
//                asumiendo CONFIG.TZ_OFFSET_MIN (Perú = -300),
//                de modo que el resultado es idéntico sin importar
//                la TZ del servidor.
//
//    - FIX EXTRACCIÓN ROBUSTA:
//        Antes el regex exigía EXACTAMENTE "YYYY-MM-DD HH:MM:SS" y
//        las etiquetas "inicio"/"fin"; si la página cambiaba de
//        formato (sin segundos, separador "T", etiqueta distinta)
//        devolvía null EN SILENCIO.
//        Ahora extraerFechaDeTexto() acepta variantes y se añade
//        un log de aviso cuando un sector con alerta no trae horas.
//
//  FIX v8 (mantenido): coincidencia PARCIAL de zona (buscarZona).
//  FIX v7 (mantenido): sin "git stash"; solo "git pull --rebase
//                      --autostash"; "git add -f".
// ============================================================

const { exec } = require('child_process');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const CONFIG = require('./config.js');

const URL = CONFIG.URL;
const ARCHIVO_LOG = CONFIG.ARCHIVO_LOG;
const ARCHIVO_JSON = CONFIG.ARCHIVO_JSON;
const INTERVALO = CONFIG.INTERVALO;

// Zona horaria de las horas de Keraunos (Perú = UTC-5 => -300 min).
// Se puede sobreescribir desde config.js con TZ_OFFSET_MIN.
const TZ_OFFSET_MIN = (typeof CONFIG.TZ_OFFSET_MIN === "number")
    ? CONFIG.TZ_OFFSET_MIN
    : -300;

// ------------------------------------------------------------
//  Mapa de niveles -> color y número
// ------------------------------------------------------------
const NIVELES = {
    ROJA:     { numero: 3, color: "#FA5858", clase: "roja",     emoji: "🔴" },
    NARANJA:  { numero: 2, color: "#FF8C00", clase: "naranja",  emoji: "🟠" },
    AMARILLA: { numero: 1, color: "#FFD400", clase: "amarilla", emoji: "🟡" },
    VERDE:    { numero: 0, color: "#2ECC71", clase: "verde",    emoji: "🟢" }
};

function registrarLog(mensaje) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const logLinea = `[${timestamp}] ${mensaje}\n`;
    console.log(logLinea.trim());
    try { fs.appendFileSync(ARCHIVO_LOG, logLinea, 'utf-8'); } catch (e) {}
}

// ------------------------------------------------------------
//  Normaliza un texto para comparar (minúsculas, espacios simples)
// ------------------------------------------------------------
function normalizar(texto) {
    return (texto || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------
//  FIX v9: convierte "YYYY-MM-DD HH:MM:SS" (o "YYYY-MM-DDTHH:MM[:SS]")
//  al instante UTC en ms, ASUMIENDO que la hora viene en la zona
//  horaria TZ_OFFSET_MIN (Perú = -300). Independiente de la TZ del
//  servidor. Devuelve NaN si no se puede parsear.
// ------------------------------------------------------------
function parseFechaKeraunos(texto) {
    if (!texto) return NaN;
    const m = String(texto).match(
        /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/
    );
    if (!m) return NaN;
    const Y  = Number(m[1]);
    const Mo = Number(m[2]);
    const D  = Number(m[3]);
    const H  = Number(m[4]);
    const Mi = Number(m[5]);
    const S  = m[6] ? Number(m[6]) : 0;

    // Date.UTC(...) da el instante como si fuera UTC; restamos el
    // offset (offset negativo = por detrás de UTC => sumamos horas).
    return Date.UTC(Y, Mo - 1, D, H, Mi, S) - TZ_OFFSET_MIN * 60000;
}

// ------------------------------------------------------------
//  FIX v9: extrae y normaliza una fecha "YYYY-MM-DD HH:MM:SS" de un
//  texto cualquiera. Acepta separador espacio o "T" y segundos
//  opcionales (los añade si faltan). Devuelve null si no hay fecha.
// ------------------------------------------------------------
function extraerFechaDeTexto(texto) {
    const m = String(texto || "").match(
        /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/
    );
    if (!m) return null;
    let hora = m[2];
    if (hora.length === 5) hora += ":00"; // "HH:MM" -> "HH:MM:SS"
    return `${m[1]} ${hora}`;
}

// ------------------------------------------------------------
//  Detecta el nivel de UNA tarjeta
// ------------------------------------------------------------
function detectarNivelDeTarjeta($, el) {
    const $el = $(el);

    let textoNivel = $el.find('.alert-text h2').first().text().trim().toUpperCase();
    if (!textoNivel) textoNivel = $el.find('.badge').first().text().trim().toUpperCase();
    if (!textoNivel) textoNivel = $el.find('.card-message').first().text().trim().toUpperCase();
    if (!textoNivel) textoNivel = $el.find('.icon').first().text().trim();
    if (!textoNivel) textoNivel = ($el.find('.alert-box').attr('style') || '').toUpperCase();

    if (textoNivel.includes("ROJA") || textoNivel.includes("ROJO") ||
        textoNivel.includes("NIVEL 3") || textoNivel.includes("🔴") ||
        textoNivel.includes("#FA5858")) {
        return "ROJA";
    }
    if (textoNivel.includes("NARANJA") ||
        textoNivel.includes("NIVEL 2") || textoNivel.includes("🟠") ||
        textoNivel.includes("#FF8C00")) {
        return "NARANJA";
    }
    if (textoNivel.includes("AMARILLA") || textoNivel.includes("AMARILLO") ||
        textoNivel.includes("NIVEL 1") || textoNivel.includes("🟡") ||
        textoNivel.includes("#FFD400")) {
        return "AMARILLA";
    }

    return "VERDE";
}

// ------------------------------------------------------------
//  FIX v9: extrae hora de INICIO y FIN de UNA tarjeta.
//  - Acepta variantes de formato (con/sin segundos, "T" o espacio).
//  - Acepta variantes de etiqueta (inicio/inicia/desde/comienzo y
//    fin/final/hasta/término/previsto).
//  - Si no hay etiqueta, usa el orden (1ª fecha = inicio, 2ª = fin).
// ------------------------------------------------------------
function extraerHorasDeTarjeta($, el) {
    const $el = $(el);
    let inicio = null;
    let fin = null;
    const sinEtiqueta = [];

    $el.find('.small-text').each((i, p) => {
        const texto = $(p).text().trim();
        const valor = extraerFechaDeTexto(texto);
        if (!valor) return;

        const t = texto.toLowerCase();
        const esInicio = /inicio|inicia|desde|comienz/.test(t);
        const esFin    = /fin|final|hasta|termin|previst/.test(t);

        if (esInicio && !esFin)      inicio = valor;
        else if (esFin && !esInicio) fin = valor;
        else                         sinEtiqueta.push(valor);
    });

    // Fallback: si no hubo etiquetas reconocibles, asumir orden.
    if (inicio === null && fin === null && sinEtiqueta.length > 0) {
        inicio = sinEtiqueta[0] || null;
        fin    = sinEtiqueta[1] || null;
    }

    return { inicio, fin };
}

// ------------------------------------------------------------
//  FIX v8: busca la zona por COINCIDENCIA PARCIAL del nombre.
// ------------------------------------------------------------
function buscarZona(nombre) {
    const norm = normalizar(nombre);
    for (const clave of Object.keys(CONFIG.MAPA_ZONAS)) {
        if (norm.includes(normalizar(clave))) {
            return CONFIG.MAPA_ZONAS[clave];
        }
    }
    return null;
}

// ------------------------------------------------------------
//  Consulta la página y devuelve el estado por sector
// ------------------------------------------------------------
async function consultarKeraunos() {
    try {
        const respuesta = await axios.get(URL, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 20000
        });

        const $ = cheerio.load(respuesta.data);
        const tarjetas = $('.card.card-activo');
        const sectoresEnPagina = [];

        tarjetas.each((i, el) => {
            const $el = $(el);
            let nombre = $el.find('h1.title').first().text().trim();
            if (!nombre) nombre = ($el.attr('data-nombre') || `Sector ${i + 1}`).trim();

            const nivel = detectarNivelDeTarjeta($, el);
            const { inicio, fin } = extraerHorasDeTarjeta($, el);

            // FIX v9: aviso si hay alerta pero no se pudieron leer las horas.
            if (nivel !== "VERDE" && (!inicio || !fin)) {
                registrarLog(
                    `Aviso: sector con alerta ${nivel} pero sin horas legibles -> ` +
                    `${nombre.substring(0, 60)} (inicio=${inicio}, fin=${fin})`
                );
            }

            sectoresEnPagina.push({ nombre, nivel, inicio, fin });
        });

        // Combinar con la lista maestra de sectores esperados.
        const sectoresDetectados = [];
        const usados = new Set();

        for (const esperado of CONFIG.SECTORES_ESPERADOS) {
            const normEsperado = normalizar(esperado);
            const encontrado = sectoresEnPagina.find(s =>
                normalizar(s.nombre).includes(normEsperado)
            );

            if (encontrado) {
                usados.add(encontrado.nombre);
                sectoresDetectados.push({
                    nombre: encontrado.nombre,
                    nivel: encontrado.nivel,
                    inicio: encontrado.inicio,
                    fin: encontrado.fin
                });
            } else {
                sectoresDetectados.push({
                    nombre: esperado,
                    nivel: "VERDE",
                    inicio: null,
                    fin: null
                });
            }
        }

        if (CONFIG.INCLUIR_SECTORES_EXTRA) {
            for (const s of sectoresEnPagina) {
                if (!usados.has(s.nombre)) {
                    sectoresDetectados.push({ ...s });
                }
            }
        }

        const sectoresFinal = sectoresDetectados.map(s => {
            const info = NIVELES[s.nivel];
            return {
                nombre: s.nombre,
                nivel: s.nivel,
                nivelNumero: info.numero,
                color: info.color,
                clase: info.clase,
                emoji: info.emoji,
                inicio: s.inicio,
                fin: s.fin
            };
        });

        // Estado global = nivel más alto
        let estadoGlobal = "VERDE";
        let maxNumero = 0;
        for (const s of sectoresFinal) {
            if (s.nivelNumero > maxNumero) {
                maxNumero = s.nivelNumero;
                estadoGlobal = s.nivel;
            }
        }

        return { estadoGlobal, sectoresDetectados: sectoresFinal };

    } catch (e) {
        registrarLog(`Error al consultar Keraunos: ${e.message}`);
        return null;
    }
}

// ------------------------------------------------------------
//  FIX v9: calcula duración y timestampInicio desde las horas
//  de la tarjeta, interpretándolas SIEMPRE en hora de Perú
//  (CONFIG.TZ_OFFSET_MIN). Si no hay hora de fin, usa
//  DURACION_DEFAULT_MIN.
// ------------------------------------------------------------
function calcularDuracion(sector) {
    const defMin = CONFIG.DURACION_DEFAULT_MIN || 15;

    if (!sector.inicio) {
        return { duracionMin: defMin, timestampInicio: Date.now() };
    }

    const inicioMs = parseFechaKeraunos(sector.inicio);
    if (isNaN(inicioMs)) {
        return { duracionMin: defMin, timestampInicio: Date.now() };
    }

    if (sector.fin) {
        const finMs = parseFechaKeraunos(sector.fin);
        if (!isNaN(finMs) && finMs > inicioMs) {
            const min = Math.round((finMs - inicioMs) / 60000);
            return { duracionMin: Math.max(1, min), timestampInicio: inicioMs };
        }
    }

    return { duracionMin: defMin, timestampInicio: inicioMs };
}

// ------------------------------------------------------------
//  Escribe estado.json con `sectores[]` + `alertas[]`
// ------------------------------------------------------------
function guardarJSON(estadoGlobal, sectores) {
    const alertas = [];

    for (const s of sectores) {
        if (s.nivel === "VERDE") continue;

        const zona = buscarZona(s.nombre);
        if (!zona) {
            registrarLog(`Aviso: sector sin zona mapeada, se omite alerta -> ${s.nombre}`);
            continue;
        }

        const coords = CONFIG.COORDENADAS_ZONAS[zona] || {};
        const { duracionMin, timestampInicio } = calcularDuracion(s);

        alertas.push({
            sectorOriginal:  s.nombre,
            nivelScraper:    s.nivel,
            nivel:           s.nivel.toLowerCase(),
            distrito:        zona,
            lat:             coords.lat ?? null,
            lng:             coords.lng ?? null,
            duracionMin,
            timestampInicio,
            inicio:          s.inicio || null,
            fin:             s.fin    || null,
            color:           s.color,
            emoji:           s.emoji,
            titulo:  `⚡ ALERTA ${s.nivel} — ${s.nombre}`,
            mensaje: `Actividad eléctrica detectada en ${s.nombre} (${zona}). ` +
                     `Nivel ${s.nivel}.` +
                     (s.inicio ? ` Inicio: ${s.inicio}.` : "") +
                     (s.fin    ? ` Fin previsto: ${s.fin}.` : "")
        });
    }

    const data = {
        actualizado: new Date().toISOString(),
        estadoGlobal,
        estadoGlobalNumero: NIVELES[estadoGlobal].numero,
        totalSectores: sectores.length,
        resumen: {
            roja:     sectores.filter(s => s.nivel === "ROJA").length,
            naranja:  sectores.filter(s => s.nivel === "NARANJA").length,
            amarilla: sectores.filter(s => s.nivel === "AMARILLA").length,
            verde:    sectores.filter(s => s.nivel === "VERDE").length
        },
        sectores: sectores.map(s => ({
            nombre: s.nombre,
            nivel: s.nivel,
            nivelNumero: s.nivelNumero,
            color: s.color,
            inicio: s.inicio,
            fin: s.fin
        })),
        alertas
    };

    fs.writeFileSync(ARCHIVO_JSON, JSON.stringify(data, null, 2), 'utf-8');
    return data;
}

// ------------------------------------------------------------
//  Procesa un resultado: guarda el JSON y hace push
// ------------------------------------------------------------
function procesarResultado(resultado) {
    if (!resultado) return;

    const json = guardarJSON(resultado.estadoGlobal, resultado.sectoresDetectados);

    registrarLog(
        `estado.json actualizado. Global: ${resultado.estadoGlobal} | ` +
        `R:${json.resumen.roja} N:${json.resumen.naranja} ` +
        `A:${json.resumen.amarilla} V:${json.resumen.verde} | ` +
        `Alertas publicadas: ${json.alertas.length}`
    );

    if (CONFIG.SUBIR_A_GITHUB) {
        subirAGithub();
    }
}

// ------------------------------------------------------------
//  Sube estado.json a GitHub (FIX v7)
// ------------------------------------------------------------
function subirAGithub() {
    const archivos = [ARCHIVO_JSON].join(" ");

    const cmd =
        `git pull --rebase --autostash --quiet origin main; ` +
        `git add -f ${archivos} && ` +
        `git commit -m "Update estado.json $(date +%H:%M)" && ` +
        `git push origin main`;

    exec(cmd, (error) => {
        if (error) {
            registrarLog(`Error en Git Push: ${error.message}`);
            exec("git rebase --abort 2>/dev/null", () => {});
            return;
        }
        registrarLog("estado.json subido a GitHub Pages exitosamente.");
    });
}

// ------------------------------------------------------------
//  Ciclo principal
// ------------------------------------------------------------
async function cicloPrincipal() {
    registrarLog(`Monitor Keraunos iniciado. Intervalo: ${INTERVALO / 1000}s | TZ Keraunos: UTC${TZ_OFFSET_MIN / 60}`);

    procesarResultado(await consultarKeraunos());

    setInterval(async () => {
        procesarResultado(await consultarKeraunos());
    }, INTERVALO);
}

module.exports = {
    consultarKeraunos,
    detectarNivelDeTarjeta,
    extraerHorasDeTarjeta,
    extraerFechaDeTexto,
    parseFechaKeraunos,
    buscarZona,
    guardarJSON,
    calcularDuracion,
    procesarResultado,
    NIVELES
};

if (require.main === module) {
    cicloPrincipal();
}
