// js/search.js

import { abrirEarth } from "./earth.js";
import { mostrarInformacion } from "./ui.js";

let fuse;
let resultados = [];
let indiceSeleccionado = -1;


//======================================================
// Crear buscador Fuse
//======================================================

export function crearBuscador(lugares) {

    fuse = new Fuse(lugares, {

        keys: [
            "nombre"
        ],

        threshold: 0.35,

        ignoreLocation: true,

        includeScore: true

    });

    return buscar;

}


//======================================================
// Buscar
//======================================================

function buscar(texto, contenedor, mapa, stats) {

    contenedor.innerHTML = "";

    indiceSeleccionado = -1;

    if (texto.trim() === "") {

        resultados = [];

        stats.innerHTML = "";

        return 0;

    }


    resultados =
        fuse.search(texto)
            .map(r => r.item);


    stats.innerHTML =
        `${resultados.length} resultado(s)`;


    resultados.forEach((lugar, index) => {

        const div =
            document.createElement("div");

        div.className = "result";

        div.dataset.index = index;


        div.innerHTML = `

            <h3>
                ${resaltar(lugar.nombre, texto)}
            </h3>

            <p>
                ${lugar.tipo || ""}
            </p>

            <small>
                ${lugar.lat.toFixed(6)},
                ${lugar.lng.toFixed(6)}
            </small>

        `;


        // CLICK
        div.onclick = () => {

            seleccionar(index, mapa);

            const input =
                document.getElementById("search");

            input.value =
                lugar.nombre;

            contenedor.innerHTML = "";

            stats.innerHTML = "";

        };


        // DOBLE CLICK → Google Earth
        div.ondblclick = () => {

            abrirEarth(lugar);

        };


        contenedor.appendChild(div);

    });


    /*
       NO seleccionamos automáticamente
       el primer resultado.

       Esto evita que el mapa se mueva
       mientras el usuario escribe.
    */

    return resultados.length;

}


//======================================================
// Seleccionar lugar
//======================================================

function seleccionar(index, mapa) {

    if (
        index < 0 ||
        index >= resultados.length
    ) {
        return;
    }


    const items =
        document.querySelectorAll(".result");


    items.forEach(x =>
        x.classList.remove("selected")
    );


    indiceSeleccionado = index;


    if (items[index]) {

        items[index]
            .classList
            .add("selected");


        items[index]
            .scrollIntoView({

                block: "nearest"

            });

    }


    mapa.irA(
        resultados[index]
    );


    mostrarInformacion(
        resultados[index]
    );

}


//======================================================
// Navegación con teclado
//======================================================

export function teclado(e, mapa) {

    if (resultados.length === 0)
        return;


    switch (e.key) {


        case "ArrowDown":

            e.preventDefault();

            indiceSeleccionado++;


            if (
                indiceSeleccionado >=
                resultados.length
            ) {

                indiceSeleccionado = 0;

            }


            resaltarSeleccion(
                indiceSeleccionado
            );

            break;


        case "ArrowUp":

            e.preventDefault();

            indiceSeleccionado--;


            if (
                indiceSeleccionado < 0
            ) {

                indiceSeleccionado =
                    resultados.length - 1;

            }


            resaltarSeleccion(
                indiceSeleccionado
            );

            break;


        case "Enter":

            e.preventDefault();


            if (
                indiceSeleccionado >= 0
            ) {

                const lugar =
                    resultados[
                        indiceSeleccionado
                    ];


                seleccionar(
                    indiceSeleccionado,
                    mapa
                );


                document
                    .getElementById("search")
                    .value =
                    lugar.nombre;


                document
                    .getElementById("results")
                    .innerHTML =
                    "";

            }

            break;


        case "Escape":

            document
                .getElementById("search")
                .value =
                "";


            document
                .getElementById("results")
                .innerHTML =
                "";


            resultados = [];

            indiceSeleccionado = -1;

            break;

    }

}


//======================================================
// Solo resaltar sugerencia
// sin mover mapa
//======================================================

function resaltarSeleccion(index) {

    const items =
        document.querySelectorAll(".result");


    items.forEach(x =>
        x.classList.remove("selected")
    );


    if (items[index]) {

        items[index]
            .classList
            .add("selected");


        items[index]
            .scrollIntoView({

                block: "nearest"

            });

    }

}


//======================================================
// Resaltar coincidencia
//======================================================

function resaltar(texto, buscar) {

    const escapado =
        buscar.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
        );


    const exp =
        new RegExp(
            `(${escapado})`,
            "ig"
        );


    return texto.replace(
        exp,
        "<mark>$1</mark>"
    );

}
