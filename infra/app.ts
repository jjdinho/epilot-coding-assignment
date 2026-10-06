import * as path from 'node:path';
import { App, CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

class BtcUpDownStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const table = new TableV2(this, 'Table', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
    });

    // One message per guess, delayed 60 s (D5). No dead-letter queue: a message that keeps failing is retried until
    // retention ends, and the GET /state backup still resolves its guess when the player returns (§10).
    const queue = new Queue(this, 'ResolveQueue');

    const lambda = (id: string, file: string, props: NodejsFunctionProps = {}) =>
      new NodejsFunction(this, id, {
        entry: path.join(__dirname, '../backend/src', file),
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        environment: { TABLE_NAME: table.tableName, QUEUE_URL: queue.queueUrl },
        ...props,
      });

    // 256 MB like the API, for the same Coinbase call. The 10 s timeout stays below the queue's 30 s visibility timeout.
    const resolver = lambda('Resolver', 'resolver.ts', { memorySize: 256, timeout: Duration.seconds(10) });
    table.grantReadWriteData(resolver);
    // Re-sends the message while the price hasn't moved or Coinbase is down (D5).
    queue.grantSendMessages(resolver);
    resolver.addEventSource(new SqsEventSource(queue, { batchSize: 1 }));

    // CPU scales with memory. At 128 MB, a cold GET /price/history took up to 2.6 s, against a 2 s Coinbase timeout.
    const apiHandler = lambda('ApiHandler', 'api.ts', { memorySize: 256 });
    table.grantReadWriteData(apiHandler);
    // POST /guess sends each guess's message (D5).
    queue.grantSendMessages(apiHandler);
    const api = new HttpApi(this, 'Api', {
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
        allowHeaders: ['content-type', 'x-player-id'],
        // The client polls every second, so let browsers cache the preflight.
        maxAge: Duration.hours(2),
      },
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', apiHandler);
    api.addRoutes({ path: '/state', methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: '/player', methods: [HttpMethod.POST], integration });
    api.addRoutes({ path: '/guess', methods: [HttpMethod.POST], integration });
    api.addRoutes({ path: '/price/history', methods: [HttpMethod.GET], integration });

    const siteBucket = new Bucket(this, 'SiteBucket');
    const site = new Distribution(this, 'Site', {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
    });
    // config.json is written at deploy time, so the frontend build doesn't depend on the API URL.
    new BucketDeployment(this, 'SiteDeployment', {
      sources: [
        Source.asset(path.join(__dirname, '../frontend/dist')),
        Source.jsonData('config.json', { apiUrl: api.apiEndpoint }),
      ],
      destinationBucket: siteBucket,
      distribution: site,
    });

    new CfnOutput(this, 'SiteUrl', { value: `https://${site.distributionDomainName}` });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}

const app = new App();
// No context lookups, so `cdk synth` runs without AWS credentials.
new BtcUpDownStack(app, 'BtcUpDown', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-north-1' },
});
