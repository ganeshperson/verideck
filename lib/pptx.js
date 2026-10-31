// Extract slide text (and speaker notes) from a .pptx buffer.
import { readZip } from './zip.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

// Each <a:p> paragraph becomes one line; runs (<a:t>) inside it are joined.
export function paragraphsFromXml(xml) {
  const lines = [];
  for (const [, body] of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const text = [...body.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\/>/g)]
      .map((m) => (m[1] === undefined ? '\n' : decodeXml(m[1])))
      .join('')
      .trim();
    if (text) lines.push(text);
  }
  return lines;
}

function relsTarget(rels, type) {
  if (!rels) return null;
  for (const [tag] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (tag.includes(type)) return tag.match(/Target="([^"]+)"/)?.[1] ?? null;
  }
  return null;
}

function slideOrder(zip) {
  // Prefer presentation.xml order; fall back to numeric file order.
  const pres = zip.readText('ppt/presentation.xml');
  const rels = zip.readText('ppt/_rels/presentation.xml.rels');
  if (pres && rels) {
    const map = new Map();
    for (const [tag] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = tag.match(/Id="([^"]+)"/)?.[1];
      const target = tag.match(/Target="([^"]+)"/)?.[1];
      if (id && target) map.set(id, 'ppt/' + target.replace(/^\/?ppt\//, '').replace(/^\.\.\//, ''));
    }
    const ordered = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)]
      .map((m) => map.get(m[1]))
      .filter((p) => p && zip.has(p));
    if (ordered.length) return ordered;
  }
  return zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
}

export function parsePptx(buf) {
  const zip = readZip(buf);
  const paths = slideOrder(zip);
  if (!paths.length) throw new Error('No slides found in this file');

  return paths.map((path, i) => {
    const lines = paragraphsFromXml(zip.readText(path) ?? '');
    const file = path.split('/').pop();
    const notesRel = relsTarget(zip.readText(`ppt/slides/_rels/${file}.rels`), '/notesSlide');
    let notes = [];
    if (notesRel) {
      const notesPath = 'ppt/' + notesRel.replace(/^\.\.\//, '');
      // Drop the slide-number placeholder that notes pages usually contain.
      notes = paragraphsFromXml(zip.readText(notesPath) ?? '').filter((l) => !/^\d+$/.test(l));
    }
    return { index: i + 1, title: lines[0] ?? `Slide ${i + 1}`, lines, notes };
  });
}

// Plain-text/markdown decks: slides separated by a line of `---`.
export function parseText(text) {
  return text
    .split(/^\s*-{3,}\s*$/m)
    .map((chunk) => chunk.split('\n').map((l) => l.replace(/^\s*(#+|[-*•]|\d+\.)\s+/, '').trim()).filter(Boolean))
    .filter((lines) => lines.length)
    .map((lines, i) => ({ index: i + 1, title: lines[0], lines, notes: [] }));
}
