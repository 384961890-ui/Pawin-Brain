// pdf-extract.js — macOS PDFKit 文本层提取 via JXA（零依赖）
// 用法: osascript -l JavaScript pdf-extract.js <pdf_path> [max_chars]
// 输出: JSON {pages, chars, truncated, text} 到 stdout；失败输出 JSON {error}
// 注意: 只提取文本层。扫描件 PDF（无文本层）chars 会接近 0 —— 由调用方判定降级。
ObjC.import('Quartz');

function run(argv) {
  const path = argv[0];
  if (!path) return JSON.stringify({ error: 'usage: pdf-extract.js <pdf_path> [max_chars]' });
  const maxChars = parseInt(argv[1] || '200000', 10);

  const url = $.NSURL.fileURLWithPath(path);
  const doc = $.PDFDocument.alloc.initWithURL(url);
  if (doc.isNil()) return JSON.stringify({ error: 'cannot load pdf: ' + path });

  const pages = Number(doc.pageCount);
  const raw = doc.string.isNil() ? '' : doc.string.js;
  const truncated = raw.length > maxChars;

  return JSON.stringify({
    pages: pages,
    chars: raw.length,
    truncated: truncated,
    text: truncated ? raw.slice(0, maxChars) : raw,
  });
}
