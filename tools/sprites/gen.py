#!/usr/bin/env python3
"""Generador reproducible del pixel art de Kiji Office.

Dibuja por código (sin PNGs hechos a mano) los robots y la oficina y escribe en src/assets/sprites/:
  robot-{terracota,azul,verde,crema}.png/.json, robot-terracota-jefe.png/.json  (spritesheets PixiJS)
  oficina.png, oficina-frente.png, oficina.json
Además deja una hoja de contacto en tools/sprites/out/ (ignorada por git) para revisar el resultado.

Uso:  python3 tools/sprites/gen.py            (requiere Pillow)
"""
import json
import math
import os
import random

from PIL import Image, ImageDraw

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DESTINO = os.path.join(RAIZ, "src", "assets", "sprites")
SALIDA_CONTACTO = os.path.join(RAIZ, "tools", "sprites", "out")


# ---------------------------------------------------------------------------------------------------------------
# Colores
# ---------------------------------------------------------------------------------------------------------------

def c(h, a=255):
    """'#rrggbb' → (r, g, b, a)."""
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def rampa(luz, medio, sombra):
    """Tres tonos (luz arriba-izquierda / medio / sombra)."""
    return (c(luz), c(medio), c(sombra))


TINTA = c("#1d1b26")
PALETAS = {
    "terracota": rampa("#F0A184", "#D97757", "#A9543A"),  # Claude
    "azul": rampa("#8FB0FF", "#4A7DFF", "#2F56C4"),  # Gemini / OpenAI según la escena
    "verde": rampa("#7FDCBC", "#2FB38A", "#1F7F61"),
    "crema": rampa("#ECE7DC", "#C9C3B5", "#8F897B"),  # Ollama
}
METAL = rampa("#c9ccd6", "#9aa0ae", "#676c7c")
VISOR = rampa("#2a3150", "#1f2436", "#171a28")
BRILLO_VISOR = c("#3b4466")
BLANCO = rampa("#ffffff", "#f1eee6", "#cfc9bb")
ORO = rampa("#ffe08a", "#f4c542", "#b8891f")
GEMA = rampa("#ff8a7a", "#e2483d", "#a32a22")
HUMO = rampa("#f2f1f5", "#d4d2dc", "#a9a6b6")
BORDE_HUMO = c("#6e6a7e")
LEDS = {
    "cian": rampa("#d8fbff", "#8af0ff", "#3fb8cc"),
    "oro": ORO,
    "rojo": rampa("#ffb0b0", "#ff5a5a", "#b83232"),
    "verde": rampa("#b8f5cf", "#5fd38d", "#2f9a5a"),
    "apagado": rampa("#4a4f60", "#3a3e4c", "#2a2d38"),
}
CIAN_OJO = c("#8af0ff")
CIAN_BRILLO = c("#d8fbff")
CIAN_TENUE = c("#3e7c8c")
ROJO_OJO = c("#ff5a5a")
VERDE_OJO = c("#5fd38d")


# ---------------------------------------------------------------------------------------------------------------
# Lienzo con primitivas de pixel art
# ---------------------------------------------------------------------------------------------------------------

class Lienzo:
    def __init__(self, w, h, fondo=(0, 0, 0, 0)):
        self.w, self.h = w, h
        self.img = Image.new("RGBA", (w, h), fondo)
        self.px = self.img.load()

    def p(self, x, y, col):
        """Pinta un píxel; con alfa < 255 mezcla sobre lo que hay (operador 'over')."""
        if col is None or not (0 <= x < self.w and 0 <= y < self.h):
            return
        if col[3] >= 255:
            self.px[x, y] = col
            return
        r, g, b, a = self.px[x, y]
        fa = col[3] / 255
        if a == 0:
            self.px[x, y] = col
            return
        oa = fa + (a / 255) * (1 - fa)
        mix = lambda s, d: round((s * fa + d * (a / 255) * (1 - fa)) / oa)
        self.px[x, y] = (mix(col[0], r), mix(col[1], g), mix(col[2], b), round(oa * 255))

    def get(self, x, y):
        return self.px[x, y] if 0 <= x < self.w and 0 <= y < self.h else (0, 0, 0, 0)

    def rect(self, x0, y0, x1, y1, col):
        """Rectángulo relleno, extremos incluidos."""
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.p(x, y, col)

    def caja(self, x0, y0, x1, y1, ramp, redondo=1, tinta=TINTA):
        """Caja con contorno de tinta y sombreado de 3 tonos (luz arriba-izquierda).
        redondo=0 esquinas rectas · 1 recorta la esquina · 2 recorta y mete tinta en la esquina interior."""
        luz, medio, sombra = ramp
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                bx, by = x in (x0, x1), y in (y0, y1)
                if bx and by and redondo:
                    continue
                if bx or by:
                    col = tinta
                elif redondo >= 2 and x in (x0 + 1, x1 - 1) and y in (y0 + 1, y1 - 1):
                    col = tinta
                elif y == y0 + 1 or x == x0 + 1:
                    col = luz
                elif y == y1 - 1 or x == x1 - 1:
                    col = sombra
                else:
                    col = medio
                self.p(x, y, col)

    def sello(self, x, y, arte, colores):
        """Estampa arte ASCII: cada carácter es una clave de `colores`; '.' es transparente."""
        for j, fila in enumerate(arte):
            for i, ch in enumerate(fila):
                if ch != "." and ch != " ":
                    self.p(x + i, y + j, colores[ch])

    def oscurecer(self, x0, y0, x1, y1, f):
        for y in range(max(0, y0), min(self.h, y1 + 1)):
            for x in range(max(0, x0), min(self.w, x1 + 1)):
                r, g, b, a = self.px[x, y]
                self.px[x, y] = (round(r * f), round(g * f), round(b * f), a)

    def pegar(self, otro, x, y):
        self.img.alpha_composite(otro.img, (x, y))
        self.px = self.img.load()


def contornear(capa, tinta=TINTA):
    """Pone tinta en cada píxel transparente que toca (4-vecinos) un píxel opaco de la capa."""
    marcados = []
    for y in range(capa.h):
        for x in range(capa.w):
            if capa.get(x, y)[3] == 0 and any(
                capa.get(x + dx, y + dy)[3] > 0 for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
            ):
                marcados.append((x, y))
    for x, y in marcados:
        capa.p(x, y, tinta)


# ---------------------------------------------------------------------------------------------------------------
# Robot 32×40 (pies en el borde inferior, centro x=16)
# ---------------------------------------------------------------------------------------------------------------

ROBOT_W, ROBOT_H = 32, 40
ANIMACIONES = [("idle", 4), ("thinking", 4), ("writing", 6), ("needs_you", 2), ("error", 2), ("done", 4)]

CORONA = [
    ".k...kk...k.",
    "kLk.kLLk.kLk",
    "kGLkLGGLkLGk",
    "kGGGGrRGGGGk",
    "kDDDDRdDDDDk",
    "kkkkkkkkkkkk",
]
CHECK = [
    ".......kk",
    "......kLk",
    ".....kLGk",
    "kk..kLGk.",
    "kLkkLGk..",
    "kGGLGk...",
    ".kGGk....",
    "..kk.....",
]
HUMO_GRANDE = [
    ".oooo.",
    "oLLLMo",
    "oLMMDo",
    "oMMDDo",
    ".oooo.",
]
HUMO_PEQUENO = [
    ".oo.",
    "oLMo",
    "oMDo",
    ".oo.",
]


def led(L, x, y, color):
    """LED de 2×2 con brillo arriba-izquierda."""
    luz, medio, sombra = LEDS[color]
    L.p(x, y, luz)
    L.p(x + 1, y, medio)
    L.p(x, y + 1, medio)
    L.p(x + 1, y + 1, sombra)


def dibujar_robot(paleta, estado, f, jefe=False):
    pal = PALETAS[paleta]
    L = Lienzo(ROBOT_W, ROBOT_H)

    # --- parámetros del fotograma ---
    respira = {"idle": [0, 1, 1, 0], "thinking": [0, 0, 1, 1]}.get(estado, [0] * 6)[f]
    salto = [0, -1, -1, 0][f] if estado == "done" else 0
    o = respira + salto  # desplazamiento vertical de cabeza y torso
    color_led = {
        "idle": "cian",
        "thinking": "oro" if f % 2 == 0 else "apagado",
        "writing": "cian" if f % 2 == 0 else "apagado",
        "needs_you": "oro",
        "error": "rojo" if f % 2 == 0 else "apagado",
        "done": "verde",
    }[estado]

    # --- sombra en el suelo (no salta) ---
    for x in range(10, 22):
        L.p(x, 39, c("#1d1b26", 85))
    L.p(9, 39, c("#1d1b26", 40))
    L.p(22, 39, c("#1d1b26", 40))

    # --- piernas y pies ---
    L.caja(11, 32 + salto, 14, 37 + salto, pal, 1)
    L.caja(17, 32 + salto, 20, 37 + salto, pal, 1)
    L.caja(10, 35 + salto, 14, 38 + salto, METAL, 1)
    L.caja(17, 35 + salto, 21, 38 + salto, METAL, 1)

    # --- orejas, cuello, cuerpo y panel de pecho ---
    L.caja(5, 11 + o, 7, 15 + o, METAL, 1)
    L.caja(24, 11 + o, 26, 15 + o, METAL, 1)
    L.rect(13, 20 + o, 18, 21 + o, TINTA)
    L.rect(14, 20 + o, 17, 21 + o, METAL[1])
    L.rect(14, 20 + o, 14, 21 + o, METAL[0])
    L.caja(9, 22 + o, 22, 33 + o, pal, 1)
    L.caja(12, 24 + o, 19, 30 + o, VISOR, 1)
    L.rect(13, 26 + o, 14, 26 + o, CIAN_TENUE)
    L.rect(13, 28 + o, 14, 28 + o, CIAN_TENUE)
    led(L, 16, 26 + o, color_led)

    # --- cabeza y visor ---
    L.caja(7, 7 + o, 24, 19 + o, pal, 2)
    L.caja(9, 9 + o, 22, 16 + o, VISOR, 1)
    for x, y in ((10, 10), (11, 10), (10, 11)):
        L.p(x, y + o, BRILLO_VISOR)

    # --- ojos ---
    def ojos_normales(dx=0, dy=0):
        for ex in (12, 18):
            L.rect(ex + dx, 11 + o + dy, ex + 1 + dx, 13 + o + dy, CIAN_OJO)
            L.p(ex + dx, 11 + o + dy, CIAN_BRILLO)

    if estado == "idle":
        if f == 3:  # parpadeo
            for ex in (12, 18):
                L.rect(ex, 13 + o, ex + 1, 13 + o, CIAN_OJO)
        else:
            ojos_normales()
    elif estado == "thinking":
        ojos_normales(1, -1)  # mira arriba, hacia la burbuja
    elif estado == "writing":
        ojos_normales(0, 2)  # mira abajo, al teclado
    elif estado == "needs_you":
        ojos_normales()
    elif estado == "error":
        for ex in (11, 18):
            for dx, dy in ((0, 0), (2, 0), (1, 1), (0, 2), (2, 2)):
                L.p(ex + dx, 11 + o + dy, ROJO_OJO)
    elif estado == "done":
        for ex in (11, 18):
            for dx, dy in ((1, 0), (0, 1), (2, 1), (0, 2), (2, 2)):
                L.p(ex + dx, 11 + o + dy, VERDE_OJO)

    # --- antena o corona ---
    if jefe:
        L.sello(10, 2 + o, CORONA, {"k": TINTA, "L": ORO[0], "G": ORO[1], "D": ORO[2],
                                    "r": GEMA[0], "R": GEMA[1], "d": GEMA[2]})
    else:
        for y in (5 + o, 6 + o):
            L.p(14, y, TINTA)
            L.p(15, y, METAL[0])
            L.p(16, y, METAL[2])
            L.p(17, y, TINTA)
        L.caja(14, 1 + o, 17, 4 + o, LEDS[color_led], 1)

    # --- brazos ---
    def brazo_lado(x0):
        L.caja(x0, 23 + o, x0 + 3, 30 + o, pal, 1)
        L.caja(x0, 29 + o, x0 + 3, 32 + o, METAL, 1)

    if estado == "writing":
        izq = [1, 0, 0, 1, 0, 0][f]
        der = [0, 0, 1, 0, 0, 1][f]
        L.caja(6, 23 + o, 9, 27 + o, pal, 1)
        L.caja(8, 26 + o + izq, 12, 29 + o + izq, METAL, 1)
        L.caja(22, 23 + o, 25, 27 + o, pal, 1)
        L.caja(19, 26 + o + der, 23, 29 + o + der, METAL, 1)
    elif estado == "needs_you":
        brazo_lado(6)
        xo = f  # saluda moviendo la mano 1 px
        L.caja(21, 21 + o, 25, 25 + o, pal, 1)  # hombro
        L.caja(23 + xo, 10 + o, 26 + xo, 23 + o, pal, 1)
        L.caja(23 + xo, 6 + o, 26 + xo, 10 + o, METAL, 1)
    else:
        brazo_lado(6)
        brazo_lado(22)

    # --- extras de cada estado ---
    if estado == "thinking":
        # x21..31: comparte el borde con la punta derecha de la corona del jefe, sin taparla
        L.caja(21, 0, 31, 5, BLANCO, 1)
        llenos = [1, 2, 3, 3][f]
        for i, x in enumerate((22, 25, 28)):
            L.rect(x, 2, x + 1, 3, TINTA if i < llenos else c("#d9d4c8"))
    elif estado == "needs_you":
        by = 1 - f  # el bocadillo bota
        L.caja(0, by, 6, 9 + by, ORO, 1)
        L.rect(3, 2 + by, 3, 5 + by, TINTA)
        L.p(3, 7 + by, TINTA)
    elif estado == "error":
        cols = {"o": BORDE_HUMO, "L": HUMO[0], "M": HUMO[1], "D": HUMO[2]}
        if f == 0:
            L.sello(8, 3, HUMO_PEQUENO, cols)
            L.sello(1, 0, HUMO_GRANDE, cols)
        else:
            L.sello(1, 4, HUMO_PEQUENO, cols)
            L.sello(4, 0, HUMO_GRANDE, cols)
    elif estado == "done":
        L.sello(23, [1, 0, 0, 1][f], CHECK, {"k": TINTA, "L": LEDS["verde"][0], "G": LEDS["verde"][1]})

    return L.img


def hoja_robot(paleta, jefe=False):
    """Spritesheet: una fila por animación, hasta 6 columnas."""
    cols = max(n for _, n in ANIMACIONES)
    hoja = Image.new("RGBA", (cols * ROBOT_W, len(ANIMACIONES) * ROBOT_H), (0, 0, 0, 0))
    frames, anims = {}, {}
    for fila, (nombre, n) in enumerate(ANIMACIONES):
        anims[nombre] = []
        for f in range(n):
            x, y = f * ROBOT_W, fila * ROBOT_H
            hoja.alpha_composite(dibujar_robot(paleta, nombre, f, jefe), (x, y))
            clave = f"{nombre}_{f}"
            anims[nombre].append(clave)
            frames[clave] = {
                "frame": {"x": x, "y": y, "w": ROBOT_W, "h": ROBOT_H},
                "rotated": False,
                "trimmed": False,
                "spriteSourceSize": {"x": 0, "y": 0, "w": ROBOT_W, "h": ROBOT_H},
                "sourceSize": {"w": ROBOT_W, "h": ROBOT_H},
                "anchor": {"x": 0.5, "y": 1},
            }
    return hoja, frames, anims


# ---------------------------------------------------------------------------------------------------------------
# Oficina 320×180 lógicos (tiles de 16 px)
# ---------------------------------------------------------------------------------------------------------------

OFI_W, OFI_H = 320, 180
SUELO_Y = 68  # primera fila de suelo
DESK_W = 52
ESCRITORIOS = [(128, 112), (190, 112), (252, 112), (128, 164), (190, 164), (252, 164)]  # pies del robot
JEFE = (46, 146)
JEFE_W = 60
DE_PIE = [(296, 92), (296, 132), (296, 172)]

PARED = c("#e8dcc6")
MADERA_SUELO = [c("#bd8f61"), c("#b98b5e"), c("#b4875a")]
JUNTA_SUELO = c("#9b6e46")
VETA_SUELO = c("#a97d52")
TABLERO = rampa("#f0dcb6", "#dfc497", "#b99a6c")  # parte de arriba del escritorio
FRENTE = rampa("#d4b282", "#bf9a68", "#987549")
TABLERO_JEFE = rampa("#b07a52", "#8f5f3e", "#6a432a")
FRENTE_JEFE = rampa("#9a6844", "#7c5034", "#5a3824")
MONITOR = rampa("#6c7282", "#4f5463", "#373a46")
TAZAS = [c("#e2483d"), c("#4a7dff"), c("#f4c542"), c("#2fb38a"), c("#8e6bd1"), c("#ff8c42")]

FUENTE_3x5 = {
    "J": ["..#", "..#", "..#", "#.#", ".#."],
    "E": ["###", "#..", "##.", "#..", "###"],
    "F": ["###", "#..", "##.", "#..", "#.."],
}


def aclarar(col, f):
    return tuple(min(255, round(v + (255 - v) * f)) for v in col[:3]) + (col[3],)


def oscuro(col, f):
    return tuple(round(v * f) for v in col[:3]) + (col[3],)


def dibujar_pared(L):
    for y in range(0, SUELO_Y):
        for x in range(OFI_W):
            col = PARED
            if x % 8 == 4 and y % 8 == 4:
                col = c("#dfd1b6")  # papel pintado de puntitos
            L.p(x, y, col)
    # moldura del techo
    L.rect(0, 0, OFI_W - 1, 2, c("#d4c3a3"))
    L.rect(0, 3, OFI_W - 1, 3, c("#bba783"))
    # zócalo
    L.rect(0, 59, OFI_W - 1, 59, c("#5e3f2a"))
    L.rect(0, 60, OFI_W - 1, 60, c("#b07c54"))
    L.rect(0, 61, OFI_W - 1, 65, c("#9c6a45"))
    L.rect(0, 66, OFI_W - 1, 66, c("#7a5236"))
    L.rect(0, 67, OFI_W - 1, 67, c("#5e3f2a"))
    for x in range(8, OFI_W, 16):  # juntas del zócalo cada tile
        L.rect(x, 61, x, 65, c("#86593a"))


def dibujar_suelo(L, rng):
    for k in range((OFI_H - SUELO_Y) // 8 + 1):
        y0 = SUELO_Y + k * 8
        desfase = (k * 24) % 48
        for m in range(-1, OFI_W // 48 + 2):
            xa = m * 48 + desfase
            base = MADERA_SUELO[(k * 7 + m * 3) % 3]
            for y in range(y0, y0 + 8):
                for x in range(xa, xa + 48):
                    col = base
                    if y == y0:
                        col = aclarar(base, 0.12)
                    if y == y0 + 7:
                        col = JUNTA_SUELO
                    if x == xa:
                        col = JUNTA_SUELO
                    elif x == xa + 1 and y < y0 + 7:
                        col = aclarar(base, 0.12)
                    L.p(x, y, col)
            # vetas
            for _ in range(3):
                vx = xa + rng.randint(4, 40)
                vy = y0 + rng.randint(2, 5)
                for x in range(vx, vx + rng.randint(3, 6)):
                    L.p(x, vy, VETA_SUELO)
    # sombra de contacto junto a la pared
    L.oscurecer(0, SUELO_Y, OFI_W - 1, SUELO_Y, 0.82)
    L.oscurecer(0, SUELO_Y + 1, OFI_W - 1, SUELO_Y + 1, 0.92)


def dibujar_ventana(L, x0, y0):
    w, h = 34, 34
    x1, y1 = x0 + w - 1, y0 + h - 1
    L.caja(x0, y0, x1, y1, rampa("#fbf9f4", "#efeae0", "#c7c0b0"), 1)
    # cielo en bandas
    cielos = [c("#86c5f5"), c("#97cff7"), c("#a9d9f9"), c("#bde3fb")]
    gx0, gy0, gx1, gy1 = x0 + 3, y0 + 3, x1 - 3, y1 - 3
    for y in range(gy0, gy1 + 1):
        banda = min(3, (y - gy0) * 4 // (gy1 - gy0 + 1))
        L.rect(gx0, y, gx1, y, cielos[banda])
    L.rect(gx0 - 1, gy0 - 1, gx1 + 1, gy0 - 1, TINTA)
    L.rect(gx0 - 1, gy0, gx0 - 1, gy1, TINTA)
    # nube
    nube = ["..wwww...", ".wwwwwww.", "wwwwwwwwww", ".ssssssss."]
    L.sello(gx0 + 4, gy0 + 6, nube, {"w": c("#ffffff"), "s": c("#e3f1fb")})
    # reflejos diagonales
    for i in range(6):
        L.p(gx1 - 4 - i, gy0 + 2 + i, c("#e6f5ff"))
        L.p(gx1 - 7 - i, gy0 + 2 + i, c("#d4edfd"))
    # cruceta
    mx, my = (x0 + x1) // 2, (y0 + y1) // 2
    L.rect(mx - 1, gy0, mx, gy1, c("#efeae0"))
    L.rect(mx + 1, gy0, mx + 1, gy1, c("#c7c0b0"))
    L.rect(gx0, my, gx1, my, c("#efeae0"))
    L.rect(gx0, my + 1, gx1, my + 1, c("#c7c0b0"))
    # alféizar
    L.caja(x0 - 2, y1, x1 + 2, y1 + 3, rampa("#fbf9f4", "#e6dfd1", "#b9b19f"), 1)


def dibujar_reloj(L, cx, cy, r=6):
    for y in range(cy - r - 1, cy + r + 2):
        for x in range(cx - r - 1, cx + r + 2):
            d = math.hypot(x - cx, y - cy)
            if d <= r + 0.5:
                if d > r - 0.7:
                    L.p(x, y, TINTA)
                elif (x - cx) + (y - cy) > 3:
                    L.p(x, y, c("#ddd8cc"))
                else:
                    L.p(x, y, c("#f8f6f0"))
    for dx, dy in ((r - 2, 0), (-(r - 2), 0), (0, r - 2)):
        L.p(cx + dx, cy + dy, c("#9aa0ae"))
    L.rect(cx, cy - (r - 2), cx, cy, TINTA)  # minutero (las 12)
    L.rect(cx, cy, cx + 3, cy, TINTA)  # horario (las 3)
    L.p(cx, cy, c("#e2483d"))


def dibujar_pizarra(L, x0, y0, x1, y1, rng):
    L.caja(x0, y0, x1, y1, METAL, 1)
    sx0, sy0, sx1, sy1 = x0 + 2, y0 + 2, x1 - 2, y1 - 2
    L.rect(sx0, sy0, sx1, sy1, c("#f7f7f2"))
    L.rect(sx0, sy0, sx1, sy0, TINTA)
    L.rect(sx0, sy0, sx0, sy1, TINTA)
    L.rect(sx0, sy1, sx1, sy1, c("#e2e2da"))
    ancho = (sx1 - sx0) // 3
    cabeceras = [c("#4a7dff"), c("#f4c542"), c("#2fb38a")]
    notas = [c("#ffe066"), c("#ff9ec4"), c("#8fd0ff"), c("#a8e6a1")]
    cuantas = [3, 2, 2]
    for i in range(3):
        cx0 = sx0 + 1 + i * ancho
        if i > 0:
            L.rect(cx0 - 1, sy0 + 3, cx0 - 1, sy1 - 2, c("#d6d6cc"))
        L.rect(cx0 + 3, sy0 + 3, cx0 + ancho - 5, sy0 + 4, cabeceras[i])  # título de columna
        for j in range(cuantas[i]):
            nx = cx0 + 3 + (j % 2) * 2
            ny = sy0 + 8 + j * 10
            col = notas[(i * 2 + j) % 4]
            L.rect(nx + 1, ny + 1, nx + 9, ny + 8, c("#d8d6cc"))  # sombra de la nota
            L.rect(nx, ny, nx + 8, ny + 7, col)
            L.rect(nx, ny, nx + 8, ny, aclarar(col, 0.4))
            L.rect(nx, ny + 7, nx + 8, ny + 7, oscuro(col, 0.82))
            L.rect(nx + 2, ny + 3, nx + 6, ny + 3, oscuro(col, 0.6))
            L.rect(nx + 2, ny + 5, nx + 4, ny + 5, oscuro(col, 0.6))
    # bandeja con rotuladores
    L.caja(x0 + 4, y1, x1 - 4, y1 + 3, METAL, 1)
    for k, col in enumerate((c("#e2483d"), c("#4a7dff"), c("#2fb38a"))):
        L.rect(x0 + 8 + k * 5, y1 + 1, x0 + 10 + k * 5, y1 + 1, col)


def dibujar_dispensador(L, x0, y_suelo):
    # garrafa
    L.caja(x0 + 2, y_suelo - 48, x0 + 12, y_suelo - 35, rampa("#d6f0ff", "#a8dcff", "#6fb8e6"), 2)
    L.rect(x0 + 4, y_suelo - 46, x0 + 4, y_suelo - 38, c("#f2fbff"))
    L.rect(x0 + 3, y_suelo - 42, x0 + 11, y_suelo - 42, c("#8ccbf2"))
    L.caja(x0 + 5, y_suelo - 35, x0 + 9, y_suelo - 33, METAL, 0)
    # cuerpo
    L.caja(x0, y_suelo - 33, x0 + 14, y_suelo, BLANCO, 1)
    L.rect(x0 + 3, y_suelo - 27, x0 + 4, y_suelo - 26, c("#e2483d"))
    L.rect(x0 + 10, y_suelo - 27, x0 + 11, y_suelo - 26, c("#4a7dff"))
    L.caja(x0 + 2, y_suelo - 22, x0 + 12, y_suelo - 17, rampa("#555a68", "#3f4350", "#2c2f3a"), 0)
    L.rect(x0 + 3, y_suelo - 10, x0 + 11, y_suelo - 10, c("#cfc9bb"))


def dibujar_estanteria(L, x0, y0, x1, y1, rng):
    madera = rampa("#a87048", "#8a5a3a", "#5e3c26")
    L.caja(x0, y0, x1, y1, madera, 0)
    colores = [c("#e2483d"), c("#4a7dff"), c("#2fb38a"), c("#f4c542"), c("#8e6bd1"), c("#ff8c42"),
               c("#e8e2d0")]
    baldas = [(y0 + 3, y0 + 15), (y0 + 18, y0 + 30), (y0 + 33, y0 + 45)]
    for (by0, by1) in baldas:
        L.rect(x0 + 2, by0, x1 - 2, by1, c("#3f281a"))  # fondo del hueco
        L.rect(x0 + 1, by1 + 1, x1 - 1, by1 + 1, madera[0])  # balda
        L.rect(x0 + 1, by1 + 2, x1 - 1, by1 + 2, madera[2])
        x = x0 + 3
        while x < x1 - 3:
            ancho = rng.choice((2, 2, 3))
            if x + ancho > x1 - 2:
                break
            alto = rng.randint(7, 11)
            col = rng.choice(colores)
            for bx in range(x, x + ancho):
                tono = aclarar(col, 0.3) if bx == x else (oscuro(col, 0.75) if bx == x + ancho - 1 else col)
                L.rect(bx, by1 - alto + 1, bx, by1, tono)
            L.rect(x, by1 - alto + 3, x + ancho - 1, by1 - alto + 3, oscuro(col, 0.6))  # banda del lomo
            x += ancho + (1 if rng.random() < 0.25 else 0)
    # zócalo del mueble con dos cajones
    zy = y0 + 48
    L.rect(x0 + 1, zy, x1 - 1, y1 - 1, madera[1])
    medio = (x0 + x1) // 2
    L.rect(medio, zy, medio, y1 - 1, TINTA)
    for hx in ((x0 + medio) // 2, (medio + x1) // 2):
        L.rect(hx - 1, zy + (y1 - zy) // 2, hx + 1, zy + (y1 - zy) // 2, METAL[0])


def dibujar_planta(L, x0, y_suelo):
    capa = Lienzo(24, 40)
    hojas = [rampa("#8fd27a", "#5fae5a", "#3f8a45")]
    luz, medio, sombra = hojas[0]
    # hojas como elipses (de atrás a delante)
    for (cx, cy, rx, ry) in ((7, 12, 4, 7), (16, 11, 4, 7), (12, 7, 3, 7), (5, 20, 5, 4), (18, 20, 5, 4),
                             (12, 16, 5, 6)):
        for y in range(cy - ry, cy + ry + 1):
            for x in range(cx - rx, cx + rx + 1):
                if ((x - cx) / (rx + 0.4)) ** 2 + ((y - cy) / (ry + 0.4)) ** 2 <= 1:
                    dx, dy = x - cx, y - cy
                    col = luz if dx + dy < -rx * 0.6 else (sombra if dx + dy > rx * 0.6 else medio)
                    capa.p(x + 0, y + 1, col)
    # nervios
    for (x, y0_, y1_) in ((12, 2, 22), (7, 7, 18), (16, 6, 17)):
        capa.rect(x, y0_, x, y1_, sombra)
    contornear(capa)
    L.pegar(capa, x0 - 2, y_suelo - 38)
    # maceta
    L.caja(x0 + 3, y_suelo - 14, x0 + 17, y_suelo, rampa("#9aa8c6", "#6d7a99", "#4c5670"), 1)
    L.rect(x0 + 3, y_suelo - 11, x0 + 17, y_suelo - 11, TINTA)


def dibujar_cartel_jefe(L, cx, y0):
    texto = "JEFE"
    ancho_texto = len(texto) * 4 - 1
    x0, x1 = cx - ancho_texto // 2 - 4, cx + (ancho_texto - ancho_texto // 2) + 3
    L.caja(x0, y0, x1, y0 + 10, rampa("#4a4d63", "#2d2f3d", "#20212c"), 1)
    L.rect(x0 + 1, y0 + 1, x1 - 1, y0 + 1, ORO[2])
    tx = cx - ancho_texto // 2
    for letra in texto:
        for j, fila in enumerate(FUENTE_3x5[letra]):
            for i, ch in enumerate(fila):
                if ch == "#":
                    L.p(tx + i, y0 + 3 + j, ORO[1] if j else ORO[0])
        tx += 4
    # cordel del que cuelga
    L.p(x0 + 3, y0 - 1, TINTA)
    L.p(x1 - 3, y0 - 1, TINTA)


def dibujar_cuadro(L, x0, y0, x1, y1):
    L.caja(x0, y0, x1, y1, rampa("#c99a55", "#a8793d", "#7a5528"), 0)
    L.rect(x0 + 2, y0 + 2, x1 - 2, y1 - 2, c("#a9d9f9"))
    L.rect(x0 + 2, (y0 + y1) // 2 + 1, x1 - 2, y1 - 2, c("#7cc06e"))
    # montaña
    mx = (x0 + x1) // 2
    for i in range(6):
        L.rect(mx - i, (y0 + y1) // 2 - 4 + i, mx + i, (y0 + y1) // 2 - 4 + i, c("#8a8fa8"))
    L.p(mx, (y0 + y1) // 2 - 4, c("#ffffff"))
    L.p(x1 - 4, y0 + 4, c("#ffe066"))


def dibujar_cristal_vertical(L, x0, x1, y0, y1):
    """Mampara de cristal: perfiles metálicos y vidrio tintado con reflejos."""
    for y in range(y0, y1 + 1):
        L.p(x0, y, TINTA)
        L.p(x0 + 1, y, METAL[0])
        L.p(x1 - 1, y, METAL[2])
        L.p(x1, y, TINTA)
        for x in range(x0 + 2, x1 - 1):
            L.p(x, y, c("#d4eef8", 150))
            if (y - x) % 22 in (0, 1):
                L.p(x, y, c("#ffffff", 200))


def dibujar_cristal_horizontal(L, x0, x1, y0, y1):
    L.rect(x0, y0, x1, y0, TINTA)
    L.rect(x0, y0 + 1, x1, y0 + 1, METAL[0])
    for y in range(y0 + 2, y1 + 1):
        for x in range(x0, x1 + 1):
            L.p(x, y, c("#d4eef8", 140))
            if (x + y) % 26 in (0, 1):
                L.p(x, y, c("#ffffff", 190))


def dibujar_alfombra(L, x0, y0, x1, y1):
    L.rect(x0, y0, x1, y1, c("#3d5aa8"))
    L.rect(x0, y1, x1, y1, c("#2f4a8f"))
    L.rect(x0 + 2, y0 + 2, x1 - 2, y1 - 2, c("#5b7fd1"))
    L.rect(x0 + 3, y0 + 3, x1 - 3, y0 + 3, c("#7fa0e6"))
    L.rect(x0 + 3, y0 + 3, x0 + 3, y1 - 3, c("#7fa0e6"))
    L.rect(x0 + 3, y1 - 3, x1 - 3, y1 - 3, c("#4a6cc0"))
    L.rect(x1 - 3, y0 + 3, x1 - 3, y1 - 3, c("#4a6cc0"))
    # rombos
    for y in range(y0 + 8, y1 - 6, 10):
        for x in range(x0 + 9, x1 - 6, 12):
            for dx, dy in ((0, -1), (-1, 0), (1, 0), (0, 1)):
                L.p(x + dx, y + dy, c("#7fa0e6"))
    # flecos
    for x in range(x0 + 1, x1, 2):
        L.p(x, y0 - 1, c("#e8dcc6"))
        L.p(x, y1 + 1, c("#e8dcc6"))


def dibujar_escritorio(fondo, frente, fx, fy, ancho, tablero, cara, taza):
    """Escritorio cuyo robot pisa en (fx, fy). El tablero va al fondo; el frente, monitor y taza a la capa
    `frente`, que la escena pinta encima del robot (tapa piernas y pies: filas 32-39 del sprite)."""
    x0 = fx - ancho // 2
    x1 = x0 + ancho - 1
    # --- fondo: sombra en el suelo y tablero ---
    fondo.oscurecer(x0 + 1, fy, x1 - 1, fy + 5, 0.78)
    fondo.oscurecer(x0 + 3, fy + 6, x1 - 3, fy + 6, 0.9)
    fondo.caja(x0, fy - 13, x1, fy - 8, tablero, 0)
    fondo.rect(x0 + 1, fy - 12, x1 - 1, fy - 12, tablero[0])
    # papeles sobre el tablero
    fondo.rect(fx + 8, fy - 11, fx + 13, fy - 9, c("#fbfaf6"))
    fondo.rect(fx + 8, fy - 9, fx + 13, fy - 9, c("#dedbd0"))
    # --- frente: canto, cara con cajón y patas ---
    frente.rect(x0, fy - 8, x1, fy - 8, TINTA)
    frente.rect(x0 + 1, fy - 8, x1 - 1, fy - 8, tablero[0])  # canto iluminado
    frente.caja(x0, fy - 7, x1, fy + 1, cara, 0)
    frente.rect(x0, fy - 8, x0, fy - 8, TINTA)
    frente.rect(x1, fy - 8, x1, fy - 8, TINTA)
    cx0, cx1 = x1 - 16, x1 - 3
    frente.rect(cx0, fy - 5, cx1, fy - 5, oscuro(cara[2], 0.8))
    frente.rect(cx0, fy - 5, cx0, fy - 1, oscuro(cara[2], 0.8))
    frente.rect((cx0 + cx1) // 2 - 2, fy - 3, (cx0 + cx1) // 2 + 2, fy - 3, METAL[0])
    frente.rect(x0 + 3, fy - 5, x0 + 10, fy - 5, cara[0])
    for lx in (x0 + 1, x1 - 4):
        frente.caja(lx, fy + 1, lx + 3, fy + 5, cara, 0)
    # --- monitor visto de espaldas (a la izquierda, sin tapar al robot) ---
    mx0, mx1 = fx - 24, fx - 13
    frente.caja(mx0, fy - 25, mx1, fy - 14, MONITOR, 1)
    for vy in (fy - 22, fy - 20, fy - 18):  # rejilla de ventilación
        frente.rect(mx0 + 3, vy, mx1 - 3, vy, MONITOR[2])
    frente.p(mx1 - 2, fy - 16, c("#5fd38d"))  # piloto
    frente.rect((mx0 + mx1) // 2 - 1, fy - 14, (mx0 + mx1) // 2 + 1, fy - 11, TINTA)
    frente.rect((mx0 + mx1) // 2, fy - 13, (mx0 + mx1) // 2, fy - 11, MONITOR[1])
    frente.caja((mx0 + mx1) // 2 - 4, fy - 11, (mx0 + mx1) // 2 + 4, fy - 9, MONITOR, 0)
    # --- taza (a la derecha) ---
    tx = fx + 15
    frente.caja(tx, fy - 14, tx + 4, fy - 9, (aclarar(taza, 0.35), taza, oscuro(taza, 0.7)), 0)
    frente.rect(tx + 1, fy - 13, tx + 3, fy - 13, c("#5a3a26"))  # café
    frente.p(tx + 5, fy - 13, TINTA)
    frente.p(tx + 6, fy - 12, TINTA)
    frente.p(tx + 5, fy - 11, TINTA)
    frente.p(tx + 2, fy - 16, c("#ffffff", 120))  # vapor
    frente.p(tx + 3, fy - 17, c("#ffffff", 90))


def dibujar_oficina():
    rng = random.Random(16)
    fondo = Lienzo(OFI_W, OFI_H)
    frente = Lienzo(OFI_W, OFI_H)
    dibujar_pared(fondo)
    dibujar_suelo(fondo, rng)

    # --- despacho de cristal del jefe (x 0..97) ---
    dibujar_estanteria(fondo, 4, 18, 29, 70, rng)
    dibujar_cartel_jefe(fondo, JEFE[0], 9)
    dibujar_cuadro(fondo, 36, 28, 56, 44)
    dibujar_planta(fondo, 64, 72)
    dibujar_alfombra(fondo, 6, 100, 86, 170)
    dibujar_cristal_vertical(fondo, 90, 97, 0, OFI_H - 1)
    dibujar_cristal_horizontal(fondo, 0, 89, 174, OFI_H - 1)
    fondo.rect(0, 0, 97, 3, METAL[1])  # perfil superior de la mampara
    fondo.rect(0, 3, 97, 3, TINTA)

    # --- sala principal ---
    dibujar_ventana(fondo, 104, 11)
    dibujar_reloj(fondo, 152, 22)
    dibujar_pizarra(fondo, 166, 8, 232, 50, rng)
    dibujar_ventana(fondo, 240, 11)
    dibujar_dispensador(fondo, 300, 71)

    # --- escritorios ---
    dibujar_escritorio(fondo, frente, JEFE[0], JEFE[1], JEFE_W, TABLERO_JEFE, FRENTE_JEFE, ORO[1])
    for i, (fx, fy) in enumerate(ESCRITORIOS):
        dibujar_escritorio(fondo, frente, fx, fy, DESK_W, TABLERO, FRENTE, TAZAS[i % len(TAZAS)])
    return fondo, frente


def datos_oficina():
    return {
        "size": {"w": OFI_W, "h": OFI_H},
        "tile": 16,
        "scale": 3,
        "nota": "Puntos = donde apoyan los pies del robot (ancla abajo-centro), en px lógicos.",
        "desks": [{"x": x, "y": y} for x, y in ESCRITORIOS],
        "boss": {"x": JEFE[0], "y": JEFE[1]},
        "bossZone": {"x": 0, "y": SUELO_Y, "w": 90, "h": OFI_H - SUELO_Y},
        "standing": [{"x": x, "y": y} for x, y in DE_PIE],
        "robot": {"w": ROBOT_W, "h": ROBOT_H, "anchor": {"x": 0.5, "y": 1}},
        "layers": {"background": "oficina.png", "front": "oficina-frente.png"},
    }


# ---------------------------------------------------------------------------------------------------------------
# Hoja de contacto (solo para revisar; no se usa en la app)
# ---------------------------------------------------------------------------------------------------------------

def ampliar(img, k):
    return img.resize((img.width * k, img.height * k), Image.NEAREST)


def hoja_contacto(hojas, fondo, frente):
    os.makedirs(SALIDA_CONTACTO, exist_ok=True)
    gris = (138, 143, 158, 255)
    # 1) Cada robot ×6: una fila por animación (6 filas × 6 columnas)
    bloques = []
    for nombre, hoja in hojas:
        b = ampliar(hoja, 6)
        lienzo = Image.new("RGBA", (b.width + 12, b.height + 30), gris)
        lienzo.alpha_composite(b, (6, 24))
        ImageDraw.Draw(lienzo).text((8, 6), f"{nombre}  x6", fill=(255, 255, 255, 255))
        lienzo.save(os.path.join(SALIDA_CONTACTO, f"{nombre}-x6.png"))
        bloques.append(lienzo)
    # 2) Fila de todos los robots ×3 (primer fotograma de cada estado)
    fila3 = Image.new("RGBA", (len(hojas) * 6 * ROBOT_W * 3 + 12, ROBOT_H * 3 + 12), c("#e8dcc6"))
    for i, (_, hoja) in enumerate(hojas):
        for j, (anim, _) in enumerate(ANIMACIONES):
            fr = hoja.crop((0, j * ROBOT_H, ROBOT_W, (j + 1) * ROBOT_H))
            fila3.alpha_composite(ampliar(fr, 3), (6 + (i * 6 + j) * ROBOT_W * 3, 6))
    # 3) Oficina ×3 con robots en sus sitios y la capa de frente encima
    escena = fondo.img.copy()
    estados = ["writing", "thinking", "idle", "needs_you", "error", "done"]
    paletas = ["azul", "verde", "crema", "terracota", "azul", "verde"]
    hoja_de = dict(hojas)
    def poner(hoja, anim, f, x, y):
        j = [a for a, _ in ANIMACIONES].index(anim)
        fr = hoja.crop((f * ROBOT_W, j * ROBOT_H, (f + 1) * ROBOT_W, (j + 1) * ROBOT_H))
        escena.alpha_composite(fr, (x - ROBOT_W // 2, y - ROBOT_H))
    poner(hoja_de["robot-terracota-jefe"], "idle", 0, *JEFE)
    for i, (x, y) in enumerate(ESCRITORIOS):
        poner(hoja_de[f"robot-{paletas[i]}"], estados[i], 1 if estados[i] in ("writing", "done") else 0, x, y)
    poner(hoja_de["robot-crema"], "idle", 0, *DE_PIE[0])
    poner(hoja_de["robot-terracota"], "thinking", 2, *DE_PIE[2])
    escena.alpha_composite(frente.img)
    oficina3 = ampliar(escena, 3)
    oficina3.save(os.path.join(SALIDA_CONTACTO, "oficina-x3.png"))

    ancho = max(max(b.width for b in bloques) * 2 + 12, fila3.width, oficina3.width)
    alto_robots = sum(b.height for b in bloques[::2]) + 12
    total = Image.new("RGBA", (ancho, alto_robots + fila3.height + oficina3.height + 24), (40, 38, 52, 255))
    x, y = 0, 0
    for i, b in enumerate(bloques):
        total.alpha_composite(b, (x, y))
        if i % 2 == 0:
            x = b.width + 12
        else:
            x, y = 0, y + b.height + 6
    y = alto_robots if len(bloques) % 2 == 0 else y + bloques[-1].height + 6
    total.alpha_composite(fila3, (0, y))
    total.alpha_composite(oficina3, (0, y + fila3.height + 12))
    total.save(os.path.join(SALIDA_CONTACTO, "contacto.png"))


# ---------------------------------------------------------------------------------------------------------------

def main():
    os.makedirs(DESTINO, exist_ok=True)
    hojas = []
    variantes = [(p, False) for p in PALETAS] + [("terracota", True)]
    for paleta, jefe in variantes:
        nombre = f"robot-{paleta}" + ("-jefe" if jefe else "")
        hoja, frames, anims = hoja_robot(paleta, jefe)
        hoja.save(os.path.join(DESTINO, nombre + ".png"), optimize=True)
        datos = {
            "frames": frames,
            "animations": anims,
            "meta": {
                "app": "kiji-office tools/sprites/gen.py",
                "version": "1",
                "image": nombre + ".png",
                "format": "RGBA8888",
                "size": {"w": hoja.width, "h": hoja.height},
                "scale": "1",
            },
        }
        with open(os.path.join(DESTINO, nombre + ".json"), "w") as fh:
            json.dump(datos, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        hojas.append((nombre, hoja))

    fondo, frente = dibujar_oficina()
    fondo.img.save(os.path.join(DESTINO, "oficina.png"), optimize=True)
    frente.img.save(os.path.join(DESTINO, "oficina-frente.png"), optimize=True)
    with open(os.path.join(DESTINO, "oficina.json"), "w") as fh:
        json.dump(datos_oficina(), fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    hoja_contacto(hojas, fondo, frente)
    print(f"Sprites escritos en {os.path.relpath(DESTINO, RAIZ)}; contacto en "
          f"{os.path.relpath(SALIDA_CONTACTO, RAIZ)}/contacto.png")


if __name__ == "__main__":
    main()
