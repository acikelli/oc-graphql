import {
  Stack,
  StackProps,
  RemovalPolicy,
  Duration,
  Expiration,
  CfnDeletionPolicy,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as glue from "aws-cdk-lib/aws-glue";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import {
  DynamoEventSource,
  SqsEventSource,
} from "aws-cdk-lib/aws-lambda-event-sources";
import { SchemaMetadata } from "../parsers/schema-parser";
import * as path from "path";

export interface OcGraphQLStackProps extends StackProps {
  projectName: string;
  schemaMetadata: SchemaMetadata;
  generatedCodePath: string;
}

export class OcGraphQLStack extends Stack {
  private readonly projectName: string;

  constructor(scope: Construct, id: string, props: OcGraphQLStackProps) {
    super(scope, id, props);

    const { projectName, schemaMetadata, generatedCodePath } = props;
    this.projectName = projectName;

    // Check if storage should be retained (from context)
    const retainStorage = this.node.tryGetContext("retainStorage") === "true";
    const storagePolicy = retainStorage
      ? RemovalPolicy.RETAIN
      : RemovalPolicy.DESTROY;

    // DynamoDB Table
    const table = new dynamodb.Table(this, "DataTable", {
      tableName: projectName,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: storagePolicy,
      pointInTimeRecovery: true, // Enable for data protection
    });

    // S3 Bucket for data lake
    const dataBucket = new s3.Bucket(this, "DataBucket", {
      bucketName: `${projectName}-${this.account}`,
      removalPolicy: storagePolicy,
      autoDeleteObjects: !retainStorage, // Only auto-delete if not retaining
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // S3 Bucket for Athena query results
    const athenaResultsBucket = new s3.Bucket(this, "AthenaResultsBucket", {
      bucketName: `${projectName}-athena-results-${this.account}`,
      removalPolicy: storagePolicy,
      autoDeleteObjects: !retainStorage, // Only auto-delete if not retaining
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // Glue Database (will be retained if storage is retained)
    const glueDatabase = new glue.CfnDatabase(this, "GlueDatabase", {
      catalogId: this.account,
      databaseInput: {
        name: `${projectName}_db`,
        description: `Database for ${projectName} project`,
      },
    });

    // Add deletion policy to Glue database
    if (retainStorage) {
      glueDatabase.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;
    }

    // AppSync GraphQL API
    const api = new appsync.GraphqlApi(this, "GraphQLApi", {
      name: `${projectName}-api`,
      schema: appsync.SchemaFile.fromAsset(
        path.join(generatedCodePath, "processed-schema.graphql")
      ),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.API_KEY,
          apiKeyConfig: {
            expires: Expiration.after(Duration.days(365)),
          },
        },
      },
    });

    // Lambda execution role
    const lambdaRole = new iam.Role(this, "LambdaExecutionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
      inlinePolicies: {
        DynamoDBPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "dynamodb:PutItem",
                "dynamodb:GetItem",
                "dynamodb:UpdateItem",
                "dynamodb:DeleteItem",
                "dynamodb:Query",
                "dynamodb:Scan",
              ],
              resources: [table.tableArn],
            }),
          ],
        }),
        AthenaPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "athena:StartQueryExecution",
                "athena:GetQueryExecution",
                "athena:GetQueryResults",
                "athena:StopQueryExecution",
              ],
              resources: ["*"],
            }),
          ],
        }),
        S3Policy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
              resources: [
                dataBucket.bucketArn + "/*",
                athenaResultsBucket.bucketArn + "/*",
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "s3:ListBucket",
                "s3:GetBucketLocation",
                "s3:CreateBucket",
              ],
              resources: [dataBucket.bucketArn, athenaResultsBucket.bucketArn],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:ListAllMyBuckets", "s3:GetBucketLocation"],
              resources: ["*"],
            }),
          ],
        }),
        GluePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "glue:CreateTable",
                "glue:GetTable",
                "glue:UpdateTable",
                "glue:DeleteTable",
                "glue:CreateDatabase",
                "glue:GetDatabase",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // Create Lambda functions
    const lambdaFunctions = this.createLambdaFunctions(
      schemaMetadata,
      projectName,
      generatedCodePath,
      lambdaRole,
      table,
      dataBucket,
      athenaResultsBucket,
      glueDatabase
    );

    // Create AppSync resolvers
    this.createAppSyncResolvers(api, lambdaFunctions, schemaMetadata);

    // SQS Queue for cascade deletion
    const cascadeDeletionQueue = new sqs.Queue(this, "CascadeDeletionQueue", {
      queueName: `${projectName}-cascade-deletion`,
      visibilityTimeout: Duration.minutes(5),
      retentionPeriod: Duration.days(14),
    });

    // Environment variables for all functions (same as other Lambda functions)
    const commonEnvironment: Record<string, string> = {
      DYNAMODB_TABLE_NAME: table.tableName,
      S3_BUCKET_NAME: dataBucket.bucketName,
      ATHENA_DATABASE_NAME: glueDatabase.ref,
      ATHENA_OUTPUT_LOCATION: `s3://${athenaResultsBucket.bucketName}/query-results/`,
      CASCADE_DELETION_QUEUE_URL: cascadeDeletionQueue.queueUrl,
    };

    // DynamoDB Stream processor (Python with Parquet support)
    const streamProcessor = new lambda.Function(this, "StreamProcessor", {
      functionName: `OCG-${projectName}-stream-processor`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: `ocg-${projectName}-stream-processor.lambda_handler`,
      code: lambda.Code.fromAsset(generatedCodePath),
      role: lambdaRole,
      environment: commonEnvironment,
      timeout: Duration.minutes(5),
      memorySize: 1024,
      layers: [
        // AWS managed layer with pandas, pyarrow, and other data libraries
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          "PandasLayer",
          `arn:aws:lambda:${this.region}:336392948345:layer:AWSSDKPandas-Python311:8`
        ),
      ],
    });

    streamProcessor.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 3,
      })
    );

    // Grant stream processor permission to send messages to SQS
    cascadeDeletionQueue.grantSendMessages(streamProcessor);

    // Cascade deletion queue listener Lambda (always created)
    const cascadeDeletionListener = new lambda.Function(
      this,
      "CascadeDeletionListener",
      {
        functionName: `OCG-${projectName}-cascade-deletion-listener`,
        runtime: lambda.Runtime.NODEJS_18_X,
        handler: `ocg-${projectName}-cascade-deletion-listener.handler`,
        code: lambda.Code.fromAsset(generatedCodePath),
        role: lambdaRole,
        environment: commonEnvironment,
        timeout: Duration.minutes(5),
        memorySize: 512,
      }
    );

    // Connect Lambda to SQS queue
    cascadeDeletionListener.addEventSource(
      new SqsEventSource(cascadeDeletionQueue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(5),
      })
    );

    // Grant permissions for DynamoDB and S3
    table.grantReadWriteData(cascadeDeletionListener);
    dataBucket.grantDelete(cascadeDeletionListener);

    // Create EventBridge Lambda and rule for tracking Athena query executions (if any tasks exist)
    const hasTasks = schemaMetadata.queries.some((q) => q.isTask);
    if (hasTasks) {
      const athenaExecutionTrackerFunctionName = `${projectName}-athena-execution-tracker`;
      const athenaExecutionTracker =
        lambdaFunctions[athenaExecutionTrackerFunctionName];

      if (athenaExecutionTracker) {
        // Create EventBridge rule to track Athena query state changes
        // Athena emits native EventBridge events when query state changes
        // The taskResult query also polls Athena directly as a fallback
        const athenaRule = new events.Rule(this, "AthenaQueryStateChangeRule", {
          eventPattern: {
            source: ["aws.athena"],
            detailType: ["Athena Query State Change"],
            detail: {
              currentState: ["SUCCEEDED", "FAILED", "CANCELLED"],
            },
          },
          description:
            "Track Athena query execution state changes for task tracking. Falls back to polling in taskResult query if EventBridge is unavailable.",
          enabled: true,
        });

        athenaRule.addTarget(
          new targets.LambdaFunction(athenaExecutionTracker)
        );

        // Grant EventBridge permission to invoke the Lambda
        athenaExecutionTracker.addPermission("EventBridgeInvoke", {
          principal: new iam.ServicePrincipal("events.amazonaws.com"),
          sourceArn: athenaRule.ruleArn,
        });
      }
    }
  }

  private createLambdaFunctions(
    schemaMetadata: SchemaMetadata,
    projectName: string,
    generatedCodePath: string,
    role: iam.Role,
    table: dynamodb.Table,
    dataBucket: s3.Bucket,
    athenaResultsBucket: s3.Bucket,
    glueDatabase: glue.CfnDatabase
  ): Record<string, lambda.Function> {
    const functions: Record<string, lambda.Function> = {};

    // Environment variables for all functions
    const commonEnvironment: Record<string, string> = {
      DYNAMODB_TABLE_NAME: table.tableName,
      S3_BUCKET_NAME: dataBucket.bucketName,
      ATHENA_DATABASE_NAME: glueDatabase.ref,
      ATHENA_OUTPUT_LOCATION: `s3://${athenaResultsBucket.bucketName}/query-results/`,
    };

    // CRUD functions for each type
    for (const type of schemaMetadata.types) {
      if (!type.isPrimitive && !type.isResolver) {
        const typeName = type.name.toLowerCase();

        ["create", "read", "update", "delete"].forEach((operation) => {
          const functionName = `${projectName}-${operation}-${typeName}`;
          functions[functionName] = new lambda.Function(
            this,
            `${operation}${type.name}Function`,
            {
              functionName: `OCG-${functionName}`,
              runtime: lambda.Runtime.NODEJS_18_X,
              handler: `ocg-${functionName}.handler`,
              code: lambda.Code.fromAsset(generatedCodePath),
              role,
              environment: commonEnvironment,
              timeout: Duration.seconds(30),
            }
          );
        });
      }
    }

    // Query functions
    for (const query of schemaMetadata.queries) {
      if (query.sqlQuery) {
        const functionName = `${projectName}-query-${query.name}`;
        functions[functionName] = new lambda.Function(
          this,
          `Query${query.name}Function`,
          {
            functionName: `OCG-${functionName}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: `ocg-${functionName}.handler`,
            code: lambda.Code.fromAsset(generatedCodePath),
            role,
            environment: commonEnvironment,
            timeout: Duration.minutes(5),
          }
        );
      }
    }

    // Mutation functions
    for (const mutation of schemaMetadata.mutations) {
      if (mutation.sqlQuery) {
        const functionName = `${projectName}-mutation-${mutation.name}`;
        functions[functionName] = new lambda.Function(
          this,
          `Mutation${mutation.name}Function`,
          {
            functionName: `OCG-${functionName}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: `ocg-${functionName}.handler`,
            code: lambda.Code.fromAsset(generatedCodePath),
            role,
            environment: commonEnvironment,
            timeout: Duration.minutes(5),
          }
        );
      }
    }

    // Resolver functions
    for (const type of schemaMetadata.types) {
      if (type.isResolver) {
        const functionName = `${projectName}-resolver-${type.name.toLowerCase()}`;
        functions[functionName] = new lambda.Function(
          this,
          `Resolver${type.name}Function`,
          {
            functionName: `OCG-${functionName}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: `ocg-${functionName}.handler`,
            code: lambda.Code.fromAsset(generatedCodePath),
            role,
            environment: commonEnvironment,
            timeout: Duration.minutes(5),
          }
        );
      }
    }

    // Individual field resolvers for fields with @sql_query in regular types
    for (const type of schemaMetadata.types) {
      if (!type.isPrimitive && !type.isResolver) {
        for (const field of type.fields) {
          if (field.sqlQuery) {
            const functionName = `${projectName}-field-${type.name.toLowerCase()}-${field.name}`;
            functions[functionName] = new lambda.Function(
              this,
              `Field${type.name}${field.name}Function`,
              {
                functionName: `OCG-${functionName}`,
                runtime: lambda.Runtime.NODEJS_18_X,
                handler: `ocg-${functionName}.handler`,
                code: lambda.Code.fromAsset(generatedCodePath),
                role,
                environment: commonEnvironment,
                timeout: Duration.minutes(5),
              }
            );
          }
        }
      }
    }

    // Task mutation functions (triggerTask)
    for (const query of schemaMetadata.queries) {
      if (query.isTask && query.sqlQuery) {
        const capitalizedName =
          query.name.charAt(0).toUpperCase() + query.name.slice(1);
        const functionName = `${projectName}-mutation-triggerTask${capitalizedName}`;
        functions[functionName] = new lambda.Function(
          this,
          `TriggerTask${capitalizedName}Function`,
          {
            functionName: `OCG-${functionName}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: `ocg-${functionName}.handler`,
            code: lambda.Code.fromAsset(generatedCodePath),
            role,
            environment: commonEnvironment,
            timeout: Duration.seconds(30),
          }
        );
      }
    }

    // Task result query functions (taskResult)
    for (const query of schemaMetadata.queries) {
      if (query.isTask && query.sqlQuery) {
        const capitalizedName =
          query.name.charAt(0).toUpperCase() + query.name.slice(1);
        const functionName = `${projectName}-query-taskResult${capitalizedName}`;
        functions[functionName] = new lambda.Function(
          this,
          `TaskResult${capitalizedName}Function`,
          {
            functionName: `OCG-${functionName}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: `ocg-${functionName}.handler`,
            code: lambda.Code.fromAsset(generatedCodePath),
            role,
            environment: commonEnvironment,
            timeout: Duration.seconds(30),
          }
        );
      }
    }

    // Athena execution tracker Lambda
    const hasTasks = schemaMetadata.queries.some((q) => q.isTask);
    if (hasTasks) {
      const functionName = `${projectName}-athena-execution-tracker`;
      functions[functionName] = new lambda.Function(
        this,
        "AthenaExecutionTrackerFunction",
        {
          functionName: `OCG-${functionName}`,
          runtime: lambda.Runtime.NODEJS_18_X,
          handler: `ocg-${functionName}.handler`,
          code: lambda.Code.fromAsset(generatedCodePath),
          role,
          environment: commonEnvironment,
          timeout: Duration.minutes(5),
        }
      );
    }

    return functions;
  }

  private createAppSyncResolvers(
    api: appsync.GraphqlApi,
    lambdaFunctions: Record<string, lambda.Function>,
    schemaMetadata: SchemaMetadata
  ): void {
    // Create data sources for Lambda functions
    const dataSources: Record<string, appsync.LambdaDataSource> = {};

    Object.entries(lambdaFunctions).forEach(([name, func]) => {
      dataSources[name] = api.addLambdaDataSource(`${name}DataSource`, func);
    });

    // CRUD resolvers
    for (const type of schemaMetadata.types) {
      if (!type.isPrimitive && !type.isResolver) {
        const typeName = type.name.toLowerCase();
        const projectName = this.projectName;

        // Query resolvers
        const readFunctionName = `${projectName}-read-${typeName}`;
        if (dataSources[readFunctionName]) {
          dataSources[readFunctionName].createResolver(
            `read${type.name}Resolver`,
            {
              typeName: "Query",
              fieldName: `read${type.name}`,
            }
          );
        }

        // Mutation resolvers
        ["create", "update", "delete"].forEach((operation) => {
          const functionName = `${projectName}-${operation}-${typeName}`;
          if (dataSources[functionName]) {
            dataSources[functionName].createResolver(
              `${operation}${type.name}Resolver`,
              {
                typeName: "Mutation",
                fieldName: `${operation}${type.name}`,
              }
            );
          }
        });
      }
    }

    // Custom query resolvers (skip if it's a task query - those use taskResult instead)
    for (const query of schemaMetadata.queries) {
      if (query.sqlQuery && !query.isTask) {
        const projectName = this.projectName;
        const functionName = `${projectName}-query-${query.name}`;
        if (dataSources[functionName]) {
          dataSources[functionName].createResolver(`${query.name}Resolver`, {
            typeName: "Query",
            fieldName: query.name,
          });
        }
      }
    }

    // Task result query resolvers
    for (const query of schemaMetadata.queries) {
      if (query.isTask && query.sqlQuery) {
        const projectName = this.projectName;
        const capitalizedName =
          query.name.charAt(0).toUpperCase() + query.name.slice(1);
        const functionName = `${projectName}-query-taskResult${capitalizedName}`;
        if (dataSources[functionName]) {
          dataSources[functionName].createResolver(
            `taskResult${capitalizedName}Resolver`,
            {
              typeName: "Query",
              fieldName: `taskResult${capitalizedName}`,
            }
          );
        }
      }
    }

    // Custom mutation resolvers
    for (const mutation of schemaMetadata.mutations) {
      if (mutation.sqlQuery) {
        const projectName = this.projectName;
        const functionName = `${projectName}-mutation-${mutation.name}`;
        if (dataSources[functionName]) {
          dataSources[functionName].createResolver(`${mutation.name}Resolver`, {
            typeName: "Mutation",
            fieldName: mutation.name,
          });
        }
      }
    }

    // Task trigger mutation resolvers
    for (const query of schemaMetadata.queries) {
      if (query.isTask && query.sqlQuery) {
        const projectName = this.projectName;
        const capitalizedName =
          query.name.charAt(0).toUpperCase() + query.name.slice(1);
        const functionName = `${projectName}-mutation-triggerTask${capitalizedName}`;
        if (dataSources[functionName]) {
          dataSources[functionName].createResolver(
            `triggerTask${capitalizedName}Resolver`,
            {
              typeName: "Mutation",
              fieldName: `triggerTask${capitalizedName}`,
            }
          );
        }
      }
    }

    // Individual field resolvers for fields with @sql_query in regular types
    for (const type of schemaMetadata.types) {
      if (!type.isPrimitive && !type.isResolver) {
        for (const field of type.fields) {
          if (field.sqlQuery) {
            const functionName = `${this.projectName}-field-${type.name.toLowerCase()}-${field.name}`;
            if (dataSources[functionName]) {
              dataSources[functionName].createResolver(
                `${type.name}${field.name}FieldResolver`,
                {
                  typeName: type.name,
                  fieldName: field.name,
                }
              );
            }
          }
        }
      }
    }

    // Resolver type data sources - attach to ALL fields of the resolver type
    for (const type of schemaMetadata.types) {
      if (type.isResolver) {
        const projectName = this.projectName;
        const functionName = `${projectName}-resolver-${type.name.toLowerCase()}`;
        if (dataSources[functionName]) {
          // Create resolvers for ALL fields in the resolver type
          for (const field of type.fields) {
            dataSources[functionName].createResolver(
              `${type.name}${field.name}Resolver`,
              {
                typeName: type.name,
                fieldName: field.name,
              }
            );
          }
        }
      }
    }

    // Attach resolver types to fields that reference them in other types
    for (const type of schemaMetadata.types) {
      if (!type.isPrimitive && !type.isResolver) {
        for (const field of type.fields) {
          // Check if field type is a resolver type
          const referencedType = schemaMetadata.types.find(
            (t) => t.name === field.type
          );
          if (referencedType && referencedType.isResolver) {
            const functionName = `${this.projectName}-resolver-${referencedType.name.toLowerCase()}`;
            if (dataSources[functionName]) {
              dataSources[functionName].createResolver(
                `${type.name}${field.name}ResolverTypeResolver`,
                {
                  typeName: type.name,
                  fieldName: field.name,
                }
              );
            }
          }
        }
      }
    }
  }
}
