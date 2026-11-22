// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Sections 5 to 8: line matching and the three other formats. */

let STRICT = false;
/** [old, new] pairs of move edits that ran, for the `R` output lines (section 2). */
const MOVES: Array<[string, string]> = [];

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

/** Section 3: a file's lines, its line break and whether it ends with one. */
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Section 5: the tiers, in order. */
function tiers(): number[] {
  return STRICT ? [0] : [0, 1, 2];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at which O occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(O[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions, or null. */
function findTier(lines: string[], O: string[], from: number, eofOnly: boolean): [number, number[]] | null {
  for (const t of tiers()) {
    let occ = occurrences(lines, O, t, from);
    if (eofOnly) occ = occ.filter((p) => p + O.length === lines.length);
    if (occ.length > 0) return [t, occ];
  }
  return null;
}

/** O and N of a hunk/chunk/block, with which N lines are context lines (and which O line they are). */
interface Block {
  O: string[];
  N: string[];
  ctx: boolean[];
  ctxO: number[];
}

type BodyKind = ' ' | '-' | '+';
interface BodyLine {
  kind: BodyKind | '\\';
  text: string;
  raw: string;
}

function buildBlock(body: BodyLine[]): Block {
  const O: string[] = [];
  const N: string[] = [];
  const ctx: boolean[] = [];
  const ctxO: number[] = [];
  for (const l of body) {
    if (l.kind === ' ') { ctx.push(true); ctxO.push(O.length); O.push(l.text); N.push(l.text); }
    else if (l.kind === '-') O.push(l.text);
    else if (l.kind === '+') { ctx.push(false); ctxO.push(-1); N.push(l.text); }
  }
  return { O, N, ctx, ctxO };
}

/** Replace O at `at` by N (section 5): context lines from the file, tier-2 re-indentation. */
function replaceAt(lines: string[], at: number, b: Block, tier: number): string[] {
  const out = lines.slice();
  const F = b.O.length > 0 ? leadingWs(lines[at] ?? '') : '';
  const P = b.O.length > 0 ? leadingWs(b.O[0]!) : '';
  const repl = b.N.map((line, i) => {
    if (b.ctx[i]) return lines[at + b.ctxO[i]!]!;
    if (tier === 2 && line.trim() !== '' && line.startsWith(P)) return F + line.slice(P.length);
    return line;
  });
  out.splice(at, b.O.length, ...repl);
  return out;
}

/** Section 6: one hunk of a unified diff. */
interface Hunk {
  a: number;
  block: Block;
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** The `+` lines, in order, and whether a `\` line follows the last of them. */
  plus: string[];
  plusNoEol: boolean;
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  pairSet: boolean;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  return stripAB(p);
}

function parseDiffGit(line: string, num: number): [string, string] {
  const m = /^diff --git a\/([^ ]+) b\/([^ ]+)[ \t]*$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${num}`);
  return [m[1]!, m[2]!];
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const line = lines[i]!;
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = parseInt(m[1]!, 10);
  const body: BodyLine[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push({ kind: (l === '' ? ' ' : l[0]) as BodyKind | '\\', text: l === '' ? '' : l.slice(1), raw: l });
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  let noEol = false;
  let plusNoEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') {
      noEol = body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
      break;
    }
  }
  const plus: string[] = [];
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === '+') {
      plus.push(body[k]!.text);
      plusNoEol = body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
    }
  }
  return { hunk: { a, block: buildBlock(body), noEol, plus, plusNoEol }, next: j };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const fresh = (): USection => ({ diffOld: null, diffNew: null, pairOld: null, pairNew: null, pairSet: false, renameOld: null, renameNew: null, newFile: false, deletedFile: false, hunks: [] });
  const close = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [o, n] = parseDiffGit(line, i + 1);
      close();
      cur = fresh();
      cur.diffOld = o;
      cur.diffNew = n;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !cur.pairSet && cur.hunks.length === 0) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.pairSet = true;
        i += 2;
        continue;
      }
      close();
      cur = fresh();
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      cur.pairSet = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    if (cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  close();
  return sections.map(unifiedEdit);
}

/** Apply one hunk to the file's lines and final-break flag (section 6). */
function applyHunk(lines: string[], final: boolean, h: Hunk, d: number, path: string): { lines: string[]; final: boolean } {
  const b = h.block;
  if (b.O.length === 0) {
    const pos = Math.min(Math.max(h.a + d, 0), lines.length);
    const out = lines.slice();
    out.splice(pos, 0, ...b.N);
    const atEnd = pos === lines.length;
    return { lines: out, final: atEnd ? !h.noEol : final };
  }
  const found = findTier(lines, b.O, 0, false);
  if (found === null) throw new Fail('no-match', path);
  const [tier, occ] = found;
  const target = h.a - 1 + d;
  let at = occ[0]!;
  for (const p of occ) {
    if (Math.abs(p - target) < Math.abs(at - target)) at = p;
  }
  const out = replaceAt(lines, at, b, tier);
  const atEnd = at + b.O.length === lines.length;
  return { lines: out, final: atEnd ? !h.noEol : final };
}

function unifiedEdit(sec: USection): Edit {
  const oldP = sec.pairOld ?? sec.renameOld ?? sec.diffOld;
  const newP = sec.pairNew ?? sec.renameNew ?? sec.diffNew;
  const isCreate = oldP === null || sec.newFile;
  const isDelete = !isCreate && (newP === null || sec.deletedFile);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let final = true;
      for (const h of sec.hunks) {
        plus.push(...h.plus);
        if (h.plus.length > 0) final = !h.plusNoEol;
      }
      tree.now.set(newP, joinFile(plus, '\n', final));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const p = oldP!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let parts = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(parts.lines, parts.final, h, d, p);
      parts = { lines: r.lines, br: parts.br, final: r.final };
      d += h.block.N.length - h.block.O.length;
    }
    const out = joinFile(parts.lines, parts.br, parts.final);
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(newP!, out);
      MOVES.push([p, newP!]);
    } else {
      tree.now.set(p, out);
    }
  };
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let k = i + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '=======') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let m = k + 1;
    while (m < lines.length && lines[m]!.trimEnd() !== '>>>>>>> REPLACE') m++;
    if (m >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, k), lines.slice(k + 1, m)));
    prevPath = path;
    prevEnd = m + 1;
    i = m + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile(newLines, '\n', true));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const found = findTier(parts.lines, oldLines, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const [tier, occ] = found;
    if (occ.length !== 1) throw new Fail('ambiguous', path);
    const b: Block = { O: oldLines, N: newLines, ctx: newLines.map(() => false), ctxO: newLines.map(() => -1) };
    tree.now.set(path, joinFile(replaceAt(parts.lines, occ[0]!, b, tier), parts.br, parts.final));
  };
}

/** Section 8: V4A patches. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VRawLine {
  text: string;
  num: number;
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface VSec {
    kind: 'add' | 'delete' | 'update';
    path: string;
    start: number;
    raw: VRawLine[];
  }
  const sections: VSec[] = [];
  let cur: VSec | null = null;
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    const num = i + 1;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) { kind = 'add'; path = l.slice('*** Add File: '.length).trim(); }
    else if (l.startsWith('*** Delete File: ')) { kind = 'delete'; path = l.slice('*** Delete File: '.length).trim(); }
    else if (l.startsWith('*** Update File: ')) { kind = 'update'; path = l.slice('*** Update File: '.length).trim(); }
    if (kind !== null) {
      cur = { kind, path, start: num, raw: [] };
      sections.push(cur);
    } else if (blank(l)) {
      if (cur !== null) cur.raw.push({ text: l, num });
    } else if (cur === null) {
      throw new Exit2(`error: parse ${num}`);
    } else {
      cur.raw.push({ text: l, num });
    }
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    while (s.raw.length > 0 && s.raw[s.raw.length - 1]!.text.trim() === '') s.raw.pop();
    if (s.kind === 'add') {
      const fileLines: string[] = [];
      for (const r of s.raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(vAddEdit(s.path, fileLines));
    } else if (s.kind === 'delete') {
      if (s.raw.length > 0) throw new Exit2(`error: parse ${s.raw[0]!.num}`);
      edits.push(vDeleteEdit(s.path));
    } else {
      edits.push(vUpdateEdit(s.path, s.start, s.raw));
    }
  }
  return edits;
}

function vAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinFile(fileLines, '\n', true));
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, startLine: number, raw: VRawLine[]): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const t = r.text;
    if (t === '@@' || t.startsWith('@@ ') || t.startsWith('@@\t')) {
      const anchor = t.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
    } else if (t.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.num}`);
      cur.eof = true;
      cur = null;
    } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      cur.body.push({ kind: (t === '' ? ' ' : t[0]) as BodyKind | '\\', text: t === '' ? '' : t.slice(1), raw: t });
    } else {
      throw new Exit2(`error: parse ${r.num}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
  const blocks = chunks.map((c) => ({ anchor: c.anchor, eof: c.eof, block: buildBlock(c.body) }));
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let parts = splitFile(before);
    let cursor = 0;
    for (const ch of blocks) {
      if (ch.anchor !== null) {
        const found = findTier(parts.lines, [ch.anchor], cursor, false);
        if (found === null) throw new Fail('no-match', path);
        cursor = found[1][0]! + 1;
      }
      const b = ch.block;
      if (b.O.length === 0) {
        const pos = ch.eof ? parts.lines.length : cursor;
        const out = parts.lines.slice();
        out.splice(pos, 0, ...b.N);
        parts = { lines: out, br: parts.br, final: parts.final };
        cursor = pos + b.N.length;
      } else {
        const found = findTier(parts.lines, b.O, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const [tier, occ] = found;
        const at = occ[0]!;
        parts = { lines: replaceAt(parts.lines, at, b, tier), br: parts.br, final: parts.final };
        cursor = at + b.N.length;
      }
    }
    const out = joinFile(parts.lines, parts.br, parts.final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      MOVES.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  STRICT = strict;
  MOVES.length = 0;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines) : kind === 'search-replace' ? parseSearchReplace(lines) : parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const used = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of MOVES) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o !== undefined && n !== undefined && o.was !== null && o.now === null && n.was === null && n.now !== null && !used.has(oldP) && !used.has(newP)) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const [p, { was, now }] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const linesOut = rows.map((r) => r.line);
  if (!check) {
    for (const [p, { now }] of changed) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...linesOut, `ok: ${linesOut.length} ${linesOut.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
