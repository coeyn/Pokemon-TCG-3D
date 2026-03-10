# Poke TCG 3D - Prototype QR + AR Web

Prototype web pour:
- lire la camera
- detecter 4 QR de calibration (`TL`, `TR`, `BR`, `BL`)
- estimer la pose du playmat
- afficher un objet 3D ancre sur le playmat

## Lancer le prototype

Tu dois lancer un serveur local (pas `file://`) pour utiliser `getUserMedia`.
La camera est autorisee uniquement en `https` ou `http://localhost`.

Option 1 (Node):
```bash
npx serve .
```

Option 2 (Python):
```bash
python -m http.server 8000
```

Puis ouvre:
- `http://localhost:3000` (avec `serve`)
- ou `http://localhost:8000` (avec Python)

Page utile:
- `http://localhost:3000/qr-markers-print.html` (ou port 8000) pour imprimer les QR de calibration.

## Deploiement GitHub Pages

1. Va dans `Settings` > `Pages` du repo GitHub.
2. Dans `Build and deployment`, choisis:
- `Source`: `Deploy from a branch`
- `Branch`: `main`
- `Folder`: `/ (root)`
3. Clique `Save`.
4. Attends 1 a 3 minutes, puis ouvre:
- `https://coeyn.github.io/Pokemon-TCG-3D/`

Sur mobile, la camera doit etre autorisee en HTTPS. GitHub Pages est en HTTPS par defaut.

## Calibration QR

Imprime 4 QR et place-les aux 4 coins du playmat:
- haut gauche: `TL`
- haut droit: `TR`
- bas droit: `BR`
- bas gauche: `BL`

Le code attend un playmat de taille reelle:
- largeur: `0.60 m`
- hauteur: `0.35 m`

Tu peux changer ces valeurs dans [`main.js`](/c:/Users/coeyn/Documents/projet code/poke_tcg_3d/main.js) (`MAT_WIDTH_M`, `MAT_HEIGHT_M`).

## Modele 3D

Par defaut, un modele "placeholder" est affiche.

Si tu ajoutes un fichier `assets/pokemon.glb`, il sera charge automatiquement et place sur le tapis.

## Limitations actuelles

- intrinseques camera approximees (FOV fixe) -> leger decalage possible
- detection QR basee sur image 2D, sensible a la lumiere/flou
- pas encore de suivi NFC/RFID des cartes (etape suivante)
