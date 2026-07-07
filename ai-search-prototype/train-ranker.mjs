import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TRAINING_DIR = path.resolve('training-data');
const FEEDBACK_PATH = path.join(TRAINING_DIR, 'feedback.jsonl');
const WEIGHTS_PATH = path.join(TRAINING_DIR, 'ranking-weights.json');
const FEATURE_NAMES = [
  'bias',
  'clipScore',
  'colorScore',
  'metadataScore',
  'visualScore',
  'visualPenalty',
  'exclusionPenalty',
];

const DEFAULT_WEIGHTS = {
  bias: 0,
  clipScore: 1,
  colorScore: 0.22,
  metadataScore: 0.12,
  visualScore: 0.18,
  visualPenalty: -0.82,
  exclusionPenalty: -1,
};

const LIMITS = {
  bias: [-1.2, 1.2],
  clipScore: [0.25, 2],
  colorScore: [0, 1.1],
  metadataScore: [0, 0.8],
  visualScore: [0, 0.8],
  visualPenalty: [-2.8, 0],
  exclusionPenalty: [-3, 0],
};

const SEED_PROMPTS = [
  {
    query: 'brown ceramic tile',
    label(result) {
      const brown = Number(result.colorProfile?.brown) || 0;
      if (result.primaryColor === 'brown' || brown >= 0.38 || result.colorScore >= 0.7) return 1;
      if (brown <= 0.08 && result.primaryColor !== 'brown') return 0;
      return null;
    },
  },
  {
    query: 'blue ceramic tile',
    label(result) {
      const blue = (Number(result.colorProfile?.blue) || 0) + (Number(result.colorProfile?.cyan) || 0);
      if (result.primaryColor === 'blue' || result.primaryColor === 'cyan' || blue >= 0.34) return 1;
      if (blue <= 0.07) return 0;
      return null;
    },
  },
  {
    query: 'cream light ceramic tile',
    label(result) {
      const light = (Number(result.colorProfile?.cream) || 0) + (Number(result.colorProfile?.white) || 0);
      if ((result.primaryColor === 'cream' || result.primaryColor === 'white') && light >= 0.35) return 1;
      if (light <= 0.08) return 0;
      return null;
    },
  },
  {
    query: 'no dark edges ceramic tile',
    label(result) {
      const metrics = result.visualMetrics || {};
      const edge = Number(metrics.edgeFrameScore) || 0;
      const darkBorder = Number(metrics.darkBorderRatio) || 0;
      if (result.visualPenalty <= 0.08 && edge <= 0.08 && darkBorder <= 0.04) return 1;
      if (result.visualPenalty >= 0.28 || edge >= 0.24 || darkBorder >= 0.18) return 0;
      return null;
    },
  },
  {
    query: 'no edges ceramic tile',
    label(result) {
      const edge = Number(result.visualMetrics?.edgeFrameScore) || 0;
      if (result.visualPenalty <= 0.05 && edge <= 0.04) return 1;
      if (result.visualPenalty >= 0.2 || edge >= 0.16) return 0;
      return null;
    },
  },
  {
    query: 'brown no dark edges ceramic tile',
    label(result) {
      const brown = Number(result.colorProfile?.brown) || 0;
      if ((result.primaryColor === 'brown' || brown >= 0.28) && result.visualPenalty <= 0.16) return 1;
      if (result.visualPenalty >= 0.3 || brown <= 0.05) return 0;
      return null;
    },
  },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value) {
  if (value < -40) return 0;
  if (value > 40) return 1;
  return 1 / (1 + Math.exp(-value));
}

function normalizeFeatures(features = {}) {
  return Object.fromEntries(FEATURE_NAMES.map((name) => [name, Number(features[name]) || 0]));
}

function score(weights, features) {
  return FEATURE_NAMES.reduce((sum, name) => sum + weights[name] * features[name], 0);
}

function labelFromFeedback(entry) {
  const label = String(entry.label || '').toLowerCase();
  if (label === 'good' || label === 'positive') return 1;
  if (label === 'bad' || label === 'negative') return 0;
  return null;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFeedbackExamples() {
  if (!(await fileExists(FEEDBACK_PATH))) return [];

  const lines = (await fs.readFile(FEEDBACK_PATH, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((entry) => {
      const label = labelFromFeedback(entry);
      const features = normalizeFeatures(entry.features);
      if (label == null || Object.values(features).every((value) => value === 0)) return null;
      return {
        source: 'feedback',
        label,
        sampleWeight: 1.4,
        features,
      };
    })
    .filter(Boolean);
}

function runSearch(query) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['search.mjs', query], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TOP_K: process.env.TRAIN_TOP_K || '120',
        IGNORE_TRAINED_WEIGHTS: '1',
        ALLOW_REMOTE: process.env.ALLOW_REMOTE ?? '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `search.mjs exited with code ${code}`));
        return;
      }

      const jsonLine = stdout
        .trim()
        .split(/\r?\n/)
        .reverse()
        .find((line) => line.trim().startsWith('{'));
      if (!jsonLine) {
        reject(new Error(`search.mjs did not return JSON: ${stdout}`));
        return;
      }

      resolve(JSON.parse(jsonLine));
    });
  });
}

async function buildSeedExamples() {
  const examples = [];

  for (const prompt of SEED_PROMPTS) {
    const response = await runSearch(prompt.query);
    for (const result of response.results || []) {
      const label = prompt.label(result);
      if (label == null) continue;
      examples.push({
        source: 'seed',
        label,
        sampleWeight: 0.35,
        features: normalizeFeatures(result.features),
      });
    }
  }

  return examples;
}

function trainWeights(examples) {
  const weights = { ...DEFAULT_WEIGHTS };
  const learningRate = 0.035;
  const l2 = 0.001;

  for (let epoch = 0; epoch < 550; epoch += 1) {
    for (const example of examples) {
      const probability = sigmoid(score(weights, example.features));
      const error = (example.label - probability) * example.sampleWeight;

      for (const name of FEATURE_NAMES) {
        const [min, max] = LIMITS[name];
        const regularization = name === 'bias' ? 0 : l2 * (weights[name] - DEFAULT_WEIGHTS[name]);
        weights[name] = clamp(
          weights[name] + learningRate * (error * example.features[name] - regularization),
          min,
          max,
        );
      }
    }
  }

  return Object.fromEntries(
    Object.entries(weights).map(([name, value]) => [name, Number(value.toFixed(6))]),
  );
}

function evaluate(weights, examples) {
  let correct = 0;
  let total = 0;
  for (const example of examples) {
    const prediction = sigmoid(score(weights, example.features)) >= 0.5 ? 1 : 0;
    if (prediction === example.label) correct += 1;
    total += 1;
  }

  return {
    examples: total,
    accuracy: total ? Number((correct / total).toFixed(4)) : 0,
  };
}

async function main() {
  await fs.mkdir(TRAINING_DIR, { recursive: true });

  const [feedbackExamples, seedExamples] = await Promise.all([
    readFeedbackExamples(),
    buildSeedExamples(),
  ]);
  const examples = [...seedExamples, ...feedbackExamples];
  const weights = examples.length > 0 ? trainWeights(examples) : DEFAULT_WEIGHTS;
  const metrics = evaluate(weights, examples);
  const output = {
    version: 1,
    trainedAt: new Date().toISOString(),
    weights,
    metrics,
    counts: {
      seedExamples: seedExamples.length,
      feedbackExamples: feedbackExamples.length,
    },
  };

  await fs.writeFile(WEIGHTS_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
