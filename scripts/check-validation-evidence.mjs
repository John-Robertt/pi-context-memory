#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  currentValidationEvidenceKeys,
  stableEvidenceMismatches,
  validationEvidenceDefinition,
} from "./validation-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keys = currentValidationEvidenceKeys();
let failed = false;
for (const key of keys) {
  const relativePath = validationEvidenceDefinition(key).evidencePath;
  const evidence = JSON.parse(readFileSync(join(root, relativePath), "utf8"));
  const mismatches = stableEvidenceMismatches(root, key, evidence);
  if (mismatches.length === 0) {
    console.log(`${relativePath}: current`);
    continue;
  }
  failed = true;
  console.error(`${relativePath}: stale`);
  for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
}
if (failed) process.exitCode = 1;
