from __future__ import annotations
from itertools import combinations
import json
import csv
import math



#меня в детсве били лопатой и я рещил стать программистом
def load_bounds(path: str = "bounds.json") -> dict:
    with open(path, "r", encoding="utf-8") as file:
        return json.load(file)

def parse_cell_id(cell_id: str): #tuple int, int
    """превращаем X006_Y013 в кортеж индексов (6, 13).""" #Баткен сила - насвай могила :)
    x_part, y_part = cell_id.split("_")

    return int(x_part[1:]), int(y_part[1:])


def cell_center_latlon(ix: int, iy: int, bounds: dict) -> tuple[float, float]:
    """Считает координаты (lat, lon) геометрического центра клетки (ix, iy)."""

    # Переводим метры обратно в радианы, а затем в обычные GPS-градусы. да
    R = bounds["earth_radius_m"]
 
    cell_size = bounds["cell_size_m"]
    lat0 = math.radians(bounds["grid_origin_lat"])
    lon0 = math.radians(bounds["grid_origin_lon"])

    # находим центр квадрата в метрах от левого нижнего угла сетки
    cx = (ix + 0.5) * cell_size
    cy = (iy + 0.5) * cell_size

    # Обратная локальная равнопромежуточная проекция -> градусы
    center_lat = bounds["grid_origin_lat"] + math.degrees(cy / R)
    center_lon = bounds["grid_origin_lon"] + math.degrees(cx / (R * math.cos(lat0)))

    return center_lat, center_lon

def load_points_csv(path: str) -> list[dict]:
    """Читает towers.csv или candidates.csv в список словарей."""
    points = []
    with open(path, "r", encoding="utf-8") as file:
        for row in csv.DictReader(file):
            points.append({
                "id": row["id"].strip(),
                "lat": float(row["lat"]),
                "lon": float(row["lon"]),
            })
    return points


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float, R: float) -> float: 
    """Считает расстояние в метрах между двумя точками по формуле гаверсинуса.""" # пифагор повесился ы
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)

    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    a = min(1.0, max(0.0, a)) # тама значение погрешности имело, теперь нет
    return 2 * R * math.asin(math.sqrt(a))


def filter_valid_candidates(
    candidates: list[dict],
    towers: list[dict],
    R: float,
    min_dist_m: float = 500.0,
) -> list[dict]:
    """Оставляет только площадки, удалённые от КАЖДОЙ существующей БС минимум на 500 м."""
    valid = []
    for cand in candidates:
        is_far_enough = all(
            haversine_m(cand["lat"], cand["lon"], tower["lat"], tower["lon"], R) >= min_dist_m
            for tower in towers
        )
        if is_far_enough:
            valid.append(cand)
    return valid

def get_covered_weak_cells(
    cand: dict,
    weak_cells: list[dict],
    bounds: dict,
    max_dist_m: float = 1000.0,
) -> set[str]:
    """Возвращает множество cell_id красных клеток в радиусе <= 1000 м от кандидата."""
    R = bounds["earth_radius_m"]
    covered = set()

    for cell in weak_cells:
        # Берём индексы клетки (если 1-й участник передал ix/iy, иначе парсим cell_id)
        if "ix" in cell and "iy" in cell:
            ix, iy = cell["ix"], cell["iy"]
        else:
            ix, iy = parse_cell_id(cell["cell_id"])

        center_lat, center_lon = cell_center_latlon(ix, iy, bounds)
        dist = haversine_m(cand["lat"], cand["lon"], center_lat, center_lon, R)

        if dist <= max_dist_m:
            covered.add(cell["cell_id"])

    return covered


def find_best_pair_exact(
    valid_candidates: list[dict],
    weak_cells: list[dict],
    bounds: dict,
) -> tuple[list[str], int, dict[str, set[str]]]:
    """Полный перебор всех пар допустимых кандидатов (основное решение)."""
    # 1. Заранее считаем множество покрытых клеток для каждого кандидата
    coverage_map: dict[str, set[str]] = {}
    for cand in valid_candidates:
        coverage_map[cand["id"]] = get_covered_weak_cells(cand, weak_cells, bounds)

    best_pair: tuple[str, str] | None = None
    best_count = -1

    # 2. Перебираем все уникальные пары кандидатов
    for cand_a, cand_b in combinations(valid_candidates, 2):
        pair = tuple(sorted([cand_a["id"], cand_b["id"]]))
        # Объединение множеств (|) автоматически убирает двойной учёт клеток
        union_count = len(coverage_map[pair[0]] | coverage_map[pair[1]])

        # Максимизируем охват; при равенстве берём лексикографически меньшую пару
        if union_count > best_count or (union_count == best_count and pair < best_pair):
            best_count = union_count
            best_pair = pair

    if best_pair is None:
        return [], 0, coverage_map

    return list(best_pair), best_count, coverage_map


def find_best_pair_greedy(coverage_map: dict[str, set[str]]) -> tuple[list[str], int]:
    """Жадный алгоритм для бонусного сравнения: берём лучшего, затем лучшее дополнение."""
    if len(coverage_map) < 2:
        return [], 0

    # выбираем кандидата с максимальным одиночным покрытием (при равенстве — меньший ID)
    first_id = min(coverage_map.keys(), key=lambda cid: (-len(coverage_map[cid]), cid))
    first_cov = coverage_map[first_id]

    #выбираем второго, который добавит больше всего ЕЩЁ НЕ ПОКРЫТЫХ клеток
    remaining_ids = [cid for cid in coverage_map.keys() if cid != first_id]
    second_id = min(
        remaining_ids,
        key=lambda cid: (-len(coverage_map[cid] - first_cov), cid),
    )

    greedy_pair = sorted([first_id, second_id])
    total_covered = len(first_cov | coverage_map[second_id])
    return greedy_pair, total_covered


if __name__ == "__main__":
    bounds = load_bounds("bounds.json")

    # Проверка на самой худшей клетке из expected.json
    ix, iy = parse_cell_id("X006_Y013")
    lat_c, lon_c = cell_center_latlon(ix, iy, bounds)

    print(f"X006_Y013 -> lat={lat_c:.6f}, lon={lon_c:.6f}")

