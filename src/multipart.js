/**
 * Minimal multipart/form-data parser — just enough to pull image files and
 * text fields out of a browser upload, with no dependency.
 *
 * We operate on the raw Buffer (not a string) because image bytes are binary
 * and any utf-8 round-trip would corrupt them. The only text we decode is the
 * per-part headers, which are always ASCII by spec.
 */

/**
 * @param {Buffer} buffer  full request body
 * @param {string} contentType  the request Content-Type header (carries boundary)
 * @returns {{ fields: Record<string,string>, files: {name:string, filename:string, contentType:string, data:Buffer}[] }}
 */
export function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) throw Object.assign(new Error('Missing multipart boundary'), { status: 400 });
  const boundary = `--${match[1] || match[2]}`;

  const fields = {};
  const files = [];

  const delimiter = Buffer.from(`\r\n${boundary}`);
  // Prepend a CRLF so the first boundary is found by the same delimiter search.
  const body = Buffer.concat([Buffer.from('\r\n'), buffer]);

  let start = body.indexOf(delimiter);
  if (start === -1) return { fields, files };

  while (start !== -1) {
    const partStart = start + delimiter.length;

    // "--" immediately after a boundary marks the end of the multipart body.
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break;

    // Skip the CRLF that follows the boundary line.
    const headerStart = partStart + 2;
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd === -1) break;

    const headerText = body.toString('ascii', headerStart, headerEnd);
    const contentStart = headerEnd + 4;

    const nextBoundary = body.indexOf(delimiter, contentStart);
    if (nextBoundary === -1) break;

    const content = body.subarray(contentStart, nextBoundary);
    const { name, filename, type } = parseDisposition(headerText);

    if (filename !== undefined) {
      // Only keep parts that are actual files with content.
      if (filename && content.length > 0) {
        files.push({ name, filename, contentType: type || 'application/octet-stream', data: Buffer.from(content) });
      }
    } else if (name) {
      fields[name] = content.toString('utf-8');
    }

    start = nextBoundary;
  }

  return { fields, files };
}

function parseDisposition(headerText) {
  let name;
  let filename;
  let type;
  for (const line of headerText.split('\r\n')) {
    const lower = line.toLowerCase();
    if (lower.startsWith('content-disposition:')) {
      const nm = /name="([^"]*)"/i.exec(line);
      const fn = /filename="([^"]*)"/i.exec(line);
      if (nm) name = nm[1];
      if (fn) filename = fn[1];
    } else if (lower.startsWith('content-type:')) {
      type = line.slice(line.indexOf(':') + 1).trim();
    }
  }
  return { name, filename, type };
}
