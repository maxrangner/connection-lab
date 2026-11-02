import { preview, toAscii } from '../bytes/bytes';
import { FieldList, type LayerPdu } from './types';

const METHODS = ['GET ', 'POST ', 'HEAD ', 'PUT ', 'DELETE ', 'OPTIONS ', 'PATCH '];

function indexOfCrlf(b: Uint8Array, from: number, end: number): number {
  for (let i = from; i + 1 < end; i++) if (b[i] === 0x0d && b[i + 1] === 0x0a) return i;
  return -1;
}

const HEADER_EXPLAIN: Record<string, string> = {
  host: 'Which website on this IP address we want. One server address can host many sites.',
  'user-agent': 'Identifies the browser and operating system.',
  accept: 'Which media types the client can handle.',
  connection: '"close" means: after this response the connection is torn down instead of being reused.',
  date: 'When the server produced the response.',
  'content-type': 'What the body is and, for text, its character encoding, so the browser knows how to interpret the bytes.',
  'transfer-encoding': '"chunked" means the body is sent in pieces, each prefixed with its size in hex, ending with a zero-size chunk. Used when the length is not known up front.',
  server: 'Software or network that produced the response.',
  'last-modified': 'When the document last changed; useful for caching.',
  allow: 'Methods this resource supports.',
  'accept-ranges': 'The server can send partial byte ranges of the file.',
  age: 'Seconds this response has been sitting in a cache. A CDN edge answered from its cache.',
  'cf-cache-status': 'Cloudflare-specific: HIT means the edge served it from cache.',
  'cf-ray': 'Cloudflare request id; the suffix is the code of the data center that answered.',
  'alt-svc': 'Advertises that the same site is also available over HTTP/3 (QUIC) on port 443.',
  'content-length': 'Exact body size in bytes.',
};

/**
 * Describes HTTP/1.1 bytes. A TCP segment may carry only part of a message: if the bytes do not start with a
 * request or status line they are shown as a continuation, because HTTP only ever sees the reassembled stream.
 */
export function describeHttp(b: Uint8Array, o: number, end: number): LayerPdu {
  const f = new FieldList();
  const head = toAscii(b, o, Math.min(end, o + 8));
  const isRequest = METHODS.some((m) => head.startsWith(m));
  const isResponse = head.startsWith('HTTP/');
  if (!isRequest && !isResponse) {
    f.add('http.continuation', 'Continued data', o, end - o, `${end - o} bytes: "${preview(b, o, end, 40)}"`, 'key', 'The middle or end of an HTTP message that did not fit in one TCP segment. TCP puts the pieces back together before the browser parses them.');
    return { protocol: 'http', layer: 5, start: o, headerEnd: end, payloadEnd: end, end, summary: `HTTP continuation · ${end - o} B`, fields: f.list };
  }
  let i = o;
  const lineEnd = indexOfCrlf(b, i, end);
  const startLine = toAscii(b, i, lineEnd < 0 ? end : lineEnd);
  const summary = `HTTP ${startLine}`;
  f.add(isRequest ? 'http.request_line' : 'http.status_line', isRequest ? 'Request line' : 'Status line', i, (lineEnd < 0 ? end : lineEnd + 2) - i, startLine, 'key', isRequest
    ? 'Method, path and protocol version: which document to get, and how. Plain text, ending in CR LF.'
    : 'Protocol version, status code and reason. 200 OK means the request succeeded.');
  if (lineEnd < 0) return { protocol: 'http', layer: 5, start: o, headerEnd: end, payloadEnd: end, end, summary, fields: f.list };
  i = lineEnd + 2;
  let chunked = false;
  let headersDone = false;
  while (i < end) {
    const le = indexOfCrlf(b, i, end);
    if (le < 0) {
      f.add('http.partial', 'Partial header', i, end - i, `"${preview(b, i, end, 40)}" (continues in next segment)`, 'detail', 'The segment boundary fell in the middle of a header line.');
      i = end;
      break;
    }
    if (le === i) {
      f.add('http.blank', 'End of headers', i, 2, 'CR LF', 'detail', 'An empty line separates the headers from the body.');
      i += 2;
      headersDone = true;
      break;
    }
    const line = toAscii(b, i, le);
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon) : line;
    const lname = name.toLowerCase();
    if (lname === 'transfer-encoding' && line.toLowerCase().includes('chunked')) chunked = true;
    const important = ['host', 'content-type', 'connection', 'transfer-encoding'].includes(lname);
    f.add(`http.header.${lname}`, name, i, le + 2 - i, line.slice(colon + 1).trim(), important ? 'key' : 'detail', HEADER_EXPLAIN[lname] ?? 'An HTTP header: a "Name: value" line of plain text.');
    i = le + 2;
  }
  if (headersDone && i < end) {
    if (chunked) {
      while (i < end) {
        const le = indexOfCrlf(b, i, end);
        if (le < 0) break;
        const size = parseInt(toAscii(b, i, le), 16);
        f.add('http.chunk_size', 'Chunk size', i, le + 2 - i, `${toAscii(b, i, le)} (hex) = ${size} bytes`, 'detail', size === 0 ? 'A zero-size chunk marks the end of the body.' : 'Size of the next chunk in hexadecimal.');
        i = le + 2;
        if (size === 0) {
          if (i + 2 <= end) {
            f.add('http.chunk_end', 'End of body', i, 2, 'CR LF', 'detail', 'Final empty line after the last chunk.');
            i += 2;
          }
          break;
        }
        const dataEnd = Math.min(end, i + size);
        f.add('http.body', 'Body (HTML)', i, dataEnd - i, `${dataEnd - i} bytes${dataEnd < i + size ? ` of ${size}` : ''}: "${preview(b, i, dataEnd, 48)}"`, 'key', 'The web page itself, as HTML text. The browser parses it into the page you see.');
        i = dataEnd;
        if (i + 2 <= end && b[i] === 0x0d) {
          f.add('http.chunk_crlf', 'Chunk end', i, 2, 'CR LF', 'detail', 'Each chunk is followed by CR LF.');
          i += 2;
        }
      }
    }
    if (i < end) {
      f.add('http.body', 'Body', i, end - i, `${end - i} bytes: "${preview(b, i, end, 48)}"`, 'key', 'Message body.');
    }
  }
  return { protocol: 'http', layer: 5, start: o, headerEnd: end, payloadEnd: end, end, summary, fields: f.list };
}
