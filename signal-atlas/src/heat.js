const CELLS_PER_BLOCK = 16;
const PIXELS_PER_CELL = 8;
const BLOCK_PIXELS = CELLS_PER_BLOCK * PIXELS_PER_CELL;
const COLOR_STOPS = [
  [-130, [199, 75, 68]],
  [-106, [235, 128, 112]],
  [-105, [238, 177, 95]],
  [-95, [241, 207, 122]],
  [-90, [135, 195, 146]],
  [-70, [58, 161, 125]],
];

function signalColor(rsrp) {
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [high, end] = COLOR_STOPS[i];
    if (rsrp > high) continue;
    const [low, start] = COLOR_STOPS[i - 1];
    const fraction = Math.max(0, (rsrp - low) / (high - low));
    return start.map((value, channel) => Math.round(value + (end[channel] - value) * fraction));
  }
  return COLOR_STOPS.at(-1)[1];
}

// Билинейная интерполяция по соседним центрам. Пустые соседи не участвуют в весах.
function interpolateRsrp(medians, x, y) {
  const left = Math.floor(x);
  const bottom = Math.floor(y);
  let weightedSum = 0;
  let totalWeight = 0;
  for (let dy = 0; dy <= 1; dy++) {
    const row = bottom + dy;
    for (let dx = 0; dx <= 1; dx++) {
      const col = left + dx;
      const rsrp = medians.get(row + ',' + col);
      if (rsrp === undefined) continue;
      const weight = (1 - Math.abs(x - col)) * (1 - Math.abs(y - row));
      weightedSum += rsrp * weight;
      totalWeight += weight;
    }
  }
  return weightedSum / totalWeight;
}

function renderBlock(cells, medians, grid) {
  const firstRow = Math.floor(cells[0].row / CELLS_PER_BLOCK) * CELLS_PER_BLOCK;
  const firstCol = Math.floor(cells[0].col / CELLS_PER_BLOCK) * CELLS_PER_BLOCK;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = BLOCK_PIXELS;
  const context = canvas.getContext('2d');
  const image = context.createImageData(BLOCK_PIXELS, BLOCK_PIXELS);

  // Рисуем только учтённые ячейки. Ось Y растра направлена на юг, ось сетки — на север.
  for (const { row, col } of cells) {
    for (let y = 0; y < PIXELS_PER_CELL; y++) {
      for (let x = 0; x < PIXELS_PER_CELL; x++) {
        const gridX = col + (x + 0.5) / PIXELS_PER_CELL - 0.5;
        const gridY = row + (y + 0.5) / PIXELS_PER_CELL - 0.5;
        const color = signalColor(interpolateRsrp(medians, gridX, gridY));
        const pixelX = (col - firstCol) * PIXELS_PER_CELL + x;
        const pixelY = BLOCK_PIXELS - 1 - ((row - firstRow) * PIXELS_PER_CELL + y);
        const offset = (pixelY * BLOCK_PIXELS + pixelX) * 4;
        image.data.set([...color, 185], offset);
      }
    }
  }
  context.putImageData(image, 0, 0);
  const southWest = grid.point(firstRow, firstCol);
  const northEast = grid.point(firstRow + CELLS_PER_BLOCK, firstCol + CELLS_PER_BLOCK);
  const bounds = [
    [southWest.lat, southWest.lon],
    [northEast.lat, northEast.lon],
  ];
  return L.imageOverlay(canvas.toDataURL(), bounds, { pane: 'heatSurface' });
}

export function heatOverlays(cells, grid) {
  const medians = new Map();
  const blocks = new Map();
  for (const cell of cells) {
    medians.set(cell.row + ',' + cell.col, cell.rsrp);
    const blockRow = Math.floor(cell.row / CELLS_PER_BLOCK);
    const blockCol = Math.floor(cell.col / CELLS_PER_BLOCK);
    const blockId = blockRow + ',' + blockCol;
    if (!blocks.has(blockId)) blocks.set(blockId, []);
    blocks.get(blockId).push(cell);
  }

  const layer = L.layerGroup();
  for (const block of blocks.values()) {
    renderBlock(block, medians, grid).addTo(layer);
  }
  return layer;
}
