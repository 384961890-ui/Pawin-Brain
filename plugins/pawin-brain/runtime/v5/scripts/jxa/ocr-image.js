// ocr-image.js — macOS Vision OCR via JXA（零依赖）
// 用法: osascript -l JavaScript ocr-image.js <image_path>
// 输出: 识别出的文本行（\n 分隔）到 stdout；失败输出 JSON {error}
// 坑: ObjC selector `topCandidates:` 在 JXA 里映射为 topCandidates(n)，
//     不是 topCandidatesCount(n) —— 见 v5/DESIGN.md §5.6
ObjC.import('Vision');
ObjC.import('AppKit');

function run(argv) {
  const path = argv[0];
  if (!path) return JSON.stringify({ error: 'usage: ocr-image.js <image_path>' });

  const img = $.NSImage.alloc.initWithContentsOfFile(path);
  if (img.isNil()) return JSON.stringify({ error: 'cannot load image: ' + path });

  const tiff = img.TIFFRepresentation;
  const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
  if (rep.isNil()) return JSON.stringify({ error: 'cannot get bitmap rep' });
  const cg = rep.CGImage;

  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  req.recognitionLanguages = $.NSArray.arrayWithArray([$('zh-Hans'), $('en-US')]);
  req.usesLanguageCorrection = true;

  const handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(cg, $.NSDictionary.dictionary);
  const err = Ref();
  const ok = handler.performRequestsError($.NSArray.arrayWithObject(req), err);
  if (!ok) return JSON.stringify({ error: 'vision request failed' });

  const results = req.results;
  const lines = [];
  for (let i = 0; i < results.count; i++) {
    const cand = results.objectAtIndex(i).topCandidates(1);
    if (cand.count > 0) lines.push(cand.objectAtIndex(0).string.js);
  }
  return lines.join('\n');
}
