# Sejda online PDF editor - user-visible behavior (research notes)

Method: public product page and search snippets of sejda.com/pdf-editor, summarized in my own words. The live editor was NOT opened (no browser session, no file upload). Anything marked [unverified] is general knowledge of this class of editor, not confirmed from Sejda sources. No Sejda code or assets were examined.

Sources: https://www.sejda.com/pdf-editor , https://www.sejda.com/blog/post/144162708524/new-sejdas-online-pdf-editor , https://www.sejda.com/desktop , third-party reviews (TechRadar, europeanpurpose.com).

## 1. Tool inventory (toolbar)
- Text: add new text by clicking on the page; click existing text to edit it.
- Links: add/edit links to URL, email, phone number, or a page inside the document.
- Forms: fill existing fields; add text field, multiline field, dropdown, checkbox, radio, signature box; detect fields in a static form; set tab order.
- Images: insert from disk; drag to move, drag corner to resize; existing images can be deleted.
- Sign: create signature by typing, drawing, uploading an image, or camera; then place and resize.
- Whiteout: draw a white rectangle over content (content stays in the file; not redaction).
- Annotate: strike-out, highlight, underline on text; freehand highlight and freehand draw.
- Shapes: rectangle, ellipse, line, arrow; border and fill colors adjustable.
- Find & Replace: search with case-match option and an option to include link text.
- Undo (and redo [unverified]); "recover unsaved changes" offer after a crash/reload.
- Page thumbnails/page management, zoom: not documented on the page; [unverified]. Sejda notes browser zoom should be 100% and zooming may be blocked on pages that have pending changes.

## 2. Text-edit interaction flow
1. User picks the Text tool (the existing text is detected on the page and becomes clickable).
2. Click on an existing text line -> that line becomes an editable text box in place, caret inside. Reviews say selection granularity is one original line at a time, so rewriting a paragraph means editing each line separately.
3. Type/delete to change content; the box edits live.
4. Change style via the controls (section 3).
5. Click elsewhere to commit; edit stays a pending change until "Apply changes".
6. Clicking empty page area with the Text tool creates a new text box at that spot.
7. Moving/resizing the box: desktop product page says text can be added, edited, moved; exact online drag-handle behavior not confirmed [unverified].

Generic technique note: an edit is presented as an editable box laid over the original line, with the original glyphs hidden (covered), then re-rendered as new text at save time.

## 3. Controls shown while editing
- Bold, italic toggles.
- Font size.
- Font family (list of built-in fonts; locally installed fonts only in the Sejda Desktop app).
- Text color.
- Delete / move affordances on the box [unverified].
- Whiteout is a separate tool, not a text control.

## 4. How fonts and sizes are matched
- Not documented in detail. Observable claims only: the editor reads the style of the clicked text (size, color, bold/italic flags) and offers the same controls. Embedded fonts may not support every style change (e.g. bold/italic on a subset font). If typed characters are missing from the embedded font, the user is prompted to choose a replacement font.
- Implication: a reasonable approach is to reuse the original font when its subset contains the glyphs, and fall back to a standard/built-in font otherwise, asking the user.

## 5. Limitations Sejda discloses
- Scanned / image-only PDFs: existing text cannot be edited (no text layer); adding new text, images, annotations still works. OCR is a separate tool.
- PDFs with text converted to outlines/images: not editable.
- Fonts: embedded fonts may not allow style changes; missing glyphs trigger font replacement. Reviews report poor results with unusual fonts and complex layouts.
- Rotated pages: form fields and annotations cannot be added.
- Complex scripts (Arabic, Devanagari) and right-to-left text not fully supported.
- XFA forms unsupported.
- Permission-restricted PDFs need the owner password before content changes.
- Whiteout is not redaction: covered text can still be selected/extracted.
- Free-tier caps on saves per period, page count, file size; uploads auto-deleted after 2 hours (online service policy; irrelevant for a local app).

## 6. Save / export flow
- Edits accumulate as pending changes; user clicks "Apply changes", then "Download" the resulting PDF. Document is re-generated with changes baked in. Undo before applying; unsaved-change recovery offered.
- Desktop app: edits files locally (no upload).

## 7. Prioritized behaviors to replicate in CodePad

Must-have
1. Text tool: hover shows editable text lines; single click on an existing line opens an in-place editable box with caret.
2. Edit unit = one text line/run (matches Sejda; simplest with pdf.js text items grouped by line).
3. Style controls: font family, size, bold, italic, color; pre-filled from the original run.
4. Original text is hidden when edit is committed (whiteout-style cover or true content replacement) and new text drawn at the same position/baseline.
5. Click empty area with Text tool to add new text.
6. Pending-changes model with undo/redo; explicit Apply/Save step producing a new PDF (via Save As, never silent overwrite).
7. Font fallback: use original font if glyphs available, otherwise standard font and warn the user.
8. Scanned/no-text-layer pages: detect (no text items) and show a clear message; still allow adding text/images/whiteout.
9. Zoom and page thumbnails/navigation; edits remain positioned correctly at any zoom (store in PDF coordinates, not screen pixels).
10. Whiteout rectangle tool, with a visible warning that it is not redaction.

Nice-to-have
- Move/resize edited or added text box with drag handles.
- Image insert with move/resize; delete existing images.
- Highlight / underline / strike-out and freehand draw annotations.
- Shapes (rect, ellipse, line, arrow) with border/fill color.
- Links (URL / page) add and edit.
- Form filling and adding fields; signature (type/draw/image).
- Find & Replace.
- Recover unsaved changes after crash.
- Warning on rotated pages, RTL/complex scripts, encrypted PDFs (owner password prompt).

## 8. Could not observe
- The live editor UI: exact hover/selection visuals, whether single or double click starts editing, box handle design, toolbar layout, undo/redo buttons, shortcut keys.
- How Sejda matches non-embedded fonts and what substitute it picks; how it computes baseline/width when text length changes (wrapping vs. overflow).
- Thumbnail/zoom controls, page add/delete/reorder.
- Output fidelity (whether original text objects are removed or only covered).
- Why: no browser session was used and no test file was uploaded; findings come from Sejda's public page and search snippets only. Dedicated help article for the online editor returned 404.
