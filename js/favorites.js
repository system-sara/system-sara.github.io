const KEY="favoritos";


export function favoritos(){


return JSON.parse(

localStorage.getItem(KEY) || "[]"

);


}



export function cambiarFavorito(codigo){


let lista=favoritos();


if(lista.includes(codigo)){


lista=
lista.filter(x=>x!==codigo);


}

else{


lista.push(codigo);


}


localStorage.setItem(

KEY,

JSON.stringify(lista)

);


}



export function esFavorito(codigo){


return favoritos()

.includes(codigo);


}