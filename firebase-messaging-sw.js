// firebase-messaging-sw.js
//
// Service Worker para Firebase Cloud Messaging.
// Debe estar en la RAÍZ del sitio (mismo nivel que index.html) para que
// tenga alcance sobre todo el dominio.
//
// Permite recibir notificaciones push incluso cuando la pestaña está
// cerrada o en segundo plano.

importScripts("https://www.gstatic.com/firebasejs/12.17.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.17.0/firebase-messaging-compat.js");

// Configuración (coincide con js/firebase-config.js)
const firebaseConfig = {
    apiKey: "AIzaSyDc5EUjoE5HjkVWnTGJwWSDraszijxBz1E",
    authDomain: "antitomessage.firebaseapp.com",
    projectId: "antitomessage",
    storageBucket: "antitomessage.firebasestorage.app",
    messagingSenderId: "301615802026",
    appId: "1:301615802026:web:d1a6cec0c1e21a71ad92d3",
    measurementId: "G-2NWGFM3L53"
};

// Inicializar Firebase en el Service Worker
firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

// Manejar mensajes en segundo plano (pestaña cerrada o minimizada)
messaging.onBackgroundMessage((payload) => {
    console.log("[SW] Mensaje en segundo plano:", payload);

    const titulo = payload.notification?.title || "🔔 Alerta Antamina";
    const opciones = {
        body: payload.notification?.body || "Tienes una nueva notificación",
        icon: "https://cdn-icons-png.flaticon.com/512/1827/1827301.png",
        badge: "https://cdn-icons-png.flaticon.com/512/1827/1827301.png",
        tag: "antamina-fcm",
        requireInteraction: false,
        data: payload.data || {}
    };

    self.registration.showNotification(titulo, opciones);
});

// Manejar clic en la notificación (abre/foca la app)
self.addEventListener("notificationclick", (event) => {
    event.notification.close();

    // URL a abrir al hacer clic (tu sitio)
    const urlAbrir = event.notification.data.url || "/";

    event.waitUntil(
        clients.matchAll({
            type: "window",
            includeUncontrolled: true
        }).then((listaClientes) => {
            // Si la app ya está abierta, enfocarla
            for (const cliente of listaClientes) {
                if (cliente.url.includes(self.location.origin) && "focus" in cliente) {
                    return cliente.focus();
                }
            }
            // Si no está abierta, abrir nueva ventana
            if (clients.openWindow) {
                return clients.openWindow(urlAbrir);
            }
        })
    );
});
