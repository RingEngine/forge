import { writeFileSync } from 'node:fs';
import { RUNTIME_VERSION } from '../src/runtime-config.js';

const DOCS_RAW_BASE_URL = `https://raw.githubusercontent.com/RingEngine/docs/runtime-${RUNTIME_VERSION}`;

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

const filterSrcSchema = await fetchText(`${DOCS_RAW_BASE_URL}/schemas/filter-src.schema.json`);

writeFileSync(new URL('../schemas/filter-src.schema.json', import.meta.url), filterSrcSchema);
console.log(`schemas/filter-src.schema.json updated from ${DOCS_RAW_BASE_URL}`);
