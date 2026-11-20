"""Karta12.py — полный конвейер в ОДНОМ файле: очистка -> сетка -> медианы
-> выбор пары БС -> HTML-карта folium. Внешних модулей кроме pandas/numpy/folium не нужно.

Запуск:  python Karta12.py .        (папка с bounds.json, measurements.csv,
                                      towers.csv, candidates.csv, expected.json)
"""

from __future__ import annotations
import itertools, json, math, re, sys, os

import numpy as np
import pandas as pd
import folium
from folium.plugins import HeatMap

# ----------------------------- настройки -----------------------------
FOLDER = sys.argv[1] if len(sys.argv) > 1 else "."
RSRP_MIN, RSRP_MAX = -140.0, -44.0
GREEN_MIN, YELLOW_MIN = -90.0, -105.0          # >= -90 зелёный, -105..-90 жёлтый, < -105 красный
DAY_HOURS = range(6, 22)                        # день 06:00–22:00, ночь остальное
MIN_MEAS = 5                                    # клетки с <5 замерами не учитываются
COVER_RADIUS_M = 1000.0                         # радиус покрытия кандидата
FORBIDDEN_M = 500.0                             # запретная зона вокруг действующих БС
COLORS = {"green": "#2ecc71", "yellow": "#f1c40f", "red": "#e74c3c"}
COLOR_RU = {"green": "зелёный", "yellow": "жёлтый", "red": "красный"}


# ----------------------------- геометрия -----------------------------
def haversine_m(lat1, lon1, lat2, lon2, R=6371000.0):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def color_of(rsrp):
    if rsrp >= GREEN_MIN:
        return "green"
    if rsrp >= YELLOW_MIN:
        return "yellow"
    return "red"


def cell_bounds(ix, iy, b):
    """[[lat_sw, lon_sw], [lat_ne, lon_ne]] ячейки сетки 200 м."""
    R, S = b["earth_radius_m"], b["cell_size_m"]
    lat0, lon0 = b["grid_origin_lat"], b["grid_origin_lon"]
    def xy2ll(px, py):
        return [lat0 + math.degrees(py / R),
                lon0 + math.degrees(px / (R * math.cos(math.radians(lat0))))]
    return [xy2ll(ix * S, iy * S), xy2ll((ix + 1) * S, (iy + 1) * S)]


# ----------------------------- 1. очистка -----------------------------
def load_clean():
    b = json.load(open(os.path.join(FOLDER, "bounds.json"), encoding="utf-8"))
    df = pd.read_csv(os.path.join(FOLDER, "measurements.csv"))
    n0 = len(df)
    for c in ("lat", "lon", "rsrp_dbm"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    df = df.dropna(subset=["lat", "lon", "rsrp_dbm", "timestamp"])
    df = df[(df.rsrp_dbm.between(RSRP_MIN, RSRP_MAX))
            & (df.lat.between(b["lat_min"], b["lat_max"]))
            & (df.lon.between(b["lon_min"], b["lon_max"]))]
    # дедупликация по ВСЕМ 4 полям (ТЗ)
    df = df.drop_duplicates(subset=["lat", "lon", "rsrp_dbm", "timestamp"])
    print(f"очистка: {n0} -> {len(df)} строк (отброшено {n0 - len(df)})")
    return df, b


# ----------------------------- 2. сетка -----------------------------
def to_cells(df, b):
    R, S = b["earth_radius_m"], b["cell_size_m"]
    lat0, lon0 = b["grid_origin_lat"], b["grid_origin_lon"]
    k = math.radians(1) * R
    x = (df.lon - lon0) * k * math.cos(math.radians(lat0))
    y = (df.lat - lat0) * k
    df = df.assign(ix=np.floor(x / S).astype(int), iy=np.floor(y / S).astype(int))
    df["cell_id"] = df.apply(lambda r: f"X{r.ix:03d}_Y{r.iy:03d}", axis=1)

    hour = df.timestamp.dt.hour
    day = df[hour.isin(DAY_HOURS)].groupby("cell_id").rsrp_dbm.median()
    night = df[~hour.isin(DAY_HOURS)].groupby("cell_id").rsrp_dbm.median()

    g = df.groupby("cell_id").rsrp_dbm.agg(median="median", count="count")
    n_cells_all = len(g)
    g = g[g["count"] >= MIN_MEAS]                      # малые клетки не учитываются
    print(f"клеток с замерами: {n_cells_all}, в анализе (>= {MIN_MEAS} замеров): {len(g)}")

    cells = []
    for cid, r in g.iterrows():
        m = re.fullmatch(r"X(-?\d+)_Y(-?\d+)", cid)
        bl = cell_bounds(int(m.group(1)), int(m.group(2)), b)
        med = round(float(r["median"]), 2)
        cells.append({"cell_id": cid, "rsrp_median": med, "count": int(r["count"]),
                      "bounds_latlon": bl, "color": color_of(med),
                      "rsrp_median_day": None if pd.isna(day.get(cid)) else round(float(day[cid]), 2),
                      "rsrp_median_night": None if pd.isna(night.get(cid)) else round(float(night[cid]), 2)})
    return cells


# ----------------------------- 3. оптимизация -----------------------------
def optimize(cells, candidates, towers, b):
    red = [c for c in cells if c["color"] == "red"]
    ok = [c for c in candidates
          if min(haversine_m(c["lat"], c["lon"], t["lat"], t["lon"], b["earth_radius_m"])
                 for t in towers) >= FORBIDDEN_M]

    def covered_count(ids):
        pts = [c for c in ok if c["id"] in ids]
        n = 0
        for c in red:
            la = (c["bounds_latlon"][0][0] + c["bounds_latlon"][1][0]) / 2
            lo = (c["bounds_latlon"][0][1] + c["bounds_latlon"][1][1]) / 2
            if any(haversine_m(la, lo, p["lat"], p["lon"], b["earth_radius_m"]) <= COVER_RADIUS_M
                   for p in pts):
                n += 1
        return n

    ids = [c["id"] for c in ok]
    best, best_n = None, -1
    for pair in itertools.combinations(ids, 2):
        n = covered_count(pair)
        if n > best_n:
            best, best_n = list(pair), n
    g1 = max(ids, key=lambda i: covered_count([i]))
    g2 = max([i for i in ids if i != g1], key=lambda i: covered_count([g1, i]))
    greedy_n = covered_count([g1, g2])

    cov_ids = []
    pts = [c for c in ok if c["id"] in best]
    for c in red:
        la = (c["bounds_latlon"][0][0] + c["bounds_latlon"][1][0]) / 2
        lo = (c["bounds_latlon"][0][1] + c["bounds_latlon"][1][1]) / 2
        if any(haversine_m(la, lo, p["lat"], p["lon"], b["earth_radius_m"]) <= COVER_RADIUS_M
               for p in pts):
            cov_ids.append(c["cell_id"])
    return best, best_n, [g1, g2], greedy_n, cov_ids, ok


# ----------------------------- 4. карта -----------------------------
def grid_layer(name, cells, value_key, show):
    fg = folium.FeatureGroup(name=name, show=show)
    for c in cells:
        v = c.get(value_key)
        if v is None:
            continue
        col = c["color"] if value_key == "rsrp_median" else color_of(v)
        folium.Rectangle(
            bounds=c["bounds_latlon"], color=COLORS[col], weight=1,
            fill=True, fill_color=COLORS[col], fill_opacity=0.45,
            tooltip=f"{c['cell_id']}: {v:.1f} дБм",
            popup=folium.Popup(
                f"<b>{c['cell_id']}</b><br>Медиана RSRP: {v:.2f} дБм<br>"
                f"Замеров: {c['count']}<br>Статус: {COLOR_RU[col]}", max_width=240),
        ).add_to(fg)
    return fg


def heat_layer(df):
    fg = folium.FeatureGroup(name="Тепловая карта", show=False)
    w = np.clip((-df.rsrp_dbm.values - 60.0) / 75.0, 0.05, 1.0)  # -60 -> 0.05, -135 -> 1.0
    data = [[la, lo, wi] for la, lo, wi in zip(df.lat, df.lon, w)]
    HeatMap(data, radius=14, blur=18, min_opacity=0.25,
            gradient={0.0: "#2ecc71", 0.4: "#f1c40f", 0.7: "#e67e22", 1.0: "#c0392b"}).add_to(fg)
    return fg


def build_map(cells, towers, candidates, b, result, extra, df, out_html):
    center = [(b["lat_min"] + b["lat_max"]) / 2, (b["lon_min"] + b["lon_max"]) / 2]
    m = folium.Map(location=center, zoom_start=13, tiles="OpenStreetMap", control_scale=True)
    folium.Rectangle([[b["lat_min"], b["lon_min"]], [b["lat_max"], b["lon_max"]]],
                     color="#555", weight=2, dash_array="4", fill=False).add_to(m)

    grid_layer("Общая сетка", cells, "rsrp_median", True).add_to(m)
    grid_layer("День", cells, "rsrp_median_day", False).add_to(m)
    grid_layer("Ночь", cells, "rsrp_median_night", False).add_to(m)
    heat_layer(df).add_to(m)

    # худшие 3 квадрата
    fg = folium.FeatureGroup(name="Худшие 3 квадрата", show=True)
    for rank, w in enumerate(result["worst_cells"], 1):
        c = next(x for x in cells if x["cell_id"] == w["cell_id"])
        folium.Rectangle(bounds=c["bounds_latlon"], color="#000", weight=4, fill=False,
                         tooltip=f"№{rank} худший: {w['cell_id']}, {w['rsrp_median']} дБм").add_to(fg)
    fg.add_to(m)

    # БС
    fg = folium.FeatureGroup(name="Базовые станции", show=True)
    for t in towers:
        folium.Marker([t["lat"], t["lon"]], tooltip=f"БС {t['id']}",
                      icon=folium.Icon(color="blue", icon="signal", prefix="glyphicon")).add_to(fg)
        folium.Circle([t["lat"], t["lon"]], radius=500, color="#2980b9", weight=1.5,
                      dash_array="6", fill=True, fill_opacity=0.05).add_to(fg)
    fg.add_to(m)

    # кандидаты
    by_id = {c["id"]: c for c in candidates}
    fg = folium.FeatureGroup(name="Кандидаты", show=True)
    for c in candidates:
        dmin = min(haversine_m(c["lat"], c["lon"], t["lat"], t["lon"], b["earth_radius_m"])
                   for t in towers)
        if c["id"] in result["best_candidates"]:
            color, status = "green", "ЛУЧШАЯ ПАРА"
        elif dmin < FORBIDDEN_M:
            color, status = "gray", f"недопустима ({dmin:.0f} м < 500 м)"
        else:
            color, status = "orange", "допустима"
        folium.Marker([c["lat"], c["lon"]], tooltip=f"{c['id']}: {status}",
                      icon=folium.Icon(color=color, icon="star" if color == "green" else "flag",
                                       prefix="glyphicon")).add_to(fg)
    fg.add_to(m)

    # радиусы лучшей пары
    fg = folium.FeatureGroup(name="Радиусы лучшей пары (1 км)", show=True)
    for cid in result["best_candidates"]:
        c = by_id[cid]
        folium.Circle([c["lat"], c["lon"]], radius=1000, color="#27ae60", weight=2,
                      fill=True, fill_opacity=0.08, tooltip=f"Покрытие 1 км: {cid}").add_to(fg)
    fg.add_to(m)

    # панель
    n_red = sum(1 for c in cells if c["color"] == "red")
    worst = "".join(f"<li>{w['cell_id']}: {w['rsrp_median']} дБм</li>"
                    for w in result["worst_cells"])
    diff = result["covered_weak_cells"] - extra["greedy_covered"]
    html = f"""
<div style="position:fixed;bottom:24px;left:12px;z-index:9999;background:rgba(255,255,255,.95);
 padding:10px 12px;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,.35);
 font:12px/1.35 sans-serif;max-width:290px;color:#222">
 <div style="font-weight:bold;font-size:13px;margin-bottom:4px">Карта покрытия, Бишкек</div>
 <div><span style="background:{COLORS['green']};padding:0 8px;opacity:.7">&nbsp;</span> ≥ −90 дБм</div>
 <div><span style="background:{COLORS['yellow']};padding:0 8px;opacity:.7">&nbsp;</span> −105 … −90 дБм</div>
 <div><span style="background:{COLORS['red']};padding:0 8px;opacity:.7">&nbsp;</span> &lt; −105 дБм</div>
 <table style="margin-top:6px;border-collapse:collapse">
  <tr><td>Отброшено строк</td><td><b>{result['dropped_rows']}</b></td></tr>
  <tr><td>Квадратов в анализе</td><td><b>{len(cells)}</b></td></tr>
  <tr><td>Красных квадратов</td><td><b>{n_red}</b></td></tr>
  <tr><td>Лучшая пара (перебор)</td><td><b>{' + '.join(result['best_candidates'])}</b></td></tr>
  <tr><td>Покрыто красных</td><td><b>{result['covered_weak_cells']}</b></td></tr>
  <tr><td>Жадный алгоритм</td><td><b>{' + '.join(extra['greedy_pair'])}</b> ({extra['greedy_covered']})</td></tr>
  <tr><td>Перебор лучше жадного на</td><td><b>{diff}</b></td></tr>
 </table>
 <div style="margin-top:4px"><b>Топ-3 худших:</b><ul style="margin:2px 0 0 16px;padding:0">{worst}</ul></div>
</div>"""
    m.get_root().html.add_child(folium.Element(html))
    folium.LayerControl(collapsed=False).add_to(m)
    m.fit_bounds([[b["lat_min"], b["lon_min"]], [b["lat_max"], b["lon_max"]]])
    m.save(out_html)


# ----------------------------- main -----------------------------
def main():
    df, b = load_clean()
    cells = to_cells(df, b)
    towers = pd.read_csv(os.path.join(FOLDER, "towers.csv")).to_dict("records")
    candidates = pd.read_csv(os.path.join(FOLDER, "candidates.csv")).to_dict("records")

    best, best_n, greedy, greedy_n, cov_ids, _ = optimize(cells, candidates, towers, b)
    worst = sorted(cells, key=lambda c: c["rsrp_median"])[:3]
    result = {"worst_cells": [{"cell_id": w["cell_id"], "rsrp_median": w["rsrp_median"]} for w in worst],
              "best_candidates": best, "dropped_rows": int(5000 - len(df)),
              "covered_weak_cells": best_n}
    extra = {"greedy_pair": greedy, "greedy_covered": greedy_n}

    # сверка с эталоном
    exp_path = os.path.join(FOLDER, "expected.json")
    if os.path.exists(exp_path):
        exp = json.load(open(exp_path, encoding="utf-8"))
        for name in ("worst_cells", "best_candidates", "dropped_rows", "covered_weak_cells"):
            ok = result[name] == exp[name]
            print(f"  сверка {name}: {'OK' if ok else f'РАСХОЖДЕНИЕ: {result[name]} vs {exp[name]}'}")

    out = os.path.join(FOLDER, "map.html")
    build_map(cells, towers, candidates, b, result, extra, df, out)
    print(f"{out} готов (реальные данные)")


if __name__ == "__main__":
    main()