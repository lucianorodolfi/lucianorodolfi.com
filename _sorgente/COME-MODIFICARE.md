# Sito di Luciano Rodolfi

Sito statico: nessun server, nessun abbonamento. Ospitato su GitHub Pages.

## Cosa si cambia senza toccare il codice

Tutto in `index.html`, con un editor di testo qualsiasi:

- **Impostazioni della scena** (palo, volantino, prospettiva, retro…):
  il blocco `window.SCENE`, sono gli stessi valori del pannello di Framer.
  `phone` contiene i valori diversi sul telefono (fino a 809.98 px).
- **Testi del volantino**: dentro `<template id="front-flyer">`.
- **Linguette**: `data-count` (quante), `data-href` (link del PDF),
  `data-label` (scritta).
- **Retro**: dentro `<template id="back-page">`; la stella si regola con
  `data-width`, `data-speed`, `data-href`.
- **Immagine dei materiali**: sostituisci `images/material.png`
  (stesso nome).
- **Stili** (font, colori, misure del volantino): `style.css`.

Dopo ogni modifica: carica il file cambiato su GitHub, il sito si aggiorna
in un minuto circa.

## Codice (solo se serve cambiare la scena 3D)

Questa cartella contiene il sorgente di `app.js`:

- `LowPolyPoleScene.tsx`: lo stesso code component di Framer, invariato;
- `main.tsx`: monta la scena, le linguette e la stella;
- `shims/`: sostituti minimi di `framer` e `framer-motion`.

Per rigenerare `app.js` (serve Node.js con react, react-dom, esbuild):

```
esbuild _sorgente/main.tsx --bundle --minify --format=iife --target=es2019 \
  --define:process.env.NODE_ENV=\"production\" \
  --alias:framer=./_sorgente/shims/framer.ts \
  --alias:framer-motion=./_sorgente/shims/framer-motion.tsx \
  --jsx=automatic --legal-comments=none --outfile=app.js
```

Le cartelle che iniziano con `_` non vengono pubblicate da GitHub Pages.
