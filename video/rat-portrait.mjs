// Robotic lab rat portraits for the 3D world (world3d.js): the same character
// as the 3D rat, drawn front-on as inline SVG. Expressions map to OBSERVABLE
// state only: "neutral", "tense" (a resource is low: amber eyes), "off"
// (shut down: eyes dark, desaturated). A bow marks feminine characters.

const mix = (a, b, t) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
};

const EYES = { neutral: "#5ffbf1", tense: "#ffb020", off: "#2b3140" };

/** SVG markup for one rat portrait. `color` is the character color (the rat's body). */
export function ratPortraitSvg(color, expression, feminine, size) {
  const body = color;
  const light = mix(color, "#ffffff", 0.55);
  const dark = "#2b3140";
  const eye = EYES[expression] ?? EYES.neutral;
  const glow = expression === "off" ? "" : `<ellipse cx="40" cy="47" rx="7" ry="5" fill="${eye}" opacity="0.25"/><ellipse cx="60" cy="47" rx="7" ry="5" fill="${eye}" opacity="0.25"/>`;
  const whiskers = [-1, 1]
    .map((s) => [[-4, 0], [0, 0], [4, 1]].map(([dy, dx]) => `<line x1="${50 + s * 11}" y1="${64 + dy * 0.4}" x2="${50 + s * (31 + dx)}" y2="${62 + dy * 1.4}" stroke="#d9dde8" stroke-width="1.2" stroke-linecap="round"/>`).join(""))
    .join("");
  const bow = feminine
    ? `<g transform="translate(31 25) rotate(-18)"><polygon points="-11,-6 -11,6 0,0" fill="#ff6fa8"/><polygon points="11,-6 11,6 0,0" fill="#ff6fa8"/><circle r="3.2" fill="#ff6fa8"/><circle r="3.2" fill="#000" opacity="0.12"/></g>`
    : "";
  const inner = [
    `<circle cx="50" cy="50" r="50" fill="#1d2433"/>`,
    `<circle cx="50" cy="50" r="47" fill="none" stroke="${color}" stroke-width="4" opacity="0.9"/>`,
    // Shoulders with the neck ring.
    `<path d="M20 100 Q22 80 50 78 Q78 80 80 100 Z" fill="${body}"/><path d="M38 80 Q50 76 62 80" stroke="${dark}" stroke-width="3" fill="none"/>`,
    // Antenna (behind the head), ears on the sides.
    `<line x1="57" y1="28" x2="63" y2="12" stroke="${dark}" stroke-width="2.4" stroke-linecap="round"/><circle cx="63.5" cy="11" r="3.2" fill="${expression === "off" ? "#6b7280" : "#ff5f8f"}"/>`,
    `<ellipse cx="25" cy="37" rx="13" ry="16" fill="${body}" transform="rotate(-20 25 37)"/><ellipse cx="25" cy="37" rx="8.5" ry="11" fill="${light}" transform="rotate(-20 25 37)"/>`,
    `<ellipse cx="75" cy="37" rx="13" ry="16" fill="${body}" transform="rotate(20 75 37)"/><ellipse cx="75" cy="37" rx="8.5" ry="11" fill="${light}" transform="rotate(20 75 37)"/>`,
    // Head, snout, nose, teeth, whiskers.
    `<ellipse cx="50" cy="51" rx="25" ry="24" fill="${body}"/>`,
    `<ellipse cx="50" cy="64" rx="12" ry="9.5" fill="${light}"/>`,
    `<rect x="47.2" y="68.5" width="2.6" height="4.2" rx="0.6" fill="#f5f1e6"/><rect x="50.2" y="68.5" width="2.6" height="4.2" rx="0.6" fill="#f5f1e6"/>`,
    `<ellipse cx="50" cy="60.5" rx="4.2" ry="3.4" fill="#ff7aa2"/>`,
    whiskers,
    // Visor with two LED eyes.
    `<rect x="27" y="40" width="46" height="13" rx="6.5" fill="#11151f"/>`,
    glow,
    `<ellipse cx="40" cy="46.5" rx="4.4" ry="3.2" fill="${eye}"/><ellipse cx="60" cy="46.5" rx="4.4" ry="3.2" fill="${eye}"/>`,
    `<path d="M31 42.5 Q50 39.5 69 42.5" stroke="#ffffff" stroke-width="1" opacity="0.25" fill="none"/>`,
    bow,
  ].join("");
  const filter = expression === "off" ? ` style="filter:grayscale(1) brightness(0.8)"` : "";
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}"${filter} xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="c"><circle cx="50" cy="50" r="50"/></clipPath></defs><g clip-path="url(#c)">${inner}</g></svg>`;
}
