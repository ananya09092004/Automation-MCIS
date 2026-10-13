const mammoth = require('mammoth');

async function processFileFromBuffer(buffer, mimeType, fileName) {
  try {
    const ext = fileName ? '.' + fileName.split('.').pop().toLowerCase() : '';
    
    // Phone pe MIME type fix karo
    let resolvedMime = mimeType;
    if (fileName?.toLowerCase().endsWith('.pdf')) resolvedMime = 'application/pdf';
    if (fileName?.toLowerCase().endsWith('.docx')) resolvedMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (fileName?.toLowerCase().endsWith('.doc')) resolvedMime = 'application/msword';
    if (fileName?.toLowerCase().endsWith('.txt')) resolvedMime = 'text/plain';

    console.log(`Processing — MIME: ${resolvedMime} | EXT: ${ext} | File: ${fileName}`);

    // Word files
    if (ext === '.docx' || ext === '.doc' || resolvedMime.includes('word')) {
      const result = await mammoth.extractRawText({ buffer });
      console.log('Word extracted ✅ —', result.value.length, 'chars');
      return result.value;
    }

    // Text files
    if (ext === '.txt' || resolvedMime === 'text/plain') {
      const text = buffer.toString('utf8');
      console.log('Text extracted ✅ —', text.length, 'chars');
      return text;
    }

    // PDF — base64 return karo vision model ke liye
    if (ext === '.pdf' || resolvedMime.includes('pdf')) {
      const base64 = buffer.toString('base64');
      console.log('PDF → base64 ready for vision ✅ size:', base64.length);
      return { isBase64: true, base64, mimeType: 'application/pdf' };
    }

    // CSV files
    if (ext === '.csv' || resolvedMime.includes('csv')) {
      const text = buffer.toString('utf8');
      console.log('CSV extracted ✅ —', text.length, 'chars');
      return text;
    }

    // JSON files
    if (ext === '.json' || resolvedMime.includes('json')) {
      const text = buffer.toString('utf8');
      console.log('JSON extracted ✅ —', text.length, 'chars');
      return text;
    }

    // Baaki — text try karo
    const text = buffer.toString('utf8');
    if (text && text.trim().length > 50) {
      console.log('Generic text extracted ✅ —', text.length, 'chars');
      return text;
    }

    console.log('Could not extract — returning null');
    return null;

  } catch (err) {
    console.error('File extraction error:', err.message);
    return null;
  }
}

module.exports = { processFileFromBuffer };