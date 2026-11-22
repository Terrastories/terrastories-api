import { describe, expect, it } from 'vitest';
import { signS3GetRequest } from '../../src/migration/rails/s3-client.js';

describe('signS3GetRequest', () => {
  // Reference vector: AWS S3 docs, SigV4 header-based auth, "GET Bucket
  // Lifecycle" example. The key pair below is the published AWS documentation
  // example (not a real credential).
  it('matches the AWS documented GET Bucket Lifecycle signature', () => {
    const headers = signS3GetRequest({
      url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'),
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      now: new Date('2013-05-24T00:00:00Z'),
    });

    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543'
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
  });
});
