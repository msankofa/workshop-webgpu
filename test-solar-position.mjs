import { sunPosition, moonPosition } from './solar-position.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const approx = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ---- equinox at equator: noon overhead, sunrise at the horizon ----
{
  const noon = sunPosition({ hour: 12, latitudeDeg: 0, dayOfYear: 81 });
  ok(approx(noon.elevationDeg, 90, 1), 'equinox/equator noon elevation ~= 90deg');
  const sunrise = sunPosition({ hour: 6, latitudeDeg: 0, dayOfYear: 81 });
  ok(approx(sunrise.elevationDeg, 0, 2), 'equinox/equator sunrise elevation ~= 0deg');
}

// ---- sunrise/sunset azimuth near east/west (generous tolerance) ----
{
  const sunrise = sunPosition({ hour: 6, latitudeDeg: 0, dayOfYear: 81 });
  ok(approx(sunrise.azimuthDeg, 90, 15), 'equinox sunrise azimuth ~= east (90deg)');
  const sunset = sunPosition({ hour: 18, latitudeDeg: 0, dayOfYear: 81 });
  ok(approx(sunset.azimuthDeg, 270, 15), 'equinox sunset azimuth ~= west (270deg)');
}

// ---- seasonal noon elevation at lat 45: summer higher than winter ----
{
  const summer = sunPosition({ hour: 12, latitudeDeg: 45, dayOfYear: 172 });
  const winter = sunPosition({ hour: 12, latitudeDeg: 45, dayOfYear: 355 });
  ok(summer.elevationDeg > winter.elevationDeg, 'summer solstice noon elevation > winter solstice noon elevation at lat 45');
}

// ---- range + determinism across a sweep ----
{
  let rangeOk = true, deterministic = true;
  for (let h = 0; h < 24; h += 0.5) {
    for (const lat of [-80, -45, 0, 45, 80]) {
      const a = sunPosition({ hour: h, latitudeDeg: lat, dayOfYear: 172 });
      if (a.elevationDeg < -90 || a.elevationDeg > 90) rangeOk = false;
      if (a.azimuthDeg < 0 || a.azimuthDeg >= 360) rangeOk = false;
      const b = sunPosition({ hour: h, latitudeDeg: lat, dayOfYear: 172 });
      if (a.elevationDeg !== b.elevationDeg || a.azimuthDeg !== b.azimuthDeg) deterministic = false;
    }
  }
  ok(rangeOk, 'elevation in [-90,90] and azimuth in [0,360) across a sweep of hours/latitudes');
  ok(deterministic, 'same inputs -> identical output');
}

// ---- moon is anti-sun: default phaseOffsetHours=12 matches sun 12h later ----
{
  const t = { hour: 9, latitudeDeg: 45, dayOfYear: 172 };
  const moon = moonPosition(t);
  const sunLater = sunPosition({ ...t, hour: t.hour + 12 });
  ok(approx(moon.elevationDeg, sunLater.elevationDeg, 1e-9), 'moonPosition elevation matches sunPosition 12h later');
  ok(approx(moon.azimuthDeg, sunLater.azimuthDeg, 1e-9), 'moonPosition azimuth matches sunPosition 12h later');

  // moon up (day) while sun down (night), at noon-ish local time
  const noonSun = sunPosition({ hour: 12, latitudeDeg: 45, dayOfYear: 172 });
  const midnightMoon = moonPosition({ hour: 0, latitudeDeg: 45, dayOfYear: 172 });
  ok(approx(midnightMoon.elevationDeg, noonSun.elevationDeg, 1e-9), 'moon at midnight ~= sun at noon (anti-sun arc)');
}

// ---- custom phaseOffsetHours and hour wrap-around ----
{
  const custom = moonPosition({ hour: 20, latitudeDeg: 20, dayOfYear: 50, phaseOffsetHours: 8 });
  const expected = sunPosition({ hour: (20 + 8) % 24, latitudeDeg: 20, dayOfYear: 50 });
  ok(approx(custom.elevationDeg, expected.elevationDeg, 1e-9), 'custom phaseOffsetHours matches shifted+wrapped sunPosition');

  const wrapped = moonPosition({ hour: 18, latitudeDeg: 20, dayOfYear: 50, phaseOffsetHours: 12 });
  const expectedWrapped = sunPosition({ hour: 6, latitudeDeg: 20, dayOfYear: 50 });
  ok(approx(wrapped.elevationDeg, expectedWrapped.elevationDeg, 1e-9), 'hour+phaseOffset wraps past 24 correctly');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
