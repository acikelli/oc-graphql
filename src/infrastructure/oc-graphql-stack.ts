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
import { Provider } from "aws-cdk-lib/custom-resources";
import { CustomResource } from "aws-cdk-lib";
import {
  DynamoEventSource,
  SqsEventSource,
} from "aws-cdk-lib/aws-lambda-event-sources";
import { SchemaMetadata } from "../parsers/schema-parser";
import * as path from "path";
import * as crypto from "crypto";

/**
 * Generate a short hash (first 16 characters) from a string
 * Used for Lambda function names to avoid 64 character limit
 */
function generateShortHash(input: string): string {
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return hash.substring(0, 16);
}

/**
 * Map GraphQL field type to Glue column type
 */
function mapGraphQLTypeToGlueType(graphQLType: string): string {
  // Remove list and non-null markers
  const baseType = graphQLType.replace(/[\[\]!]/g, "").trim();

  switch (baseType) {
    case "String":
    case "ID":
      return "string";
    case "Int":
      return "bigint";
    case "Float":
      return "double";
    case "Boolean":
      return "boolean";
    case "AWSDateTime":
      return "timestamp";
    default:
      // For custom types, default to string
      return "string";
  }
}

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
      tableName: `OCG-${projectName}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: storagePolicy,
      pointInTimeRecovery: true, // Enable for data protection
    });

    // Add GSI1 for join relation queries (GSI1-PK: joinRelation#relationId, GSI1-SK: joinRelation#entityType#entityId)
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1-PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1-SK", type: dynamodb.AttributeType.STRING },
    });

    // S3 Bucket for data lake
    const dataBucket = new s3.Bucket(this, "DataBucket", {
      bucketName: `ocg-${projectName.toLowerCase()}-${this.account}`,
      removalPolicy: storagePolicy,
      autoDeleteObjects: !retainStorage, // Only auto-delete if not retaining
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // S3 Bucket for Athena query results
    const athenaResultsBucket = new s3.Bucket(this, "AthenaResultsBucket", {
      bucketName: `ocg-${projectName.toLowerCase()}-athena-results-${this.account}`,
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
    // SQS Queue for cascade deletion
    const cascadeDeletionQueue = new sqs.Queue(this, "CascadeDeletionQueue", {
      queueName: `${projectName}-cascade-deletion`,
      visibilityTimeout: Duration.minutes(5),
      retentionPeriod: Duration.days(14),
    });

    // SQS Queue for deletion tasks (DELETE SQL operations)
    const hasDeleteMutations = schemaMetadata.mutations.some((m) => {
      const query = m.sqlQuery?.query.trim().toUpperCase() || "";
      return query.startsWith("DELETE");
    });
    const deletionQueue = hasDeleteMutations
      ? new sqs.Queue(this, "DeletionQueue", {
          queueName: `${projectName}-deletion`,
          visibilityTimeout: Duration.minutes(5),
          retentionPeriod: Duration.days(14),
        })
      : undefined;

    // Environment variables for all functions (same as other Lambda functions)
    const commonEnvironment: Record<string, string> = {
      DYNAMODB_TABLE_NAME: table.tableName,
      S3_BUCKET_NAME: dataBucket.bucketName,
      ATHENA_DATABASE_NAME: glueDatabase.ref,
      ATHENA_OUTPUT_LOCATION: `s3://${athenaResultsBucket.bucketName}/query-results/`,
      CASCADE_DELETION_QUEUE_URL: cascadeDeletionQueue.queueUrl,
    };

    // Add DELETION_QUEUE_URL if deletion queue exists
    if (deletionQueue) {
      commonEnvironment.DELETION_QUEUE_URL = deletionQueue.queueUrl;
    }

    const lambdaFunctions = this.createLambdaFunctions(
      schemaMetadata,
      projectName,
      generatedCodePath,
      lambdaRole,
      table,
      dataBucket,
      athenaResultsBucket,
      glueDatabase,
      commonEnvironment
    );

    // Create AppSync resolvers
    this.createAppSyncResolvers(api, lambdaFunctions, schemaMetadata);

    // Create Glue tables for all entity types and join tables (after lambdaRole is created)
    this.createGlueTables(
      glueDatabase,
      dataBucket,
      schemaMetadata,
      projectName,
      lambdaRole
    );

    // DynamoDB Stream processor (Python with Parquet support)
    // No hash needed - created once per project, won't hit 64 char limit
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
    // No hash needed - created once per project, won't hit 64 char limit
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

    // Deletion listener Lambda (for DELETE SQL operations)
    // No hash needed - created once per project, won't hit 64 char limit
    if (hasDeleteMutations && deletionQueue) {
      const deletionListener = new lambda.Function(this, "DeletionListener", {
        functionName: `OCG-${projectName}-deletion-listener`,
        runtime: lambda.Runtime.NODEJS_18_X,
        handler: `ocg-${projectName}-deletion-listener.handler`,
        code: lambda.Code.fromAsset(generatedCodePath),
        role: lambdaRole,
        environment: commonEnvironment,
        timeout: Duration.minutes(5),
        memorySize: 512,
      });

      // Connect Lambda to SQS queue
      deletionListener.addEventSource(
        new SqsEventSource(deletionQueue, {
          batchSize: 10,
          maxBatchingWindow: Duration.seconds(5),
        })
      );

      // Grant permissions for S3 deletion
      dataBucket.grantDelete(deletionListener);
    }

    // Create EventBridge Lambda and rule for tracking Athena query executions (if any tasks exist)
    const hasTasks =
      schemaMetadata.queries.some((q) => q.isTask) || hasDeleteMutations;
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

        // Grant Athena execution tracker permission to send messages to deletion queue (if it exists)
        if (hasDeleteMutations && deletionQueue) {
          deletionQueue.grantSendMessages(athenaExecutionTracker);
        }
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
    glueDatabase: glue.CfnDatabase,
    commonEnvironment: Record<string, string>
  ): Record<string, lambda.Function> {
    const functions: Record<string, lambda.Function> = {};

    // CRUD functions for each type
    for (const type of schemaMetadata.types) {
      if (!type.isPrimitive) {
        const typeName = type.name.toLowerCase();

        ["create", "read", "update", "delete"].forEach((operation) => {
          const functionName = `${projectName}-${operation}-${typeName}`;
          const hash = generateShortHash(functionName);
          functions[functionName] = new lambda.Function(
            this,
            `${operation}${type.name}Function`,
            {
              functionName: `OCG-${projectName}-${hash}`,
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

    // Query fields are automatically tasks - no direct Lambda functions created
    // Users must use triggerTask... mutations and taskResult... queries instead

    // Mutation functions (exclude DELETE mutations - they use triggerTask)
    for (const mutation of schemaMetadata.mutations) {
      if (mutation.sqlQuery) {
        // Skip DELETE mutations - they are handled as triggerTask mutations
        const query = mutation.sqlQuery.query.trim().toUpperCase();
        if (query.startsWith("DELETE")) {
          continue;
        }

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

    // Deletion task trigger mutation functions (for DELETE mutations)
    for (const mutation of schemaMetadata.mutations) {
      if (mutation.sqlQuery) {
        const query = mutation.sqlQuery.query.trim().toUpperCase();
        if (query.startsWith("DELETE")) {
          const capitalizedName =
            mutation.name.charAt(0).toUpperCase() + mutation.name.slice(1);
          const functionName = `${projectName}-mutation-triggerTask${capitalizedName}`;
          const hash = generateShortHash(functionName);
          functions[functionName] = new lambda.Function(
            this,
            `TriggerTaskDeletion${capitalizedName}Function`,
            {
              functionName: `OCG-${projectName}-${hash}`,
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
    }

    // Deletion task result query functions (for DELETE mutations)
    for (const mutation of schemaMetadata.mutations) {
      if (mutation.sqlQuery) {
        const query = mutation.sqlQuery.query.trim().toUpperCase();
        if (query.startsWith("DELETE")) {
          const capitalizedName =
            mutation.name.charAt(0).toUpperCase() + mutation.name.slice(1);
          const functionName = `${projectName}-query-taskResult${capitalizedName}`;
          const hash = generateShortHash(functionName);
          functions[functionName] = new lambda.Function(
            this,
            `TaskResultDeletion${capitalizedName}Function`,
            {
              functionName: `OCG-${projectName}-${hash}`,
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
    }

    // Removed: Resolver functions and field-level @sql_query resolvers
    // @resolver directive and @sql_query on type fields are no longer supported

    // Task mutation functions (triggerTask)
    for (const query of schemaMetadata.queries) {
      if (query.isTask && query.sqlQuery) {
        const capitalizedName =
          query.name.charAt(0).toUpperCase() + query.name.slice(1);
        const functionName = `${projectName}-mutation-triggerTask${capitalizedName}`;
        const hash = generateShortHash(functionName);
        functions[functionName] = new lambda.Function(
          this,
          `TriggerTask${capitalizedName}Function`,
          {
            functionName: `OCG-${projectName}-${hash}`,
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
        const hash = generateShortHash(functionName);
        functions[functionName] = new lambda.Function(
          this,
          `TaskResult${capitalizedName}Function`,
          {
            functionName: `OCG-${projectName}-${hash}`,
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
    const hasDeleteMutations = schemaMetadata.mutations.some((m) => {
      const query = m.sqlQuery?.query.trim().toUpperCase() || "";
      return query.startsWith("DELETE");
    });
    const hasTasks =
      schemaMetadata.queries.some((q) => q.isTask) || hasDeleteMutations;
    if (hasTasks) {
      const functionName = `${projectName}-athena-execution-tracker`;
      // No hash needed - created once per project, won't hit 64 char limit
      functions[functionName] = new lambda.Function(
        this,
        "AthenaExecutionTrackerFunction",
        {
          functionName: `OCG-${projectName}-athena-execution-tracker`,
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

    // CRUD resolvers (skip @task_response types)
    for (const type of schemaMetadata.types) {
      if (!type.isPrimitive && !type.isTaskResponse) {
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

    // Query fields are automatically tasks - no direct resolvers created
    // Users must use triggerTask... mutations and taskResult... queries instead

    // Task result query resolvers
    for (const query of schemaMetadata.queries) {
      if (query.isTask && query.sqlQuery) {
        const projectName = this.projectName;
        const capitalizedName =
          query.name.charAt(0).toUpperCase() + query.name.slice(1);
        // Match the Lambda function key (without ocg- prefix and .js extension)
        const functionName = `${projectName}-query-taskResult${capitalizedName}`;
        if (dataSources[functionName]) {
          dataSources[functionName].createResolver(
            `taskResult${capitalizedName}Resolver`,
            {
              typeName: "Query",
              fieldName: `taskResult${capitalizedName}`,
            }
          );
        } else {
          console.warn(
            `Data source not found for task result query: ${functionName}`
          );
        }
      }
    }

    // Custom mutation resolvers (exclude DELETE mutations - they use triggerTask)
    for (const mutation of schemaMetadata.mutations) {
      if (mutation.sqlQuery) {
        // Skip DELETE mutations - they are handled as triggerTask mutations
        const query = mutation.sqlQuery.query.trim().toUpperCase();
        if (query.startsWith("DELETE")) {
          continue;
        }

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

    // Task trigger mutation resolvers (for queries with @task directive)
    for (const query of schemaMetadata.queries) {
      if (query.isTask && query.sqlQuery) {
        const projectName = this.projectName;
        const capitalizedName =
          query.name.charAt(0).toUpperCase() + query.name.slice(1);
        // Match the Lambda function key (without ocg- prefix and .js extension)
        const functionName = `${projectName}-mutation-triggerTask${capitalizedName}`;
        if (dataSources[functionName]) {
          dataSources[functionName].createResolver(
            `triggerTask${capitalizedName}Resolver`,
            {
              typeName: "Mutation",
              fieldName: `triggerTask${capitalizedName}`,
            }
          );
        } else {
          console.warn(
            `Data source not found for task trigger mutation: ${functionName}`
          );
        }
      }
    }

    // Deletion task trigger mutation resolvers (for DELETE mutations)
    for (const mutation of schemaMetadata.mutations) {
      if (mutation.sqlQuery) {
        const query = mutation.sqlQuery.query.trim().toUpperCase();
        if (query.startsWith("DELETE")) {
          const projectName = this.projectName;
          const capitalizedName =
            mutation.name.charAt(0).toUpperCase() + mutation.name.slice(1);
          // Match the Lambda function key (without ocg- prefix and .js extension)
          const functionName = `${projectName}-mutation-triggerTask${capitalizedName}`;
          if (dataSources[functionName]) {
            dataSources[functionName].createResolver(
              `triggerTask${capitalizedName}Resolver`,
              {
                typeName: "Mutation",
                fieldName: `triggerTask${capitalizedName}`,
              }
            );
          } else {
            console.warn(
              `Data source not found for deletion task mutation: ${functionName}`
            );
          }
        }
      }
    }

    // Deletion task result query resolvers
    for (const mutation of schemaMetadata.mutations) {
      if (mutation.sqlQuery) {
        const query = mutation.sqlQuery.query.trim().toUpperCase();
        if (query.startsWith("DELETE")) {
          const projectName = this.projectName;
          const capitalizedName =
            mutation.name.charAt(0).toUpperCase() + mutation.name.slice(1);
          // Match the Lambda function key (without ocg- prefix and .js extension)
          const functionName = `${projectName}-query-taskResult${capitalizedName}`;
          if (dataSources[functionName]) {
            dataSources[functionName].createResolver(
              `taskResult${capitalizedName}Resolver`,
              {
                typeName: "Query",
                fieldName: `taskResult${capitalizedName}`,
              }
            );
          } else {
            console.warn(
              `Data source not found for deletion task result query: ${functionName}`
            );
          }
        }
      }
    }

    // Removed: Field-level @sql_query resolvers and @resolver type resolvers
    // @resolver directive and @sql_query on type fields are no longer supported
  }

  /**
   * Create Glue tables for all entity types and join tables
   * This eliminates the need for stream processor to check/create tables,
   * which was causing excessive S3 ListBucket operations
   */
  private createGlueTables(
    glueDatabase: glue.CfnDatabase,
    dataBucket: s3.Bucket,
    schemaMetadata: SchemaMetadata,
    projectName: string,
    lambdaRole: iam.Role
  ): void {
    const databaseName = `${projectName}_db`;
    const bucketName = dataBucket.bucketName;
    const baseLocation = `s3://${bucketName}/tables/`;

    // Create tables for all entity types (excluding task_response types)
    for (const type of schemaMetadata.types) {
      // Skip task_response types and primitive types
      if (type.isTaskResponse || type.isPrimitive) {
        continue;
      }

      const tableName = type.name.toLowerCase();
      const location = `${baseLocation}${tableName}/`;

      // Extract columns from GraphQL type fields
      const columns: glue.CfnTable.ColumnProperty[] = [];
      for (const field of type.fields) {
        // Skip internal fields
        if (
          field.name === "PK" ||
          field.name === "SK" ||
          field.name === "GSI1-PK" ||
          field.name === "GSI1-SK" ||
          field.name === "entityType" ||
          field.name === "entityId" ||
          field.name.startsWith("_partition_")
        ) {
          continue;
        }

        const glueType = mapGraphQLTypeToGlueType(field.type);
        columns.push({
          name: field.name,
          type: glueType,
        });
      }

      // Add standard timestamp fields if not already present
      const hasCreatedAt = columns.some((c) => c.name === "createdAt");
      const hasUpdatedAt = columns.some((c) => c.name === "updatedAt");

      if (!hasCreatedAt) {
        columns.push({ name: "createdAt", type: "timestamp" });
      }
      if (!hasUpdatedAt) {
        columns.push({ name: "updatedAt", type: "timestamp" });
      }

      // Create Glue table with partition projection
      // Storage template uses ${year} syntax for partition projection (not TypeScript template literal)
      const storageTemplate = `${location}year=\${year}/month=\${month}/day=\${day}/`;

      this.createGlueTableCustomResource(
        `GlueTable${type.name}`,
        databaseName,
        tableName,
        columns,
        location,
        storageTemplate,
        `Parquet table for ${type.name} entity with SNAPPY compression`,
        lambdaRole
      );
    }

    // Create tables for join tables
    for (const joinTable of schemaMetadata.joinTables) {
      const tableName = joinTable.toLowerCase();
      const location = `${baseLocation}${tableName}/`;

      // Extract columns from INSERT statements that use this join table
      const columns: glue.CfnTable.ColumnProperty[] = [];

      // Find mutations that use this join table
      for (const mutation of schemaMetadata.mutations) {
        if (mutation.sqlQuery?.query) {
          const query = mutation.sqlQuery.query;

          // Check if this mutation uses the current join table
          const joinTableMatch = query.match(/\$join_table\(([^)]+)\)/);
          if (
            joinTableMatch &&
            joinTableMatch[1].toLowerCase() === joinTable.toLowerCase()
          ) {
            // Extract column definitions from INSERT statement
            // Pattern: INSERT INTO $join_table(table) (col1:Type1, col2:Type2) VALUES ...
            const insertMatch = query.match(
              /INSERT\s+INTO\s+\$join_table\([^)]+\)\s*\(([^)]+)\)/i
            );
            if (insertMatch) {
              const columnDefs = insertMatch[1]
                .split(",")
                .map((col) => col.trim());

              // Parse each column definition (e.g., "userId:User" -> columnName: "userId")
              for (const colDef of columnDefs) {
                const parts = colDef.split(":");
                if (parts.length === 2) {
                  const columnName = parts[0].trim();

                  // Find the column type from mutation arguments
                  const arg = mutation.arguments?.find(
                    (a) => a.name === columnName
                  );
                  if (arg) {
                    const glueType = mapGraphQLTypeToGlueType(arg.type);

                    // Only add if not already added (avoid duplicates)
                    if (!columns.some((c) => c.name === columnName)) {
                      columns.push({
                        name: columnName,
                        type: glueType,
                      });
                    }
                  } else {
                    // If argument not found, default to string (ID types)
                    if (!columns.some((c) => c.name === columnName)) {
                      columns.push({
                        name: columnName,
                        type: "string",
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Add standard join table columns
      if (!columns.some((c) => c.name === "relationId")) {
        columns.unshift({ name: "relationId", type: "string" });
      }
      if (!columns.some((c) => c.name === "s3Key")) {
        columns.push({ name: "s3Key", type: "string" });
      }
      if (!columns.some((c) => c.name === "createdAt")) {
        columns.push({ name: "createdAt", type: "timestamp" });
      }

      // Storage template uses ${year} syntax for partition projection (not TypeScript template literal)
      const storageTemplate = `${location}year=\${year}/month=\${month}/day=\${day}/`;

      this.createGlueTableCustomResource(
        `GlueTableJoin${joinTable}`,
        databaseName,
        tableName,
        columns,
        location,
        storageTemplate,
        `Parquet table for join table ${joinTable} with SNAPPY compression`,
        lambdaRole
      );
    }
  }

  /**
   * Create a Glue table using Custom Resource Lambda
   * This handles existing tables gracefully (creates if not exists, updates if exists)
   */
  private createGlueTableCustomResource(
    id: string,
    databaseName: string,
    tableName: string,
    columns: glue.CfnTable.ColumnProperty[],
    location: string,
    storageTemplate: string,
    description: string,
    lambdaRole: iam.Role
  ): void {
    // Create Custom Resource Lambda that handles Glue table create/update
    const glueTableHandler = new lambda.Function(this, `${id}Handler`, {
      functionName: `OCG-${this.projectName}-glue-table-handler-${generateShortHash(id)}`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
const { GlueClient, GetTableCommand, CreateTableCommand, UpdateTableCommand } = require('@aws-sdk/client-glue');

const glue = new GlueClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  const { RequestType, ResourceProperties } = event;
  console.log('Event:', JSON.stringify(event, null, 2));
  const { DatabaseName, TableName, TableInput: TableInputJson } = ResourceProperties;
  console.log('Parsing TableInput from:', TableInputJson);
  const TableInput = JSON.parse(TableInputJson);
  console.log('Parsed TableInput:', JSON.stringify(TableInput, null, 2));
  
  try {
    if (RequestType === 'Delete') {
      // Don't delete tables on stack deletion (they may contain data)
      return { PhysicalResourceId: TableName };
    }
    
    // Try to get existing table
    let tableExists = false;
    try {
      await glue.send(new GetTableCommand({ DatabaseName, Name: TableName }));
      tableExists = true;
    } catch (error) {
      if (error.name !== 'EntityNotFoundException') {
        throw error;
      }
    }
    
    // Ensure Name is set in TableInput
    const finalTableInput = {
      ...TableInput,
      Name: TableName
    };
    
    // Log the TableInput for debugging
    console.log('TableInput structure:', JSON.stringify(finalTableInput, null, 2));
    
    if (tableExists) {
      // Update existing table - UpdateTableCommand requires all properties
      console.log(\`Updating existing Glue table: \${TableName}\`);
      await glue.send(new UpdateTableCommand({
        DatabaseName,
        TableInput: finalTableInput
      }));
      console.log(\`Successfully updated Glue table: \${TableName}\`);
    } else {
      // Create new table
      console.log(\`Creating new Glue table: \${TableName}\`);
      await glue.send(new CreateTableCommand({
        DatabaseName,
        TableInput: finalTableInput
      }));
      console.log(\`Successfully created Glue table: \${TableName}\`);
    }
    
    return {
      PhysicalResourceId: TableName,
      Data: { TableName }
    };
  } catch (error) {
    console.error('Error managing Glue table:', error);
    throw error;
  }
};
      `),
      role: lambdaRole,
      timeout: Duration.minutes(5),
    });

    // Grant Glue permissions
    glueTableHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "glue:GetTable",
          "glue:CreateTable",
          "glue:UpdateTable",
          "glue:DeleteTable",
        ],
        resources: [
          `arn:aws:glue:${this.region}:${this.account}:catalog`,
          `arn:aws:glue:${this.region}:${this.account}:database/${databaseName}`,
          `arn:aws:glue:${this.region}:${this.account}:table/${databaseName}/${tableName}`,
        ],
      })
    );

    // Create table input - AWS SDK expects capitalized property names
    // Convert columns from CDK format to AWS SDK format
    const sdkColumns = columns.map((col) => ({
      Name: col.name,
      Type: col.type,
    }));

    const tableInput = {
      Name: tableName,
      Description: description,
      PartitionKeys: [
        { Name: "year", Type: "string" },
        { Name: "month", Type: "string" },
        { Name: "day", Type: "string" },
      ],
      StorageDescriptor: {
        Columns: sdkColumns,
        Location: location,
        InputFormat:
          "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
        OutputFormat:
          "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
        SerdeInfo: {
          SerializationLibrary:
            "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
        },
        Parameters: {
          "parquet.compression": "SNAPPY",
          classification: "parquet",
        },
      },
      TableType: "EXTERNAL_TABLE",
      Parameters: {
        EXTERNAL: "TRUE",
        "parquet.compression": "SNAPPY",
        "projection.enabled": "true",
        "projection.year.type": "integer",
        "projection.year.range": "2024,2030",
        "projection.month.type": "integer",
        "projection.month.range": "1,12",
        "projection.month.digits": "2",
        "projection.day.type": "integer",
        "projection.day.range": "1,31",
        "projection.day.digits": "2",
        "storage.location.template": storageTemplate,
        has_encrypted_data: "false",
        typeOfData: "file",
      },
    };

    const provider = new Provider(this, `${id}Provider`, {
      onEventHandler: glueTableHandler,
    });

    new CustomResource(this, id, {
      serviceToken: provider.serviceToken,
      properties: {
        DatabaseName: databaseName,
        TableName: tableName,
        TableInput: JSON.stringify(tableInput),
      },
    });
  }
}
