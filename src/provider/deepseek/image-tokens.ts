/**
 * DeepSeek vision token accounting — the provider's published `v41` calculator.
 *
 * This is a faithful port of the first-party implementation referenced by the
 * budget document: 14px patches, a 3:1 per-axis downsample, a 544×544 total-pixel
 * floor, one row separator per row plus two framing tokens, and a 1024-token
 * cap solved as the largest aspect-preserving grid that fits. It is a local
 * calculator, not a claim that the API's usage will be byte-identical: usage is
 * authoritative and is recorded separately.
 *
 * Source: deepseek-harness `packages/llm/llm-deepseek/src/image-tokens.ts`
 * (retrieved 2026-11-08, master at implementation time), following the DeepSeek
 * vision guide. Policy revision: `deepseek-flash-v41`.
 *
 * Test vectors from the acceptance document are asserted in
 * `tests/provider/image-tokens.test.ts`. A rule change belongs here, with a new
 * policy revision and new vectors — never in the generic request planner.
 */

/** Vision patch edge in pixels. */
const PATCH_SIZE = 14;
/** Per-axis patch-to-token downsampling ratio. */
const DOWNSAMPLE_RATIO = 3;
/** Provider cap on tokens for one request image. */
const MAX_IMAGE_TOKENS = 1024;
/** Total-pixel floor; smaller images are scaled up before grid projection. */
const MIN_PIXELS = 544 * 544;
/** Pixels covered by one token cell along either axis. */
const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO;

export const DEEPSEEK_IMAGE_POLICY_REVISION = 'deepseek-flash-v41';

const intDiv = (value: number, divisor: number): number => Math.floor(value / divisor);
const ceilDiv = (value: number, divisor: number): number =>
  Math.floor((value + divisor - 1) / divisor);

interface GridResize {
  readonly gridHeight: number;
  readonly gridWidth: number;
  readonly bestHeight: number;
  readonly bestWidth: number;
  readonly numTokens: number;
}

/** Every row carries a separator, plus two framing tokens. */
function gridTokens(gridHeight: number, gridWidth: number): number {
  return gridHeight * (gridWidth + 1) + 2;
}

function gridCells(paddedLength: number): number {
  return ceilDiv(intDiv(paddedLength, PATCH_SIZE), DOWNSAMPLE_RATIO);
}

/** Solve the largest grid within `budget` tokens preserving the aspect ratio. */
function solveResizeRatio(height: number, width: number, budget: number): GridResize {
  const aspect = height / width;
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5;
  const idealGridHeight = idealGridWidth * aspect;
  let bestHeight: number;
  let bestWidth: number;
  if (idealGridWidth < 1) {
    const solvedGridWidth = 1;
    const solvedGridHeight = intDiv(budget - 2, solvedGridWidth + 1);
    bestWidth = solvedGridWidth * CELL_SIZE;
    bestHeight = solvedGridHeight * CELL_SIZE;
  } else if (idealGridHeight < 1) {
    const solvedGridHeight = 1;
    const solvedGridWidth = intDiv(budget - 2, solvedGridHeight) - 1;
    bestWidth = solvedGridWidth * CELL_SIZE;
    bestHeight = solvedGridHeight * CELL_SIZE;
  } else {
    const solvedGridWidth = Math.trunc(idealGridWidth);
    const solvedGridHeight = Math.trunc(idealGridHeight);
    const scale = Math.min(
      (solvedGridWidth * CELL_SIZE) / width,
      (solvedGridHeight * CELL_SIZE) / height,
    );
    bestWidth = Math.trunc((width * scale) / PATCH_SIZE) * PATCH_SIZE;
    bestHeight = Math.trunc((height * scale) / PATCH_SIZE) * PATCH_SIZE;
  }
  const gridHeight = gridCells(bestHeight);
  const gridWidth = gridCells(bestWidth);
  return { gridHeight, gridWidth, bestHeight, bestWidth, numTokens: gridTokens(gridHeight, gridWidth) };
}

function safeResize(
  height: number,
  width: number,
  paddedHeight: number,
  paddedWidth: number,
): GridResize {
  const gridHeight = gridCells(paddedHeight);
  const gridWidth = gridCells(paddedWidth);
  const direct: GridResize = {
    gridHeight,
    gridWidth,
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(gridHeight, gridWidth),
  };
  if (direct.numTokens <= MAX_IMAGE_TOKENS) return direct;
  const solved = solveResizeRatio(height, width, MAX_IMAGE_TOKENS);
  if (solved.numTokens > MAX_IMAGE_TOKENS) {
    throw new Error(
      `deepseek image tokens: no grid fits the token budget for ${width}x${height}`,
    );
  }
  return solved;
}

function resizeOnce(width: number, height: number): GridResize {
  let scaledWidth = width;
  let scaledHeight = height;
  const pixels = scaledWidth * scaledHeight;
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels);
    scaledWidth = Math.trunc(scaledWidth * scale);
    scaledHeight = Math.trunc(scaledHeight * scale);
  }
  const paddedWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE;
  const paddedHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE;
  return safeResize(scaledHeight, scaledWidth, paddedHeight, paddedWidth);
}

function sameResize(a: GridResize, b: GridResize): boolean {
  return (
    a.gridHeight === b.gridHeight &&
    a.gridWidth === b.gridWidth &&
    a.bestHeight === b.bestHeight &&
    a.bestWidth === b.bestWidth &&
    a.numTokens === b.numTokens
  );
}

/**
 * Tokens the provider charges for one request image of these dimensions.
 *
 * Dimensions must be the encoded request image's actual width and height — not
 * the browser's claim and not the original's size when a smaller variant is
 * sent. Invalid dimensions are refused rather than coerced to zero, because zero
 * is the one answer that would silently make an image free.
 */
export function deepSeekImageTokens(width: number, height: number): number {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    // The product's own upload limit is far below this; the guard keeps the
    // solver's arithmetic out of the range where width*height stops being a
    // safe integer.
    !Number.isSafeInteger(width * height)
  ) {
    throw new Error(`deepseek image tokens: invalid dimensions ${width}x${height}`);
  }
  let result = resizeOnce(width, height);
  for (let iteration = 1; iteration < 10; iteration += 1) {
    const next = resizeOnce(result.bestWidth, result.bestHeight);
    if (sameResize(next, result)) return result.numTokens;
    result = next;
  }
  throw new Error(`deepseek image tokens: resize did not converge for ${width}x${height}`);
}
