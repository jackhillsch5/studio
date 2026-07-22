#!/usr/bin/env node
/**
 * fetch-assets.mjs — vendor CC0/MIT/ISC assets into the vidgen repo.
 *
 * Runs in the PUBLIC studio repo (which has internet on CI). It reads the
 * PRIVATE vidgen repo's src/assetRegistry.ts + asset-sources.json, downloads
 * exactly the icons the registry references (keeps the private repo lean and
 * perfectly in sync), fetches the Open Doodles vector set (faceless, best
 * effort), optimizes everything, and writes assets-manifest.json +
 * ASSETS-LICENSES.md. It never invents assets: only packs declared in
 * asset-sources.json with a permissive licence are fetched.
 *
 * Usage:
 *   node scripts/fetch-assets.mjs --repo vidgen [--packs all|lucide,tabler] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
      acc.push([k, v]);
    }
    return acc;
  }, [])
);
const REPO = args.repo || '.';
const DRY = !!args['dry-run'];
const ONLY = args.packs && args.packs !== 'all' ? String(args.packs).split(',').map((s) => s.trim()) : null;

const log = (...m) => console.log(...m);
const warn = (...m) => console.warn('WARN:', ...m);
const die = (m) => { console.error('ERROR:', m); process.exit(1); };

const registryPath = path.join(REPO, 'src/assetRegistry.ts');
const sourcesPath = path.join(REPO, 'asset-sources.json');
if (!fs.existsSync(registryPath)) die(`missing ${registryPath}`);
if (!fs.existsSync(sourcesPath)) die(`missing ${sourcesPath}`);

// 1) Parse the registry (order: concept, kind, file, pack, license).
const regText = fs.readFileSync(registryPath, 'utf8');
const RE = /\{[^{}]*?concept:\s*'([^']+)'[^{}]*?kind:\s*'([^']+)'[^{}]*?file:\s*'([^']+)'[^{}]*?pack:\s*'([^']+)'[^{}]*?license:\s*'([^']+)'[^{}]*?\}/g;
const entries = [...regText.matchAll(RE)].map((m) => ({ concept: m[1], kind: m[2], file: m[3], pack: m[4], license: m[5] }));
if (entries.length === 0) die('parsed 0 registry entries — check assetRegistry.ts shape');
log(`Registry: ${entries.length} asset entries`);

const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
const packs = sources.packs || {};

// group registry entries by pack
const byPack = {};
for (const e of entries) (byPack[e.pack] ||= []).push(e);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-'));
const manifest = [];
const sh = (cmd, opts = {}) => cp.execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });

const hasSvgo = (() => { try { sh('npx --yes svgo --version'); return true; } catch { return false; } })();
function optimize(file) {
  if (DRY) return;
  try {
    if (hasSvgo) sh(`npx --yes svgo --multipass -q -i "${file}" -o "${file}"`);
  } catch (e) { warn(`svgo failed on ${path.basename(file)}: ${String(e).slice(0, 120)}`); }
}

// Best-effort faceless transform for figure illustrations (Open Doodles etc.).
// Removes elements whose id/class references a face part. Documented as
// best-effort: a manual QA pass is still recommended (see ASSETS-LICENSES.md).
function stripFaces(svg) {
  const facePart = 'face|eyes?|pupils?|iris|mouth|lips?|brows?|eyebrows?|nose|smile|lash(?:es)?|teeth|cheeks?';
  const idClass = new RegExp(`<(g|path|circle|ellipse|polyline|polygon|line|rect)\\b[^>]*?\\b(id|class)="[^"]*(?:${facePart})[^"]*"[^>]*?(/>|>[\\s\\S]*?</\\1>)`, 'gi');
  let out = svg, prev;
  do { prev = out; out = out.replace(idClass, ''); } while (out !== prev);
  return out;
}

function copySvg(srcFile, destRel, { face = false } = {}) {
  const dest = path.join(REPO, destRel);
  if (DRY) { log(`  would copy ${path.basename(srcFile)} -> ${destRel}`); return true; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let svg = fs.readFileSync(srcFile, 'utf8');
  if (face) svg = stripFaces(svg);
  fs.writeFileSync(dest, svg);
  optimize(dest);
  return true;
}

// find an svg by basename anywhere under dir
function findByBasename(dir, base) {
  const want = base.toLowerCase();
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name.toLowerCase() === want) return p;
    }
  }
  return null;
}

function fetchNpm(spec) {
  // npm pack downloads the tarball without installing; extract into TMP.
  const dir = fs.mkdtempSync(path.join(TMP, 'npm-'));
  const tgz = sh(`npm pack ${spec} --silent`, { cwd: dir }).trim().split('\n').pop().trim();
  sh(`tar -xzf "${tgz}"`, { cwd: dir });
  return path.join(dir, 'package');
}

function fetchZip(url) {
  const dir = fs.mkdtempSync(path.join(TMP, 'zip-'));
  sh(`curl -fsSL "${url}" -o src.zip`, { cwd: dir });
  sh(`unzip -oq src.zip`, { cwd: dir });
  return dir;
}

function fetchGit(url, ref) {
  const dir = fs.mkdtempSync(path.join(TMP, 'git-'));
  sh(`git clone --depth 1 ${ref ? `--branch ${ref}` : ''} "${url}" repo`, { cwd: dir });
  return path.join(dir, 'repo');
}

function resolveSource(pack, def) {
  if (DRY) return null;
  if (def.type === 'npm') return fetchNpm(def.spec);
  if (def.type === 'zip') return fetchZip(def.spec);
  if (def.type === 'git') return fetchGit(def.spec, def.ref);
  throw new Error(`unknown source type ${def.type} for ${pack}`);
}

let missing = 0;

// 2) ICON PACKS — fetch only the basenames the registry references.
for (const [pack, list] of Object.entries(byPack)) {
  if (ONLY && !ONLY.includes(pack)) continue;
  const def = packs[pack];
  if (!def) { warn(`registry uses pack "${pack}" but asset-sources.json has no entry`); continue; }
  if (def.type === 'zip' && (!def.spec || String(def.spec).includes('CONFIGURE'))) { warn(`pack "${pack}" source not configured — skipping`); continue; }
  log(`\n== pack ${pack} (${def.type}:${def.spec}) — ${list.length} icon(s) ==`);
  let root = null;
  try { root = resolveSource(pack, def); } catch (e) { warn(`fetch failed for ${pack}: ${String(e).slice(0, 160)}`); if (!DRY) continue; }
  for (const e of list) {
    const base = path.basename(e.file);
    let src = null;
    if (!DRY) { src = findByBasename(root, base); if (!src) { warn(`  MISSING ${base} in ${pack}`); missing++; continue; } }
    copySvg(src || base, e.file, { face: false });
    manifest.push({ concept: e.concept, file: e.file, pack, license: e.license, kind: e.kind });
  }
}

// 3) OPEN DOODLES (vector figures) — faceless, best effort.
const od = packs['open-doodles'];
if (od && (!ONLY || ONLY.includes('open-doodles'))) {
  if (!od.spec || String(od.spec).includes('CONFIGURE')) {
    warn('open-doodles source not configured in asset-sources.json — skipping. Set packs."open-doodles".spec to a CC0 git repo or .zip URL.');
  } else {
    log(`\n== open-doodles (${od.type}:${od.spec}) ==`);
    try {
      const root = DRY ? null : resolveSource('open-doodles', od);
      const allow = od.facelessAllowlist || [];
      const destDir = 'assets/vectors/open-doodles';
      if (!DRY) {
        const all = [];
        (function walk(d) { for (const ent of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, ent.name); if (ent.isDirectory()) walk(p); else if (ent.name.endsWith('.svg')) all.push(p); } })(root);
        const picked = allow.length ? all.filter((p) => allow.includes(path.basename(p, '.svg'))) : all;
        if (!allow.length) warn(`facelessAllowlist empty — importing ALL ${picked.length} doodles with best-effort face strip. Curate the allowlist for production.`);
        for (const p of picked) {
          const rel = `${destDir}/${path.basename(p)}`;
          copySvg(p, rel, { face: od.faceStrip !== false });
          manifest.push({ concept: path.basename(p, '.svg'), file: rel, pack: 'open-doodles', license: 'CC0', kind: 'vector' });
        }
      } else {
        log(`  would import Open Doodles into ${destDir} (faceStrip=${od.faceStrip !== false})`);
      }
    } catch (e) { warn(`open-doodles fetch failed: ${String(e).slice(0, 160)}`); }
  }
}

// 4) write manifest + licenses
if (!DRY) {
  const manifestOut = { generatedAt: new Date().toISOString(), count: manifest.length, assets: manifest.sort((a, b) => a.file.localeCompare(b.file)) };
  fs.writeFileSync(path.join(REPO, 'src/assets-manifest.json'), JSON.stringify(manifestOut, null, 2) + '\n');
  const packsUsed = [...new Set(manifest.map((m) => m.pack))];
  const licLines = packsUsed.map((p) => { const d = packs[p] || {}; const lic = manifest.find((m) => m.pack === p)?.license; return `- **${p}** — ${lic} — ${d.homepage || ''}`; });
  const lic = `# Asset licences\n\nAll bundled assets are permissively licensed (CC0 / MIT / ISC) and safe for commercial use.\n\n${licLines.join('\n')}\n\n## Faceless note\nOpen Doodles figures are imported with a best-effort face-strip transform.\nA human QA pass is recommended before publishing; curate\n\`asset-sources.json\` -> packs."open-doodles".facelessAllowlist to lock the set.\n\nGenerated by scripts/fetch-assets.mjs.\n`;
  fs.writeFileSync(path.join(REPO, 'ASSETS-LICENSES.md'), lic);
  log(`\nWrote src/assets-manifest.json (${manifest.length} assets) + ASSETS-LICENSES.md`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
log(`\nDone. copied=${manifest.length} missing=${missing}`);
if (missing > 0 && !DRY) process.exit(2);
