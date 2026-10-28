import { deflateSync } from 'node:zlib';
/** Minimal synthetic PDFs with real xref offsets, including compressed oversized text fixtures. */
export function syntheticPdf(pages: string[], width = 612, attachmentBytes = 0): Buffer {
  const objects: Buffer[] = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.alloc(0), Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')];
  const kids: string[] = [];
  for (const text of pages) {
    const id = objects.length + 1; kids.push(`${id} 0 R`);
    const stream = deflateSync(Buffer.from(text ? `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET` : ''));
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`), Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')]));
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`);
  // A binary stream makes a realistic large file without growing its text layer.
  if (attachmentBytes) objects.push(Buffer.concat([Buffer.from(`<< /Length ${attachmentBytes} >>\nstream\n`), Buffer.alloc(attachmentBytes), Buffer.from('\nendstream')]));
  return encodePdf(objects);
}
function encodePdf(objects: Buffer[]): Buffer {
  const parts = [Buffer.from('%PDF-1.4\n')]; const offsets = [0]; let size = parts[0]!.length;
  objects.forEach((object, index) => { offsets.push(size); const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); parts.push(part); size += part.length; });
  parts.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** CID text with an explicit Unicode map exercises Chinese text extraction without a system font. */
export function syntheticChinesePdf(): Buffer {
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /SyntheticChinese-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
4 beginbfchar
<0001> <4E2D>
<0002> <6587>
<0003> <8D44>
<0004> <6599>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  const stream = (text: string) => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  return encodePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticChinese /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    stream('BT /F1 12 Tf 72 720 Td <0001000200030004> Tj ET'),
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticChinese /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 /CIDToGIDMap /Identity >>',
    stream(cmap),
    '<< /Type /FontDescriptor /FontName /SyntheticChinese /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 800 /StemV 80 >>',
  ].map(text => Buffer.from(text)));
}
