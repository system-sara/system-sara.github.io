// config.js
// ============================================================
// Configuración del Monitor Keraunos — Scraper
// ============================================================

module.exports = {

    // --------------------------------------------------------
    //  URL FUENTE REAL de Keraunos (la página con las tarjetas
    //  .card.card-activo y los <p class="small-text">).
    // --------------------------------------------------------
    URL: "https://qr.keraunos.co/t/mHMsMSjw7fLzlVFzMsh9K99cFG7tiC",

    ARCHIVO_JSON: "estado.json",
    ARCHIVO_LOG:  "monitor.log",

    INTERVALO: 60 * 1000,

    SUBIR_A_GITHUB: true,

    // --------------------------------------------------------
    //  NUEVO (FIX v9): zona horaria en la que Keraunos publica
    //  las horas "Inicio/Fin de alerta". Keraunos usa hora de
    //  Perú (UTC-5). Se expresa en MINUTOS respecto a UTC.
    //     Perú  = -300
    //     UTC   =    0
    //  Esto hace que `timestampInicio` sea correcto SIN importar
    //  en qué zona horaria corra el servidor.
    // --------------------------------------------------------
    TZ_OFFSET_MIN: -300,

    SECTORES_ESPERADOS: [
        "Campamento Yanacancha",
        "Oficinas Mina",
        "Tucush",
        "Tajo"
    ],

    INCLUIR_SECTORES_EXTRA: false,

    // Claves CORTAS. El scraper las busca por coincidencia parcial
    // dentro del nombre completo de cada tarjeta (ver buscarZona()).
    MAPA_ZONAS: {
        "Campamento Yanacancha": "Zona 1 - Campamentos",
        "Oficinas Mina":         "Zona 2 - Oficinas Mina",
        "Tucush":                "Zona 3 - Tucush",
        "Tajo":                  "Zona 4 - Tajo"
    },

    COORDENADAS_ZONAS: {
        "Zona 1 - Campamentos":   { lat: -9.5822364, lng: -77.0223100 },
        "Zona 2 - Oficinas Mina": { lat: -9.5718388, lng: -77.0447182 },
        "Zona 3 - Tucush":        { lat: -9.5263487, lng: -77.0485794 },
        "Zona 4 - Tajo":          { lat: -9.5416465, lng: -77.0707659 }
    },

    DURACION_DEFAULT_MIN: 15
};
