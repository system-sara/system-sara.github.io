// js/earth.js

import { mostrarToast, reproducirSonido } from "./notifications.js";

export function abrirEarth(lugar) {

    const url =
`https://earth.google.com/web/search/${lugar.lat},${lugar.lng}`;

    window.open(url, "_blank");

    // Notificación al abrir Google Earth
    mostrarToast(
        "🌍 Google Earth",
        `Abriendo: ${lugar.nombre}`,
        "info",
        true
    );

}

export function copiarCoordenadas(lugar){

    const texto =
`${lugar.lng}, ${lugar.lat}, ${lugar.alt}`;

    navigator.clipboard.writeText(texto)
        .then(() => {
            // Reemplaza el antiguo alert() por toast + sonido
            mostrarToast(
                "📋 Coordenadas copiadas",
                `${lugar.lat}, ${lugar.lng}`,
                "exito",
                true
            );
        })
        .catch(() => {
            mostrarToast(
                "Error",
                "No se pudieron copiar las coordenadas",
                "alerta",
                false
            );
        });

}
