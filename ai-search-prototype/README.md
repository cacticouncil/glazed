# Local AI Tile Search Prototype

This folder contains the local command-line search engine used by the Glazy desktop app's AI Search tab.

## Goal

Given a natural-language prompt like:

```text
a red ceramic tile with a warm feeling
```

return top matching tile IDs/images from the local MariaDB tile database.

## Local-Only Runtime

Model files are cached in:

```text
ai-search-prototype/model-cache
```

After the first model download, the evaluator can run with remote model loading disabled.

Run a first-time setup/search. This downloads the CLIP model into `model-cache` if it is not already there:

```bash
cd ai-search-prototype
npm install

set -a
source ../.env
set +a

env ALLOW_REMOTE=1 CLIP_MODEL=Xenova/clip-vit-base-patch16 npm run evaluate -- "a red ceramic tile with a warm feeling"
```

After the model is cached, use offline/local mode:

```bash
env ALLOW_REMOTE=0 CLIP_MODEL=Xenova/clip-vit-base-patch16 npm run evaluate -- "a red ceramic tile with a warm feeling"
```

For the desktop app search command, the first uncached run embeds only the strongest initial candidates by default:

```bash
env ALLOW_REMOTE=0 CLIP_MODEL=Xenova/clip-vit-base-patch16 EMBEDDING_PREFILTER=60 node search.mjs "dark blue sea no dark edges ceramic tile"
```

Set `EMBEDDING_PREFILTER=0` to warm/cache every missing tile image before ranking.

For repeated searches, use the worker mode. It keeps the model loaded and reads one JSON request per line from stdin:

```bash
npm run worker
```

Example request line:

```json
{"query":"dark blue sea no dark edges ceramic tile"}
```

The desktop app uses this mode by default when `AI_SEARCH_WORKER=1`.

## Training Ranking Weights

The search ranker can learn from feedback saved by the desktop app. Feedback is written to:

```text
training-data/feedback.jsonl
```

Train or retrain weights:

```bash
npm run train
```

The trainer writes:

```text
training-data/ranking-weights.json
```

`search.mjs` loads that file automatically. Set `IGNORE_TRAINED_WEIGHTS=1` to compare against the default handcrafted weights.

## Candidates Tried

1. Dominant color/profile heuristic baseline
   - Uses `PrimaryColor`, `ColorProfile`, and `DominantColors` when those columns are populated.
   - Falls back to existing `Color_L`, `Color_A`, `Color_B` values for older rows.
   - Better for explicit color words like blue, red, black, warm, dark, bright, earthy.
   - Handles multi-color tiles better because a mostly blue tile with small red/black areas still has a high blue percentage.
   - Bad for abstract visual style, texture, “cozy,” “minimal,” “traditional,” etc.

2. Metadata text baseline
   - Searches GlazeType, SurfaceCondition, FiringType, SoilType, ChemicalComposition.
   - Bad right now because imported rows mostly have blank metadata.
   - Could become useful later if the annotation/export workflow captures richer text fields.

3. CLIP text-to-image retrieval
   - Tested `Xenova/clip-vit-base-patch32`.
   - Tested `Xenova/clip-vit-base-patch16`.
   - Best fit because it compares prompt text directly against tile images.
   - `patch16` matched warm red-brown tiles better than `patch32` in the quick test.

4. Caption-then-text retrieval
   - Tested `Xenova/vit-gpt2-image-captioning`.
   - Poor fit: it described tiles as generic objects such as cake/paper/plate.
   - Not recommended as the main search model.

## Current Recommendation

Use a hybrid:

```text
final_score = CLIP image/text similarity + dominant-color intent boost + optional metadata boost + visual constraint score
```

Recommended model to start:

```text
Xenova/clip-vit-base-patch16
```

Why:

- Runs locally through ONNX/Transformers.js.
- Works directly with images, which matters because metadata is sparse.
- Handles fuzzy prompts better than color-only rules.
- Uses cached visual edge metrics for constraints like "no dark edges" or "no brown borders".
- Small enough to be practical compared with a local vision-language chat model.

## Still Future Work

- No backend endpoint.
- No supervised model training set yet.

The production version should precompute image embeddings once, store them locally, and answer searches by embedding the prompt and ranking vectors.
