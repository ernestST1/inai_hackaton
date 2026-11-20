"""map_builder.py (участник №3): HTML-карта покрытия на folium.

Единственная точка входа для main.py:

    build_map(cells, towers, candidates, bounds, result, out_html,
              heat_points=None, extra=None)

Вход (все поля, кроме обязательных, необязательны, карта не падает без них):
  cells       список dict из grid.py:
                cell_id        "X006_Y013"            (обязательно)
                rsrp_median    float                  (обязательно)
                count          int
                bounds_latlon  [[lat_sw, lon_sw], [lat_ne, lon_ne]]  (иначе считаю по cell_id)
                color          "green"|"yellow"|"red"                (иначе считаю по медиане)
                rsrp_median_day, rsrp_median_night  float | None     (для слоёв «День»/«Ночь»)
  towers      список dict {id, lat, lon}  (или pandas.DataFrame)
  candidates  список dict {id, lat, lon}  (или pandas.DataFrame)
  bounds      dict из bounds.json
  result      dict: worst_cells [{cell_id, rsrp_median}], best_candidates [2 id],
              dropped_rows, covered_weak_cells
  heat_points список (lat, lon, rsrp_dbm) очищенных замеров, для «Тепловой карты»
  extra       dict (необязательно) от optimizer.py:
                greedy_pair [id, id], greedy_covered int,
                covered_cell_ids [cell_id, ...]  (красные клетки, покрытые лучшей парой)
"""
from __future__ import annotations

import math
import re

import folium
from folium.plugins import HeatMap

R_EARTH = 6371000.0
CELL_M = 200.0
GREEN_MIN, YELLOW_MIN = -90.0, -105.0
COLORS = {"green": "#2ecc71", "yellow": "#f1c40f", "red": "#e74c3c"}
COLOR_RU = {"green": "зелёный", "yellow": "жёлтый", "red": "красный"}


# ---------------------------------------------------------------- геометрия
def haversine_m(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(a))


def _xy_to_latlon(x, y, lat0, lon0):
    """Обратное преобразование локальной равнопромежуточной модели (CLARIFICATIONS п.7)."""
    lat = lat0 + math.degrees(y / R_EARTH)
    lon = lon0 + math.degrees(x / (R_EARTH * math.cos(math.radians(lat0))))
    return lat, lon


def cell_bounds_from_id(cell_id, bounds):
    """[[lat_sw, lon_sw], [lat_ne, lon_ne]] по cell_id вида X006_Y013."""
    m = re.fullmatch(r"X(-?\d+)_Y(-?\d+)", cell_id)
    if not m:
        return None
    ix, iy = int(m.group(1)), int(m.group(2))
    lat0 = bounds.get("grid_origin_lat", bounds["lat_min"])
    lon0 = bounds.get("grid_origin_lon", bounds["lon_min"])
    size = float(bounds.get("cell_size_m", CELL_M))
    sw = _xy_to_latlon(ix * size, iy * size, lat0, lon0)
    ne = _xy_to_latlon((ix + 1) * size, (iy + 1) * size, lat0, lon0)
    return [list(sw), list(ne)]


def color_of(rsrp):
    if rsrp >= GREEN_MIN:
        return "green"
    if rsrp >= YELLOW_MIN:
        return "yellow"
    return "red"


def _rows(obj):
    """list[dict] или DataFrame -> list[dict]."""
    if obj is None:
        return []
    if hasattr(obj, "to_dict"):
        return obj.to_dict("records")
    return list(obj)


def _valid(v):
    return v is not None and not (isinstance(v, float) and math.isnan(v))


# ---------------------------------------------------------------- слои
def _grid_layer(name, cells, bounds, value_key, show, highlight_ids=()):
    fg = folium.FeatureGroup(name=name, show=show)
    for c in cells:
        val = c.get(value_key)
        if not _valid(val):
            continue
        bl = c.get("bounds_latlon") or cell_bounds_from_id(c["cell_id"], bounds)
        if bl is None:
            continue
        col = color_of(val) if value_key != "rsrp_median" else (c.get("color") or color_of(val))
        popup = (
            f"<b>{c['cell_id']}</b><br>"
            f"Медиана RSRP: {val:.2f} дБм<br>"
            f"Замеров: {c.get('count', '—')}<br>"
            f"Статус: {COLOR_RU[col]}"
        )
        folium.Rectangle(
            bounds=bl,
            color=COLORS[col],
            weight=1,
            fill=True,
            fill_color=COLORS[col],
            fill_opacity=0.45,
            tooltip=f"{c['cell_id']}: {val:.1f} дБм",
            popup=folium.Popup(popup, max_width=240),
        ).add_to(fg)
    return fg


def _worst_layer(worst, cells_by_id, bounds):
    fg = folium.FeatureGroup(name="Худшие 3 квадрата", show=True)
    for rank, w in enumerate(worst, 1):
        cid = w["cell_id"]
        c = cells_by_id.get(cid, {})
        bl = c.get("bounds_latlon") or cell_bounds_from_id(cid, bounds)
        if bl is None:
            continue
        folium.Rectangle(
            bounds=bl, color="#000000", weight=4, fill=False,
            tooltip=f"№{rank} худший: {cid}, {w['rsrp_median']} дБм",
        ).add_to(fg)
        folium.Marker(
            [(bl[0][0] + bl[1][0]) / 2, (bl[0][1] + bl[1][1]) / 2],
            icon=folium.DivIcon(
                html=f'<div style="font:bold 14px sans-serif;color:#000;'
                     f'text-shadow:0 0 3px #fff,0 0 3px #fff">#{rank}</div>',
                icon_size=(24, 18), icon_anchor=(12, 9)),
        ).add_to(fg)
    return fg


def _towers_layer(towers):
    fg = folium.FeatureGroup(name="Базовые станции", show=True)
    for t in towers:
        folium.Marker(
            [t["lat"], t["lon"]], tooltip=f"БС {t['id']}",
            icon=folium.Icon(color="blue", icon="signal", prefix="glyphicon"),
        ).add_to(fg)
        folium.Circle(
            [t["lat"], t["lon"]], radius=500, color="#2980b9", weight=1.5,
            dash_array="6", fill=True, fill_opacity=0.05,
            tooltip=f"Запретная зона 500 м вокруг {t['id']}",
        ).add_to(fg)
    return fg


def _candidates_layer(candidates, towers, best, greedy):
    fg = folium.FeatureGroup(name="Кандидаты", show=True)
    for c in candidates:
        cid = c["id"]
        dmin = min((haversine_m(c["lat"], c["lon"], t["lat"], t["lon"]) for t in towers),
                   default=float("inf"))
        forbidden = dmin < 500
        if cid in best:
            color, status = "green", "ЛУЧШАЯ ПАРА"
        elif forbidden:
            color, status = "gray", f"недопустима (до БС {dmin:.0f} м < 500 м)"
        else:
            color, status = "orange", "допустима"
        extra_txt = " · жадный выбор" if cid in greedy else ""
        folium.Marker(
            [c["lat"], c["lon"]],
            tooltip=f"{cid}: {status}{extra_txt}",
            popup=folium.Popup(f"<b>{cid}</b><br>{status}{extra_txt}<br>до ближайшей БС: {dmin:.0f} м",
                               max_width=260),
            icon=folium.Icon(color=color, icon="star" if cid in best else "flag", prefix="glyphicon"),
        ).add_to(fg)
    return fg


def _best_pair_layer(candidates, best):
    fg = folium.FeatureGroup(name="Радиусы лучшей пары (1 км)", show=True)
    by_id = {c["id"]: c for c in candidates}
    for cid in best:
        c = by_id.get(cid)
        if not c:
            continue
        folium.Circle(
            [c["lat"], c["lon"]], radius=1000, color="#27ae60", weight=2,
            fill=True, fill_opacity=0.08, tooltip=f"Покрытие 1 км: {cid}",
        ).add_to(fg)
    return fg


def _heat_layer(points):
    fg = folium.FeatureGroup(name="Тепловая карта", show=False)
    data = []
    for lat, lon, rsrp in points:
        if not (_valid(rsrp) and _valid(lat) and _valid(lon)):
            continue
        w = min(1.0, max(0.0, (-rsrp - 70.0) / 60.0))  # -70 дБм -> 0, -130 дБм -> 1 (хуже = горячее)
        data.append([lat, lon, w])
    if data:
        HeatMap(data, radius=14, blur=18, min_opacity=0.25).add_to(fg)
    return fg


# ---------------------------------------------------------------- панель и легенда
def _panel_html(result, extra, n_cells, n_red):
    best = result.get("best_candidates", [])
    gp = extra.get("greedy_pair")
    gc = extra.get("greedy_covered")
    bc = result.get("covered_weak_cells")
    rows = [
        f"<tr><td>Отброшено строк</td><td><b>{result.get('dropped_rows', '—')}</b></td></tr>",
        f"<tr><td>Квадратов в анализе</td><td><b>{n_cells}</b></td></tr>",
        f"<tr><td>Красных квадратов</td><td><b>{n_red}</b></td></tr>",
        f"<tr><td>Лучшая пара (перебор)</td><td><b>{' + '.join(best) or '—'}</b></td></tr>",
        f"<tr><td>Покрыто красных</td><td><b>{bc if bc is not None else '—'}</b></td></tr>",
    ]
    if gp:
        diff = (bc - gc) if (bc is not None and gc is not None) else None
        rows.append(f"<tr><td>Жадный алгоритм</td><td><b>{' + '.join(gp)}</b>"
                    f"{f' ({gc})' if gc is not None else ''}</td></tr>")
        if diff is not None:
            rows.append(f"<tr><td>Перебор лучше жадного на</td><td><b>{diff}</b></td></tr>")
    worst = "".join(
        f"<li>{w['cell_id']}: {w['rsrp_median']} дБм</li>" for w in result.get("worst_cells", [])
    )
    return f"""
<div style="position:fixed;bottom:24px;left:12px;z-index:9999;background:rgba(255,255,255,.95);
  padding:10px 12px;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,.35);
  font:12px/1.35 sans-serif;max-width:290px;color:#222">
  <div style="font-weight:bold;font-size:13px;margin-bottom:4px">Карта покрытия, Бишкек</div>
  <div><span style="background:{COLORS['green']};padding:0 8px;opacity:.7">&nbsp;</span> ≥ −90 дБм</div>
  <div><span style="background:{COLORS['yellow']};padding:0 8px;opacity:.7">&nbsp;</span> −105 … −90 дБм</div>
  <div><span style="background:{COLORS['red']};padding:0 8px;opacity:.7">&nbsp;</span> &lt; −105 дБм (слабая зона)</div>
  <div style="margin-top:3px"><span style="border:2px solid #000;padding:0 6px">&nbsp;</span> худшие 3 квадрата</div>
  <table style="margin-top:6px;border-collapse:collapse">{''.join(rows)}</table>
  <div style="margin-top:4px"><b>Топ-3 худших:</b><ul style="margin:2px 0 0 16px;padding:0">{worst}</ul></div>
</div>"""


# ---------------------------------------------------------------- точка входа
def build_map(cells, towers, candidates, bounds, result, out_html,
              heat_points=None, extra=None):
    cells = _rows(cells)
    towers = _rows(towers)
    candidates = _rows(candidates)
    extra = extra or {}
    best = list(result.get("best_candidates", []))
    greedy = list(extra.get("greedy_pair") or [])

    center = [(bounds["lat_min"] + bounds["lat_max"]) / 2,
              (bounds["lon_min"] + bounds["lon_max"]) / 2]
    m = folium.Map(location=center, zoom_start=13, tiles="OpenStreetMap", control_scale=True)

    # рамка района
    folium.Rectangle(
        [[bounds["lat_min"], bounds["lon_min"]], [bounds["lat_max"], bounds["lon_max"]]],
        color="#555", weight=2, dash_array="4", fill=False, tooltip="Границы района",
    ).add_to(m)

    cells_by_id = {c["cell_id"]: c for c in cells}
    n_red = sum(1 for c in cells if _valid(c.get("rsrp_median")) and color_of(c["rsrp_median"]) == "red")

    _grid_layer("Общая сетка", cells, bounds, "rsrp_median", True).add_to(m)
    _grid_layer("День", cells, bounds, "rsrp_median_day", False).add_to(m)
    _grid_layer("Ночь", cells, bounds, "rsrp_median_night", False).add_to(m)
    _heat_layer(heat_points or []).add_to(m)
    _worst_layer(result.get("worst_cells", []), cells_by_id, bounds).add_to(m)
    _towers_layer(towers).add_to(m)
    _candidates_layer(candidates, towers, best, greedy).add_to(m)
    _best_pair_layer(candidates, best).add_to(m)

    # красные клетки, покрытые лучшей парой: чёрные точки в центрах
    covered_ids = extra.get("covered_cell_ids") or []
    if covered_ids:
        fg = folium.FeatureGroup(name="Покрытые красные клетки", show=False)
        for cid in covered_ids:
            c = cells_by_id.get(cid, {})
            bl = c.get("bounds_latlon") or cell_bounds_from_id(cid, bounds)
            if bl:
                folium.CircleMarker([(bl[0][0] + bl[1][0]) / 2, (bl[0][1] + bl[1][1]) / 2],
                                    radius=3, color="#222", fill=True, fill_opacity=1,
                                    tooltip=cid).add_to(fg)
        fg.add_to(m)

    m.get_root().html.add_child(folium.Element(_panel_html(result, extra, len(cells), n_red)))
    folium.LayerControl(collapsed=False).add_to(m)
    m.fit_bounds([[bounds["lat_min"], bounds["lon_min"]], [bounds["lat_max"], bounds["lon_max"]]])
    m.save(out_html)
    return out_html


# ---------------------------------------------------------------- демо на заглушках
if __name__ == "__main__":
    import csv
    import json
    import random
    import sys

    folder = sys.argv[1] if len(sys.argv) > 1 else "."
    b = json.load(open(f"{folder}/bounds.json"))
    rd = lambda n: list(csv.DictReader(open(f"{folder}/{n}", encoding="utf-8")))
    tw = [{"id": r["id"], "lat": float(r["lat"]), "lon": float(r["lon"])} for r in rd("towers.csv")]
    cd = [{"id": r["id"], "lat": float(r["lat"]), "lon": float(r["lon"])} for r in rd("candidates.csv")]

    random.seed(1)
    fake = []
    for ix in range(0, 24):
        for iy in range(0, 20):
            v = random.uniform(-130, -70)
            fake.append({"cell_id": f"X{ix:03d}_Y{iy:03d}", "rsrp_median": round(v, 2),
                         "count": random.randint(5, 20),
                         "rsrp_median_day": round(v + 3, 2), "rsrp_median_night": round(v - 3, 2)})
    res = {"worst_cells": [{"cell_id": "X006_Y013", "rsrp_median": -124.5}],
           "best_candidates": ["C09", "C14"], "dropped_rows": 200, "covered_weak_cells": 111}
    heat = [(random.uniform(b["lat_min"], b["lat_max"]), random.uniform(b["lon_min"], b["lon_max"]),
             random.uniform(-130, -70)) for _ in range(800)]
    build_map(fake, tw, cd, b, res, "map_demo.html", heat,
              {"greedy_pair": ["C09", "C11"], "greedy_covered": 105})
    print("map_demo.html готов")