// js/keraunos-config.js
// ============================================================
// Configuración de keraunos.html (modo scraper).
// Se carga ANTES de app.js.
// ============================================================
window.__APP_CONFIG__ = {
    modo: "keraunos",
    zonasFile: "./zonas2.json",
    origenFiltro: "scraper",      // solo alertas con origen !== "manual"
    usarFirestore: false,         // NO escucha Firestore
    usarEstadoJSON: true          // SÍ lee estado.json
};
console.log("[config] keraunos.html en modo KERAUNOS (scraper)");
