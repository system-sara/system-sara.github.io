// js/firebase-app.js
//
// Instancia ÚNICA y COMPARTIDA de Firebase para toda la app.
// Evita inicializar Firebase más de una vez (index.html + admin.html
// importan este mismo módulo).

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
import { firebaseConfig } from "./firebase-config.js";

export function obtenerApp() {
    if (getApps().length === 0) {
        return initializeApp(firebaseConfig);
    }
    return getApp();
}
