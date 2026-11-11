// Illustrated portraits for video characters, drawn as inline SVG from
// deterministic parameters (src/story/cast.ts). Expressions map to OBSERVABLE
// state only: "neutral", "tense" (a resource is low), "off" (shut down).

const SKIN = ["#f6d7c3", "#eac0a2", "#d9a07a", "#b97a56", "#8d5a3b", "#5e3b28"];
const HAIR = ["#1f1915", "#4a2f1c", "#8a5a30", "#d8b25a", "#9a9a9a", "#c4521f"];

function face(shape, skin) {
  if (shape === 1) return `<ellipse cx="50" cy="50" rx="24" ry="29" fill="${skin}"/>`;
  if (shape === 2) return `<rect x="26" y="23" width="48" height="56" rx="16" fill="${skin}"/>`;
  return `<circle cx="50" cy="51" r="27" fill="${skin}"/>`;
}

function hairBack(style, color) {
  if (style === 1 || style === 7) return `<path d="M22 46 Q20 86 34 92 L66 92 Q80 86 78 46 Z" fill="${color}"/>`; // long, long curly
  if (style === 2) return `<circle cx="50" cy="16" r="10" fill="${color}"/>`; // bun
  if (style === 6) return `<ellipse cx="50" cy="40" rx="37" ry="33" fill="${color}"/>`; // afro
  return "";
}

function hairFront(style, color) {
  switch (style) {
    case 0: return `<path d="M24 46 Q24 20 50 20 Q76 20 76 46 Q66 32 50 33 Q34 32 24 46 Z" fill="${color}"/>`; // short
    case 1: return `<path d="M23 50 Q22 18 50 18 Q78 18 77 50 Q70 30 50 30 Q30 30 23 50 Z" fill="${color}"/>`; // long (front)
    case 2: return `<path d="M25 44 Q26 22 50 22 Q74 22 75 44 Q64 30 50 30 Q36 30 25 44 Z" fill="${color}"/>`; // bun (front)
    case 3: return `<path d="M26 40 Q28 24 50 24 Q72 24 74 40 Q62 31 50 31 Q38 31 26 40 Z" fill="${color}" opacity="0.85"/>`; // buzz
    case 6: return `<path d="M24 44 Q26 24 50 24 Q74 24 76 44 Q66 33 50 34 Q34 33 24 44 Z" fill="${color}"/>`; // afro (front)
    case 4: case 7: return [24, 34, 44, 54, 64, 74].map((x, i) => `<circle cx="${x + 1}" cy="${28 + (i % 2) * 4}" r="8" fill="${color}"/>`).join(""); // curly
    default: return ""; // bald
  }
}

function eyesAndBrows(expression, shape) {
  if (expression === "off") {
    return `<path d="M37 50 Q41 53 45 50 M55 50 Q59 53 63 50" stroke="#2b2118" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
  }
  const [rx, ry] = shape === 1 ? [3.3, 2.3] : [2.8, 3.4]; // almond or round
  const eyes = `<ellipse cx="41" cy="50" rx="${rx}" ry="${ry}" fill="#2b2118"/><ellipse cx="59" cy="50" rx="${rx}" ry="${ry}" fill="#2b2118"/>`;
  const brows = expression === "tense"
    ? `<path d="M35 42 L45 45 M65 42 L55 45" stroke="#2b2118" stroke-width="2.2" stroke-linecap="round"/>`
    : `<path d="M36 43 Q41 40 46 43 M54 43 Q59 40 64 43" stroke="#2b2118" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  return eyes + brows;
}

function mouth(expression) {
  if (expression === "tense") return `<path d="M42 66 Q45 63 48 66 Q51 69 54 66 Q57 63 58 66" stroke="#5a2a20" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  if (expression === "off") return `<path d="M43 66 L57 66" stroke="#5a2a20" stroke-width="2" stroke-linecap="round"/>`;
  return `<path d="M42 64 Q50 70 58 64" stroke="#5a2a20" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
}

function accessory(kind) {
  switch (kind) {
    case 1: return `<g stroke="#1d2330" stroke-width="2" fill="none"><circle cx="41" cy="50" r="6.5"/><circle cx="59" cy="50" r="6.5"/><path d="M47.5 50 L52.5 50"/></g>`;
    case 2: return `<path d="M25 38 Q50 26 75 38" stroke="#ffe08a" stroke-width="4" fill="none"/>`;
    case 3: return `<circle cx="23.5" cy="60" r="2.6" fill="#ffe08a"/><circle cx="76.5" cy="60" r="2.6" fill="#ffe08a"/>`;
    default: return "";
  }
}

/**
 * SVG markup for one portrait. `color` is the character color (background and
 * shirt); `off` portraits are desaturated.
 */
export function portraitSvg(p, expression, color, size) {
  const skin = SKIN[p.skin % SKIN.length];
  const hair = HAIR[p.hairColor % HAIR.length];
  const body = `<path d="M18 100 Q20 80 50 78 Q80 80 82 100 Z" fill="${color}"/><path d="M18 100 Q20 80 50 78 Q80 80 82 100 Z" fill="#000" opacity="0.18"/>`;
  const inner = [
    `<circle cx="50" cy="50" r="50" fill="${color}"/>`,
    `<circle cx="50" cy="50" r="50" fill="#fff" opacity="0.12"/>`,
    hairBack(p.hair, hair),
    body,
    face(p.face, skin),
    hairFront(p.hair, hair),
    p.freckles ? [[35, 58], [38, 61], [41, 58], [59, 58], [62, 61], [65, 58]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1" fill="#a8562e" opacity="0.7"/>`).join("") : "",
    eyesAndBrows(expression, p.eyes ?? 0),
    mouth(expression),
    accessory(p.accessory),
    expression === "tense" ? `<path d="M70 38 q3 5 0 8 q-3 -3 0 -8" fill="#8fd3ff"/>` : "",
  ].join("");
  const filter = expression === "off" ? ` style="filter:grayscale(1) brightness(0.8)"` : "";
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}"${filter} xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="c"><circle cx="50" cy="50" r="50"/></clipPath></defs><g clip-path="url(#c)">${inner}</g></svg>`;
}
