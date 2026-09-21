import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { AgentEnv } from '@cr-agentic/config';
import { Readable } from 'stream';

export class S3StorageClient {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly customEndpoint: boolean;

  constructor(
    private readonly env: Pick<
      AgentEnv,
      | 'AWS_REGION'
      | 'AWS_S3_BUCKET'
      | 'AWS_ACCESS_KEY_ID'
      | 'AWS_SECRET_ACCESS_KEY'
      | 'AWS_ENDPOINT_URL'
    >,
  ) {
    this.bucket = env.AWS_S3_BUCKET;
    this.customEndpoint = Boolean(env.AWS_ENDPOINT_URL);
    this.client = new S3Client({
      region: env.AWS_REGION,
      ...(this.customEndpoint
        ? {
            endpoint: env.AWS_ENDPOINT_URL,
            forcePathStyle: true,
          }
        : {}),
      credentials:
        env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
    });
  }

  async upload(
    key: string,
    body: Buffer | string,
    contentType?: string,
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(this.customEndpoint ? {} : { ServerSideEncryption: 'AES256' as const }),
      }),
    );
    return key;
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  sessionKey(accountId: string, version: string): string {
    return `sessions/${accountId}/${version}.json.enc`;
  }

  documentKey(userId: string, documentId: string, filename: string): string {
    return `documents/${userId}/${documentId}/${filename}`;
  }

  screenshotKey(taskRunId: string, name: string): string {
    return `screenshots/${taskRunId}/${name}.png`;
  }
}
