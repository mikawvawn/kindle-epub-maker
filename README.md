# Kindle EPUB Maker

Turns PDFs and text into clean EPUBs for Kindle. Runs in the browser; files never leave your computer.

**Use it:** https://mikawvawn.github.io/kindle-epub-maker/

Or open `index.html` locally. PDFs need an internet connection the first time, to load pdf.js.

Send the EPUB to your Kindle at [amazon.com/sendtokindle](https://www.amazon.com/sendtokindle).

## Files

- `index.html`: the page
- `epub-core.js`: PDF and text parsing, clean-up, EPUB packaging

## Limits

- Scanned PDFs need OCR first.
- Multi-column layouts aren't supported.
- Small caps come out lowercase.
