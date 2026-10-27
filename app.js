class GoogleEarthSearch {


constructor(){


this.lugares=[];

this.resultados=[];

this.indexActivo=-1;


this.input=document.getElementById("search");

this.results=document.getElementById("results");

this.counter=document.getElementById("counter");


this.cargar();


}



async cargar(){


this.results.innerHTML=

`
<div class="loading">
🌍 Cargando lugares...
</div>
`;


try{


let respuesta=
await fetch("lugares.json");


this.lugares=
await respuesta.json();


console.log(
"lugares:",
this.lugares.length
);


this.eventos();


}


catch(error){


this.results.innerHTML=

`
<div class="empty">

❌ Error cargando lugares.json

</div>
`;


console.error(error);


}


}




eventos(){


this.input.addEventListener(
"input",
()=>{

this.colorFondo();

this.buscar();

}

);



this.input.addEventListener(
"keydown",
(e)=>{


if(e.key==="ArrowDown"){

this.mover(1);

}


if(e.key==="ArrowUp"){

this.mover(-1);

}



if(e.key==="Enter"){

if(this.resultados[this.indexActivo]){

this.abrir(
this.resultados[this.indexActivo]
);

}

}



});



}




colorFondo(){


let texto=this.input.value.trim();


if(texto===""){


document.body.style.background="#2c3e50";


return;


}



let tono=
(texto.length*20)%360;



document.body.style.background=

`hsl(${tono},45%,30%)`;



}




buscar(){


let texto=
this.input.value
.toLowerCase()
.trim();



this.results.innerHTML="";

this.indexActivo=-1;


if(!texto){

this.counter.innerHTML="";

return;

}



this.resultados=
this.lugares.filter(l=>{


let datos=[

l.codigo,

l.nombre,

l.categoria,

l.descripcion,

...(l.tags||[])

]
.join(" ")
.toLowerCase();



return datos.includes(texto);


});



this.counter.innerHTML=

`${this.resultados.length} lugares encontrados`;




if(this.resultados.length===0){


this.results.innerHTML=

`
<div class="empty">

No hay resultados

</div>
`;


return;

}



this.resultados.forEach(
l=>this.crearTarjeta(l,texto)

);



}





crearTarjeta(l,texto){



let div=document.createElement("div");


div.className="result";


div.innerHTML=


`

<h2>
${this.marcar(l.nombre,texto)}
</h2>


<p>
<b>${l.codigo}</b>
</p>


<p>
${l.descripcion}
</p>


<p>
📍 ${l.lat},
${l.lng}
</p>



<button>
🌍 Abrir Google Earth
</button>


<button>
📋 Copiar
</button>


`;



div.children[3].onclick=()=>{

this.abrir(l);

};



div.children[4].onclick=()=>{

navigator.clipboard.writeText(

`${l.lat}, ${l.lng}`

);

};



this.results.appendChild(div);


}




marcar(texto,buscar){


let regex=
new RegExp(
buscar,
"gi"
);



return texto.replace(
regex,
match=>
`
<span class="highlight">
${match}
</span>
`
);



}




mover(valor){


let tarjetas=
document.querySelectorAll(".result");


if(!tarjetas.length)return;



this.indexActivo+=valor;



if(this.indexActivo<0)

this.indexActivo=tarjetas.length-1;



if(this.indexActivo>=tarjetas.length)

this.indexActivo=0;



tarjetas.forEach(
t=>t.classList.remove("active")
);



tarjetas[this.indexActivo]
.classList.add("active");


}




abrir(l){


window.open(

`https://earth.google.com/web/search/${l.lat},${l.lng}`,

"_blank"

);


}


}



new GoogleEarthSearch();
