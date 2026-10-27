// ============================================================
//  Monitor Keraunos — Scraper (v11)  ·  a prueba de fallas
//  ------------------------------------------------------------
//  Responsabilidad ÚNICA:
//    1. Scrapear Keraunos cada INTERVALO ms.
//    2. Extraer {nombre, nivel, inicio, fin} por cada tarjeta.
//    3. Escribir estado.json SOLO cuando el estado de alertas cambia.
//    4. git push a GitHub Pages (solo si cambió).
//
//  NUEVO v11 (sobre v10):
//    - Descarga con reintentos + backoff exponencial + jitter,
//      timeout duro (AbortController) y conexión nueva en cada
//      intento (sin keep-alive => sin sockets zombis).
//    - Bucle autorreparable con setTimeout (nunca se solapa ni
//      muere): backoff creciente tras fallos y log de
//      "conexión restablecida".
//    - Cada ciclo tiene un tope de tiempo (watchdog): un ciclo
//      colgado no congela el monitor.
//    - Protección anti-falso-verde: si la página responde pero
//      no trae tarjetas (HTML cambiado / página de error), NO se
//      publica; se trata como fallo. Así una alerta roja nunca se
//      borra por un error del sitio.
//    - Horas inicio/fin más tolerantes: varias fechas por texto,
//      formato ISO o dd/mm/yyyy, respaldo escaneando toda la
//      tarjeta, y corrección si fin < inicio.
//    - estado.json se escribe de forma atómica (tmp + rename).
//    - Git robusto: timeouts, limpia index.lock viejo, "nada que
//      commitear" cuenta como éxito, reintenta el push tras
//      pull --rebase, aborta rebase si queda a medias.
//    - Rotación del log por tamaño.
//    - Manejo de uncaughtException / unhandledRejection / SIGTERM.
//    - Modo verificación:  node keraunos-v11.js --verificar
//      (una consulta, imprime tabla de inicio/fin, no publica).
//    - latido.json: prueba de vida LOCAL, reescrita en cada ciclo
//      (no se sube a git). Ver:  node keraunos-v11.js --estado
//      Opcional en config.js: ARCHIVO_LATIDO (por defecto, junto a estado.json).
//
//  Opciones nuevas de config.js (todas OPCIONALES):
//    REINTENTOS (3), TIMEOUT_MS (20000), BACKOFF_MAX_MS (300000),
//    CICLO_MAX_MS (180000), LOG_MAX_BYTES (1000000)
// ============================================================

const { execFile } = require('child_process');
const https = require('https');
const http = require('http');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config.js');

const URL = CONFIG.URL;
const ARCHIVO_LOG = CONFIG.ARCHIVO_LOG;
const ARCHIVO_JSON = CONFIG.ARCHIVO_JSON;
const INTERVALO = CONFIG.INTERVALO;

const num = (v, def) => (typeof v === 'number' && isFinite(v) ? v : def);

const TZ_OFFSET_MIN       = num(CONFIG.TZ_OFFSET_MIN, -300);     // Perú UTC-5
const HORAS_REFRESCO_PUSH = num(CONFIG.HORAS_REFRESCO_PUSH, 0);
const REINTENTOS          = num(CONFIG.REINTENTOS, 3);
const TIMEOUT_MS          = num(CONFIG.TIMEOUT_MS, 20000);
const BACKOFF_MAX_MS      = num(CONFIG.BACKOFF_MAX_MS, 300000);
const CICLO_MAX_MS        = num(CONFIG.CICLO_MAX_MS, 180000);
const LOG_MAX_BYTES       = num(CONFIG.LOG_MAX_BYTES, 1000000);
const GIT_TIMEOUT_MS      = 60000;

// Latido: archivo LOCAL (nunca se sube a git) que se reescribe en cada ciclo.
const ARCHIVO_LATIDO = CONFIG.ARCHIVO_LATIDO ||
    path.join(path.dirname(ARCHIVO_JSON), 'latido.json');

// ------------------------------------------------------------
//  Niveles
// ------------------------------------------------------------
const NIVELES = {
    ROJA:     { numero: 3, color: "#FA5858", clase: "roja",     emoji: "🔴" },
    NARANJA:  { numero: 2, color: "#FF8C00", clase: "naranja",  emoji: "🟠" },
    AMARILLA: { numero: 1, color: "#FFD400", clase: "amarilla", emoji: "🟡" },
    VERDE:    { numero: 0, color: "#2ECC71", clase: "verde",    emoji: "🟢" }
};

// ------------------------------------------------------------
//  Estado del proceso
// ------------------------------------------------------------
let firmaAnterior  = null;
let ultimoPushMs   = 0;
let fallosSeguidos = 0;
let detenido       = false;
let temporizador   = null;

// Datos para latido.json
const inicioProcesoMs = Date.now();
let ciclosTotales        = 0;
let ciclosOk             = 0;
let ultimoExitoMs        = 0;
let ultimoCambioMs       = 0;     // último push exitoso (cambio publicado)
let ultimoError          = null;  // { cuando, mensaje }
let ultimoResumen        = null;  // { estadoGlobal, alertasActivas }

function anotarError(mensaje) {
    ultimoError = { cuando: new Date().toISOString(), mensaje: String(mensaje).substring(0, 300) };
}

const dormir = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------
//  Log (con rotación por tamaño)
// ------------------------------------------------------------
function rotarLogSiHaceFalta() {
    try {
        if (!ARCHIVO_LOG || !fs.existsSync(ARCHIVO_LOG)) return;
        if (fs.statSync(ARCHIVO_LOG).size > LOG_MAX_BYTES) {
            fs.renameSync(ARCHIVO_LOG, ARCHIVO_LOG + '.1');   // sobreescribe el anterior
        }
    } catch (e) { /* el log nunca debe romper el monitor */ }
}

function registrarLog(mensaje) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const linea = `[${ts}] ${mensaje}\n`;
    console.log(linea.trim());
    try {
        rotarLogSiHaceFalta();
        fs.appendFileSync(ARCHIVO_LOG, linea, 'utf-8');
    } catch (e) {}
}

// ------------------------------------------------------------
//  Utilidades
// ------------------------------------------------------------
function normalizar(texto) {
    return (texto || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function firmaSectores(sectores) {
    return sectores
        .filter(s => s.nivel && s.nivel !== "VERDE")
        .map(s => `${normalizar(s.nombre)}|${s.nivel}|${s.inicio || ''}|${s.fin || ''}`)
        .sort()
        .join("\n");
}

function cargarEstadoExistente() {
    try {
        if (!fs.existsSync(ARCHIVO_JSON)) return null;
        const data = JSON.parse(fs.readFileSync(ARCHIVO_JSON, 'utf-8'));
        if (!Array.isArray(data.sectores)) return null;
        return {
            firma: firmaSectores(data.sectores),
            actualizado: data.actualizado ? Date.parse(data.actualizado) : 0
        };
    } catch (e) {
        return null;
    }
}

// ------------------------------------------------------------
//  Fechas de Keraunos
//  Formatos aceptados:
//    2026-10-21 14:30[:45]   |   2026-10-21T14:30[:45]
//    21/10/2026 14:30[:45]   |   21-10-2026 14:30[:45]
//  Se normalizan siempre a "YYYY-MM-DD HH:MM:SS".
// ------------------------------------------------------------
const RE_FECHAS = new RegExp(
    '(?:(\\d{4})-(\\d{2})-(\\d{2})|(\\d{2})[/-](\\d{2})[/-](\\d{4}))' +
    '[ T]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?',
    'g'
);

function extraerTodasLasFechas(texto) {
    const out = [];
    const s = String(texto || "");
    RE_FECHAS.lastIndex = 0;
    let m;
    while ((m = RE_FECHAS.exec(s)) !== null) {
        const Y  = m[1] || m[6];
        const Mo = m[2] || m[5];
        const D  = m[3] || m[4];
        const H  = String(m[7]).padStart(2, '0');
        const Mi = m[8];
        const S  = m[9] || "00";
        out.push({ valor: `${Y}-${Mo}-${D} ${H}:${Mi}:${S}`, indice: m.index });
    }
    return out;
}

function extraerFechaDeTexto(texto) {
    const f = extraerTodasLasFechas(texto);
    return f.length ? f[0].valor : null;
}

function parseFechaKeraunos(texto) {
    if (!texto) return NaN;
    const m = String(texto).match(
        /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/
    );
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0)
         - TZ_OFFSET_MIN * 60000;
}

// ------------------------------------------------------------
//  Nivel por tarjeta
// ------------------------------------------------------------
function detectarNivelDeTarjeta($, el) {
    const $el = $(el);

    let textoNivel = $el.find('.alert-text h2').first().text().trim().toUpperCase();
    if (!textoNivel) textoNivel = $el.find('.badge').first().text().trim().toUpperCase();
    if (!textoNivel) textoNivel = $el.find('.card-message').first().text().trim().toUpperCase();
    if (!textoNivel) textoNivel = $el.find('.icon').first().text().trim();
    if (!textoNivel) textoNivel = ($el.find('.alert-box').attr('style') || '').toUpperCase();

    if (/ROJA|ROJO|NIVEL 3|🔴|#FA5858/.test(textoNivel)) return "ROJA";
    if (/NARANJA|NIVEL 2|🟠|#FF8C00/.test(textoNivel))   return "NARANJA";
    if (/AMARILLA|AMARILLO|NIVEL 1|🟡|#FFD400/.test(textoNivel)) return "AMARILLA";
    return "VERDE";
}

// ------------------------------------------------------------
//  Horas de la tarjeta (inicio / fin)
//  Estrategia en 3 capas:
//    1) Cada `.small-text` con su etiqueta (inicio/fin/desde/hasta…).
//       Si un mismo texto trae dos fechas, la 1ª es inicio y la 2ª fin.
//    2) Fechas sin etiqueta: 1ª = inicio, 2ª = fin.
//    3) Respaldo: escanear TODO el texto de la tarjeta.
//  Al final, si fin < inicio se intercambian (con aviso en el log).
// ------------------------------------------------------------
function extraerHorasDeTarjeta($, el) {
    const $el = $(el);
    let inicio = null;
    let fin = null;
    const sinEtiqueta = [];

    $el.find('.small-text').each((i, p) => {
        const texto = $(p).text().replace(/\s+/g, ' ').trim();
        const fechas = extraerTodasLasFechas(texto);
        if (!fechas.length) return;

        const t = texto.toLowerCase();
        const esInicio = /inicio|inicia|desde|comienz/.test(t);
        const esFin    = /\bfin\b|final|hasta|termin|previst/.test(t);

        if (fechas.length >= 2 && esInicio && esFin) {
            // "Desde 14:00 hasta 15:00" en una sola línea
            const posInicio = t.search(/inicio|inicia|desde|comienz/);
            const posFin    = t.search(/\bfin\b|final|hasta|termin|previst/);
            if (posInicio <= posFin) { inicio = inicio || fechas[0].valor; fin = fin || fechas[1].valor; }
            else                     { fin = fin || fechas[0].valor; inicio = inicio || fechas[1].valor; }
        } else if (esInicio && !esFin) {
            inicio = inicio || fechas[0].valor;
        } else if (esFin && !esInicio) {
            fin = fin || fechas[0].valor;
        } else {
            fechas.forEach(f => sinEtiqueta.push(f.valor));
        }
    });

    if (!inicio && !fin && sinEtiqueta.length) {
        inicio = sinEtiqueta[0] || null;
        fin    = sinEtiqueta[1] || null;
    } else if (!inicio && sinEtiqueta.length) {
        inicio = sinEtiqueta[0];
    } else if (!fin && sinEtiqueta.length) {
        fin = sinEtiqueta[0];
    }

    // Respaldo: toda la tarjeta
    if (!inicio || !fin) {
        const todas = extraerTodasLasFechas($el.text().replace(/\s+/g, ' '))
            .map(f => f.valor)
            .filter((v, i, a) => a.indexOf(v) === i);
        if (!inicio && !fin) { inicio = todas[0] || null; fin = todas[1] || null; }
        else if (!inicio)    { inicio = todas.find(v => v !== fin) || null; }
        else if (!fin)       { fin = todas.find(v => v !== inicio) || null; }
    }

    // Coherencia
    if (inicio && fin) {
        const a = parseFechaKeraunos(inicio), b = parseFechaKeraunos(fin);
        if (!isNaN(a) && !isNaN(b) && b < a) {
            registrarLog(`Aviso: fin (${fin}) anterior a inicio (${inicio}); se intercambian.`);
            [inicio, fin] = [fin, inicio];
        }
    }

    return { inicio, fin };
}

// ------------------------------------------------------------
//  Zona por coincidencia parcial
// ------------------------------------------------------------
function buscarZona(nombre) {
    const norm = normalizar(nombre);
    for (const clave of Object.keys(CONFIG.MAPA_ZONAS)) {
        if (norm.includes(normalizar(clave))) return CONFIG.MAPA_ZONAS[clave];
    }
    return null;
}

// ------------------------------------------------------------
//  Descarga con reintentos + backoff + timeout duro
// ------------------------------------------------------------
async function descargarHTML() {
    const esHttps = /^https:/i.test(URL);
    let ultimoError;

    for (let intento = 1; intento <= REINTENTOS; intento++) {
        const ctrl = new AbortController();
        const corte = setTimeout(() => ctrl.abort(), TIMEOUT_MS + 5000); // tope absoluto
        try {
            const r = await axios.get(URL, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
                                  "(KHTML, like Gecko) Chrome/124 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml",
                    "Cache-Control": "no-cache"
                },
                timeout: TIMEOUT_MS,
                signal: ctrl.signal,
                responseType: 'text',
                maxRedirects: 5,
                validateStatus: s => s >= 200 && s < 300,
                // conexión nueva cada vez: evita sockets colgados tras cortes de red
                httpAgent:  new http.Agent({ keepAlive: false }),
                httpsAgent: new https.Agent({ keepAlive: false })
            });
            if (typeof r.data !== 'string' || r.data.length < 200) {
                throw new Error(`Respuesta vacía o demasiado corta (${(r.data || '').length} bytes)`);
            }
            return r.data;
        } catch (e) {
            ultimoError = e;
            const causa = e.code || (e.response && `HTTP ${e.response.status}`) || e.message;
            if (intento < REINTENTOS) {
                const espera = Math.min(15000, 1000 * 2 ** (intento - 1)) +
                               Math.floor(Math.random() * 500);
                registrarLog(`Descarga falló (${causa}) intento ${intento}/${REINTENTOS}; ` +
                             `reintento en ${Math.round(espera / 1000)}s`);
                await dormir(espera);
            }
        } finally {
            clearTimeout(corte);
        }
    }
    throw ultimoError;
}

// ------------------------------------------------------------
//  Parseo del HTML (separado para poder probarlo sin red)
// ------------------------------------------------------------
function parsearHTML(html) {
    const $ = cheerio.load(html);
    const tarjetas = $('.card.card-activo');
    const sectoresEnPagina = [];

    tarjetas.each((i, el) => {
        const $el = $(el);
        let nombre = $el.find('h1.title').first().text().trim();
        if (!nombre) nombre = ($el.attr('data-nombre') || `Sector ${i + 1}`).trim();

        const nivel = detectarNivelDeTarjeta($, el);
        const { inicio, fin } = extraerHorasDeTarjeta($, el);

        if (nivel !== "VERDE" && (!inicio || !fin)) {
            registrarLog(
                `Aviso: alerta ${nivel} sin horas completas -> ` +
                `${nombre.substring(0, 60)} (inicio=${inicio}, fin=${fin})`
            );
        }
        sectoresEnPagina.push({ nombre, nivel, inicio, fin });
    });

    return { totalTarjetas: tarjetas.length, sectoresEnPagina };
}

function combinarConListaMaestra(sectoresEnPagina) {
    const detectados = [];
    const usados = new Set();

    for (const esperado of CONFIG.SECTORES_ESPERADOS) {
        const normEsperado = normalizar(esperado);
        const encontrado = sectoresEnPagina.find(s =>
            normalizar(s.nombre).includes(normEsperado)
        );
        if (encontrado) {
            usados.add(encontrado.nombre);
            detectados.push({ ...encontrado });
        } else {
            detectados.push({ nombre: esperado, nivel: "VERDE", inicio: null, fin: null });
        }
    }

    if (CONFIG.INCLUIR_SECTORES_EXTRA) {
        for (const s of sectoresEnPagina) {
            if (!usados.has(s.nombre)) detectados.push({ ...s });
        }
    }

    return detectados.map(s => {
        const info = NIVELES[s.nivel];
        return {
            nombre: s.nombre, nivel: s.nivel,
            nivelNumero: info.numero, color: info.color,
            clase: info.clase, emoji: info.emoji,
            inicio: s.inicio, fin: s.fin
        };
    });
}

function calcularEstadoGlobal(sectores) {
    let estadoGlobal = "VERDE", max = 0;
    for (const s of sectores) {
        if (s.nivelNumero > max) { max = s.nivelNumero; estadoGlobal = s.nivel; }
    }
    return estadoGlobal;
}

// ------------------------------------------------------------
//  Consulta completa. Devuelve null si algo falla o es sospechoso.
// ------------------------------------------------------------
async function consultarKeraunos() {
    try {
        const html = await descargarHTML();
        const { totalTarjetas, sectoresEnPagina } = parsearHTML(html);

        // Anti-falso-verde: sin tarjetas => la página cambió o es una página de error.
        if (totalTarjetas === 0) {
            registrarLog("Anomalía: la página respondió pero no trae tarjetas " +
                         "(.card.card-activo). No se publica nada.");
            anotarError("Página sin tarjetas (.card.card-activo)");
            return null;
        }

        const sectoresDetectados = combinarConListaMaestra(sectoresEnPagina);
        return { estadoGlobal: calcularEstadoGlobal(sectoresDetectados), sectoresDetectados };
    } catch (e) {
        const causa = e.code || (e.response && `HTTP ${e.response.status}`) || e.message;
        registrarLog(`Error al consultar Keraunos: ${causa}`);
        anotarError(`Consulta: ${causa}`);
        return null;
    }
}

// ------------------------------------------------------------
//  Duración y timestamp de inicio
// ------------------------------------------------------------
function calcularDuracion(sector) {
    const defMin = CONFIG.DURACION_DEFAULT_MIN || 15;
    if (!sector.inicio) return { duracionMin: defMin, timestampInicio: Date.now() };

    const inicioMs = parseFechaKeraunos(sector.inicio);
    if (isNaN(inicioMs)) return { duracionMin: defMin, timestampInicio: Date.now() };

    if (sector.fin) {
        const finMs = parseFechaKeraunos(sector.fin);
        if (!isNaN(finMs) && finMs > inicioMs) {
            return {
                duracionMin: Math.max(1, Math.round((finMs - inicioMs) / 60000)),
                timestampInicio: inicioMs
            };
        }
    }
    return { duracionMin: defMin, timestampInicio: inicioMs };
}

// ------------------------------------------------------------
//  estado.json (escritura atómica)
// ------------------------------------------------------------
function escribirAtomico(archivo, contenido) {
    const tmp = path.join(path.dirname(archivo), `.${path.basename(archivo)}.tmp`);
    fs.writeFileSync(tmp, contenido, 'utf-8');
    fs.renameSync(tmp, archivo);
}

function guardarJSON(estadoGlobal, sectores) {
    const alertas = [];

    for (const s of sectores) {
        if (s.nivel === "VERDE") continue;

        const zona = buscarZona(s.nombre);
        if (!zona) {
            registrarLog(`Aviso: sector sin zona mapeada, se omite alerta -> ${s.nombre}`);
            continue;
        }

        const coords = (CONFIG.COORDENADAS_ZONAS || {})[zona] || {};
        const { duracionMin, timestampInicio } = calcularDuracion(s);

        alertas.push({
            sectorOriginal: s.nombre,
            nivelScraper:   s.nivel,
            nivel:          s.nivel.toLowerCase(),
            distrito:       zona,
            lat:            coords.lat ?? null,
            lng:            coords.lng ?? null,
            duracionMin,
            timestampInicio,
            inicio:         s.inicio || null,
            fin:            s.fin    || null,
            color:          s.color,
            emoji:          s.emoji,
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
            nombre: s.nombre, nivel: s.nivel, nivelNumero: s.nivelNumero,
            color: s.color, inicio: s.inicio, fin: s.fin
        })),
        alertas
    };

    escribirAtomico(ARCHIVO_JSON, JSON.stringify(data, null, 2));
    return data;
}

// ------------------------------------------------------------
//  Git robusto
// ------------------------------------------------------------
function git(args) {
    return new Promise((resolve) => {
        execFile('git', args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
            (error, stdout, stderr) => {
                resolve({
                    ok: !error,
                    code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
                    out: String(stdout || ''),
                    err: String(stderr || '') || (error ? error.message : '')
                });
            });
    });
}

function limpiarLockViejo() {
    try {
        const lock = path.join('.git', 'index.lock');
        if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 120000) {
            fs.unlinkSync(lock);
            registrarLog("Se eliminó un .git/index.lock obsoleto.");
        }
    } catch (e) {}
}

// ------------------------------------------------------------
//  Reparación de git: deja el repositorio en un estado en el que
//  se pueda commitear. estado.json se REGENERA siempre desde el
//  scraper, así que su versión en conflicto se descarta sin riesgo.
//  Si el conflicto es en OTROS archivos, no se toca nada (podría
//  ser trabajo tuyo) y se avisa en el log.
// ------------------------------------------------------------
async function repararRepo() {
    const enGit = (p) => fs.existsSync(path.join('.git', p));

    if (enGit('rebase-merge') || enGit('rebase-apply')) {
        registrarLog("Git: había un rebase a medias; se aborta.");
        await git(['rebase', '--abort']);
    }
    if (enGit('MERGE_HEAD')) {
        registrarLog("Git: había un merge a medias; se aborta.");
        await git(['merge', '--abort']);
    }
    if (enGit('CHERRY_PICK_HEAD')) await git(['cherry-pick', '--abort']);

    const u = await git(['diff', '--name-only', '--diff-filter=U']);
    const sinResolver = u.out.split('\n').map(s => s.trim()).filter(Boolean);
    if (!sinResolver.length) return true;

    const mio = path.basename(ARCHIVO_JSON);
    const ajenos = sinResolver.filter(f => path.basename(f) !== mio);
    if (ajenos.length) {
        registrarLog(`Git: conflicto sin resolver en archivos que NO son ${mio}: ` +
                     `${ajenos.join(', ')}. Resuélvelos a mano (git status). No se toca nada.`);
        return false;
    }

    registrarLog(`Git: conflicto sin resolver en ${mio}; se descarta su versión (se regenera).`);
    let r = await git(['checkout', 'HEAD', '--', ARCHIVO_JSON]);
    if (!r.ok) {
        await git(['reset', '-q', '--', ARCHIVO_JSON]);
        r = await git(['checkout', '--', ARCHIVO_JSON]);
    }
    return r.ok;
}

// Si el pull --rebase falla (p. ej. commits locales de estado.json que chocan
// con el remoto), y lo único sin subir son cambios de estado.json, el remoto
// gana y luego se vuelve a escribir el estado actual.
async function sincronizarForzado() {
    await git(['rebase', '--abort']);
    const f = await git(['fetch', '--quiet', 'origin', 'main']);
    if (!f.ok) { registrarLog(`git fetch falló: ${f.err.trim().split('\n')[0]}`); return false; }

    const d = await git(['diff', '--name-only', 'origin/main...HEAD']);
    const locales = d.out.split('\n').map(s => s.trim()).filter(Boolean);
    const mio = path.basename(ARCHIVO_JSON);
    if (locales.some(x => path.basename(x) !== mio)) {
        registrarLog("Git: hay commits locales sin subir que tocan otros archivos; " +
                     "no se fuerza la sincronización. Revisa con git status / git log.");
        return false;
    }
    const r = await git(['reset', '-q', 'origin/main']);   // mixed: conserva el árbol de trabajo
    if (r.ok) registrarLog("Git: se alineó con origin/main (solo diferían commits de estado.json).");
    return r.ok;
}

async function subirAGithub() {
    limpiarLockViejo();

    // Contenido nuevo que hay que publicar (se vuelve a poner tras sincronizar)
    let contenido;
    try { contenido = fs.readFileSync(ARCHIVO_JSON, 'utf-8'); }
    catch (e) { registrarLog(`No se pudo leer ${ARCHIVO_JSON}: ${e.message}`); return false; }

    // 0) Sanear el repo si quedó un conflicto/rebase de un intento anterior
    if (!(await repararRepo())) return false;

    // 1) Dejar estado.json limpio para que el pull no lo trate como cambio local
    await git(['checkout', 'HEAD', '--', ARCHIVO_JSON]);

    // 2) Sincronizar
    let r = await git(['pull', '--rebase', '--autostash', '--quiet', 'origin', 'main']);
    if (!r.ok) {
        registrarLog(`git pull falló: ${r.err.trim().split('\n')[0]}`);
        if (!(await repararRepo())) return false;
        if (!(await sincronizarForzado())) return false;
    }

    // 3) Reponer el estado actual
    try { escribirAtomico(ARCHIVO_JSON, contenido); }
    catch (e) { registrarLog(`No se pudo reponer ${ARCHIVO_JSON}: ${e.message}`); return false; }

    // 4) Agregar
    r = await git(['add', '-f', ARCHIVO_JSON]);
    if (!r.ok) { registrarLog(`git add falló: ${r.err.trim()}`); return false; }

    // 5) ¿Hay algo que commitear?  (diff --quiet: 0 = sin cambios, 1 = hay cambios)
    r = await git(['diff', '--cached', '--quiet', '--', ARCHIVO_JSON]);
    if (r.ok) {
        // Puede haber commits locales pendientes de subir de un intento anterior
        const p = await git(['push', 'origin', 'main']);
        if (p.ok) registrarLog("Git: sin cambios nuevos; remoto al día.");
        else registrarLog(`git push falló: ${p.err.trim().split('\n')[0]}`);
        return p.ok;
    }

    const hora = new Date().toLocaleTimeString('es-PE', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Lima'
    });
    r = await git(['commit', '-m', `Update estado.json ${hora}`]);
    if (!r.ok) { registrarLog(`git commit falló: ${r.err.trim()}`); return false; }

    // 6) Push con un reintento tras re-sincronizar
    r = await git(['push', 'origin', 'main']);
    if (!r.ok) {
        registrarLog(`git push falló (${r.err.trim().split('\n')[0]}); reintentando…`);
        const pr = await git(['pull', '--rebase', '--autostash', '--quiet', 'origin', 'main']);
        if (!pr.ok) {
            await repararRepo();
            if (!(await sincronizarForzado())) return false;
            try { escribirAtomico(ARCHIVO_JSON, contenido); } catch (e) {}
            await git(['add', '-f', ARCHIVO_JSON]);
            await git(['commit', '-m', `Update estado.json ${hora}`]);
        }
        r = await git(['push', 'origin', 'main']);
        if (!r.ok) {
            registrarLog(`Error en Git Push: ${r.err.trim().split('\n')[0]}`);
            return false;
        }
    }

    registrarLog("estado.json subido a GitHub Pages exitosamente.");
    return true;
}

// ------------------------------------------------------------
//  Publicación inteligente
// ------------------------------------------------------------
async function procesarResultado(resultado) {
    if (!resultado) return;

    const firmaNueva = firmaSectores(resultado.sectoresDetectados);
    const haCambiado = firmaNueva !== firmaAnterior;
    const tocaRefresco = HORAS_REFRESCO_PUSH > 0 &&
        (Date.now() - ultimoPushMs) >= HORAS_REFRESCO_PUSH * 3600_000;

    if (!haCambiado && !tocaRefresco) {
        registrarLog(`Sin cambios (Global: ${resultado.estadoGlobal}). No se publica.`);
        return;
    }

    const json = guardarJSON(resultado.estadoGlobal, resultado.sectoresDetectados);

    const motivo = haCambiado
        ? (firmaAnterior === null ? "estado inicial" : "cambio detectado")
        : "refresco programado";

    registrarLog(
        `${motivo}. estado.json actualizado. Global: ${resultado.estadoGlobal} | ` +
        `R:${json.resumen.roja} N:${json.resumen.naranja} ` +
        `A:${json.resumen.amarilla} V:${json.resumen.verde} | ` +
        `Alertas publicadas: ${json.alertas.length}`
    );
    for (const a of json.alertas) {
        registrarLog(`  · ${a.nivelScraper} ${a.sectorOriginal} | inicio=${a.inicio} fin=${a.fin} (${a.duracionMin} min)`);
    }

    let pushOk = true;
    if (CONFIG.SUBIR_A_GITHUB) pushOk = await subirAGithub();

    if (pushOk) {
        firmaAnterior = firmaNueva;
        ultimoPushMs  = Date.now();
        ultimoCambioMs = Date.now();
    } else {
        anotarError("Push a GitHub fallido (se reintenta)");
        registrarLog("Push fallido: se reintentará en el próximo ciclo.");
    }
}

// ------------------------------------------------------------
//  Un ciclo completo con tope de tiempo (watchdog)
// ------------------------------------------------------------
async function ejecutarCiclo() {
    let timer;
    const tope = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`Ciclo excedió ${CICLO_MAX_MS / 1000}s`)), CICLO_MAX_MS);
    });

    try {
        const trabajo = (async () => {
            const resultado = await consultarKeraunos();
            if (!resultado) return false;
            ultimoResumen = {
                estadoGlobal: resultado.estadoGlobal,
                alertasActivas: resultado.sectoresDetectados.filter(s => s.nivel !== "VERDE").length
            };
            await procesarResultado(resultado);
            return true;
        })();
        trabajo.catch(() => {}); // evita "unhandled" si el tope gana la carrera
        return await Promise.race([trabajo, tope]);
    } finally {
        clearTimeout(timer);
    }
}

// ------------------------------------------------------------
//  latido.json — prueba de vida local (NO se sube a git).
//  Se reescribe en cada ciclo, haya o no cambios.
// ------------------------------------------------------------
function escribirLatido(estado, esperaMs) {
    try {
        const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
        escribirAtomico(ARCHIVO_LATIDO, JSON.stringify({
            version: "v11",
            estado,                                   // "ok" | "con-fallos" | "detenido"
            pid: process.pid,
            procesoIniciado: iso(inicioProcesoMs),
            ultimoCiclo: new Date().toISOString(),
            ultimoExito: iso(ultimoExitoMs),
            ultimoCambioPublicado: iso(ultimoCambioMs),
            proximoCicloEnSeg: esperaMs != null ? Math.round(esperaMs / 1000) : null,
            intervaloSeg: Math.round(INTERVALO / 1000),
            fallosSeguidos,
            ciclosTotales,
            ciclosOk,
            estadoGlobal: ultimoResumen ? ultimoResumen.estadoGlobal : null,
            alertasActivas: ultimoResumen ? ultimoResumen.alertasActivas : null,
            ultimoError
        }, null, 2));
    } catch (e) { /* el latido nunca debe romper el monitor */ }
}

function proximaEspera() {
    if (fallosSeguidos === 0) return INTERVALO;
    return Math.min(BACKOFF_MAX_MS, INTERVALO * 2 ** Math.min(fallosSeguidos, 6));
}

async function bucle() {
    if (detenido) return;

    try {
        ciclosTotales++;
        const ok = await ejecutarCiclo();
        if (ok) {
            ciclosOk++;
            ultimoExitoMs = Date.now();
            if (fallosSeguidos >= 3) {
                registrarLog(`Conexión restablecida tras ${fallosSeguidos} fallos seguidos.`);
            }
            fallosSeguidos = 0;
        } else {
            fallosSeguidos++;
        }
    } catch (e) {
        fallosSeguidos++;
        anotarError(`Ciclo abortado: ${e.message}`);
        registrarLog(`Ciclo abortado: ${e.message}`);
    }

    if (fallosSeguidos >= 5 && fallosSeguidos % 5 === 0) {
        registrarLog(`ATENCIÓN: ${fallosSeguidos} ciclos seguidos sin datos válidos. ` +
                     `Se conserva el último estado.json publicado.`);
    }

    const espera = proximaEspera();
    escribirLatido(fallosSeguidos === 0 ? "ok" : "con-fallos", espera);
    if (fallosSeguidos > 0) {
        registrarLog(`Próximo intento en ${Math.round(espera / 1000)}s (fallos seguidos: ${fallosSeguidos}).`);
    }
    if (!detenido) temporizador = setTimeout(bucle, espera);
}

// ------------------------------------------------------------
//  Arranque y cierre ordenado
// ------------------------------------------------------------
function iniciar() {
    const previo = cargarEstadoExistente();
    if (previo) {
        firmaAnterior = previo.firma;
        ultimoPushMs  = previo.actualizado || 0;
        registrarLog("Firma cargada desde estado.json existente (sin push si no cambia).");
    } else {
        registrarLog("No existe estado previo: la primera consulta publicará.");
    }

    registrarLog(
        `Monitor Keraunos v11 iniciado. Intervalo: ${INTERVALO / 1000}s | ` +
        `TZ Keraunos: UTC${TZ_OFFSET_MIN / 60} | Reintentos: ${REINTENTOS} | ` +
        `Refresco: ${HORAS_REFRESCO_PUSH > 0 ? HORAS_REFRESCO_PUSH + "h" : "off"}`
    );

    process.on('uncaughtException', (e) => {
        registrarLog(`uncaughtException: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
    });
    process.on('unhandledRejection', (e) => {
        registrarLog(`unhandledRejection: ${e && e.message ? e.message : e}`);
    });
    const cerrar = (sig) => {
        registrarLog(`${sig} recibido: cerrando monitor.`);
        detenido = true;
        clearTimeout(temporizador);
        escribirLatido("detenido", null);
        setTimeout(() => process.exit(0), 300);
    };
    process.on('SIGINT',  () => cerrar('SIGINT'));
    process.on('SIGTERM', () => cerrar('SIGTERM'));

    bucle();
}

// ------------------------------------------------------------
//  Modo verificación: una consulta, tabla de horas, sin publicar
// ------------------------------------------------------------
async function verificar() {
    console.log(`Consultando ${URL} …\n`);
    const r = await consultarKeraunos();
    if (!r) { console.log("✖ No se obtuvieron datos válidos (ver mensajes arriba)."); process.exitCode = 1; return; }

    const filas = r.sectoresDetectados.map(s => ({
        sector: s.nombre.substring(0, 40),
        nivel: s.nivel,
        inicio: s.inicio || '—',
        fin: s.fin || '—',
        zona: buscarZona(s.nombre) || '(sin zona)',
        duracionMin: s.inicio && s.fin ? calcularDuracion(s).duracionMin : '—'
    }));
    console.table(filas);

    const sinHoras = r.sectoresDetectados.filter(s => s.nivel !== "VERDE" && (!s.inicio || !s.fin));
    const conAlerta = r.sectoresDetectados.filter(s => s.nivel !== "VERDE").length;
    console.log(`\nGlobal: ${r.estadoGlobal} | Sectores con alerta: ${conAlerta}`);
    if (sinHoras.length) {
        console.log(`⚠ ${sinHoras.length} alerta(s) SIN inicio/fin completos:`);
        sinHoras.forEach(s => console.log(`   - ${s.nombre}`));
    } else if (conAlerta) {
        console.log("✔ Todas las alertas activas traen inicio y fin.");
    } else {
        console.log("ℹ No hay alertas activas ahora: no se pueden comprobar horas en vivo.");
    }
}

// ------------------------------------------------------------
//  Modo estado:  node keraunos-v11.js --estado
//  Lee latido.json y dice en claro si el monitor está vivo.
// ------------------------------------------------------------
function hace(iso) {
    if (!iso) return "nunca";
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 90)    return `hace ${s} s`;
    if (s < 5400)  return `hace ${Math.round(s / 60)} min`;
    if (s < 172800) return `hace ${(s / 3600).toFixed(1)} h`;
    return `hace ${Math.round(s / 86400)} días`;
}

function verEstado() {
    let l;
    try { l = JSON.parse(fs.readFileSync(ARCHIVO_LATIDO, 'utf-8')); }
    catch (e) {
        console.log(`✖ No se pudo leer ${ARCHIVO_LATIDO}: el monitor nunca arrancó o está en otra carpeta.`);
        process.exitCode = 1; return;
    }
    let pidVivo = false;
    try { process.kill(l.pid, 0); pidVivo = true; } catch (e) {}

    const edadSeg = (Date.now() - Date.parse(l.ultimoCiclo)) / 1000;
    const limiteSeg = (l.proximoCicloEnSeg || l.intervaloSeg) + 180 + 30;  // espera + tope de ciclo + margen
    const vivo = l.estado !== "detenido" && pidVivo && edadSeg <= limiteSeg;

    console.log(`Archivo:                 ${ARCHIVO_LATIDO}`);
    console.log(`Veredicto:               ${vivo ? (l.estado === "ok" ? "✔ VIVO Y SANO" : "⚠ VIVO CON FALLOS") : "✖ SIN LATIDO (caído o detenido)"}`);
    console.log(`Último ciclo:            ${hace(l.ultimoCiclo)}  (próximo en ~${l.proximoCicloEnSeg ?? '?'} s)`);
    console.log(`Última lectura válida:   ${hace(l.ultimoExito)}`);
    console.log(`Último cambio publicado: ${hace(l.ultimoCambioPublicado)}`);
    console.log(`Estado global / alertas: ${l.estadoGlobal ?? '?'} / ${l.alertasActivas ?? '?'}`);
    console.log(`Ciclos ok / total:       ${l.ciclosOk} / ${l.ciclosTotales}   (fallos seguidos: ${l.fallosSeguidos})`);
    console.log(`Proceso:                 pid ${l.pid} ${pidVivo ? "(activo)" : "(NO existe)"} · iniciado ${hace(l.procesoIniciado)}`);
    if (l.ultimoError) console.log(`Último error:            ${l.ultimoError.mensaje} (${hace(l.ultimoError.cuando)})`);
    if (!vivo) process.exitCode = 2;
}

module.exports = {
    consultarKeraunos, descargarHTML, parsearHTML, combinarConListaMaestra,
    detectarNivelDeTarjeta, extraerHorasDeTarjeta, extraerTodasLasFechas,
    extraerFechaDeTexto, parseFechaKeraunos, buscarZona, firmaSectores,
    cargarEstadoExistente, guardarJSON, calcularDuracion, procesarResultado,
    subirAGithub, NIVELES
};

if (require.main === module) {
    if (process.argv.includes('--verificar')) verificar();
    else if (process.argv.includes('--estado')) verEstado();
    else iniciar();
}

