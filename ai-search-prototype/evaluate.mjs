import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import {
  AutoProcessor,
  AutoTokenizer,
  CLIPModel,
  RawImage,
  env,
  pipeline,
} from '@xenova/transformers';

const ROOT = path.resolve('..');
const OUT_DIR = path.resolve('sample-images');
const CACHE_DIR = path.resolve('model-cache');
const LIMIT = Number(process.env.LIMIT || 40);
const QUERY = process.argv.slice(2).join(' ') || 'a red ceramic tile with a warm feeling';

env.cacheDir = CACHE_DIR;
env.localModelPath = CACHE_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = process.env.ALLOW_REMOTE === '1';

function hostDatabaseValue(value = process.env.DB_HOST || '127.0.0.1') {
  return value === 'tile-db' ? '127.0.0.1' : value;
}

function labToRgb(l, a, b) {
  const y = (l + 16) / 116;
  const x = a / 500 + y;
  const z = y - b / 200;
  const xyz = [x, y, z].map((v) => {
    const v3 = v ** 3;
    return v3 > 0.008856 ? v3 : (v - 16 / 116) / 7.787;
  });

  let [X, Y, Z] = [xyz[0] * 95.047, xyz[1] * 100, xyz[2] * 108.883];
  X /= 100;
  Y /= 100;
  Z /= 100;

  let r = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  let g = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  let bl = X * 0.0557 + Y * -0.204 + Z * 1.057;

  const correct = (v) => (v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v);
  return [r, g, bl].map((v) => Math.max(0, Math.min(255, Math.round(correct(v) * 255))));
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function normalize(vec) {
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0)) || 1;
  return Array.from(vec, (value) => value / norm);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function targetLightnessScore(lightness, target, tolerance = 0.42) {
  return clamp01(1 - Math.abs(clamp01(lightness) - target) / tolerance);
}

function legacyColorIntentScore(query, row) {
  if (!hasLegacyLab(row)) return 0;

  const tokens = queryTokens(query);
  const [r, g, b] = labToRgb(Number(row.Color_L), Number(row.Color_A), Number(row.Color_B));
  const warmth = Math.max(0, (r + 0.45 * g - 1.2 * b) / 255);
  const coolness = Math.max(0, (b + 0.35 * g - 1.05 * r) / 255);
  const redness = Math.max(0, (r - Math.max(g, b)) / 255);
  const blueness = Math.max(0, (b - Math.max(r, g)) / 255);
  const earthiness = Math.max(0, (r + g - b) / 510);
  const brightness = Number(row.Color_L) / 100;
  let score = 0;

  if (tokens.includes('red')) score += redness;
  if (tokens.includes('warm')) score += warmth;
  if (tokens.includes('blue')) score += blueness;
  if (tokens.includes('cold') || tokens.includes('cool')) score += coolness;
  if (tokens.some((token) => ['bright', 'light', 'pale'].includes(token))) score += brightness;
  if (tokens.some((token) => ['lighter', 'brighter'].includes(token))) score += targetLightnessScore(brightness, 0.68);
  if (tokens.includes('dark') || tokens.includes('deep')) score += 1 - brightness;
  if (tokens.includes('darker') || tokens.includes('deeper')) score += targetLightnessScore(brightness, 0.38);
  if (tokens.some((token) => ['brown', 'earth', 'rustic'].includes(token))) score += earthiness;

  return score;
}

const FAMILY_ALIASES = {
  aqua: 'cyan',
  beige: 'cream',
  black: 'black',
  blue: 'blue',
  brown: 'brown',
  burgundy: 'red',
  cream: 'cream',
  cyan: 'cyan',
  gold: 'yellow',
  gray: 'gray',
  green: 'green',
  grey: 'gray',
  maroon: 'red',
  navy: 'blue',
  orange: 'orange',
  pink: 'pink',
  purple: 'purple',
  red: 'red',
  tan: 'brown',
  teal: 'cyan',
  turquoise: 'cyan',
  violet: 'purple',
  white: 'white',
  yellow: 'yellow',
};

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeProfile(profile) {
  if (!profile || Array.isArray(profile) || typeof profile !== 'object') return {};

  return Object.fromEntries(Object.entries(profile)
    .map(([family, percent]) => [family.toLowerCase(), Number(percent)])
    .filter(([, percent]) => Number.isFinite(percent) && percent > 0));
}

function dominantColors(row) {
  const parsed = parseJsonField(row.DominantColors, []);
  return Array.isArray(parsed) ? parsed : [];
}

function hasLegacyLab(row) {
  return [row.Color_L, row.Color_A, row.Color_B].every((value) => Number.isFinite(Number(value)));
}

function displayRgb(row) {
  const [firstColor] = dominantColors(row);
  if (Array.isArray(firstColor?.rgb) && firstColor.rgb.length === 3) {
    return firstColor.rgb.map((value) => Math.max(0, Math.min(255, Math.round(Number(value) || 0))));
  }

  if (hasLegacyLab(row)) {
    return labToRgb(Number(row.Color_L), Number(row.Color_A), Number(row.Color_B));
  }

  return [0, 0, 0];
}

function colorProfile(row) {
  return normalizeProfile(parseJsonField(row.ColorProfile, {}));
}

function familyPercent(row, family, profile = colorProfile(row), colors = dominantColors(row)) {
  if (Number.isFinite(profile[family])) {
    return profile[family];
  }

  return Math.max(
    0,
    ...colors
      .filter((color) => color?.family === family)
      .map((color) => Number(color.percent) || 0),
  );
}

function profileGroupPercent(row, families, profile, colors) {
  return families.reduce((sum, family) => sum + familyPercent(row, family, profile, colors), 0);
}

function weightedLightness(row, colors = dominantColors(row)) {
  let weightedTotal = 0;
  let totalWeight = 0;

  for (const color of colors) {
    const lightness = Number(Array.isArray(color.lab) ? color.lab[0] : color.lab?.l);
    const percent = Number(color.percent);
    if (!Number.isFinite(lightness) || !Number.isFinite(percent)) continue;
    weightedTotal += lightness * percent;
    totalWeight += percent;
  }

  if (totalWeight > 0) {
    return weightedTotal / totalWeight / 100;
  }

  return Number.isFinite(Number(row.Color_L)) ? Number(row.Color_L) / 100 : 0.5;
}

function queryTokens(query) {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function colorIntentScore(query, row) {
  const profile = colorProfile(row);
  const colors = dominantColors(row);
  if (Object.keys(profile).length === 0 && colors.length === 0) {
    return legacyColorIntentScore(query, row);
  }

  const tokens = queryTokens(query);
  const exactFamilies = new Set(tokens.map((token) => FAMILY_ALIASES[token]).filter(Boolean));
  let score = 0;
  let factors = 0;

  for (const family of exactFamilies) {
    const percent = familyPercent(row, family, profile, colors);
    const primaryBoost = row.PrimaryColor === family ? 0.25 : 0;
    score += Math.min(1.25, percent * 1.3 + primaryBoost);
    factors += 1;
  }

  if (tokens.some((token) => ['warm', 'earth', 'earthy', 'rustic'].includes(token))) {
    score += Math.min(1.2, profileGroupPercent(row, ['red', 'orange', 'yellow', 'brown', 'cream'], profile, colors) * 1.2);
    factors += 1;
  }

  if (tokens.some((token) => ['cold', 'cool'].includes(token))) {
    score += Math.min(1.2, profileGroupPercent(row, ['blue', 'cyan', 'green', 'purple'], profile, colors) * 1.2);
    factors += 1;
  }

  const lightness = weightedLightness(row, colors);
  if (tokens.some((token) => ['bright', 'light', 'pale'].includes(token))) {
    score += lightness;
    factors += 1;
  }

  if (tokens.some((token) => ['lighter', 'brighter'].includes(token))) {
    score += targetLightnessScore(lightness, 0.68);
    factors += 1;
  }

  if (tokens.includes('dark') || tokens.includes('deep')) {
    score += 1 - lightness;
    factors += 1;
  }

  if (tokens.includes('darker') || tokens.includes('deeper')) {
    score += targetLightnessScore(lightness, 0.38);
    factors += 1;
  }

  return factors ? score / factors : 0;
}

function metadataScore(query, row) {
  const qTokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const text = [
    row.GlazeType,
    row.SurfaceCondition,
    row.FiringType,
    row.SoilType,
    row.ChemicalComposition,
  ].join(' ').toLowerCase();
  if (!text.trim()) return 0;
  return [...qTokens].reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
}

async function ensureColorMetadataColumns(conn) {
  const requiredColumns = {
    PrimaryColor: 'VARCHAR(32) DEFAULT NULL',
    DominantColors: 'MEDIUMTEXT DEFAULT NULL',
    ColorProfile: 'MEDIUMTEXT DEFAULT NULL',
  };
  const [columns] = await conn.execute(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'testpiece'
       AND COLUMN_NAME IN (?, ?, ?)`,
    Object.keys(requiredColumns),
  );
  const existing = new Set(columns.map((column) => column.COLUMN_NAME));

  for (const [column, definition] of Object.entries(requiredColumns)) {
    if (!existing.has(column)) {
      await conn.execute(`ALTER TABLE testpiece ADD COLUMN ${column} ${definition}`);
    }
  }
}

async function loadTiles() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const conn = await mysql.createConnection({
    host: hostDatabaseValue(),
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'ceramadmin',
    password: process.env.DB_PASSWORD || 'glazed-dev-password',
    database: process.env.DB_NAME || process.env.MYSQL_DATABASE || 'tilearchive',
  });

  await ensureColorMetadataColumns(conn);

  const [tileRows] = await conn.execute(
    `SELECT
      tp.ID,
      tp.Image,
      tp.Color_L,
      tp.Color_A,
      tp.Color_B,
      tp.PrimaryColor,
      tp.DominantColors,
      tp.ColorProfile,
      gt.Name AS GlazeType,
      sc.Name AS SurfaceCondition,
      tp.FiringType,
      tp.SoilType,
      tp.ChemicalComposition
    FROM testpiece tp
    LEFT JOIN glazetype gt ON tp.GlazeTypeID = gt.ID
    LEFT JOIN surfacecondition sc ON tp.SurfaceConditionID = sc.ID
    WHERE tp.Image IS NOT NULL
      AND (
        (tp.Color_L IS NOT NULL AND tp.Color_A IS NOT NULL AND tp.Color_B IS NOT NULL)
        OR tp.ColorProfile IS NOT NULL
        OR tp.DominantColors IS NOT NULL
      )
    ORDER BY tp.ID DESC
    LIMIT ?`,
    [LIMIT],
  );
  await conn.end();

  for (const row of tileRows) {
    row.imagePath = path.join(OUT_DIR, `${row.ID}.jpg`);
    await fs.writeFile(row.imagePath, row.Image);
    delete row.Image;
  }

  return tileRows;
}

function printResults(title, rows, scoreKey) {
  console.log(`\n${title}`);
  for (const row of rows.slice(0, 10)) {
    const [r, g, b] = displayRgb(row);
    const lab = hasLegacyLab(row)
      ? `LAB(${Number(row.Color_L).toFixed(1)},${Number(row.Color_A).toFixed(1)},${Number(row.Color_B).toFixed(1)})`
      : 'LAB(n/a)';
    console.log(
      [
        `#${row.ID}`,
        `${scoreKey}=${row[scoreKey].toFixed(4)}`,
        `rgb(${r},${g},${b})`,
        lab,
        row.imagePath,
      ].join(' | '),
    );
  }
}

async function runClip(rows) {
  const modelName = process.env.CLIP_MODEL || 'Xenova/clip-vit-base-patch32';
  console.log(`\nLoading local CLIP candidate: ${modelName}`);

  const tokenizer = await AutoTokenizer.from_pretrained(modelName);
  const processor = await AutoProcessor.from_pretrained(modelName);
  const model = await CLIPModel.from_pretrained(modelName);

  const textInputs = tokenizer([QUERY], { padding: true, truncation: true });
  for (const row of rows) {
    const image = await RawImage.read(row.imagePath);
    const imageInputs = await processor(image);
    const output = await model({ ...textInputs, ...imageInputs });
    row.clipScore = Number(output.logits_per_image.data[0]);
  }

  rows.sort((a, b) => b.clipScore - a.clipScore);
  printResults('CLIP text-to-image ranking', rows, 'clipScore');
}

async function runCaptionThenText(rows) {
  const modelName = process.env.CAPTION_MODEL || 'Xenova/vit-gpt2-image-captioning';
  console.log(`\nLoading local caption candidate: ${modelName}`);
  const captioner = await pipeline('image-to-text', modelName);
  const q = QUERY.toLowerCase();

  for (const row of rows.slice(0, 12)) {
    const [caption] = await captioner(row.imagePath);
    row.caption = caption.generated_text || '';
    row.captionScore = q
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .reduce((score, token) => score + (row.caption.toLowerCase().includes(token) ? 1 : 0), 0);
  }

  const ranked = rows
    .slice(0, 12)
    .sort((a, b) => b.captionScore - a.captionScore || b.colorScore - a.colorScore);
  console.log('\nCaption-then-text ranking');
  for (const row of ranked.slice(0, 10)) {
    console.log(`#${row.ID} | captionScore=${row.captionScore} | "${row.caption}" | ${row.imagePath}`);
  }
}

const rows = await loadTiles();
console.log(`Query: "${QUERY}"`);
console.log(`Loaded ${rows.length} local tile images from MariaDB.`);

for (const row of rows) {
  row.colorScore = colorIntentScore(QUERY, row);
  row.metadataScore = metadataScore(QUERY, row);
}

printResults('Color/LAB heuristic baseline', [...rows].sort((a, b) => b.colorScore - a.colorScore), 'colorScore');
printResults('Metadata text baseline', [...rows].sort((a, b) => b.metadataScore - a.metadataScore), 'metadataScore');

await runClip(rows);

if (process.env.RUN_CAPTION === '1') {
  await runCaptionThenText(rows);
}
