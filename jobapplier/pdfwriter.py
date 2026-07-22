"""A tiny, dependency-free PDF writer for ATS-friendly resumes.

Why hand-rolled? ATS parsers want a single-column layout with *selectable*
text in standard fonts (no images, no columns, no exotic glyphs). That is
exactly what a minimal PDF needs, and it lets the whole tool stay pure-stdlib
(no reportlab/fpdf, which were unavailable/broken in the target environment).

Supported:
  * Multiple pages (auto page breaks)
  * Helvetica / Helvetica-Bold with accurate word-wrapping via embedded AFM widths
  * Headings, body lines, bullets, horizontal rules
  * WinAnsi text encoding (Latin-1) so text extracts cleanly

Not supported (by design): images, colors beyond gray, embedded fonts.
"""
from __future__ import annotations

from typing import List, Tuple

# Adobe standard Helvetica advance widths (units per 1000 em), ASCII 32..126.
_HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,
         556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,
         722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,
         667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,
         556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,
         500,334,260,334,584]
_HELV_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,
              556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,
              722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,
              667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,
              611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,
              611,556,778,556,556,500,389,280,389,584]


def _char_width(ch: str, bold: bool) -> int:
    o = ord(ch)
    table = _HELV_BOLD if bold else _HELV
    if 32 <= o <= 126:
        return table[o - 32]
    return 556  # reasonable default for other Latin-1 chars


def text_width(s: str, size: float, bold: bool = False) -> float:
    return sum(_char_width(c, bold) for c in s) * size / 1000.0


def wrap_text(s: str, size: float, max_width: float, bold: bool = False) -> List[str]:
    """Greedy word-wrap using real font metrics."""
    words = s.split()
    if not words:
        return [""]
    lines: List[str] = []
    cur = words[0]
    for w in words[1:]:
        trial = cur + " " + w
        if text_width(trial, size, bold) <= max_width:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def _esc(s: str) -> str:
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _to_latin1(s: str) -> str:
    return s.encode("latin-1", "replace").decode("latin-1")


class PDF:
    """Accumulates styled lines, then serializes to a valid PDF byte string."""

    def __init__(self, page=(612.0, 792.0), margin=54.0):
        self.pw, self.ph = page                # US Letter points
        self.margin = margin
        self.content_w = self.pw - 2 * margin
        self.pages: List[List[str]] = [[]]     # each page = list of content ops
        self.y = self.ph - margin

    # -- layout ------------------------------------------------------------- #
    def _newpage(self) -> None:
        self.pages.append([])
        self.y = self.ph - self.margin

    def _ensure(self, height: float) -> None:
        if self.y - height < self.margin:
            self._newpage()

    def _emit_line(self, text: str, size: float, bold: bool, x: float) -> None:
        font = "F2" if bold else "F1"
        ty = self.y
        op = (f"BT /{font} {size:.1f} Tf 1 0 0 1 {x:.1f} {ty:.1f} Tm "
              f"({_esc(_to_latin1(text))}) Tj ET")
        self.pages[-1].append(op)

    # -- public drawing API ------------------------------------------------- #
    def space(self, h: float = 6.0) -> None:
        self.y -= h

    def rule(self, gray: float = 0.75) -> None:
        self._ensure(6)
        self.y -= 3
        op = (f"{gray:.2f} G 0.6 w {self.margin:.1f} {self.y:.1f} m "
              f"{self.pw - self.margin:.1f} {self.y:.1f} l S 0 G")
        self.pages[-1].append(op)
        self.y -= 5

    def paragraph(self, text: str, size=10.0, bold=False, leading=None,
                  indent=0.0, gap=2.0) -> None:
        leading = leading or size * 1.32
        x = self.margin + indent
        for line in wrap_text(text, size, self.content_w - indent, bold):
            self._ensure(leading)
            self._emit_line(line, size, bold, x)
            self.y -= leading
        self.y -= gap

    def bullet(self, text: str, size=10.0, leading=None) -> None:
        leading = leading or size * 1.32
        marker_indent = 12.0
        first = True
        for line in wrap_text(text, size, self.content_w - marker_indent):
            self._ensure(leading)
            if first:
                self._emit_line("-", size, False, self.margin + 2)
                first = False
            self._emit_line(line, size, False, self.margin + marker_indent)
            self.y -= leading
        self.y -= 1.5

    def heading(self, text: str, size=11.0) -> None:
        self.space(4)
        self._ensure(size * 1.4)
        self._emit_line(text.upper(), size, True, self.margin)
        self.y -= size * 1.25
        self.rule(0.6)

    def title_block(self, name: str, contact_lines: List[str]) -> None:
        self._ensure(40)
        self._emit_line(name, 18.0, True, self.margin)
        self.y -= 22
        for cl in contact_lines:
            if not cl:
                continue
            self._emit_line(cl, 9.5, False, self.margin)
            self.y -= 12
        self.y -= 2
        self.rule(0.55)

    # -- serialization ------------------------------------------------------ #
    def build(self) -> bytes:
        objects: List[bytes] = []

        def add(obj: bytes) -> int:
            objects.append(obj)
            return len(objects)  # 1-based object number

        # Fonts (standard 14 — no embedding needed).
        font1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
                    b"/Encoding /WinAnsiEncoding >>")
        font2 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold "
                    b"/Encoding /WinAnsiEncoding >>")

        page_obj_nums: List[int] = []
        content_obj_nums: List[int] = []
        for ops in self.pages:
            stream = ("\n".join(ops)).encode("latin-1", "replace")
            content = (b"<< /Length %d >>\nstream\n" % len(stream)) + stream + b"\nendstream"
            content_obj_nums.append(add(content))

        pages_obj_placeholder = len(objects) + len(self.pages) + 1  # /Pages obj number
        for i, _ in enumerate(self.pages):
            page = (
                f"<< /Type /Page /Parent {pages_obj_placeholder} 0 R "
                f"/MediaBox [0 0 {self.pw:.0f} {self.ph:.0f}] "
                f"/Resources << /Font << /F1 {font1} 0 R /F2 {font2} 0 R >> >> "
                f"/Contents {content_obj_nums[i]} 0 R >>"
            ).encode("latin-1")
            page_obj_nums.append(add(page))

        kids = " ".join(f"{n} 0 R" for n in page_obj_nums)
        pages_obj = (f"<< /Type /Pages /Count {len(page_obj_nums)} "
                     f"/Kids [{kids}] >>").encode("latin-1")
        pages_num = add(pages_obj)
        assert pages_num == pages_obj_placeholder, (pages_num, pages_obj_placeholder)

        catalog_num = add(f"<< /Type /Catalog /Pages {pages_num} 0 R >>".encode("latin-1"))

        # Assemble file with xref table.
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets: List[int] = []
        for i, obj in enumerate(objects, start=1):
            offsets.append(len(out))
            out += f"{i} 0 obj\n".encode("latin-1") + obj + b"\nendobj\n"

        xref_pos = len(out)
        n = len(objects)
        out += f"xref\n0 {n + 1}\n".encode("latin-1")
        out += b"0000000000 65535 f \n"
        for off in offsets:
            out += f"{off:010d} 00000 n \n".encode("latin-1")
        out += (f"trailer\n<< /Size {n + 1} /Root {catalog_num} 0 R >>\n"
                f"startxref\n{xref_pos}\n%%EOF\n").encode("latin-1")
        return bytes(out)


def save_pdf(pdf: PDF, path: str) -> None:
    with open(path, "wb") as f:
        f.write(pdf.build())
