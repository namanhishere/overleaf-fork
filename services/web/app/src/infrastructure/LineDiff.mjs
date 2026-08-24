// Shared LCS-based line diff used by the AI proposal workflow and the
// release diff view. Each hunk replaces
// previousLines[beforeStart .. beforeStart+beforeLines.length) with
// afterLines; unchanged lines between hunks are implied.

function computeHunks(previousLines, newLines) {
  const a = previousLines || [];
  const b = newLines || [];
  // LCS table (capped to keep proposals cheap on huge files)
  const MAX = 2000;
  const A = a.slice(0, MAX);
  const B = b.slice(0, MAX);
  const m = A.length;
  const n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        A[i] === B[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // walk to get matched pairs
  const ops = []; // {type: 'same'|'del'|'add', aIdx, bIdx}
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      ops.push({ type: "same", aIdx: i, bIdx: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", aIdx: i });
      i++;
    } else {
      ops.push({ type: "add", bIdx: j });
      j++;
    }
  }
  while (i < m) ops.push({ type: "del", aIdx: i++ });
  while (j < n) ops.push({ type: "add", bIdx: j++ });
  // group consecutive del/add runs into hunks
  const hunks = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === "same") {
      k++;
      continue;
    }
    const beforeLines = [];
    const afterLines = [];
    const beforeStart = ops[k].aIdx ?? a.length;
    const afterStart = ops[k].bIdx ?? b.length;
    while (k < ops.length && ops[k].type !== "same") {
      if (ops[k].type === "del") beforeLines.push(A[ops[k].aIdx]);
      else afterLines.push(B[ops[k].bIdx]);
      k++;
    }
    hunks.push({ beforeStart, beforeLines, afterStart, afterLines });
  }
  return hunks;
}

function renderDiff(hunks, previousLines, newLines) {
  const a = previousLines || [];
  const b = newLines || [];
  const out = [];
  let pi = 0;
  for (const h of hunks) {
    while (pi < h.beforeStart && pi < a.length) out.push(`  ${a[pi++]}`);
    for (const l of h.beforeLines) out.push(`- ${l}`);
    for (const l of h.afterLines) out.push(`+ ${l}`);
    pi = h.beforeStart + h.beforeLines.length;
  }
  while (pi < a.length) out.push(`  ${a[pi++]}`);
  return out;
}

// Render a unified-ish diff from stored hunks
function hunkDiff(hunks, previousLines) {
  return renderDiff(hunks || [], previousLines, []);
}

export default { computeHunks, renderDiff };
