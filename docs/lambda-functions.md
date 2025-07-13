# Lambda Functions Guide

OC-GraphQL automatically generates a comprehensive set of Lambda functions to handle all GraphQL operations. This guide explains the function types, execution patterns, and configuration details.

## 🏗️ Function Architecture Overview

### Function Categories

1. **CRUD Functions** - Basic entity operations (Create, Read, Update, Delete)
2. **Query Functions** - Custom SQL query execution
3. **Mutation Functions** - Custom SQL mutations
4. **Resolver Functions** - Complex type resolution with multiple SQL queries
5. **Field Resolver Functions** - Individual field-level SQL queries
6. **Stream Processor** - DynamoDB to Parquet data pipeline

## 📋 Function Naming Patterns

### Consistent Naming Convention

```
Pattern: OCG-{project}-{category}-{identifier}
Examples:
- OCG-blog-create-user
- OCG-blog-query-getPopularPosts
- OCG-blog-resolver-postconnection
- OCG-blog-stream-processor
```

## 🔧 Function Types & Implementation

### 1. CRUD Functions (Node.js 18.x)

Auto-generated for each entity type to handle basic database operations.

#### Create Function

```javascript
// Pattern: OCG-{project}-create-{entity}
// Example: OCG-blog-create-user

const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");
const { v4: uuidv4 } = require("uuid");

exports.handler = async (event) => {
  const input = event.arguments.input;
  const id = uuidv4();
  const now = new Date().toISOString();

  const item = {
    PK: `user#${id}`,
    SK: `user#${id}`,
    id,
    ...input,
    entityType: "user",
    createdAt: now,
    updatedAt: now,
  };

  await dynamoClient.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(item),
    })
  );

  return item;
};
```

#### Read Function

```javascript
// Pattern: OCG-{project}-read-{entity}
// Example: OCG-blog-read-user

const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

exports.handler = async (event) => {
  const id = event.arguments.id;

  const result = await dynamoClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `user#${id}` },
        SK: { S: `user#${id}` },
      },
    })
  );

  if (!result.Item) {
    throw new Error("User not found");
  }

  return unmarshall(result.Item);
};
```

#### Update Function

```javascript
// Pattern: OCG-{project}-update-{entity}
// Example: OCG-blog-update-user

exports.handler = async (event) => {
  const id = event.arguments.id;
  const input = event.arguments.input;
  const now = new Date().toISOString();

  // Dynamic update expression generation
  const updateExpression = [];
  const expressionAttributeValues = { ":updatedAt": { S: now } };
  const expressionAttributeNames = { "#updatedAt": "updatedAt" };

  Object.entries(input).forEach(([key, value], index) => {
    if (value !== undefined) {
      const attrName = `#attr${index}`;
      const attrValue = `:val${index}`;
      updateExpression.push(`${attrName} = ${attrValue}`);
      expressionAttributeNames[attrName] = key;
      expressionAttributeValues[attrValue] = marshall(value);
    }
  });

  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { PK: { S: `user#${id}` }, SK: { S: `user#${id}` } },
      UpdateExpression: `SET ${updateExpression.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  return { id, ...input, updatedAt: now };
};
```

#### Delete Function

```javascript
// Pattern: OCG-{project}-delete-{entity}
// Example: OCG-blog-delete-user

exports.handler = async (event) => {
  const id = event.arguments.id;

  await dynamoClient.send(
    new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `user#${id}` },
        SK: { S: `user#${id}` },
      },
    })
  );

  return { id, deleted: true };
};
```

### 2. Query Functions (Node.js 18.x)

Execute custom SQL queries for complex data retrieval.

```javascript
// Pattern: OCG-{project}-query-{queryName}
// Example: OCG-blog-query-getPopularPosts

const {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} = require("@aws-sdk/client-athena");

// SQL injection prevention
function escapeSqlValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  } else if (typeof value === "number") {
    if (!isFinite(value)) {
      throw new Error("Invalid number value");
    }
    return value.toString();
  } else if (typeof value === "boolean") {
    return value ? "true" : "false";
  } else if (typeof value === "string") {
    let escaped = value.split("'").join("''"); // SQL standard escaping
    return "'" + escaped + "'";
  } else {
    throw new Error("Unsupported data type for SQL parameter");
  }
}

exports.handler = async (event) => {
  let query = `SELECT p.*, COUNT(pl.id) as like_count 
               FROM post p 
               LEFT JOIN post_likes pl ON p.id = pl.post_id 
               WHERE p.published = true
                 AND p.created_at >= current_date - interval '$args.days' day
               GROUP BY p.id 
               ORDER BY like_count DESC 
               LIMIT $args.limit`;

  // Replace parameter placeholders with SQL-safe escaping
  if (event.arguments) {
    Object.entries(event.arguments).forEach(([key, value]) => {
      const argsPattern = "$args." + key;
      const sqlSafeValue = escapeSqlValue(value);
      query = query.split(argsPattern).join(sqlSafeValue);
    });
  }

  // Execute Athena query
  const queryExecution = await athenaClient.send(
    new StartQueryExecutionCommand({
      QueryString: query,
      QueryExecutionContext: { Database: DATABASE_NAME },
      ResultConfiguration: { OutputLocation: S3_OUTPUT_LOCATION },
    })
  );

  // Wait for completion and return results
  // ... (polling and result processing logic)

  return data; // Array of results
};
```

### 3. Resolver Functions (Node.js 18.x)

Handle complex types with multiple SQL queries executed in parallel.

```javascript
// Pattern: OCG-{project}-resolver-{typeName}
// Example: OCG-blog-resolver-postconnection

exports.handler = async (event) => {
  const sourceArgs = event.source || {};
  const fieldArgs = event.arguments || {};

  // Determine which field is being requested
  const requestedField = event.info?.fieldName;

  // Execute multiple SQL queries in parallel
  const queryPromises = [
    executeQuery(
      `SELECT * FROM post WHERE user_id = $source.id ORDER BY created_at DESC LIMIT $args.limit OFFSET $args.offset`,
      { ...sourceArgs, ...fieldArgs }
    ).then((result) => ({ field: "items", result: result })),

    executeQuery(
      `SELECT COUNT(*) as count FROM post WHERE user_id = $source.id`,
      { ...sourceArgs, ...fieldArgs }
    ).then((result) => ({
      field: "totalCount",
      result: result[0]["count"] || 0,
    })),
  ];

  const results = await Promise.all(queryPromises);

  // Build response object
  const response = {};
  results.forEach(({ field, result }) => {
    response[field] = result;
  });

  // Handle @return directives
  response.hasMore = fieldArgs.offset + fieldArgs.limit < response.totalCount;

  // Return only the requested field value
  if (requestedField && response.hasOwnProperty(requestedField)) {
    return response[requestedField];
  }

  return response;
};
```

### 4. Field Resolver Functions (Node.js 18.x)

Execute SQL queries for individual fields within regular entity types.

```javascript
// Pattern: OCG-{project}-field-{typeName}-{fieldName}
// Example: OCG-blog-field-user-totalPosts

exports.handler = async (event) => {
  let query = `SELECT COUNT(*) as count FROM post WHERE user_id = $source.id`;

  // Replace source parameters
  if (event.source) {
    Object.entries(event.source).forEach(([key, value]) => {
      const sourcePattern = "$source." + key;
      const sqlSafeValue = escapeSqlValue(value);
      query = query.split(sourcePattern).join(sqlSafeValue);
    });
  }

  // Execute query and return scalar result
  const results = await executeQuery(query, event.source || {});
  return results[0]?.count || 0;
};
```

### 5. Stream Processor (Python 3.11)

Real-time DynamoDB to Parquet conversion with advanced optimization.

```python
# Pattern: OCG-{project}-stream-processor
# Example: OCG-blog-stream-processor

import json
import os
import boto3
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from datetime import datetime
from io import BytesIO
import logging

def lambda_handler(event, context):
    """Main Lambda handler for DynamoDB stream processing"""
    for record in event['Records']:
        try:
            process_record(record)
        except Exception as e:
            logger.error(f"Error processing record: {str(e)}")

    return {'statusCode': 200, 'body': 'Stream processing completed'}

def process_record(record):
    """Process individual DynamoDB stream record"""
    event_name = record['eventName']  # INSERT, MODIFY, REMOVE
    current_date = datetime.utcnow()
    year = current_date.strftime('%Y')
    month = current_date.strftime('%m')
    day = current_date.strftime('%d')

    if event_name == 'REMOVE':
        handle_delete_operation(record, current_date, year, month, day)
    else:
        handle_insert_update_operation(record, event_name, current_date, year, month, day)

def create_dataframe_from_item(item):
    """Convert DynamoDB item to optimized pandas DataFrame"""
    df = pd.DataFrame([item])

    # Intelligent type optimization
    for column in df.columns:
        if column.startswith('_partition_'):
            continue

        # Convert ISO timestamps to native datetime
        if isinstance(df[column].iloc[0], str) and is_iso_timestamp(df[column].iloc[0]):
            df[column] = pd.to_datetime(df[column], format='mixed', utc=True)
        elif df[column].dtype == 'int64':
            df[column] = df[column].astype('int32')  # Smaller int type
        elif df[column].dtype == 'float64':
            df[column] = df[column].astype('float32')  # Smaller float type

    return df

def write_parquet_to_s3(df, s3_key):
    """Write optimized Parquet file to S3"""
    table = pa.Table.from_pandas(df, preserve_index=False)

    # Create ultra-minimal schema for maximum compression
    ultra_minimal_schema = []
    for i, field in enumerate(table.schema):
        if pd.api.types.is_datetime64_any_dtype(df.iloc[:, i]):
            minimal_field = pa.field(field.name, pa.timestamp('ns', tz='UTC'))
        # ... other type optimizations
        ultra_minimal_schema.append(minimal_field)

    # Write with SNAPPY compression
    parquet_buffer = BytesIO()
    pq.write_table(
        minimal_table,
        parquet_buffer,
        compression='snappy',
        use_dictionary=False,
        write_statistics=False,
        version='2.6'
    )

    # Upload to S3
    s3_client.put_object(
        Bucket=BUCKET_NAME,
        Key=s3_key,
        Body=parquet_buffer.getvalue(),
        ContentType='application/octet-stream'
    )
```

## ⚙️ Function Configuration

### Runtime & Memory Allocation

| **Function Type** | **Runtime**  | **Memory** | **Timeout** | **Concurrency** |
| ----------------- | ------------ | ---------- | ----------- | --------------- |
| CRUD Operations   | Node.js 18.x | 128 MB     | 30 seconds  | 1000            |
| SQL Queries       | Node.js 18.x | 256 MB     | 5 minutes   | 100             |
| Resolvers         | Node.js 18.x | 512 MB     | 5 minutes   | 100             |
| Stream Processor  | Python 3.11  | 1024 MB    | 5 minutes   | 10              |

### Environment Variables

All functions receive these environment variables:

```bash
DYNAMODB_TABLE_NAME={project}
S3_BUCKET_NAME={project}-{account-id}
ATHENA_DATABASE_NAME={project}_db
ATHENA_OUTPUT_LOCATION=s3://{project}-athena-results-{account-id}/query-results/
AWS_REGION={region}
```

### IAM Permissions

#### CRUD Functions

```json
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem"
  ],
  "Resource": "arn:aws:dynamodb:{region}:{account}:table/{project}"
}
```

#### Query/Resolver Functions

```json
{
  "Effect": "Allow",
  "Action": [
    "athena:StartQueryExecution",
    "athena:GetQueryExecution",
    "athena:GetQueryResults",
    "glue:GetTable",
    "glue:GetDatabase"
  ],
  "Resource": "*"
}
```

#### Stream Processor

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:GetObject",
    "glue:CreateTable",
    "glue:GetTable"
  ],
  "Resource": [
    "arn:aws:s3:::{project}-{account}/*",
    "arn:aws:glue:{region}:{account}:*"
  ]
}
```

## 🚀 Performance Optimization

### Cold Start Mitigation

```javascript
// Connection reuse across invocations
const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
  retryMode: "adaptive",
});

// Optimize SDK imports
const { GetItemCommand } = require("@aws-sdk/client-dynamodb");
```

### Memory Optimization

```javascript
// Efficient data processing
exports.handler = async (event) => {
  try {
    const result = await processEvent(event);
    return result;
  } catch (error) {
    console.error("Error:", error);
    throw error;
  } finally {
    // Cleanup resources if needed
  }
};
```

### Parallel Execution

```javascript
// Resolver functions execute queries in parallel
const queryPromises = [
  executeQuery(query1, params),
  executeQuery(query2, params),
  executeQuery(query3, params),
];

const results = await Promise.all(queryPromises);
```

## 📊 Monitoring & Debugging

### CloudWatch Metrics

- **Duration**: Function execution time
- **Errors**: Error count and rate
- **Throttles**: Concurrency limit hits
- **Cold Starts**: First-time execution delays

### Logging Strategy

```javascript
exports.handler = async (event) => {
  console.log("Function started:", JSON.stringify(event, null, 2));

  try {
    const result = await processEvent(event);
    console.log("Function completed successfully");
    return result;
  } catch (error) {
    console.error("Function failed:", error);
    throw error;
  }
};
```

### X-Ray Tracing

```javascript
const AWSXRay = require("aws-xray-sdk-core");
const AWS = AWSXRay.captureAWS(require("aws-sdk"));

// Automatic distributed tracing across all services
```

## 🔧 Custom Function Patterns

### Error Handling

```javascript
exports.handler = async (event) => {
  try {
    // Validate input
    if (!event.arguments?.id) {
      throw new Error("Missing required argument: id");
    }

    // Execute operation
    const result = await performOperation(event.arguments);

    return result;
  } catch (error) {
    console.error("Error processing request:", error);

    if (error.message.includes("not found")) {
      throw new Error("Resource not found");
    } else if (error.message.includes("validation")) {
      throw new Error("Invalid input parameters");
    } else {
      throw new Error("Internal server error");
    }
  }
};
```

### Caching Strategy

```javascript
const cache = new Map();

exports.handler = async (event) => {
  const cacheKey = JSON.stringify(event.arguments);

  // Check cache first
  if (cache.has(cacheKey)) {
    console.log("Cache hit");
    return cache.get(cacheKey);
  }

  // Execute query
  const result = await executeQuery(event);

  // Cache result (with TTL)
  cache.set(cacheKey, result);
  setTimeout(() => cache.delete(cacheKey), 300000); // 5 minutes

  return result;
};
```

## 📈 Scaling Considerations

### Concurrency Limits

- **CRUD Operations**: High concurrency (1000+) for fast operations
- **Analytics Queries**: Lower concurrency (100) for resource-intensive operations
- **Stream Processor**: Controlled concurrency (10) for stable data processing

### Cost Optimization

- **Right-sized Memory**: Minimize memory allocation for faster cold starts
- **Efficient Code**: Minimize dependencies and optimize data processing
- **Connection Reuse**: Leverage connection pooling across invocations

---

This comprehensive function architecture provides scalable, efficient, and maintainable serverless GraphQL operations while maintaining optimal performance and cost characteristics.
