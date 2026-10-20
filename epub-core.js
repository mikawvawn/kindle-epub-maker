/*
 * epub-core.js — turns PDFs or plain text into a clean document model, then into an EPUB.
 * Runs in the browser (loaded by index.html) and in Node (for testing).
 * No dependencies of its own: callers pass in pdf.js and JSZip.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Text clean-up helpers
  // ---------------------------------------------------------------------------

  const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

  // Normalise a raw text fragment: ligatures, odd spaces, invisible characters.
  function cleanFragment(s) {
    return s
      .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c])
      .replace(/[  -   　\t]/g, ' ') // exotic spaces -> space
      .replace(/[​-‍⁠﻿­]/g, '') // zero-width + soft hyphen
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, ''); // invalid in XML
  }

  function escapeXml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const END_MARKS = /^[♦◆■□▪◼∎●•❖✦✧⬥◊]$/;
  const BREAK_LINE = /^\s*(?:[*✱∗⁂•·◆♦#~=_-]\s*){1,7}$/; // "* * *", "#", "⁂", "———" …

  // Runs are [{t, i, b}]. Merge neighbours with equal style and tidy whitespace.
  function normaliseRuns(runs) {
    const out = [];
    for (const r of runs) {
      if (!r.t) continue;
      const last = out[out.length - 1];
      if (last && !!last.i === !!r.i && !!last.b === !!r.b) last.t += r.t;
      else out.push({ t: r.t, i: !!r.i, b: !!r.b });
    }
    // Collapse whitespace across run boundaries, and move edge spaces out of styled runs.
    let prevEndsSpace = true;
    for (const r of out) {
      r.t = r.t.replace(/\s+/g, ' ');
      if (prevEndsSpace) r.t = r.t.replace(/^ /, '');
      if (r.t) prevEndsSpace = r.t.endsWith(' ');
    }
    // Spaces at the edge of a styled run belong outside it ("_word _next" -> "_word_ next").
    for (let k = 0; k < out.length; k++) {
      const r = out[k];
      if (!(r.i || r.b)) continue;
      if (r.t.endsWith(' ') && r.t.trim()) {
        r.t = r.t.slice(0, -1);
        if (out[k + 1] && !out[k + 1].t.startsWith(' ')) out[k + 1].t = ' ' + out[k + 1].t;
        else if (!out[k + 1]) out.push({ t: ' ', i: false, b: false });
      }
      if (r.t.startsWith(' ') && r.t.trim()) {
        r.t = r.t.slice(1);
        if (k > 0 && !out[k - 1].t.endsWith(' ')) out[k - 1].t += ' ';
      }
    }
    // Strip trailing space at the end of the paragraph.
    for (let k = out.length - 1; k >= 0; k--) {
      out[k].t = out[k].t.replace(/ $/, '');
      if (out[k].t) break;
    }
    // A styled run whose text is only punctuation/space reads better unstyled
    // (e.g. a stray italic comma) — but keep it if it is a real word.
    for (const r of out) if ((r.i || r.b) && !/[\p{L}\p{N}]/u.test(r.t)) { r.i = false; r.b = false; }
    // Remove spaces before closing punctuation that PDF item joins sometimes create.
    const merged = [];
    for (const r of out) {
      if (!r.t) continue;
      const last = merged[merged.length - 1];
      if (last && last.i === r.i && last.b === r.b) last.t += r.t;
      else merged.push(r);
    }
    for (let k = 0; k < merged.length; k++) {
      merged[k].t = merged[k].t
        .replace(/\.( \.){2,}/g, (m) => m.replace(/ /g, '\uE000')) // protect spaced ellipses ". . ."
        .replace(/ +([,.;:!?)\]]+)(?=[\s”’"]|$)/g, '$1')
        .replace(/ +([”])(?=[\s,.;:!?]|$)/g, '$1')
        .replace(/([(\[“]) +/g, '$1')
        .replace(/\uE000/g, ' ');
      if (k > 0 && /^[,;:!?)\]”]/.test(merged[k].t)) merged[k - 1].t = merged[k - 1].t.replace(/ $/, '');
    }
    return merged.filter((r) => r.t);
  }

  function runsText(runs) {
    return runs.map((r) => r.t).join('');
  }

  // ---------------------------------------------------------------------------
  // Font style detection (reads the embedded OpenType tables pdf.js hands us)
  // ---------------------------------------------------------------------------

  function fontStyle(font) {
    const style = { i: false, b: false };
    if (!font) return style;
    const name = String(font.name || '').replace(/^[A-Z]{6}\+/, '');
    if (/italic|oblique|-it$|-ital|slanted/i.test(name)) style.i = true;
    if (/bold|black|heavy|semibold|demi/i.test(name)) style.b = true;
    if (font.italic) style.i = true;
    if (font.bold || font.black) style.b = true;
    const d = font.data;
    if (d && d.length > 12) {
      try {
        const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
        const n = v.getUint16(4);
        const t = {};
        for (let k = 0; k < n && 12 + k * 16 + 16 <= d.length; k++) {
          const o = 12 + k * 16;
          t[String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3])] = v.getUint32(o + 8);
        }
        if (t['OS/2'] != null) {
          const weight = v.getUint16(t['OS/2'] + 4);
          const fsSel = v.getUint16(t['OS/2'] + 62);
          if (fsSel & 1) style.i = true;
          if (weight >= 600 || fsSel & 32) style.b = true;
        }
        if (t.post != null && v.getInt32(t.post + 4) !== 0) style.i = true;
        if (t.head != null) {
          const mac = v.getUint16(t.head + 44);
          if (mac & 2) style.i = true;
          if (mac & 1) style.b = true;
        }
      } catch (e) { /* not an sfnt font; keep name-based guess */ }
    }
    return style;
  }

  // ---------------------------------------------------------------------------
  // PDF -> document model
  // ---------------------------------------------------------------------------

  function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }
  function percentile(a, p) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }
  // Most common value after rounding to `step`.
  function mode(a, step) {
    const counts = new Map();
    for (const v of a) {
      const k = Math.round(v / step) * step;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let best = 0, bestN = -1;
    for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
    return best;
  }

  async function extractPdf(pdfjsLib, data, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const doc = await pdfjsLib.getDocument({ data, verbosity: 0, fontExtraProperties: true, isEvalSupported: false }).promise;
    const pages = [];
    const fontStyles = new Map();

    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      await page.getOperatorList(); // makes fonts resolvable through commonObjs
      const tc = await page.getTextContent();
      const items = [];
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        const str = cleanFragment(it.str);
        if (!str) continue;
        const tr = it.transform;
        const size = Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]);
        if (Math.abs(tr[1]) > 0.01 * size || Math.abs(tr[2]) > 0.3 * size) continue; // rotated text
        let st = fontStyles.get(it.fontName);
        if (!st) {
          let font = null;
          try { font = page.commonObjs.get(it.fontName); } catch (e) { /* unresolved */ }
          st = fontStyle(font);
          if (font) fontStyles.set(it.fontName, st);
        }
        items.push({ str, x: tr[4], y: tr[5], w: it.width, size, i: st.i, b: st.b, ws: !str.trim() });
      }
      pages.push({ n: p, width: vp.width, height: vp.height, items });
      page.cleanup();
      onProgress(p / doc.numPages, p, doc.numPages);
    }

    let info = {};
    try { info = (await doc.getMetadata()).info || {}; } catch (e) { /* none */ }
    await doc.destroy();
    return layoutToModel(pages, info, opts);
  }

  // Group items (already filtered to one size class) into visual lines.
  function groupLines(items) {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      let line = null;
      for (let k = lines.length - 1; k >= 0 && k >= lines.length - 3; k--) {
        if (Math.abs(lines[k].y - it.y) <= Math.max(1, 0.35 * it.size)) { line = lines[k]; break; }
      }
      if (!line) { line = { y: it.y, items: [], size: it.size }; lines.push(line); }
      line.items.push(it);
    }
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      const solid = l.items.filter((i) => !i.ws);
      const src = solid.length ? solid : l.items;
      l.x0 = Math.min(...src.map((i) => i.x));
      l.x1 = Math.max(...src.map((i) => i.x + i.w));
      l.size = median(src.map((i) => i.size));
      l.runs = lineRuns(l.items);
      l.text = runsText(l.runs).trim();
    }
    return lines.filter((l) => l.text);
  }

  // Join the items of one line into styled runs, inserting spaces only where the gap says so.
  function lineRuns(items) {
    const runs = [];
    let prev = null;
    for (const it of items) {
      if (it.ws) { if (prev) runs.push({ t: ' ', i: prev.i, b: prev.b }); continue; }
      const lineEndHyphen = /^[-\u2010\u2011]$/.test(it.str) && it === items[items.length - 1];
      if (prev && !lineEndHyphen) {
        const gap = it.x - (prev.x + prev.w);
        const last = runs[runs.length - 1];
        const already = last && /\s$/.test(last.t);
        if (!already && gap > 0.18 * it.size && !/^\s/.test(it.str)) runs.push({ t: ' ', i: false, b: false });
      }
      if (lineEndHyphen && runs.length) { runs[runs.length - 1].t = runs[runs.length - 1].t.replace(/\s+$/, '') + '-'; prev = it; continue; }
      runs.push({ t: it.str, i: it.i, b: it.b });
      prev = it;
    }
    return runs;
  }

  function lineKey(text) {
    return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  }

  function layoutToModel(pages, info, opts) {
    const removed = [];
    const allItems = pages.flatMap((p) => p.items.filter((i) => !i.ws));
    if (!allItems.length) {
      return { title: info.Title || 'Untitled', author: info.Author || '', blocks: [], removed, stats: { pages: pages.length }, warnings: ['No text found (scanned PDF?)'] };
    }

    // 1. Body text size = the size carrying the most characters.
    const sizeChars = new Map();
    for (const it of allItems) {
      const k = Math.round(it.size * 4) / 4;
      sizeChars.set(k, (sizeChars.get(k) || 0) + it.str.length);
    }
    let bodySize = 0, bestChars = -1;
    for (const [k, n] of sizeChars) if (n > bestChars) { bodySize = k; bestChars = n; }
    const isBody = (s) => Math.abs(s - bodySize) <= Math.max(0.3, bodySize * 0.03);
    const isHeading = (s) => s >= bodySize * 1.2;

    // 2. Repeated page furniture (running heads, footers, page numbers).
    const marginLineCounts = new Map();
    const pageLines = pages.map((pg) => {
      const lines = groupLines(pg.items);
      for (const l of lines) {
        l.page = pg.n;
        l.inMargin = l.y > pg.height * 0.9 || l.y < pg.height * 0.1;
        if (l.inMargin) {
          const k = lineKey(l.text);
          marginLineCounts.set(k, (marginLineCounts.get(k) || 0) + 1);
        }
      }
      return lines;
    });
    const repeatThreshold = Math.max(2, Math.ceil(pages.length * 0.3));
    const isFurniture = (l) =>
      l.inMargin && (marginLineCounts.get(lineKey(l.text)) >= repeatThreshold || /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(l.text));

    // 3. Body lines: body size only. Regroup per page from body-size items so that
    //    sidebars at other sizes can never interleave with body lines.
    const bodyLinesByPage = pages.map((pg) => {
      const items = pg.items.filter((i) => isBody(i.size));
      const lines = groupLines(items);
      for (const l of lines) {
        l.page = pg.n;
        l.inMargin = l.y > pg.height * 0.9 || l.y < pg.height * 0.1;
      }
      return lines;
    });
    const flatBody = bodyLinesByPage.flat().filter((l) => !isFurniture(l));

    // Body column: where body lines start and end.
    const bodyLeft = mode(flatBody.map((l) => l.x0), 2);
    const bodyRight = percentile(flatBody.map((l) => l.x1), 0.9);
    const colWidth = Math.max(1, bodyRight - bodyLeft);
    const em = bodySize;
    const inColumn = (l) => l.x0 >= bodyLeft - 2 * em && l.x0 < bodyLeft + colWidth * 0.6 && l.x1 <= bodyRight + 3 * em;

    // Line spacing + paragraph spacing, learned from consecutive body lines.
    const deltas = [];
    for (const lines of bodyLinesByPage) {
      for (let k = 1; k < lines.length; k++) {
        const d = lines[k - 1].y - lines[k].y;
        if (d > 0.5 * em && d < 6 * em) deltas.push(d);
      }
    }
    // Line spacing sits between ~1em and ~2em; anything bigger is paragraph or section spacing.
    const lineDeltas = deltas.filter((d) => d >= 0.95 * em && d <= 2.1 * em);
    const lineGap = lineDeltas.length ? mode(lineDeltas, 0.5) : em * 1.2;
    const bigger = deltas.filter((d) => d > lineGap * 1.35);
    const paraGap = bigger.length >= Math.max(3, deltas.length * 0.05) ? mode(bigger, 1) : 0;
    const sceneGap = paraGap ? paraGap * 1.5 : lineGap * 2.2;

    // Does the document indent first lines? (books) — count lines starting 0.5–5em in.
    const indented = flatBody.filter((l) => l.x0 > bodyLeft + 0.5 * em && l.x0 < bodyLeft + 5 * em).length;
    const usesIndent = indented > flatBody.length * 0.04 && !paraGap;
    const indentX = usesIndent ? mode(flatBody.filter((l) => l.x0 > bodyLeft + 0.5 * em && l.x0 < bodyLeft + 5 * em).map((l) => l.x0), 1) : 0;

    // Justified text => line-end hyphens are mostly word breaks.
    const fullLines = flatBody.filter((l) => l.x1 > bodyRight - 0.6 * em).length;
    const justified = fullLines > flatBody.length * 0.6;

    // 4. Title / author from the first page(s).
    let title = '', author = '';
    const firstPages = pages.slice(0, 2);
    let titleSize = 0, titleLines = [];
    for (const pg of firstPages) {
      const ls = groupLines(pg.items.filter((i) => isHeading(i.size)));
      for (const l of ls) {
        l.page = pg.n;
        l.inMargin = l.y > pg.height * 0.9 || l.y < pg.height * 0.1;
        if (isFurniture(l) || l.text.length > 150) continue;
        if (l.size > titleSize + 0.5) { titleSize = l.size; titleLines = [l]; }
        else if (Math.abs(l.size - titleSize) <= 0.5 && titleLines.length) {
          // a second line of the same title: directly below the previous one
          const prev = titleLines[titleLines.length - 1];
          if (prev.y - l.y < l.size * 1.8) titleLines.push(l);
        }
      }
      if (titleLines.length) break;
    }
    if (titleLines.length) title = titleLines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
    for (const pg of firstPages) {
      for (const l of groupLines(pg.items)) {
        const m = /^[Bb][Yy]\s+([\p{Lu}][\p{L}.'’\- ]{1,60})$/u.exec(l.text);
        if (m) { author = m[1].trim(); break; }
      }
      if (author) break;
    }
    const infoTitle = String(info.Title || '').trim();
    const infoAuthor = String(info.Author || '').trim();
    if (!title && infoTitle) {
      title = infoTitle.replace(/\s*[|–—-]\s*[^|–—-]+$/, '');
      const m = /^[“"]?(.+?)[,”"]*\s+by\s+(.+)$/i.exec(title);
      if (m) { title = m[1].replace(/[,”"]+$/, ''); if (!author) author = m[2]; }
    }
    if (!author && infoAuthor) author = infoAuthor;
    const titleKey = lineKey(title);

    // 5. Walk pages and build blocks.
    const blocks = [];
    let cur = null; // paragraph under construction
    let prevLine = null;
    let ended = false; // passed an end-of-article mark (♦ etc.)

    const flush = () => {
      if (cur) {
        cur.runs = normaliseRuns(cur.runs);
        if (cur.runs.length) blocks.push(cur);
      }
      cur = null;
    };
    const pushBreak = (symbol) => {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.type !== 'break' && last.type !== 'h') blocks.push({ type: 'break', symbol: symbol || '' });
    };
    const appendLine = (line) => {
      // Join with previous line: handle hyphenation, else a single space.
      const runs = line.runs.map((r) => ({ ...r }));
      if (cur.runs.length) {
        const last = cur.runs[cur.runs.length - 1];
        last.t = last.t.replace(/\s+$/, '');
        last.t = last.t.replace(/[\u2010\u2011]$/, '-');
        const m = /(\p{L}+)-$/u.exec(last.t);
        const firstWord = (/^\s*(\p{L}+)/u.exec(runs[0].t) || [])[1];
        if (m && firstWord) {
          if (shouldDehyphenate(m[1], firstWord)) last.t = last.t.slice(0, -1);
          // keep hyphen, no space (e.g. "great-great-" + "whoever")
        } else if (/[—–]$/.test(last.t) || /^\s*[—–?!,;:.)\]”]/.test(runs[0].t)) {
          // em-dash at a line edge: no space
        } else {
          cur.runs.push({ t: ' ', i: last.i && runs[0].i, b: last.b && runs[0].b });
        }
      }
      cur.runs.push(...runs);
      cur.lastLine = line;
    };

    // Word list for hyphenation decisions (built from all body text).
    const wordSet = new Set();
    const hyphenSet = new Set();
    for (const l of flatBody) {
      for (const w of l.text.toLowerCase().match(/[\p{L}]+(?:-[\p{L}]+)*/gu) || []) {
        if (w.includes('-')) hyphenSet.add(w); else wordSet.add(w);
      }
    }
    function shouldDehyphenate(a, b) {
      const joined = (a + b).toLowerCase();
      const hyph = (a + '-' + b).toLowerCase();
      if (hyphenSet.has(hyph)) return false;
      if (wordSet.has(joined)) return true;
      if (/^\p{Lu}/u.test(b)) return false;
      return justified;
    }

    for (let pi = 0; pi < pages.length; pi++) {
      const pg = pages[pi];
      // All lines on the page, in reading order, so we can log what we drop.
      const allLines = pageLines[pi];
      const bodySet = new Set();
      const lines = bodyLinesByPage[pi];
      const headingLines = groupLines(pg.items.filter((i) => isHeading(i.size))).map((l) => ({ ...l, heading: true, page: pg.n, inMargin: l.y > pg.height * 0.9 || l.y < pg.height * 0.1 }));
      const keep = [];
      for (const l of lines) {
        if (isFurniture(l)) continue;
        if (!inColumn(l)) continue;
        keep.push(l);
      }
      for (const h of headingLines) {
        if (isFurniture(h) || ended) continue;
        if (h.x0 < bodyLeft - 3 * em || h.x0 > bodyRight) continue;
        if (titleKey && lineKey(h.text) === titleKey) continue; // the title is rendered separately
        if (titleLines.some((t) => t.page === pg.n && Math.abs(t.y - h.y) < 1)) continue;
        if (h.text.length > 120) continue;
        keep.push(h);
      }
      keep.sort((a, b) => b.y - a.y || a.x0 - b.x0);
      for (const l of keep) bodySet.add(lineKey(l.text) + '@' + Math.round(l.y));
      const foreignYs = [];
      for (const l of allLines) {
        if (!bodySet.has(lineKey(l.text) + '@' + Math.round(l.y)) && !keep.some((k) => Math.abs(k.y - l.y) < 1 && l.text.includes(k.text))) {
          if (!l.inMargin) foreignYs.push(l.y);
          if (!titleLines.some((t) => t.page === pg.n && Math.abs(t.y - l.y) < 1)) removed.push({ page: pg.n, text: l.text });
        }
      }

      for (const line of keep) {
        const text = line.text;

        if (line.heading) {
          if (ended) continue;
          flush();
          blocks.push({ type: 'h', runs: normaliseRuns(line.runs.map((r) => ({ ...r, b: false }))) });
          prevLine = null;
          continue;
        }

        // Scene-break markers on their own line.
        if (BREAK_LINE.test(text) && text.replace(/\s/g, '').length <= 7) {
          pushBreak(text.replace(/\s+/g, ' ').trim());
          prevLine = null;
          continue;
        }

        let newPara = false, sceneBreak = false;
        const center = (line.x0 + line.x1) / 2;
        const centered = Math.abs(center - (bodyLeft + bodyRight) / 2) < em && line.x0 > bodyLeft + 3 * em;

        // Something we removed (ad, caption, image credit) sits between the two lines?
        // (Text beside the column, like a sidebar the body wraps around, doesn't count: the gap stays normal.)
        const interrupted = prevLine && prevLine.page === line.page && prevLine.y - line.y > lineGap * 1.45 &&
          foreignYs.some((y) => y < prevLine.y - 0.5 * em && y > line.y + 0.5 * em);

        if (!cur || !prevLine) newPara = true;
        else if (prevLine.page === line.page && !interrupted) {
          const d = prevLine.y - line.y;
          // Blank-space scene breaks are only trusted in book-style (indented) layouts; in web-style
          // layouts, extra space is usually an empty ad or image slot, so it only ends the paragraph.
          if (d > sceneGap * 0.97 && d < pg.height * 0.5) { if (usesIndent) sceneBreak = true; else newPara = true; }
          else if (paraGap ? d > (lineGap + paraGap) / 2 : d > lineGap * 1.45) newPara = true;
        } else {
          // Across a page boundary (or an interruption): a short last line ends the paragraph.
          const prevShort = prevLine.x1 < bodyRight - 3 * em;
          const endsSentence = /[.!?”"’)\]:♦]$/.test(prevLine.text);
          if (prevShort && endsSentence) newPara = true;
          else if (prevShort && !/[,;\-—–]$/.test(prevLine.text)) newPara = true;
        }
        if (usesIndent && Math.abs(line.x0 - indentX) < 0.6 * em) newPara = true;
        if (centered) newPara = true;
        if (cur && cur.centered && !centered) newPara = true;

        if (sceneBreak) pushBreak('');
        if (newPara || sceneBreak || !cur) {
          flush();
          const quote = !usesIndent && line.x0 > bodyLeft + 1.5 * em && !centered;
          cur = { type: 'p', runs: [], centered, quote, after: ended };
          cur.runs.push(...line.runs.map((r) => ({ ...r })));
          cur.lastLine = line;
        } else {
          appendLine(line);
        }
        prevLine = line;

        // End-of-story mark at the end of a paragraph ("… among us. ♦").
        const lastChar = text.slice(-1);
        if (END_MARKS.test(lastChar) && !ended) {
          cur.runs = cur.runs.map((r) => ({ ...r }));
          const lr = cur.runs[cur.runs.length - 1];
          lr.t = lr.t.replace(/\s*[♦◆■□▪◼∎●•❖✦✧⬥◊]\s*$/, '');
          cur.endMark = lastChar;
          flush();
          ended = true;
          prevLine = null;
        }
      }
    }
    flush();

    // Tidy: drop a break at the very start or end, merge double breaks.
    while (blocks.length && blocks[0].type === 'break') blocks.shift();
    while (blocks.length && blocks[blocks.length - 1].type === 'break') blocks.pop();

    // A quote flag on a lone paragraph that is simply the document's normal left edge noise is unwanted;
    // only keep quotes that are consistently indented over 2+ lines or short centred pieces.
    const stats = {
      pages: pages.length,
      bodySize,
      lineGap: +lineGap.toFixed(2),
      paraGap: +paraGap.toFixed(2),
      paragraphStyle: usesIndent ? 'indented' : 'spaced',
      justified,
      blocks: blocks.length,
      removedLines: removed.length,
    };
    const model = {
      title: title || 'Untitled',
      author,
      blocks,
      removed,
      stats,
      paragraphStyle: stats.paragraphStyle,
    };
    model.warnings = checkModel(model);
    return model;
  }

  // ---------------------------------------------------------------------------
  // Plain text / Markdown -> document model
  // ---------------------------------------------------------------------------

  function inlineMarkdown(s) {
    // *italic*, _italic_, **bold**, __bold__ — conservative so that stray asterisks survive.
    const runs = [];
    const re = /(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1|(\*|_)(?=\S)([\s\S]+?)(?<=\S)\3(?![\p{L}\p{N}])/gu;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m[3] === '_' && m.index > 0 && /[\p{L}\p{N}]/u.test(s[m.index - 1])) continue; // snake_case
      if (m.index > last) runs.push({ t: s.slice(last, m.index) });
      if (m[1]) runs.push({ t: m[2], b: true });
      else runs.push({ t: m[4], i: true });
      last = m.index + m[0].length;
    }
    if (last < s.length) runs.push({ t: s.slice(last) });
    return runs;
  }

  function parseText(text, name) {
    text = cleanFragment(text.replace(/\r\n?/g, '\n'));
    const lines = text.split('\n');

    // Hard-wrapped text: most non-empty lines end near the same width and paragraphs are blank-line separated.
    const nonEmpty = lines.filter((l) => l.trim());
    const lens = nonEmpty.map((l) => l.trimEnd().length);
    const wrapWidth = percentile(lens, 0.9);
    const hardWrapped = nonEmpty.length > 8 && wrapWidth < 100 && lens.filter((n) => n > wrapWidth * 0.75).length > nonEmpty.length * 0.5;
    const hasBlankSeparators = lines.some((l, k) => !l.trim() && k > 0 && lines[k - 1].trim());

    const blocks = [];
    let title = '', author = '';
    let buf = [];
    const flushBuf = () => {
      if (!buf.length) return;
      let joined = '';
      for (const l of buf) {
        const t = l.trim();
        if (!joined) joined = t;
        else if (/\p{L}-$/u.test(joined) && /^\p{Ll}/u.test(t)) joined = joined + t; // keep hyphen (safer for prose)
        else joined += ' ' + t;
      }
      buf = [];
      const runs = normaliseRuns(inlineMarkdown(joined));
      if (runs.length) blocks.push({ type: 'p', runs });
    };

    for (let k = 0; k < lines.length; k++) {
      const raw = lines[k];
      const t = raw.trim();
      if (!t) { flushBuf(); continue; }
      const h = /^(#{1,3})\s+(.+)$/.exec(t);
      if (h) {
        flushBuf();
        if (h[1] === '#' && !title && !blocks.length) title = h[2].trim();
        else blocks.push({ type: 'h', runs: normaliseRuns(inlineMarkdown(h[2])) });
        continue;
      }
      if (BREAK_LINE.test(t) && t.replace(/\s/g, '').length <= 7) {
        flushBuf();
        if (blocks.length && blocks[blocks.length - 1].type !== 'break') blocks.push({ type: 'break', symbol: t.replace(/\s+/g, ' ') });
        continue;
      }
      const by = /^by\s+([\p{Lu}][\p{L}.'’\- ]{1,60})$/u.exec(t);
      if (by && !author && blocks.length <= 1) { flushBuf(); author = by[1].trim(); if (!title && blocks.length === 1) { title = runsText(blocks.pop().runs); } continue; }
      if (/^>\s?/.test(t)) {
        flushBuf();
        blocks.push({ type: 'p', quote: true, runs: normaliseRuns(inlineMarkdown(t.replace(/^>\s?/, ''))) });
        continue;
      }
      buf.push(raw);
      // Without blank-line separators, each line is a paragraph — unless the text is hard-wrapped,
      // in which case a noticeably short line ends the paragraph.
      if (!hasBlankSeparators && (!hardWrapped || t.length < wrapWidth * 0.75)) flushBuf();
    }
    flushBuf();

    if (!title) {
      // A short first line with no terminal punctuation reads as a title.
      const first = blocks[0];
      if (first && first.type === 'p' && runsText(first.runs).length < 90 && !/[.,;:!?]$/.test(runsText(first.runs))) {
        title = runsText(first.runs);
        blocks.shift();
      }
    }
    while (blocks.length && blocks[0].type === 'break') blocks.shift();
    if (!title) title = (name || 'Untitled').replace(/\.[^.]+$/, '');

    const model = { title, author, blocks, removed: [], stats: { source: 'text', hardWrapped, blocks: blocks.length }, paragraphStyle: 'indented' };
    model.warnings = checkModel(model);
    return model;
  }

  // ---------------------------------------------------------------------------
  // Consistency checks shown to the user
  // ---------------------------------------------------------------------------

  function checkModel(model) {
    const w = [];
    const paras = model.blocks.filter((b) => b.type === 'p');
    if (!paras.length) { w.push('No paragraphs found'); return w; }
    let doubleSpace = 0, spaceBeforePunct = 0, brokenWords = 0, lowerStart = 0, longParas = 0;
    for (let k = 0; k < paras.length; k++) {
      const t = runsText(paras[k].runs);
      if (/ {2,}/.test(t)) doubleSpace++;
      if (/ [,.;:!?](?!\.)/.test(t)) spaceBeforePunct++;
      if (/\p{Ll}- \p{Ll}/u.test(t)) brokenWords++;
      if (/^\p{Ll}/u.test(t) && k > 0) lowerStart++;
      if (t.length > 4000) longParas++;
    }
    if (doubleSpace) w.push(`Double spaces in ${doubleSpace} paragraph(s)`);
    if (spaceBeforePunct) w.push(`Space before punctuation in ${spaceBeforePunct} paragraph(s)`);
    if (brokenWords) w.push(`Possible split words in ${brokenWords} paragraph(s)`);
    if (lowerStart > paras.length * 0.05) w.push(`${lowerStart} paragraph(s) start lowercase (possible bad breaks)`);
    if (longParas) w.push(`${longParas} very long paragraph(s) (possible missed breaks)`);
    return w;
  }

  // ---------------------------------------------------------------------------
  // HTML rendering (used for both the preview and the EPUB)
  // ---------------------------------------------------------------------------

  function runsToHtml(runs) {
    let html = '';
    for (const r of runs) {
      let t = escapeXml(r.t);
      // keep spaces outside the tags so Kindle doesn't swallow them
      const lead = /^ /.test(t) ? ' ' : '';
      const trail = / $/.test(t) && t.length > 1 ? ' ' : '';
      t = t.slice(lead.length, t.length - trail.length);
      if (r.i) t = `<em>${t}</em>`;
      if (r.b) t = `<strong>${t}</strong>`;
      html += lead + t + trail;
    }
    return html;
  }

  // Split a model into chapters at headings; returns [{title, html}].
  function modelToChapters(model, opts = {}) {
    const style = opts.paragraphStyle && opts.paragraphStyle !== 'auto' ? opts.paragraphStyle : model.paragraphStyle || 'indented';
    const chapters = [];
    let cur = { title: model.title, parts: [] , first: true};
    let afterBreak = true;
    let inBack = false;
    const head = (b) => {
      if (cur.parts.length || !cur.first) chapters.push(cur);
      cur = { title: runsText(b.runs), parts: [`<h2>${runsToHtml(b.runs)}</h2>`], fromHeading: true };
      afterBreak = true;
    };
    for (const b of model.blocks) {
      if (b.type === 'h') { head(b); continue; }
      if (b.type === 'break') {
        const sym = b.symbol && !/^[-_=~]+$/.test(b.symbol.replace(/\s/g, '')) ? escapeXml(b.symbol) : '*&#160;&#160;*&#160;&#160;*';
        cur.parts.push(`<p class="scene">${sym}</p>`);
        afterBreak = true;
        continue;
      }
      if (b.after && !inBack) { cur.parts.push('<div class="back">'); inBack = true; afterBreak = true; }
      const cls = [];
      if (b.quote) cls.push('quote');
      if (b.centered) cls.push('center');
      if (afterBreak && !b.quote && !b.centered) cls.push('first');
      let inner = runsToHtml(b.runs);
      if (b.endMark) inner += `&#160;<span class="endmark">${escapeXml(b.endMark)}</span>`;
      cur.parts.push(`<p${cls.length ? ` class="${cls.join(' ')}"` : ''}>${inner}</p>`);
      afterBreak = !!(b.quote || b.centered);
    }
    if (inBack) cur.parts.push('</div>');
    chapters.push(cur);
    return { style, chapters: chapters.filter((c) => c.parts.length) };
  }

  const BOOK_CSS = `
@charset "utf-8";
body { margin: 0; padding: 0; orphans: 2; widows: 2; }
h1.title { font-size: 1.6em; line-height: 1.2; text-align: center; margin: 2.5em 0 0.4em 0; font-weight: bold; page-break-before: always; }
p.byline { text-align: center; text-indent: 0; font-style: italic; margin: 0 0 2.5em 0; }
h2 { font-size: 1.25em; line-height: 1.25; text-align: center; margin: 2em 0 1.2em 0; font-weight: bold; page-break-before: always; page-break-after: avoid; }
p { margin: 0; line-height: 1.45; text-align: left; }
body.indented p { text-indent: 1.4em; }
body.indented p.first, body.indented p.center, body.indented p.quote { text-indent: 0; }
body.spaced p { text-indent: 0; margin: 0 0 0.75em 0; }
p.scene { text-align: center; text-indent: 0; margin: 1.1em 0; letter-spacing: 0.15em; page-break-after: avoid; }
p.center { text-align: center; }
p.quote { margin: 0.6em 1.5em; text-indent: 0; }
.endmark { font-size: 0.8em; }
div.back { margin-top: 2.5em; font-size: 0.9em; }
div.back p { text-indent: 0; margin: 0 0 0.6em 0; }
em { font-style: italic; }
strong { font-weight: bold; }
`.trim();

  function previewHtml(model, opts = {}) {
    const { style, chapters } = modelToChapters(model, opts);
    let html = `<div class="book ${style}"><h1 class="title">${escapeXml(model.title)}</h1>`;
    if (model.author) html += `<p class="byline">${escapeXml(model.author)}</p>`;
    html += chapters.map((c) => c.parts.join('\n')).join('\n');
    return html + '</div>';
  }

  // ---------------------------------------------------------------------------
  // EPUB packaging
  // ---------------------------------------------------------------------------

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function xhtmlDoc(title, bodyClass, body, lang) {
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head>
<meta charset="utf-8"/>
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body class="${bodyClass}">
${body}
</body>
</html>
`;
  }

  /**
   * Build an EPUB 3 (with an EPUB 2 NCX for older readers).
   * book = { title, author, lang, docs: [model, ...] } — several docs become one book with one section each.
   * Returns a Uint8Array (Node) or Blob (browser), depending on `type`.
   */
  async function buildEpub(JSZip, book, opts = {}) {
    const lang = book.lang || 'en';
    const id = 'urn:uuid:' + uuid();
    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const files = []; // {id, href, title, html}
    const multi = book.docs.length > 1;
    let n = 0;

    for (const model of book.docs) {
      const { style, chapters } = modelToChapters(model, opts);
      chapters.forEach((ch, k) => {
        n++;
        let body = '';
        if (k === 0) {
          body += `<h1 class="title">${escapeXml(model.title)}</h1>\n`;
          if (model.author && (multi || model.author)) body += `<p class="byline">${escapeXml(model.author)}</p>\n`;
        }
        body += ch.parts.join('\n');
        const title = k === 0 && (multi || !ch.fromHeading) ? model.title : ch.title;
        files.push({ id: `c${n}`, href: `c${n}.xhtml`, title, html: xhtmlDoc(title, style, body, lang) });
      });
    }

    const navItems = files.map((f) => `<li><a href="${f.href}">${escapeXml(f.title)}</a></li>`).join('\n');
    const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>Contents</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<nav epub:type="toc" id="toc"><h2>Contents</h2><ol>
${navItems}
</ol></nav>
<nav epub:type="landmarks" hidden=""><ol><li><a epub:type="bodymatter" href="${files[0].href}">Start</a></li></ol></nav>
</body>
</html>
`;
    const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${id}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>${escapeXml(book.title)}</text></docTitle>
<navMap>
${files.map((f, k) => `<navPoint id="np${k + 1}" playOrder="${k + 1}"><navLabel><text>${escapeXml(f.title)}</text></navLabel><content src="${f.href}"/></navPoint>`).join('\n')}
</navMap>
</ncx>
`;
    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${id}</dc:identifier>
<dc:title>${escapeXml(book.title)}</dc:title>
${book.author ? `<dc:creator>${escapeXml(book.author)}</dc:creator>` : ''}
<dc:language>${lang}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
${files.map((f) => `<item id="${f.id}" href="${f.href}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine toc="ncx">
${files.map((f) => `<itemref idref="${f.id}"/>`).join('\n')}
</spine>
</package>
`;
    const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`;

    const zip = new JSZip();
    const add = (name, content, o = {}) => zip.file(name, content, { createFolders: false, ...o });
    add('mimetype', 'application/epub+zip', { compression: 'STORE' }); // must be first & uncompressed
    add('META-INF/container.xml', container);
    add('OEBPS/content.opf', opf);
    add('OEBPS/nav.xhtml', nav);
    add('OEBPS/toc.ncx', ncx);
    add('OEBPS/style.css', BOOK_CSS);
    for (const f of files) add('OEBPS/' + f.href, f.html);
    return zip.generateAsync({ type: opts.type || 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  }

  function safeFilename(s) {
    return (s || 'book').replace(/[\\/:*?"<>|“”‘’]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'book';
  }

  root.EpubCore = { extractPdf, parseText, buildEpub, previewHtml, checkModel, runsText, safeFilename, BOOK_CSS, _layoutToModel: layoutToModel };
})(typeof globalThis !== 'undefined' ? globalThis : this);
