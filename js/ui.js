// js/ui.js

import {

abrirEarth,

copiarCoordenadas

}

from "./earth.js";

export function mostrarInformacion(lugar){

const panel =

document.getElementById("info-content");

panel.innerHTML =

`

<div class="info-row">

<span class="info-label">

📍 Nombre

</span>

<br>

${lugar.nombre}

</div>

<div class="info-row">

<span class="info-label">

🧭 Tipo

</span>

<br>

${lugar.tipo}

</div>

<div class="info-row">

<span class="info-label">

🌎 Latitud

</span>

<br>

${lugar.lat}

</div>

<div class="info-row">

<span class="info-label">

🌍 Longitud

</span>

<br>

${lugar.lng}

</div>

<div class="info-row">

<span class="info-label">

⛰ Altitud

</span>

<br>

${lugar.alt.toFixed(2)} m

</div>

<div class="panel-buttons">

<button id="btnEarth">

🌍 Google Earth

</button>

<button id="btnCopy">

📋 Copiar coordenadas

</button>

</div>

`;

document

.getElementById("btnEarth")

.onclick = () => abrirEarth(lugar);

document

.getElementById("btnCopy")

.onclick = () => copiarCoordenadas(lugar);

}