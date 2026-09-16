/// <reference types="vite/client" />

/*
 * tsconfig declara "types": [] para no arrastrar todo @types automaticamente,
 * asi que los tipos del cliente de Vite (import.meta.env y los imports con
 * efecto secundario de .css) se piden aqui de forma explicita.
 */
