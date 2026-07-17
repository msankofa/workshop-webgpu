// solar-position.js
// Pure-JS solar/lunar position math — NO three.js import. Node-testable, mirrors
// sky-field.js's "CPU source of truth" pattern.

const DEG = Math.PI / 180, RAD = 180 / Math.PI;

function wrapHour(h) { return ((h % 24) + 24) % 24; }
function wrapDeg(d) { return ((d % 360) + 360) % 360; }

// Real solar-position approximation: declination from day-of-year, elevation/azimuth
// from latitude + hour angle. Azimuth is compass-style, clockwise from north (east=90).
export function sunPosition({ hour, latitudeDeg, dayOfYear }) {
  const decl = 23.44 * DEG * Math.sin(360 / 365 * (dayOfYear - 81) * DEG);
  const H = 15 * (hour - 12) * DEG;
  const lat = latitudeDeg * DEG;

  const sinElev = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H);
  const elev = Math.asin(Math.max(-1, Math.min(1, sinElev)));

  const denom = Math.cos(elev) * Math.cos(lat);
  let azimuthDeg;
  if (Math.abs(denom) < 1e-6) {
    azimuthDeg = 180; // poles / zenith: azimuth undefined, fall back to a stable value
  } else {
    const cosA = (Math.sin(decl) - Math.sin(elev) * Math.sin(lat)) / denom;
    let A = Math.acos(Math.max(-1, Math.min(1, cosA))) * RAD;
    if (H > 0) A = 360 - A; // afternoon: mirror to the west side
    azimuthDeg = A;
  }

  return { elevationDeg: elev * RAD, azimuthDeg: wrapDeg(azimuthDeg) };
}

// Anti-sun approximation: same solar math with the clock offset (default 12h), so the
// moon rides an arc roughly opposite the sun without a full lunar ephemeris.
export function moonPosition({ hour, latitudeDeg, dayOfYear, phaseOffsetHours = 12 }) {
  return sunPosition({ hour: wrapHour(hour + phaseOffsetHours), latitudeDeg, dayOfYear });
}
