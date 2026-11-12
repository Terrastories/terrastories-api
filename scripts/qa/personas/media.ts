import type { Step } from '../runner.js';
export function mediaSteps(): Step[] {
  const boundary = 'qa-persona-boundary';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ZkAAAAASUVORK5CYII=',
    'base64'
  );
  const multipart = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="qa.png"\r\nContent-Type: image/png\r\n\r\n`
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return [
    {
      name: 'upload media',
      method: 'POST',
      path: '/api/v1/files/upload',
      expected: 201,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      rawBody: multipart,
      captureId: 'file',
    },
    { name: 'list media', method: 'GET', path: '/api/v1/files', expected: 200 },
    {
      name: 'read media metadata',
      method: 'GET',
      path: '/api/v1/files/{file}/info',
      expected: 200,
    },
    {
      name: 'read media',
      method: 'GET',
      path: '/api/v1/files/{file}',
      expected: 200,
    },
    {
      name: 'reject oversized media',
      method: 'POST',
      path: '/api/v1/files/upload',
      expected: 413,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      rawBody: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n`
        ),
        png,
        Buffer.alloc(11 * 1024 * 1024),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    },
    {
      name: 'delete media',
      method: 'DELETE',
      path: '/api/v1/files/{file}',
      expected: 204,
    },
  ];
}
