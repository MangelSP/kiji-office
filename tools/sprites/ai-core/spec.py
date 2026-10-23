# Genera spec.json (cuadrículas por frame) para el núcleo de IA de la pantalla de inicio. Lo pinta Pixelorama:
#   python3 spec.py && cli-anything-pixelorama -p ai-core.pxo draw paint --spec spec.json
import json, math
N, F, C = 24, 8, 11.5
legend = {"o": "#1a1c2c", "d": "#3a2f6b", "m": "#7a5cff", "l": "#c8b8ff", "w": "#ffffff",
          "h": "#2a2550", "t": "#F0A184", "T": "#D97757", "b": "#8FB0FF", "B": "#4A7DFF",
          "g": "#7FDCBC", "G": "#2FB38A", "y": "#ffd34d"}
frames = []
for f in range(F):
    g = [["." for _ in range(N)] for _ in range(N)]
    pulse = 1 if f % 4 in (1, 2) else 0
    for y in range(N):
        for x in range(N):
            r = math.hypot(x - C, y - C)
            if 8.6 <= r < 9.4 and (x + y + f) % 3 == 0: g[y][x] = "h"      # halo punteado que gira
            if r < 5.6 + pulse * 0.6:
                lx, ly = x - C + 1.6, y - C + 1.6                          # luz arriba-izquierda
                lr = math.hypot(lx, ly)
                g[y][x] = "w" if lr < 1.3 else "l" if lr < 2.8 else "m" if r < 4.2 + pulse * 0.6 else "d"
            elif r < 6.5 + pulse * 0.6:
                g[y][x] = "o"
    for i, (c1, c2) in enumerate([("t", "T"), ("b", "B"), ("g", "G")]):  # Claude, Gemini, OpenAI
        a = f * (2 * math.pi / F) + i * 2 * math.pi / 3
        sx, sy = round(C + 9 * math.cos(a)), round(C + 9 * math.sin(a) * 0.8)
        for dx, dy, ch in [(0, 0, c1), (1, 0, c2), (0, 1, c2), (1, 1, c2), (0, -1, "o"), (-1, 0, "o"), (2, 0, "o"), (0, 2, "o")]:
            X, Y = sx + dx, sy + dy
            if 0 <= X < N and 0 <= Y < N and (ch != "o" or g[Y][X] == "."): g[Y][X] = ch
    if pulse: g[int(C) - 2][int(C) + 2] = "y"                                # destello del pensamiento
    frames.append({"frame": f, "grid": ["".join(r) for r in g]})
json.dump({"legend": legend, "layer": 0, "x": 0, "y": 0, "clear": True, "frames": frames}, open("spec.json", "w"))
