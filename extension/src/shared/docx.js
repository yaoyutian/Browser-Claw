// 极简 DOCX 生成器：手写 ZIP（STORE 模式，不压缩）+ OOXML。
//
// 为什么不用 docx.js / jszip：
//   扩展要尽量零依赖，减小体积与供应链风险。
//   一个最小可用 DOCX 只需要 3 个文件，手写反而更可控。
//
// 已知限制：不支持复杂排版、表格、图片、页眉页脚、修订。
// 想要完整能力，走 markdown → pandoc / companion 服务。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, day };
}

function zip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime();

  for (const { name, content } of files) {
    const nameBytes = encoder.encode(name);
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 name
    lv.setUint16(8, 0, true); // method: STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = chunks.reduce((a, c) => a + c.length, 0) + centralSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  for (const c of central) {
    out.set(c, p);
    p += c.length;
  }
  out.set(end, p);
  return out;
}

const escapeXml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * 从 Markdown 生成 DOCX。
 * 支持：标题(#..######)、段落、列表、无序/有序列表、引用、代码块、粗体/斜体/行内代码、链接、分隔线。
 */
export function markdownToDocx(markdown, { title = 'Document' } = {}) {
  const lines = String(markdown || '').split(/\r?\n/);
  const body = [];
  let inCode = false;
  let codeBuf = [];
  let listDepth = 0;

  const flushCode = () => {
    if (!codeBuf.length) return;
    const text = codeBuf.join('\n');
    body.push(
      `<w:p><w:pPr><w:spacing w:before="60" w:after="60"/></w:pPr>` +
        `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr>` +
        `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
    );
    codeBuf = [];
  };

  const inline = (text) => {
    // 先按行内代码切分，避免代码里的 * 被误解析。
    const parts = String(text).split(/(`[^`]*`)/g);
    return parts
      .map((part) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
          return `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${escapeXml(part.slice(1, -1))}</w:t></w:r>`;
        }
        let s = escapeXml(part);
        s = s.replace(/\*\*([^*]+)\*\*/g, '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">$1</w:t></w:r>');
        s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">$2</w:t></w:r>');
        s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<w:hyperlink r:id=""><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">$1</w:t></w:r></w:hyperlink>');
        if (!/^<w:|^$/.test(s)) s = `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`;
        return s;
      })
      .join('');
  };

  const para = (text, opts = {}) => {
    const pPr = opts.pPr ? `<w:pPr>${opts.pPr}</w:pPr>` : '';
    body.push(`<w:p>${pPr}${inline(text)}</w:p>`);
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (/^```/.test(line)) {
      if (inCode) flushCode();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    if (!line.trim()) continue;

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>');
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const size = [36, 30, 26, 24, 22, 20][level - 1] || 20;
      body.push(
        `<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>` +
          `<w:r><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${escapeXml(h[2])}</w:t></w:r></w:p>`
      );
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      para(quote[1], { pPr: '<w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="4" w:color="C8C8C8"/></w:pBdr>' });
      continue;
    }

    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) {
      const depth = Math.floor(ul[1].length / 2) + 1;
      if (listDepth !== depth) {
        body.push(`<w:p><w:pPr><w:numPr><w:ilvl w:val="${depth - 1}"/><w:numId w:val="1"/></w:numPr></w:pPr>${inline(ul[2])}</w:p>`);
      } else {
        body.push(`<w:p><w:pPr><w:numPr><w:ilvl w:val="${depth - 1}"/><w:numId w:val="1"/></w:numPr></w:pPr>${inline(ul[2])}</w:p>`);
      }
      listDepth = depth;
      continue;
    }

    const ol = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (ol) {
      const depth = Math.floor(ol[1].length / 2) + 1;
      body.push(`<w:p><w:pPr><w:numPr><w:ilvl w:val="${depth - 1}"/><w:numId w:val="2"/></w:numPr></w:pPr>${inline(ol[2])}</w:p>`);
      listDepth = depth;
      continue;
    }

    listDepth = 0;
    para(line);
  }
  flushCode();

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<w:body>${body.join('')}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` +
    `</w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `</Relationships>`;

  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
    `</Relationships>`;

  const numbering =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>` +
    [0, 1, 2]
      .map(
        (l) =>
          `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
          `<w:lvlText w:val="${['•', '◦', '▪'][l]}"/><w:lvlJc w:val="left"/>` +
          `<w:pPr><w:ind w:left="${420 * (l + 1)}" w:hanging="420"/></w:pPr></w:lvl>`
      )
      .join('') +
    `</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>` +
    [0, 1, 2]
      .map(
        (l) =>
          `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="decimal"/>` +
          `<w:lvlText w:val="%${l + 1}."/><w:lvlJc w:val="left"/>` +
          `<w:pPr><w:ind w:left="${420 * (l + 1)}" w:hanging="420"/></w:pPr></w:lvl>`
      )
      .join('') +
    `</w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
    `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
    `</w:numbering>`;

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    `</cp:coreProperties>`;

  return zip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rels },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/_rels/document.xml.rels', content: docRels },
    { name: 'word/numbering.xml', content: numbering },
    { name: 'docProps/core.xml', content: core },
  ]);
}
