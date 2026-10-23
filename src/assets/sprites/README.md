# Sprites de Kiji Office

Todo lo de esta carpeta (salvo este README y `sprites.test.ts`) lo genera `tools/sprites/gen.py`. **No edites los PNG
a mano sin pasar el cambio al generador**: se perderían al regenerar.

## Regenerar

```sh
python3 tools/sprites/gen.py      # requiere Pillow (pip install pillow)
npm test -- src/assets/sprites    # test de humo
```

También escribe `tools/sprites/out/contacto.png` (ignorado por git): todos los robots ×6, una tira ×3 y la oficina
×3 con robots en sus sitios y la capa de frente encima. Míralo después de cada cambio.

## Archivos

| Archivo | Qué es |
|---|---|
| `robot-{terracota,azul,verde,crema}.png/.json` | Spritesheet PixiJS/TexturePacker (`frames`, `animations`, `meta`). |
| `robot-terracota-jefe.png/.json` | Igual, con corona en vez de antena (el jefe). |
| `oficina.png` | Fondo 320×180 px lógicos (tiles de 16), incluye el tablero de los escritorios. |
| `oficina-frente.png` | Mismo tamaño, transparente salvo frentes de escritorio, monitores y tazas: va **encima** de los robots y les tapa piernas y pies. |
| `oficina.json` | `desks` (6), `boss`, `standing` (sitios de pie), `bossZone`; puntos = pies del robot. |

- Robot: 32×40, ancla abajo-centro (`anchor {x:0.5, y:1}` en cada frame): el punto de `oficina.json` es el borde
  inferior del sprite. La escena lo dibuja ×3 con `scaleMode: 'nearest'`.
- Hoja: una fila por animación, 6 columnas (192×240). Fotogramas `idle_0…`, animaciones con nombre exacto del estado:
  `idle` 4 · `thinking` 4 · `writing` 6 · `needs_you` 2 · `error` 2 · `done` 4.
- Capas de la escena: `oficina.png` → robots → `oficina-frente.png`.

## Paletas (luz / medio / sombra, luz arriba-izquierda)

| Paleta | Uso | Tonos |
|---|---|---|
| terracota | Claude | `#F0A184` `#D97757` `#A9543A` |
| azul | Gemini | `#8FB0FF` `#4A7DFF` `#2F56C4` |
| verde | OpenAI | `#7FDCBC` `#2FB38A` `#1F7F61` |
| crema | Ollama | `#ECE7DC` `#C9C3B5` `#8F897B` |

Comunes: tinta `#1d1b26`, visor `#1f2436`, ojos `#8af0ff`, corona `#f4c542` + gema `#e2483d`, error `#ff5a5a`,
hecho `#5fd38d`. Sin logos. (El mapeo proveedor → paleta lo decide `src/scenes/officeLayout.ts`.)

## Retocar en Pixelorama sin perder el generador

1. Abre el PNG (los robots: *Import as spritesheet*, 6 columnas × 6 filas, celdas de 32×40) y experimenta.
2. Cuando te guste, pasa el cambio a `gen.py`: los detalles pequeños son arte ASCII (`CORONA`, `CHECK`, `HUMO_*`)
   y el resto son llamadas a `caja()`/`rect()` con coordenadas del fotograma; los colores están arriba del archivo.
3. Regenera y revisa la hoja de contacto. Si un retoque es imposible de expresar en código, guárdalo como PNG fuente
   en `tools/sprites/` y haz que `gen.py` lo componga, nunca sobrescribiendo directamente esta carpeta.
