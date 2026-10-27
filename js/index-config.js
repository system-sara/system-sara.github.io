// js/index-config.js
// ============================================================
// Configuración de index.html (modo manual).
// Se carga ANTES de app.js.
// ============================================================
window.__APP_CONFIG__ = {
    modo: "manual",
    zonasFile: "./zonas.json",
    origenFiltro: "manual",       // solo alertas con origen === "manual"
    usarFirestore: true,          // escucha Firestore
    usarEstadoJSON: false         // NO lee estado.json
};
console.log("[config] index.html en modo MANUAL");
