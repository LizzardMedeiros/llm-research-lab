export interface MapGrid {
  width: number;
  height: number;
  /** rows[y][x], y = 0 is the top row */
  rows: string[][];
}

export function parseAsciiMap(map: string): MapGrid {
  const lines = map.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("Map is empty");
  const width = lines[0]!.length;
  lines.forEach((line, y) => {
    if (line.length !== width) {
      throw new Error(`Map row ${y} has length ${line.length}, expected ${width}`);
    }
  });
  return { width, height: lines.length, rows: lines.map((l) => [...l]) };
}
